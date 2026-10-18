// 全局记忆 store 插件壳：把 lib/memory-store.ts 的纯逻辑装配成 Kilo 插件——
// maintain 自动维护（legacy 一次性导入 → inbox 摄入 → usage 回流 → 评分编译 → 原子替换
// GLOBAL-NOTES.md）+ 五个 agent 工具（mem_add / mem_search / mem_get / mem_cite / mem_flag）。
// 分层理由：lib 层无宿主依赖可离线全测；本壳只做路径解析/锁/报告/工具返回串，绝不实现算法。
// 全局层由本插件编译管理后，memory-bootstrap 的 4KB 封顶/模板自愈已移除（双写会打架）。
//
// 契约同 moa/quality-gate（2026-09-22 钉死）：唯一函数导出工厂 + _export 命名空间对象；
// 工厂 never-throw；工具 execute 一律 async 返回 string；本插件不联网、不调 loadCfg，
// 任何环境空参调用都能 resolve（test-plugin-contract.mjs 会空参直调）。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../lib/hx-client";
import {
  FENCE_BEGIN, FENCE_END,
  loadStore, saveStoreAtomic, renameWithRetry, appendCorruptUnique,
  addOrReinforce, addWithPipeline, applyUsage, parseUsageLines, appendUsage,
  flagEntry, resolveShortId, assignSid, ensureSids,
  parsePendingOps, applyPendingOps, rotateUsage,
  score, density, tokenize, jaccard, parseLessonLines, extractUnfenced, isLineInFence,
  buildCompiled, recalcLifecycle, ingestSources, importOnce,
  normalizeText, hashText, makeId, redactSecrets, maskValue,
  BASIC_TAGS, lintEntry, isQuarantineCandidate,
  estTokens, bumpAffinity, projAffinity, effectiveScore,
  makeInjectionLogRow, makeSearchLogRow, snapshotNotes, computeStats,
} from "../lib/memory-store";

const TAG = "[memory-store]";
const USAGE_ROTATE_KEEP = 1;          // usage.jsonl.1 只留 1 代
const LOCK_STALE_MS = 90_000;         // 锁超过 90s 视为陈尸，允许接管
const THROTTLE_MS = 10_000;           // 编译产物 mtime 距今 <10s 跳过 maintain（statSync 廉价无状态）

// 配置根：Bun 有 import.meta.dir；node（契约测试 hook / esbuild bundle）没有——
// 用 import.meta.url + fileURLToPath 兜底（细则 b）。两者都取不到返回空串，
// 调用方静默跳过编译产物写入，绝不能抛错（工厂期抛错 = provider 级联崩溃）。
function resolveConfigRoot() {
  try {
    // 插件部署在 <configRoot>/plugin/ 下：dir/dirname 双重向上与 memory-bootstrap 同口径
    if (import.meta.dir) return path.dirname(import.meta.dir);
    if (import.meta.url) {
      const here = path.dirname(fileURLToPath(import.meta.url)); // .../plugin（或 bundle 目录）
      return path.dirname(here);
    }
  } catch { /* 取不到就降级 */ }
  return "";
}

const CONFIG_ROOT = resolveConfigRoot();

function storeDir() {
  return path.join(DATA_DIR, "memory-store");
}

// ── B1 项目 key 与会话目录捕获 ───────────────────────────
// projectKey = 去空格 basename(realpath) + "-" + sha1(realpath)[:6]：目录改名即换亲和，
// hash 后缀防同名词目录互串；realpath 失败降级字面路径（同一口径两次 hash 保证 key 稳定）
function projectKeyForDir(dir) {
  const fallback = String(dir || process.cwd());
  let rp = fallback;
  try { rp = fs.realpathSync(fallback); } catch { /* 不存在的路径用字面值 */ }
  return path.basename(rp).replace(/\s+/g, "") + "-" + createHash("sha1").update(rp, "utf8").digest("hex").slice(0, 6);
}

// 会话最近一次 session.created 的 cwd——工具执行期拿不到会话目录，只能事件期捕获。
// 契约测试等无宿主上下文场景 lastDir 为空 → 亲和 key 回落 "global"（中性，不污染真实项目）。
let lastDir = "";
// maintain 双触发守卫时间锚（0=从未跑过）：init 与首个 session.created 同秒双发只跑一次
let lastMaintainStart = 0;
function currentProjectKey() {
  return lastDir ? projectKeyForDir(lastDir) : "global";
}

