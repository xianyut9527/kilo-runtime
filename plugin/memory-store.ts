// 全局记忆 store 插件壳：把 lib/memory-store.ts 的纯逻辑装配成 Kilo 插件——
// maintain 自动维护（legacy 一次性导入 → inbox 摄入 → usage 回流 → 评分编译 → 原子替换
// GLOBAL-NOTES.md）+ 三个 agent 工具（mem_add / mem_search / mem_get）。
// 分层理由：lib 层无宿主依赖可离线全测；本壳只做路径解析/锁/报告/工具返回串，绝不实现算法。
// 全局层由本插件编译管理后，memory-bootstrap 的 4KB 封顶/模板自愈已移除（双写会打架）。
//
// 契约同 moa/quality-gate（2026-09-22 钉死）：唯一函数导出工厂 + _export 命名空间对象；
// 工厂 never-throw；工具 execute 一律 async 返回 string；本插件不联网、不调 loadCfg，
// 任何环境空参调用都能 resolve（test-plugin-contract.mjs 会空参直调）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../lib/hx-client";
import {
  FENCE_BEGIN, FENCE_END,
  loadStore, saveStoreAtomic, renameWithRetry,
  addOrReinforce, applyUsage, parseUsageLines, appendUsage,
  score, density, tokenize, jaccard, parseLessonLines, extractUnfenced, isLineInFence,
  buildCompiled, recalcLifecycle, ingestSources, importOnce,
  normalizeText, hashText, makeId, redactSecrets,
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

function compiledFile() {
  if (!CONFIG_ROOT) return "";
  return path.join(CONFIG_ROOT, "GLOBAL-NOTES.md");
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
    // 节流：编译产物刚写过（<10s）说明本会话链路刚维护过，直接跳过
    if (compiled) {
      const st = fs.statSync(compiled, { throwIfNoEntry: false });
      if (st && now - st.mtimeMs < THROTTLE_MS) return;
    }
    // 取锁：陈尸（>90s）直接接管；新鲜锁重试一次 500ms，仍占用 → 跳过并记录
    const lockFile = path.join(dir, "maintain.lock");
    const readLock = () => {
      try { return JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { return null; }
    };
    const held = (l) => l && typeof l.ts === "number" && now - l.ts < LOCK_STALE_MS;
    let lock = readLock();
    if (held(lock)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      lock = readLock();
      if (held(lock)) { report("lock-skip", `另一进程 pid=${lock?.pid} 持锁中`); return; }
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: now }), "utf8");
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
      // ③ 检索回流：usage.jsonl 只消费 t:"get" 事件（search 浏览不计分，防热条目自证循环）
      const usageFile = path.join(dir, "usage.jsonl");
      let usageRaw = "";
      try { usageRaw = fs.readFileSync(usageFile, "utf8"); } catch { usageRaw = ""; }
      const { entries } = loadStore(storePath);
      applyUsage(entries, parseUsageLines(usageRaw), now);
      // ④ 编译（生命周期重算在编译内原地更新 status）→ 落盘 → 轮转 usage。
      //    落盘必须在轮转前：hits 只存在于 store，usage 行轮转后不重放（恰好一次语义）
      const { markdown } = buildCompiled(entries, {
        usageAggregatedAlready: true, // 兼容标记：hits 已在上方 applyUsage 预写入 entries
        exploreStateFile: path.join(dir, "exploreState.json"),
      }, now);
      saveStoreAtomic(storePath, entries);
      try {
        if (fs.existsSync(usageFile)) {
          // rename 覆盖旧 .1（libuv Windows 走 MoveFileExW+REPLACE_EXISTING，实测成立）
          fs.renameSync(usageFile, `${usageFile}.${USAGE_ROTATE_KEEP}`);
        }
      } catch (e) { report("usage-rotate", e?.message ?? e); /* 轮转失败只影响体量，不影响正确性 */ }
      // ⑤ 校验 + 原子替换编译产物
      if (!markdown || !markdown.includes(FENCE_BEGIN) || !markdown.includes(FENCE_END)) {
        report("compile-invalid", "编译产物为空或缺围栏，GLOBAL-NOTES.md 保持不动");
        return;
      }
      if (compiled) writeCompiled(compiled, markdown);
    } finally {
      try { fs.rmSync(path.join(dir, "maintain.lock"), { force: true }); } catch { /* 锁清理失败下轮陈尸接管 */ }
    }
  } catch (e) {
    report("maintain-error", e?.message ?? e);
  }
}