// B7 限速计数（进程级、跨日重置）：mem_add/mem_flag 同计数（cite 不计）——
// >25/日返回串附警告；>50/日 mem_add 直写熔断转存 inbox.md（由 maintain 管线同语义摄入）
const THROTTLE_WARN = 25;
const THROTTLE_INBOX = 50;
let throttleDay = 0;
let throttleCount = 0;
function bumpThrottle(now) {
  const day = Math.floor(now / 86_400_000);
  if (day !== throttleDay) { throttleDay = day; throttleCount = 0; }
  return ++throttleCount;
}

function compiledFile() {
  if (!CONFIG_ROOT) return "";
  return path.join(CONFIG_ROOT, "GLOBAL-NOTES.md");
}

// ── C 统一锁原语（裁决三 #3）────────────────────────────────
// pid 探活：kill(pid,0) 成功或 EPERM=存活（进程在但无权限也是「在」）；其余错误按死。
function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// acquireLock：wx 原子创建（EEXIST=已有锁，绝不无条件覆盖他人锁——旧 writeFileSync 无 flag
// 会把并发写者刚拿到的锁直接踩掉）→ 读锁判定 held：新鲜（<LOCK_STALE_MS）或 pid 存活
// （排除自身 pid——同进程单线程不会真并发，自身残留即陈尸）→ held 最多 waits×400ms 退避后放弃；
// 非 held 视为陈尸：双读比对内容一致才 rm（防误删他人刚创建的新锁），rm 后回环重试 wx，
// 总尝试上限 6 防死循环。返回 true=已持锁（调用方 finally 负责释放）。
function acquireLock(lockFile, now, waits = 3) {
  const readLock = () => { try { return JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { return null; } };
  const held = (l) => {
    if (!l || typeof l.pid !== "number" || typeof l.ts !== "number") return false; // 结构异常按死
    if (l.pid === process.pid) return false;
    if (now - l.ts < LOCK_STALE_MS) return true;
    return pidAlive(l.pid);
  };
  let backoffs = waits;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: now }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") return false; // 非 EEXIST 的 IO 错误按失败，不重试
    }
    const lock = readLock();
    if (held(lock)) {
      if (backoffs-- <= 0) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      continue;
    }
    const a = readLock(), b = readLock();
    if (a && b && JSON.stringify(a) === JSON.stringify(b)) {
      try { fs.rmSync(lockFile, { force: true }); } catch { /* 删失败回环重试 */ }
    }
  }
  return false;
}

// ── B6 write-through 单写者收敛（2026-10-11 裁决 #2，最高危修复）──────────
// 并发会话各自 mem_add：各持装载时旧快照 buildCompiled → 后写者把先写者条目整体抹出编译产物。
// 收敛为临界区单写者：取锁（复用 maintain 陈尸接管+3×400ms 退避）→ 临界区内从盘重读 notes.jsonl
// 合并（不信任内存快照）→ 中性编译 → 落库+产物+injection-log，全程同一临界区。
// 返回 false = 取不到锁（调用方不落盘、转 pending 队列——旧快照落盘正是要防的覆盖）。

// 同 id 合并（2026-10-18 查漏）：旧快照不得抹掉盘上并发写入的 flag/hits/pinned。
// 合并策略：hits/lastUsed 取 max（reinforce 竞争防双计）；flags 取并集（历史不丢）；
// status 只要任一侧为 flagged 就保持 flagged——若盘上已被人工复位（status 非 flagged，
// 仅保留 flags 历史），两侧均非 flagged 时保留复位结果，不因 flags 并集重新置态；
// 其余字段（text/tags/aff/createdIn…）取 hits 较大的版本，平局内存版赢（保留本进程刚做的管线意图）。
function mergeEntries(diskEntries, memEntries) {
  const byId = new Map(diskEntries.map((e) => [e.id, e]));
  for (const e of memEntries) {
    const d = byId.get(e.id);
    if (!d) { byId.set(e.id, e); continue; }
    const base = (e.hits ?? 0) >= (d.hits ?? 0) ? e : d;
    const flags = [];
    const seen = new Set();
    for (const f of [...(d.flags ?? []), ...(e.flags ?? [])]) {
      const k = `${f?.reason ?? ""}\u0000${f?.ts ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flags.push(f);
    }
    base.hits = Math.max(e.hits ?? 0, d.hits ?? 0);
    base.lastUsed = Math.max(e.lastUsed ?? 0, d.lastUsed ?? 0);
    if (flags.length) base.flags = flags.sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0));
    if (e.status === "flagged" || d.status === "flagged") {
      base.status = "flagged";
      base.prevStatus = base.prevStatus ?? (d.status === "flagged" ? d.prevStatus : e.prevStatus);
    }
    if (e.pinned || d.pinned) base.pinned = true;
    byId.set(e.id, base);
  }
  return [...byId.values()];
}

// 临界区单写者模板：取锁 → 从盘重读 → update(disk) 返回待落盘条目 → 落库+中性编译+观测。
// 锁竞争时不落盘（旧快照覆盖是真丢数据），由调用方转 pending 队列；锁内异常向上抛，finally 释锁。
function lockedStoreUpdate(storePath, now, update) {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, "maintain.lock");
  if (!acquireLock(lockFile, now)) return { ok: false };
  try {
    const disk = loadStore(storePath).entries;
    const updated = update(disk);
    if (updated === false) return { ok: true, skipped: true }; // 校验失败：不落盘（避免无意义重写）
    const entries = updated ?? disk;
    saveStoreAtomic(storePath, entries); // 先落库：产物可由下轮 maintain 从库重造，库丢了才是真丢
    const { markdown, stats } = buildCompiled(entries, { projectKey: null }, now); // 中性：跨项目注入物不偏向当前会话项目
    const compiled = compiledFile();
    if (compiled && markdown && markdown.includes(FENCE_BEGIN) && markdown.includes(FENCE_END)) {
      writeCompiled(compiled, markdown);
    }
    try {
      fs.appendFileSync(
        path.join(dir, "injection-log.jsonl"),
        JSON.stringify(makeInjectionLogRow({ projectKey: null, slotIds: stats.slotIds, bytes: stats.bytes, evictions: stats.evictions }, now)) + "\n",
        "utf8"
      );
    } catch { /* 观测可丢 */ }
    return { ok: true, entries, stats };
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* 锁清理失败下轮陈尸接管 */ }
  }
}

function writeThroughCompile(storePath, memEntries, now) {
  try {
    return lockedStoreUpdate(storePath, now, (disk) => mergeEntries(disk, memEntries)).ok;
  } catch {
    return false;
  }
}

// 编译产物替换：写 tmp → 读回校验（非空 + 双围栏）→ 旧版拷 .prev → rename 重试。
// 与 store 落盘同一套原子语义（半写的注入文件 = 每会话静态注入损坏，契约级事故）。
function writeCompiled(file, markdown) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, markdown, "utf8");
  const back = fs.readFileSync(tmp, "utf8");
  if (!back || !back.includes(FENCE_BEGIN) || !back.includes(FENCE_END)) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    throw new Error("compiled output failed write-back validation");
  }
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.prev`); } catch { /* prev 备份失败不阻断替换 */ }
  }
  renameWithRetry(tmp, file);
}