// ── agent 工具 ───────────────────────────────────────────
const MemoryStoreImpl = async ({ directory } = {}) => {
  // 进程启动时维护一次（有 directory 才做——契约测试等无宿主上下文的调用直接跳过）
  if (directory) {
    try { maintain(Date.now()); } catch (e) { console.error(TAG, "init maintain failed:", e?.message ?? e); }
  }
  return {
    event: async (input) => {
      try {
        const ev = input?.event;
        if (!ev || ev.type !== "session.created") return;
        maintain(Date.now());
      } catch { /* maintain 内部已兜底，这里双保险防事件层爆炸 */ }
    },
    tool: {
      mem_add: {
        description:
          "写入一条跨项目通用经验到全局记忆 store（自动脱敏 + 去重：hash 精确命中跳过，Jaccard≥0.85 近似命中强化计分不新增占位）。替代旧 GLOBAL-NOTES.md 手工追加。",
        args: {
          text: { type: "string", description: "经验正文（一行一条，建议带结论与可复现要点）" },
          tags: {
            type: "array",
            description: "标签列表（可选，如 [\"gateway\",\"correction\"]；correction/constraint 标签计分加权）",
            items: { type: "string" },
          },
        },
        async execute(args) {
          const text = String(args?.text ?? "").trim();
          if (!text) return "mem_add: 缺少 text 参数";
          const tags = Array.isArray(args?.tags) ? args.tags.map(String).map((t) => t.trim()).filter(Boolean) : [];
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          const r = addOrReinforce(entries, { text, tags, date: null, source: "agent" }, Date.now());
          saveStoreAtomic(storePath, entries); // 立即落盘（skip 分支重写同内容，无害保幂等）
          if (r.action === "skip") return `已存在 ${r.id}（跳过）`;
          if (r.action === "reinforced") {
            const e = entries.find((x) => x.id === r.id);
            return `已强化 ${r.id}（hits ${e?.hits ?? "?"}）`;
          }
          return `新条目 ${r.id}（试用）`;
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
          "取回一条全局记忆的全文（≤2400 字符）与元信息；本次读取写入 usage（t:get）计入条目反馈分（被读过的条目编译排序更靠前）。未命中返回邻近条目建议。",
        args: {
          id: { type: "string", description: "条目 id（mem_search 结果行首的 mXXX）" },
        },
        async execute(args) {
          const id = String(args?.id ?? "").trim();
          const storePath = path.join(storeDir(), "notes.jsonl");
          const { entries } = loadStore(storePath);
          const e = entries.find((x) => x.id === id);
          const now = Date.now();
          if (!e) {
            // 未命中：给 top-score 邻近 id 列表（而非裸报错）——检索循环不在空转处断掉
            const near = [...entries]
              .sort((a, b) => score(b, now) - score(a, now))
              .slice(0, 5)
              .map((x) => `${x.id} [${(x.tags ?? []).join(",")}] ${String(x.text ?? "").slice(0, 60)}`);
            return [`未命中 ${id || "(空 id)"}`, near.length ? `邻近条目（top-score）：\n${near.join("\n")}` : "（库为空）"].join("\n");
          }
          try { appendUsage(path.join(storeDir(), "usage.jsonl"), e.id, "get", now); } catch { /* usage 可丢 */ }
          const text = String(e.text ?? "");
          const body = text.length > 2400 ? text.slice(0, 2400) + "…(截断)" : text;
          const meta = `── ${e.id} · [${(e.tags ?? []).join(",")}] · hits ${e.hits ?? 0} · ${e.status ?? "?"}${e.pinned ? " · pinned" : ""} · source ${e.source ?? "?"} · ${new Date(e.created ?? now).toISOString().slice(0, 10)}`;
          return [body, meta].join("\n");
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
  // lib 纯函数直通（离线测试主入口走这里）
  tokenize, jaccard, parseLessonLines, extractUnfenced, isLineInFence,
  normalizeText, hashText, makeId, redactSecrets,
  loadStore, saveStoreAtomic, renameWithRetry,
  addOrReinforce, applyUsage, parseUsageLines, appendUsage,
  score, density, buildCompiled, recalcLifecycle,
  ingestSources, importOnce,
};