// ── maintain：全局记忆全流程维护（内部全 try/catch，绝不向宿主抛）──────────
function maintain(now = Date.now()) {
  const dir = storeDir();
  const compiled = compiledFile();
  const report = (action, error) => {
    // 维护报告是唯一可观测面（插件工具无 UI 进度通道），/evolve 步骤 5 消费
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "maintenance-report.jsonl"),
        JSON.stringify({ ts: new Date(now).toISOString(), action, error: String(error).slice(0, 300) }) + "\n",
        "utf8"
      );
    } catch { /* 报告失败静默：报告本身绝不能成为新的故障源 */ }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // init+首事件双触发守卫（非 dirty 短路：产物新旧不构成跳过理由，10s 窗口只挡同秒双发，
    // 跨会话照常全量跑「聚合→编译→观测」）；测试用假时钟时相邻 maintain 需间隔 >10s
    if (now - lastMaintainStart < THROTTLE_MS) return;
    lastMaintainStart = now;
    // 取锁：陈尸（>90s）直接接管；新鲜锁 3×400ms 重试，仍占用 → 本轮放弃
    //（mem_add 有 inbox/pending 兜底，内容不丢，下轮会话补上）
    const lockFile = path.join(dir, "maintain.lock");
    // C：统一锁原语（wx 原子创建/探活判定/陈尸双读清退，语义见 acquireLock 注释）
    if (!acquireLock(lockFile, now)) { report("lock-skip", "另一进程持锁中（或陈尸清退未果）"); return; }
    try {
      const storePath = path.join(dir, "notes.jsonl");
      // ① legacy 一次性导入（marker 幂等）；对账失败 → 记录并跳过本会话后续（编译产物不动）
      const imp = importOnce({
        notesFile: compiled,
        parkedFile: path.join(CONFIG_ROOT, "GLOBAL-NOTES.parked.md"), // 旧机制 parked 在配置根；缺失由 importOnce 容忍（细则 h）
        storePath,
        markerFile: path.join(dir, "imported.json"),
        archiveDir: dir,
      }, now);
      if (!imp || imp.ok === false) {
        report("import-failed", `parsed=${imp?.counts?.parsed} imported=${(imp?.counts?.added ?? 0) + (imp?.counts?.reinforced ?? 0) + (imp?.counts?.skipped ?? 0)}（详见 import-report.txt）`);
        return;
      }
      // ② inbox 摄入 + legacy 围栏外区。importOnce 本轮刚成功时 skipLegacy=true：
      //    legacy 行已在 ① 全量入库，再吃一遍会让 Jaccard 强化路径把 hits 虚增一倍
      ingestSources({
        notesFile: compiled,
        inboxFile: path.join(dir, "inbox.md"),
        storePath,
        consumedFile: path.join(dir, "inbox.consumed.md"),
        skipLegacy: imp.skipped === false,
      }, now);
      // ③ pending 队列消费（限速溢出/锁竞争的兜底通道）：与 mem_add 同管线；消费后截空（截空即确认）
      const { entries } = loadStore(storePath);
      const pendingFile = path.join(dir, "pending-ops.jsonl");
      let pendingRaw = "";
      try { pendingRaw = fs.readFileSync(pendingFile, "utf8"); } catch { pendingRaw = ""; }
      if (pendingRaw.trim()) {
        const { ops } = parsePendingOps(pendingRaw);
        applyPendingOps(entries, ops, now);
        try { fs.writeFileSync(pendingFile, "", "utf8"); } catch { /* 截空失败下轮重复消费：管线幂等 */ }
      }
      // ④ 检索回流：get+cite 计分；usage-cursor.json {lastTs} 保证事件恰好消费一次
      //（裁决 #3 光标先落盘：崩溃窗口两害取其轻——先落光标后施加，崩在施加前只丢当日软指标
      //（下次 usage 事件自愈）；反过来先施加后落光标，崩在落盘前=下轮整批重放，跨日双计持久污染评分）
      const usageFile = path.join(dir, "usage.jsonl");
      const cursorFile = path.join(dir, "usage-cursor.json");
      let usageRaw = "";
      try { usageRaw = fs.readFileSync(usageFile, "utf8"); } catch { usageRaw = ""; }
      let cursor = { lastTs: 0 };
      try { cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8")) || cursor; } catch { /* 无光标=全量首跑 */ }
      const fresh = parseUsageLines(usageRaw).filter((ev) => (ev?.ts ?? 0) > (cursor.lastTs ?? 0));
      const maxTs = fresh.reduce((m, ev) => Math.max(m, ev?.ts ?? 0), cursor.lastTs ?? 0);
      try { fs.writeFileSync(cursorFile, JSON.stringify({ lastTs: maxTs }) + "\n", "utf8"); } catch { /* 光标可丢 */ }
      applyUsage(entries, fresh, now);
      // ⑤ 编译（生命周期/sid 原地更新；projectKey=会话项目，做亲和而非污染）→ 落盘
      const pk = currentProjectKey();
      const { markdown, stats } = buildCompiled(entries, {
        usageAggregatedAlready: true,
        exploreStateFile: path.join(dir, "exploreState.json"),
        projectKey: pk, // 契约测试无 lastDir → "global" 中性；write-through 才用 null
      }, now);
      saveStoreAtomic(storePath, entries);
      // 写前快照（跨日 backups/notes-YYYYMMDD.jsonl，滚动 30 代）在替换产物之前做——
      // A（裁决三 #1）：快照拍 store（真源，编译产物可重生成），快照文件名至此名实相符；
      // 失败经 out.error 上报可观测（不允许静默），不阻断主流程
      const snap = snapshotNotes({ notesFile: storePath, backupDir: path.join(dir, "backups"), keep: 30 }, now);
      if (snap?.error) report("snapshot", snap.error);
      // ⑥ 校验 + 原子替换编译产物
      if (!markdown || !markdown.includes(FENCE_BEGIN) || !markdown.includes(FENCE_END)) {
        report("compile-invalid", "编译产物为空或缺围栏，GLOBAL-NOTES.md 保持不动");
        return;
      }
      if (compiled) writeCompiled(compiled, markdown);
      // ⑦ 观测：injection-log 追加一行 + stats.json 全量重算（/evolve 步骤 5 审阅入口）
      try {
        fs.appendFileSync(
          path.join(dir, "injection-log.jsonl"),
          JSON.stringify(makeInjectionLogRow({ projectKey: pk, slotIds: stats.slotIds, bytes: stats.bytes, evictions: stats.evictions }, now)) + "\n",
          "utf8"
        );
      } catch { /* 观测可丢 */ }
      try {
        const readLog = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
        const injRows = parseUsageLines(readLog(path.join(dir, "injection-log.jsonl")));
        const searchRows = parseUsageLines(readLog(path.join(dir, "search-log.jsonl")));
        fs.writeFileSync(
          path.join(dir, "stats.json"),
          JSON.stringify(computeStats({ injectionRows: injRows, searchRows, entries }, now), null, 2) + "\n",
          "utf8"
        );
      } catch { /* stats 可丢 */ }
      // ⑧ usage 7 日轮转（更早行并入 .old；光标已保证消费位，轮转只管体量）
      try { rotateUsage(usageFile, now); } catch (e) { report("usage-rotate", e?.message ?? e); }
    } finally {
      try { fs.rmSync(path.join(dir, "maintain.lock"), { force: true }); } catch { /* 锁清理失败下轮陈尸接管 */ }
    }
  } catch (e) {
    report("maintain-error", e?.message ?? e);
  }
}

// ── agent 工具 ───────────────────────────────────────────
const MemoryStoreImpl = async ({ directory } = {}) => {
  // ⚠ 调用方契约（2026-10-11 实证）：工厂 init 的 maintain 有真实副作用——写 DATA_DIR
  // （store/观测/标记）与 CONFIG_ROOT 编译产物。install.ps1/sh 的 vE2 冒烟会以假 ctx 调用
  // 本工厂（Invoke-TsSmoke / smoke_ts_ve2 已把 XDG_DATA_HOME 指向一次性 tmp）；
  // 改动冒烟调用方时不得移除该隔离，否则部署动作会污染真实 ~/.local/share/kilo。
  // 进程启动时维护一次（有 directory 才做——契约测试等无宿主上下文的调用直接跳过；
  // 顺带捕获 cwd 作项目亲和 key，事件侧同秒双发由 maintain 内 THROTTLE_MS 守卫去重）
  if (directory) {
    try { lastDir = String(directory); maintain(Date.now()); } catch (e) { console.error(TAG, "init maintain failed:", e?.message ?? e); }
  }
  return {
    event: async (input) => {
      try {
        const ev = input?.event;
        if (!ev || ev.type !== "session.created") return;
        // B1：优先事件目录信息，兜底进程 cwd（工具执行期无会话上下文可取）
        lastDir = String(ev.properties?.info?.directory || process.cwd());
        maintain(Date.now());
      } catch { /* maintain 内部已兜底，这里双保险防事件层爆炸 */ }
    },
    tool: {
      mem_add: {
        description:
          "写入一条跨项目通用经验到全局记忆 store。管线：脱敏 → lint（<12 或 >400 字符拒收；模板/词表为提示）→ hash 精确跳过 → Jaccard≥0.85 强化 → 新增（命中外联+祈使投毒规则进隔离区）。限速：>50 条/日直写熔断转存 inbox。",
        args: {
          text: { type: "string", description: "经验正文（一行一条，建议模板「当<条件>，<动作>（原因）」）" },
          tags: {
            type: "array",
            description: "标签列表（可选，≤5 个小写词；correction/constraint 计分加权）",
            items: { type: "string" },
          },
        },
        async execute(args) {
          const text = String(args?.text ?? "").trim();
          if (!text) return "mem_add: 缺少 text 参数";
          const tags = Array.isArray(args?.tags) ? args.tags.map(String).map((t) => t.trim()).filter(Boolean) : [];
          const now = Date.now();
          const n = bumpThrottle(now);
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          // B7：>50/日熔断——原始行转存 inbox，maintain 用同一管线摄入（限速不丢内容，只降即时性）
          if (n > THROTTLE_INBOX) {
            try {
              fs.mkdirSync(storeDir(), { recursive: true });
              fs.appendFileSync(path.join(storeDir(), "inbox.md"), `- ${redactSecrets(text).replace(/\s*\n\s*/g, " ")}\n`, "utf8");
              return `已达当日直写上限（${THROTTLE_INBOX}/日），已转存 inbox.md 待 maintain 摄入`;
            } catch (e) {
              return `mem_add: 转存 inbox 失败：${String(e?.message ?? e).slice(0, 120)}`;
            }
          }
          const pk = currentProjectKey();
          const r = addWithPipeline(entries, { text, tags, date: null, source: "agent", ws: pk, createdIn: pk }, now);
          if (r.action === "rejected") {
            const msgs = r.violations.filter((v) => v.sev === "reject").map((v) => v.msg).join("；");
            return `mem_add: 拒收——${msgs}`;
          }
          // B6 write-through（单写者收敛）：成功=库+产物已在临界区落盘；取不到锁/临界区失败
          // → 不落盘（旧快照落盘会覆盖并发写者），转 pending 队列由下轮 maintain 消费兜底
          if (CONFIG_ROOT) {
            let ok = false;
            try { ok = writeThroughCompile(storePath, entries, now); } catch { ok = false; }
            if (!ok) {
              const opLine = r.action === "reinforced"
                ? { op: "reinforce", id: r.id, ts: now }
                : { op: "add", text: redactSecrets(text), tags, source: "agent", ws: pk, createdIn: pk };
              try {
                fs.mkdirSync(storeDir(), { recursive: true });
                fs.appendFileSync(path.join(storeDir(), "pending-ops.jsonl"), JSON.stringify(opLine) + "\n", "utf8");
              } catch { /* 队列可丢：丢的是即时性，正确性由下轮 maintain/mem_add 再兜 */ }
              return r.action === "reinforced"
                ? `已强化 ${r.id}（并发维护中，已排队待编译）`
                : `已排队待编译（并发维护中）`;
            }
          } else {
            saveStoreAtomic(storePath, entries); // 无 CONFIG_ROOT（降级环境）：至少保库
          }
          const warns = (r.violations ?? []).filter((v) => v.sev === "warn").map((v) => v.msg).join("；");
          const suffix = (warns ? `\n提示：${warns}` : "")
            + (n > THROTTLE_WARN ? `\n注意：当日直写已 ${n} 次（>${THROTTLE_WARN}），建议合并沉淀而非逐条追加` : "");
          if (r.action === "skip") return `已存在 ${r.id}（跳过）${suffix}`;
          if (r.action === "reinforced") {
            const e = entries.find((x) => x.id === r.id);
            return `已强化 ${r.id}（hits ${e?.hits ?? "?"}）${suffix}`;
          }
          if (r.entry?.status === "quarantine") return `新条目 ${r.id}（隔离区：命中投毒规则，待人工放行）${suffix}`;
          return `新条目 ${r.id}（试用）${suffix}`;
        },
      },
      mem_search: {
        description:
          "本地检索全局记忆 store（BM25-lite：idf 加权 + 条目评分微调；零联网零成本）。零命中返回域目录与建议词。不写 usage（浏览不计分）。",
        args: {
          query: { type: "string", description: "检索关键词（拉丁词或中文片段均可）" },
          tag: { type: "string", description: "按标签过滤（可选）" },
          limit: { type: "string", description: "返回条数上限（可选，默认 5，最大 20）" },
        },
        async execute(args) {
          const query = String(args?.query ?? "").trim();
          const tag = typeof args?.tag === "string" ? args.tag.trim() : "";
          const limit = Math.max(1, Math.min(20, Math.floor(Number(args?.limit) || 5)));
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          const total = entries.length;
          if (!total) return "mem_search: 记忆库为空（共 0 条）";
          if (!query && !tag) return `mem_search: 缺少 query 参数（库共 ${total} 条；示例 mem_search {"query":"rename EPERM"}）`;

          // BM25-lite 预备：df 一次算全（条目量千级内全扫成本可忽略，零依赖不引索引）
          const now = Date.now();
          const qTokens = [...tokenize(query)];
          const entryTokens = entries.map((e) => tokenize(e.text ?? ""));
          const df = new Map();
          for (const tokens of entryTokens) for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);

          const hits = [];
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (tag && !(e.tags ?? []).includes(tag)) continue;
            const matched = qTokens.filter((t) => entryTokens[i].has(t));
            if (qTokens.length && matched.length === 0) continue; // 词面零命中不算命中（评分加成不救场）
            let s = 0;
            for (const t of matched) s += Math.log(1 + total / Math.max(1, df.get(t) ?? 1));
            s += 0.1 * score(e, now);
            hits.push({ e, s });
          }
          hits.sort((a, b) => b.s - a.s);

          // ⑤ search-log 脱敏落盘（观测：q 经 makeSearchLogRow 脱敏截 60；零命中也记 n=0）
          try {
            fs.mkdirSync(storeDir(), { recursive: true });
            fs.appendFileSync(
              path.join(storeDir(), "search-log.jsonl"),
              JSON.stringify(makeSearchLogRow(query, Math.min(hits.length, limit), now)) + "\n",
              "utf8"
            );
          } catch { /* 观测可丢 */ }

          if (!hits.length) {
            // 零命中兜底：域目录 top8 + 计数 + 建议词（高频 tag 即库内语义地图）
            const tagCount = new Map();
            for (const e of entries) for (const t of e.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
            const top8 = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
            return [
              `命中 0 / 共 ${total} 条`,
              "域目录 top8：" + (top8.map(([t, n]) => `${t}(${n})`).join(" ") || "（库内暂无标签）"),
              "建议：换用上述标签词或更短的关键词重试；或用 mem_add 直接沉淀新经验。",
            ].join("\n");
          }
          const lines = hits.slice(0, limit).map(({ e }) => {
            const text = String(e.text ?? "");
            return `${e.id} [${(e.tags ?? []).join(",")}] hits ${e.hits ?? 0} · ${text.length > 140 ? text.slice(0, 140) + "…" : text}`;
          });
          return [`命中 ${Math.min(hits.length, limit)} / 共 ${total} 条`, ...lines].join("\n");
        },
      },
      mem_get: {
        description:
          "取回一条全局记忆的全文（≤2400 字符）与元信息；支持完整 id 或 sid 前缀/后缀短 id；本次读取写入 usage（t:get）计入条目反馈分（被读过的条目编译排序更靠前）。未命中返回邻近条目建议。",
        args: {
          id: { type: "string", description: "条目 id 或 sid（mem_search 结果行首 mXXX / [sid|…]）" },
        },
        async execute(args) {
          const id = String(args?.id ?? "").trim();
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          const now = Date.now();
          // E（裁决三 #5）：与 mem_cite/flagEntry 同走 resolveShortId（支持 sid/前缀/后缀）；
          // 先判模糊再判未命中——与 flagEntry 已修的同型分支序对齐
          const r = resolveShortId(entries, id);
          if (r && r.candidates) {
            return `模糊命中 ${r.candidates.length} 条，请用更长的 id：\n`
              + r.candidates.slice(0, 5).map((x) => `${x.id} ${x.sid ?? "?"} ${String(x.text ?? "").slice(0, 50)}`).join("\n");
          }
          const e = r?.entry;
          if (!e) {
            // 未命中：给 top-score 邻近 id 列表（而非裸报错）——检索循环不在空转处断掉
            const near = [...entries]
              .sort((a, b) => score(b, now) - score(a, now))
              .slice(0, 5)
              .map((x) => `${x.id} [${(x.tags ?? []).join(",")}] ${String(x.text ?? "").slice(0, 60)}`);
            return [`未命中 ${id || "(空 id)"}`, near.length ? `邻近条目（top-score）：\n${near.join("\n")}` : "（库为空）"].join("\n");
          }
          try { appendUsage(path.join(storeDir(), "usage.jsonl"), e.id, "get", now, currentProjectKey()); } catch { /* usage 可丢 */ }
          const text = String(e.text ?? "");
          const body = text.length > 2400 ? text.slice(0, 2400) + "…(截断)" : text;
          const meta = `── ${e.id} · [${(e.tags ?? []).join(",")}] · hits ${e.hits ?? 0} · ${e.status ?? "?"}${e.pinned ? " · pinned" : ""} · source ${e.source ?? "?"} · ${new Date(e.created ?? now).toISOString().slice(0, 10)}`;
          return [body, meta].join("\n");
        },
      },
      mem_cite: {
        description:
          "引用一条全局记忆作为依据（t:cite 计入反馈分，与 mem_get 读回同权重；支持完整 id 或 sid 前缀/后缀短 id）。",
        args: {
          id: { type: "string", description: "条目 id 或 sid（mem_search 结果行首 [sid|…] 方括号内）" },
        },
        async execute(args) {
          const id = String(args?.id ?? "").trim();
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          const r = resolveShortId(entries, id);
          // B（裁决三 #4）：先判模糊再判未命中——ambiguous 结果不带 entry，
          // 若先走 !r.entry 分支则模糊提示永不可达（与 flagEntry 已修的同型模式对齐）
          if (r && r.candidates) {
            return `模糊命中 ${r.candidates.length} 条，请用更长的 id：\n`
              + r.candidates.slice(0, 5).map((x) => `${x.id} ${x.sid ?? "?"} ${String(x.text ?? "").slice(0, 50)}`).join("\n");
          }
          if (!r || !r.entry) {
            const now = Date.now();
            const near = [...entries]
              .sort((a, b) => score(b, now) - score(a, now))
              .slice(0, 5)
              .map((x) => `${x.id} ${x.sid ?? "?"} [${(x.tags ?? []).join(",")}] ${String(x.text ?? "").slice(0, 60)}`);
            return [`未命中 ${id || "(空 id)"}（cite 未计分）`, near.length ? `邻近条目：\n${near.join("\n")}` : "（库为空）"].join("\n");
          }
          const e = r.entry;
          try { appendUsage(path.join(storeDir(), "usage.jsonl"), e.id, "cite", Date.now(), currentProjectKey()); } catch { /* usage 可丢 */ }
          const text = String(e.text ?? "");
          return `已引用 ${e.id}（sid ${e.sid ?? "?"}）· ${text.length > 160 ? text.slice(0, 160) + "…" : text}`;
        },
      },
      mem_flag: {
        description:
          "标记一条可疑/过期记忆进入人工复审（flagged 不再编译注入；理由 4–200 字符；单条上限 3 次，全库在审上限 10 条；复位走 /evolve 步骤 5）。",
        args: {
          id: { type: "string", description: "条目 id 或 sid" },
          reason: { type: "string", description: "标记理由（4–200 字符，写清错在哪/为什么可疑）" },
        },
        async execute(args) {
          bumpThrottle(Date.now()); // flag 同限速计数（防用 flag 刷配额）
          const id = String(args?.id ?? "").trim();
          // 理由可能引用含密钥的原文，先脱敏再校验长度/落盘
          const reason = redactSecrets(String(args?.reason ?? "")).trim();
          if (!id || !reason) return "mem_flag: 需要 id 与 reason 参数";
          const now = Date.now();
          const storePath = path.join(storeDir(), "notes.jsonl");
          let r = null;
          if (CONFIG_ROOT) {
            // 与 mem_add 同一临界区：取锁→盘上重读→flag→落库+重编译（flagged 立即从注入物消失）。
            // 不持锁裸写会被 maintain/mem_add 的旧快照回写抹掉；取不到锁转 pending 队列（同 flag 语义）。
            let locked;
            try {
              locked = lockedStoreUpdate(storePath, now, (disk) => {
                r = flagEntry(disk, { id, reason }, now);
                return r.ok ? disk : false;
              });
            } catch {
              locked = { ok: false };
            }
            if (!locked.ok) {
              try {
                fs.mkdirSync(storeDir(), { recursive: true });
                fs.appendFileSync(path.join(storeDir(), "pending-ops.jsonl"), JSON.stringify({ op: "flag", id, reason }) + "\n", "utf8");
                return `mem_flag: 并发维护中，已排队待处理（${id}）`;
              } catch (e) {
                return `mem_flag: 排队失败：${String(e?.message ?? e).slice(0, 120)}`;
              }
            }
          } else {
            const { entries } = loadStore(storePath);
            r = flagEntry(entries, { id, reason }, now);
            if (r.ok) saveStoreAtomic(storePath, entries);
          }
          if (!r?.ok) {
            const why = {
              "not-found": "未命中该 id",
              "ambiguous": "id 模糊命中多条，请用更长 id",
              "reason-length": "理由长度需 4–200 字符",
              "duplicate": "该条已有相同理由的 flag（幂等跳过）",
              "flag-capped": "该条 flags 已达 3 次上限",
              "flag-pool-full": "全库在审（flagged）已达 10 条上限，先处理存量",
            }[r?.code] ?? r?.code;
            return `mem_flag: 未执行——${why}`;
          }
          return `已标记 ${r.id} 进入人工复审（第 ${r.flags}/3 次 flag）`;
        },
      },
    },
  };
};

// never-throw 包装（2026-09-22 契约）：工厂抛错 → 插件注册表留洞 → provider 列表级联全挂
export const MemoryStore = async (ctx = {}) => {
  try {
    return await MemoryStoreImpl(ctx);
  } catch (e) {
    console.error(TAG, "init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};

// Kilo vE2 契约：工具函数经 _export 命名空间暴露给离线测试（scripts/test-memory-store.mjs）——
// 对象无 server 属性，kE2 跳过，绝不会被当工厂调用。
export const _export = {
  FENCE_BEGIN, FENCE_END,
  resolveConfigRoot, maintain, writeCompiled,
  THROTTLE_MS, LOCK_STALE_MS, USAGE_ROTATE_KEEP,
  projectKeyForDir, THROTTLE_WARN, THROTTLE_INBOX,
  pidAlive, acquireLock, // C：统一锁原语（离线测试用）
  mergeEntries, lockedStoreUpdate, // B6：单写者合并策略（离线测试用）
  // lib 纯函数直通（离线测试主入口走这里；bundle 单入口把 lib+plugin 一并带出）
  tokenize, jaccard, parseLessonLines, extractUnfenced, isLineInFence,
  normalizeText, hashText, makeId, redactSecrets, maskValue, BASIC_TAGS, lintEntry, isQuarantineCandidate,
  loadStore, saveStoreAtomic, renameWithRetry, appendCorruptUnique,
  addOrReinforce, addWithPipeline, flagEntry, parsePendingOps, applyPendingOps,
  assignSid, ensureSids, resolveShortId,
  applyUsage, parseUsageLines, appendUsage, rotateUsage,
  score, density, estTokens, bumpAffinity, projAffinity, effectiveScore, buildCompiled, recalcLifecycle,
  ingestSources, importOnce,
  makeInjectionLogRow, makeSearchLogRow, snapshotNotes, computeStats,
};
