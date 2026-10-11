// 全局记忆 store：无界条目库（JSONL）+ 评分编译快照（GLOBAL-NOTES.md）+ 检索/回流 + 写路径去重。
// 背景（2026-10-11 记忆核心闭环改造）：旧机制 GLOBAL-NOTES.md 4096B FIFO 封顶裁最旧 →
// parked 只进不出（实测 3.5KB 活 / 17.5KB parked，教训只丢不涨）。本模块替换为：
// store 无界持久（notes.jsonl）、编译快照按评分入槽（精选/试用/探索 + 域目录）、
// mem_get 检索事件回流计分、写入路径 hash 精确 + Jaccard 近似双重去重；
// 零 LLM 依赖、零新 npm 依赖（纯 node 内置 crypto/fs/path）。
//
// 纯逻辑层约定：模块加载期无副作用；除编译产物围栏常量外，全部函数接收显式路径与
// now 参数（便于离线测试注入假时钟）。fs 一律用 node:fs 同步 API（细则 i：插件壳与
// lib 均可同步，插件工具契约只要求 execute 返回 Promise<string>）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── 编译围栏 ─────────────────────────────────────────────
// 编译产物中由本模块管理的区域用 HTML 注释围栏标定：ingest/再摄入路径对围栏内整块跳过，
// 防止「编译产物 → 被当教训再摄入 → 计分自强化」的正反馈回路（图纸审查必须项）。
export const FENCE_BEGIN = "<!-- KILO-MEMORY-COMPILED:BEGIN -->";
export const FENCE_END = "<!-- KILO-MEMORY-COMPILED:END -->";

const DAY_MS = 86_400_000;

// ── 分词 / 相似度（去重与检索共用）────────────────────────
// 拉丁词取小写、长度 ≥2（单字符噪声太大）；CJK 无空格边界，取相邻二字 bigram
// （单字 run 无 bigram 可取，降级取单字，否则整个 CJK run 为 0 token 会漏检）。
export function tokenize(s) {
  const text = String(s ?? "").toLowerCase();
  const out = new Set();
  for (const w of text.match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= 2) out.add(w);
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// token 集 Jaccard 相似度 ∈ [0,1]；空集按 0 处理（避免 0/0 NaN 把空串判成全同）
export function jaccard(a, b) {
  const A = a instanceof Set ? a : tokenize(a);
  const B = b instanceof Set ? b : tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── 教训行解析 ───────────────────────────────────────────
// 支持：`- YYYY-MM-DD text`、`- YYYY-MM-DD/DD text`（真机存在 10-10/11 跨日写法）、
// `- [tag1,tag2] text`、`- [tag] YYYY-MM-DD text` 及 tags/date 前缀互换的组合。
// 注释（<!--）、标题（#）、空行跳过；编译围栏区整块跳过；CRLF 兼容。
// 退化行（`- ` 前缀后无正文）不产出条目——importOnce 靠「原始 `- ` 行数 vs 解析产出数」
// 的差值暴露这类行，作为对账失败信号。
const LESSON_TAG_PREFIX = /^\[([^\][\n]*)\]\s*/;
const LESSON_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:\/\d{1,2})?(?:\s+|$)/;

export function parseLessonLines(text) {
  const lessons = [];
  let inFence = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes(FENCE_BEGIN)) { inFence = true; continue; }
    if (line.includes(FENCE_END)) { inFence = false; continue; }
    if (inFence) continue;
    if (!line.startsWith("- ")) continue;
    if (!line || line.startsWith("#") || line.startsWith("<!--")) continue;
    let rest = line.slice(2);
    let date = null;
    let tags = [];
    // tags/date 前缀最多各出现一次、顺序不限：两轮循环逐个剥前缀（「及组合」口径）
    for (let k = 0; k < 2; k++) {
      if (tags.length === 0) {
        const m = rest.match(LESSON_TAG_PREFIX);
        if (m) {
          tags = m[1].split(/[,，]/).map((t) => t.trim()).filter(Boolean);
          rest = rest.slice(m[0].length);
          continue;
        }
      }
      if (date === null) {
        const m = rest.match(LESSON_DATE_PREFIX);
        if (m) {
          date = m[1];
          rest = rest.slice(m[0].length);
          continue;
        }
      }
      break;
    }
    const body = rest.trim();
    if (!body) continue; // 退化行：有 `- ` 前缀无正文，不产出（对账时现形）
    lessons.push({ date, tags, text: body });
  }
  return lessons;
}

// 围栏状态判定：从行 0 扫到 idx（围栏标记行自身按「进入/退出围栏」计）。
// 单独导出是为让测试可以按行号断言；extractUnfenced 内部走同语义单遍扫描。
export function isLineInFence(lines, idx) {
  let inFence = false;
  for (let i = 0; i <= idx && i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(FENCE_BEGIN)) inFence = true;
    else if (line.includes(FENCE_END)) inFence = false;
  }
  return inFence;
}

// 剔除围栏区（含围栏标记行），返回围栏外文本。编译产物的头两行在围栏外，
// 但不含任何 `- ` 行——parseLessonLines(extractUnfenced(编译产物)) 恒为空，
// 这就是「编译产物再摄入零吸收」的机械保证。
export function extractUnfenced(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.includes(FENCE_BEGIN)) { inFence = true; continue; }
    if (line.includes(FENCE_END)) { inFence = false; continue; }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

// ── store 条目原语 ───────────────────────────────────────
// hash 归一化口径：trim + 连续空白折叠为单空格（细则 d）——同文异排（换行/双空格）
// 视为同一条，去重不误伤。
export function normalizeText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

export function hashText(text) {
  return createHash("sha1").update(normalizeText(text), "utf8").digest("hex").slice(0, 16);
}

// id：m<base36 now>-<rand4>——稳定（无冒号/空格，文件名/检索行友好）；随机后缀防同毫秒碰撞
export function makeId(now) {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `m${Number(now).toString(36)}-${rand}`;
}

// 写路径脱敏：sk- 密钥与 eyJ 开头的 JWT 同式打码（只留前缀证明类型，全文不可回收）。
// 在 hash 之前执行——两条只差密钥的文本归并为同一条，密钥值永不入库。
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, "eyJ***");
}

// JSONL 读：坏行跳过并计数（返回 {entries, badLines}）——手改/半写文件不炸整库
export function loadStore(file) {
  const entries = [];
  let badLines = 0;
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { entries, badLines }; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.id === "string" && typeof e.text === "string") entries.push(e);
      else badLines++;
    } catch { badLines++; }
  }
  return { entries, badLines };
}

const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]); // Windows rename 占用类错误（细则 f）

// 同步 sleep（rename 重试用）：Atomics.wait 阻塞当前线程且不烧 CPU busy loop
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// rename 重试（EPERM/EACCES/EBUSY 120ms×3）：Windows 上目标文件被杀软/索引器短暂
// 占用时 MoveFileEx 偶发 EPERM，重试窗口内几乎必然恢复；仍失败向上抛（由调用方
// 捕获写维护报告——插件壳 never-throw，绝不进宿主）。
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt < 3 && RENAME_RETRYABLE.has(e?.code)) { sleepSync(120); continue; }
      throw e;
    }
  }
}

// 原子落盘：写 file.tmp-<pid> → 旧文件先拷 .prev（存在才拷，回滚锚点）→ rename 重试。
// 不做「先删再写」——rename 原子性保证读者永远看到完整文件（半写文件是契约级事故）。
export function saveStoreAtomic(file, entries) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const payload = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  fs.writeFileSync(tmp, payload, "utf8");
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.prev`); } catch { /* prev 备份失败不阻断主写入 */ }
  }
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    throw e;
  }
}

// ── 写路径去重 / 强化 ────────────────────────────────────
// ① hash 精确命中 → skip（计分不动，防重放虚增）；
// ② Jaccard ≥0.85 → 强化（hits+1、lastUsed=now，不新增占位）；
// ③ 否则新增 trial 条目。created 优先用教训自带日期（legacy 导入的旧条目生命年龄才对）。
export function addOrReinforce(entries, { text, tags, date, source }, now) {
  const clean = normalizeText(redactSecrets(String(text ?? "")));
  const hash = createHash("sha1").update(clean, "utf8").digest("hex").slice(0, 16);
  const exact = entries.find((e) => e.hash === hash);
  if (exact) return { action: "skip", id: exact.id };

  const tokens = tokenize(clean);
  let best = null;
  let bestJ = 0;
  for (const e of entries) {
    const j = jaccard(tokens, tokenize(e.text ?? ""));
    if (j > bestJ) { bestJ = j; best = e; }
  }
  if (best && bestJ >= 0.85) {
    best.hits = (best.hits ?? 0) + 1;
    best.lastUsed = now;
    return { action: "reinforced", id: best.id };
  }

  const created = date && Number.isFinite(Date.parse(date)) ? Date.parse(date) : now;
  const entry = {
    id: makeId(now),
    text: clean,
    hash,
    tags: Array.isArray(tags) ? tags.map(String).map((t) => t.trim()).filter(Boolean) : [],
    created,
    lastUsed: created,
    hits: 0,
    source: String(source ?? "agent"),
    status: "trial",
    pinned: false,
  };
  entries.push(entry);
  return { action: "added", id: entry.id };
}

// ── 检索回流 ─────────────────────────────────────────────
// usage 事件仅消费 t:"get"（mem_get 的全文读取才是「真的用上了」；search 是浏览不计分，
// 否则每次检索都在强化命中项 → 热条目永生、冷条目永死的自证循环）。
export function applyUsage(entries, usageEvents, now) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  let applied = 0;
  for (const ev of usageEvents) {
    if (!ev || ev.t !== "get") continue;
    const e = byId.get(ev.id);
    if (!e) continue;
    e.hits = (e.hits ?? 0) + 1;
    e.lastUsed = now;
    applied++;
  }
  return applied;
}

export function parseUsageLines(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* 坏行跳过：usage 是可丢数据 */ }
  }
  return events;
}

export function appendUsage(file, id, type, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ t: type, id, ts: now }) + "\n", "utf8");
}

// ── 评分 ─────────────────────────────────────────────────
// pinned 1000（人工标记绝对优先）+ hits 对数（重复有用性，边际递减）+ 新近使用
// （45d 半衰期）+ 新条目保护分（14d 内 +1，给 trial 一个进精选的窗口）+
// correction/constraint 标签加权（被纠正过的教训价值更高）。
export function score(entry, now) {
  const hits = entry.hits ?? 0;
  const created = entry.created ?? now;
  const lastUsed = entry.lastUsed ?? created; // 缺省锚 created（从未用过的条目以年龄计衰减）
  const sinceUseDays = Math.max(0, (now - lastUsed) / DAY_MS);
  const ageDays = Math.max(0, (now - created) / DAY_MS);
  return (entry.pinned ? 1000 : 0)
    + 2.2 * Math.log(1 + hits)
    + 1.5 * (1 / (1 + sinceUseDays / 45))
    + (ageDays < 14 ? 1 : 0)
    + (/correction|constraint/i.test((entry.tags ?? []).join(",")) ? 0.6 : 0);
}

// 密度 = score / ceil(chars/60)：60 字一档的行成本归一——同样分数的短条目排前
//（注入预算是稀缺资源，一行 20 字的高分教训比一行 400 字的更值得占位）
export function density(entry, now) {
  return score(entry, now) / Math.max(1, Math.ceil(String(entry.text ?? "").length / 60));
}

// ── 编译 ─────────────────────────────────────────────────
// 槽位互斥裁定（图纸歧义，报告记录）：精选池 = active+trial，但已被试用/探索槽选中的
// 条目不再进精选（每条最多出现一次，预算不重复燃烧）；pinned 条目不进试用/探索槽
// （「pinned 在精选置顶」优先级更高）。
const BUDGET = {
  header: 200,       // 围栏外头两行
  domain: 320,       // 域目录行
  domainTags: 12,    // 域目录 tag 数上限
  domainTagChars: 12, // 单个 tag 名截断
  curated: 2200,     // 精选正文（pinned 豁免字符预算，见 renderLine 传参）
  trial: 360,        // 试用正文
  trialCount: 3,
  explore: 300,      // 探索正文
  exploreCount: 1,
  pinnedDisplay: 500, // pinned 展示截断
  hardBytes: 10240,  // UTF-8 字节硬顶（每会话注入体量红线）
};
const COMPILED_HEADER = "# Global Memory（编译产物 · 勿手工编辑）";
const COMPILED_NOTE = "<!-- 由 memory-store 插件自动生成：追加经验请写入 inbox 或用 mem_add；检索用 mem_search/mem_get。 -->";

function sha1hex(s) {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function renderLine(entry, textMax) {
  const tags = entry.tags ?? [];
  const prefix = tags.length ? `[${tags.join(",")}] ` : "";
  const body = truncate(String(entry.text ?? ""), textMax);
  return { line: `- ${prefix}${body}`, truncated: body.length < String(entry.text ?? "").length };
}

// 整行长度受限的渲染（试用/探索小预算槽用）：把行上限换算成正文截断上限，
// 保证「首条必现」策略下截断后的行仍不越槽位预算。
function renderLineWithin(entry, maxLine) {
  const tags = entry.tags ?? [];
  const prefix = tags.length ? `[${tags.join(",")}] ` : "";
  const textMax = Math.max(1, maxLine - 2 - prefix.length - 1);
  return renderLine(entry, textMax).line;
}

// 探索槽选取：候选（hits==0 且 age≥14d 且非 pinned）按 sha1(`${id}:${day}`) 确定性排序取首个；
// exploreStateFile 记 {day, id}：同日且 id 仍有效 → 复用（同日多次编译不换槽，注入内容稳定）。
// day=floor(now/86400000) UTC。状态读写失败降级为「无状态」——探索槽是可丢数据。
function pickExplore(candidates, stateFile, now) {
  const day = Math.floor(now / DAY_MS);
  const valid = new Set(candidates.map((c) => c.id));
  let prev = null;
  try {
    if (stateFile) prev = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch { prev = null; }
  if (prev && prev.day === day && typeof prev.id === "string" && valid.has(prev.id)) {
    return { id: prev.id, state: prev };
  }
  const sorted = [...candidates].sort((a, b) => (sha1hex(`${a.id}:${day}`) < sha1hex(`${b.id}:${day}`) ? -1 : 1));
  const id = sorted[0]?.id ?? null;
  const state = id ? { day, id } : null;
  if (state && stateFile) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state) + "\n", "utf8");
    } catch { /* 持久化失败降级为内存态，编译不受阻 */ }
  }
  return { id, state };
}

// 生命周期重算（编译时做，原地改 entry.status 供调用方落盘）：
// trial→active（被读过或满 14d）；active→archived（180d 零命中且非 pinned）。
export function recalcLifecycle(entries, now) {
  for (const e of entries) {
    const age = (now - (e.created ?? now)) / DAY_MS;
    if (e.status === "trial" && ((e.hits ?? 0) > 0 || age >= 14)) e.status = "active";
    if (e.status === "active" && (e.hits ?? 0) === 0 && age > 180 && !e.pinned) e.status = "archived";
  }
}

// 编译主函数。opts.usageAggregatedAlready 为兼容标记（编译函数自身绝不应用 usage 事件——
// hits 由 applyUsage 预先写入 entries，这里只读）；opts.exploreStateFile 供探索槽状态持久化。
// 返回 {markdown, stats}；entries 的 status 已原地更新，调用方须 saveStoreAtomic 落盘。
export function buildCompiled(entries, opts = {}, now = Date.now()) {
  recalcLifecycle(entries, now);

  // 探索槽先选（后续槽位互斥要用它的 id）
  const exploreCandidates = entries.filter((e) =>
    !e.pinned
    && (e.status === "active" || e.status === "archived")
    && (e.hits ?? 0) === 0
    && (now - (e.created ?? now)) / DAY_MS >= 14
  );
  const explore = pickExplore(exploreCandidates, opts.exploreStateFile, now);

  // 试用槽：top-3 trial 按 score（pinned 不进试用槽）；首条必现（超预算截到槽内），
  // 否则一条 400 字的新条目会让整个试用段空转
  const trialPool = entries
    .filter((e) => e.status === "trial" && !e.pinned)
    .sort((a, b) => score(b, now) - score(a, now) || (a.created ?? 0) - (b.created ?? 0));
  const trialLines = [];
  let trialChars = 0;
  for (const e of trialPool) {
    if (trialLines.length >= BUDGET.trialCount) break;
    let line = renderLineWithin(e, 500);
    if (trialChars + line.length > BUDGET.trial) {
      if (trialLines.length > 0) break;
      line = renderLineWithin(e, BUDGET.trial);
    }
    trialChars += line.length;
    trialLines.push({ entry: e, line });
  }
  const excludeIds = new Set([...trialLines.map((t) => t.entry.id), ...(explore.id ? [explore.id] : [])]);

  // 精选槽：active+trial，pinned 置顶，其余按密度（短高分先行）
  const curatedPool = entries
    .filter((e) => (e.status === "active" || e.status === "trial") && !excludeIds.has(e.id))
    .sort((a, b) =>
      ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      || (density(b, now) - density(a, now))
      || (score(b, now) - score(a, now))
      || ((a.created ?? 0) - (b.created ?? 0))
    );
  const curatedLines = [];
  let curatedChars = 0;
  for (const e of curatedPool) {
    const { line } = renderLine(e, e.pinned ? BUDGET.pinnedDisplay : 500);
    if (!e.pinned && curatedChars + line.length > BUDGET.curated) break; // 非 pinned 受 2200 配额约束
    if (!e.pinned) curatedChars += line.length; // pinned 豁免配额（「可越字符预算」口径：不挤占非 pinned 空间）
    curatedLines.push({ entry: e, line, pinned: !!e.pinned });
  }

  // 域目录：top12 tag（名截 12 字符），超 320 从尾丢 tag；N=全库条数（域目录是全库索引）
  const tagCount = new Map();
  for (const e of entries) for (const t of e.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const topTags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, BUDGET.domainTags)
    .map(([t, n]) => [t.length > BUDGET.domainTagChars ? t.slice(0, BUDGET.domainTagChars) : t, n]);
  let domainLine = "";
  for (let keep = topTags.length; ; keep--) {
    const body = topTags.slice(0, keep).map(([t, n]) => `${t}(${n})`).join(" ");
    domainLine = `[${body}] 共 ${entries.length} 条 · mem_search "<关键词>" 检索全部`;
    if (domainLine.length <= BUDGET.domain || keep === 0) break;
  }

  // 组装 + 字节硬顶：超限按 探索 → 试用（score 升序） → 精选（score 升序）整体剔除整条，
  // 最后兜底截域目录行/头注释。pinned score≥1000 天然最后被剔除（不得越字节硬顶）。
  let noteLine = COMPILED_NOTE;
  const assemble = () => {
    const lines = [COMPILED_HEADER, noteLine, FENCE_BEGIN, "## 域目录", domainLine];
    if (curatedLines.length) { lines.push("## 精选", ...curatedLines.map((c) => c.line)); }
    if (trialLines.length) { lines.push("## 试用", ...trialLines.map((t) => t.line)); }
    if (explore.id) {
      const e = entries.find((x) => x.id === explore.id);
      if (e) { lines.push("## 探索", renderLineWithin(e, BUDGET.explore)); }
    }
    lines.push(FENCE_END);
    return lines.join("\n") + "\n";
  };
  let markdown = assemble();
  const dropScore = (ref) => score(ref.entry, now);
  while (Buffer.byteLength(markdown, "utf8") > BUDGET.hardBytes) {
    if (explore.id) { explore.id = null; }
    else if (trialLines.length) { trialLines.sort((a, b) => dropScore(a) - dropScore(b)).shift(); }
    else if (curatedLines.length) { curatedLines.sort((a, b) => dropScore(a) - dropScore(b)).shift(); }
    else if (domainLine.length > 80) { domainLine = truncate(domainLine, Math.floor(domainLine.length / 2)); }
    else if (noteLine.length > 40) { noteLine = truncate(noteLine, 40); }
    else break;
    markdown = assemble();
  }
  // 兜底极端：全条目剔光仍超（理论不可达，单条 10240B 之上才有此态）→ 硬截全产物保围栏
  if (Buffer.byteLength(markdown, "utf8") > BUDGET.hardBytes) {
    markdown = `${COMPILED_HEADER}\n${COMPILED_NOTE}\n${FENCE_BEGIN}\n${FENCE_END}\n`;
  }

  const stats = {
    total: entries.length,
    curated: curatedLines.length,
    trial: trialLines.length,
    explore: explore.id ? 1 : 0,
    domainTags: topTags.length,
    bytes: Buffer.byteLength(markdown, "utf8"),
    exploreId: explore.id ?? null,
    exploreState: explore.state ?? null,
    usageAggregatedAlready: !!opts.usageAggregatedAlready,
  };
  return { markdown, stats };
}

// ── 摄入 ─────────────────────────────────────────────────
function readIfExists(file) {
  if (!file) return "";
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// 常规摄入：inbox（agent 兜底写通道）+ legacy notes 围栏外区（skipLegacy 控制）。
// 成功消费的 inbox 原始行追加到 consumed（带时间戳头，审计可回溯）后把 inbox 截空——
// 「截空即确认」，下次写入不会重复消费。store 仅在有实际变更时落盘（纯 skip 不写）。
export function ingestSources({ notesFile, inboxFile, storePath, consumedFile, skipLegacy }, now) {
  const counts = { added: 0, reinforced: 0, skipped: 0, consumed: 0 };

  const applyLessons = (lessons, source) => {
    const { entries } = loadStore(storePath);
    for (const l of lessons) {
      const r = addOrReinforce(entries, { text: l.text, tags: l.tags, date: l.date, source }, now);
      // 动作名 "skip" ↔ 计数字段 "skipped"（直用 r.action 当键会静默长出 NaN 野键、对账必差）
      counts[r.action === "skip" ? "skipped" : r.action]++;
    }
    if (counts.added || counts.reinforced) saveStoreAtomic(storePath, entries);
  };

  // ① inbox：解析产出条数与消费行数分开记——解析失败的行留在截空前只存在于 consumed 之外，
  //    但 inbox 仍截空（half-baked 行不值得无限重试；consumed 头注释里有时间戳可对账）
  const inboxRaw = readIfExists(inboxFile);
  if (inboxRaw.trim()) {
    const lessons = parseLessonLines(inboxRaw);
    const consumedLines = inboxRaw.split(/\r?\n/).filter((l) => l.trim().startsWith("- "));
    if (consumedLines.length) {
      try {
        fs.mkdirSync(path.dirname(consumedFile), { recursive: true });
        fs.appendFileSync(
          consumedFile,
          `\n<!-- consumed ${new Date(now).toISOString()} -->\n${consumedLines.join("\n")}\n`,
          "utf8"
        );
      } catch { /* consumed 审计失败不阻断消费主流程 */ }
    }
    counts.consumed = consumedLines.length;
    fs.writeFileSync(inboxFile, "", "utf8"); // 截空（消费确认）
    applyLessons(lessons, "inbox");
  }

  // ② legacy notes：只吃围栏外区——notesFile 在首次编译后就是编译产物本体，
  //    围栏保证编译区永不被再摄入（防自强化），围栏外的头两行无 `- ` 行，天然零吸收
  if (!skipLegacy && notesFile) {
    const raw = readIfExists(notesFile);
    if (raw.trim()) {
      applyLessons(parseLessonLines(extractUnfenced(raw)), "import");
    }
  }

  return counts;
}

// legacy 一次性导入（GLOBAL-NOTES.md + parked → store）：marker（imported.json）存在即幂等跳过。
// 对账口径（图纸硬约束）：原始 `- ` 行数 == added+reinforced+skipped（skipped 仅 hash 重复）。
// 解析器会吞掉退化行（`- ` 后无正文），原始行计数把这类行暴露成对账缺口——不通过则写
// import-report.txt、不写 marker（下次 maintain 重试），store 仍落盘（重跑靠 hash 去重自愈）。
export function importOnce({ notesFile, parkedFile, storePath, markerFile, archiveDir }, now) {
  if (fs.existsSync(markerFile)) return { ok: true, skipped: true };

  const notesRaw = readIfExists(notesFile);
  const parkedRaw = readIfExists(parkedFile);
  const combined = notesRaw + "\n" + parkedRaw;
  const counts = {
    parsed: combined.split(/\r?\n/).filter((l) => l.trim().startsWith("- ")).length,
    added: 0,
    reinforced: 0,
    skipped: 0,
  };

  const { entries } = loadStore(storePath);
  for (const l of parseLessonLines(combined)) {
    const r = addOrReinforce(entries, { text: l.text, tags: l.tags, date: l.date, source: "import" }, now);
    counts[r.action === "skip" ? "skipped" : r.action]++; // 同上：动作名与计数字段名对齐
  }

  saveStoreAtomic(storePath, entries); // 先落盘（图纸顺序）；对账失败靠重跑 hash 去重自愈

  if (counts.parsed === counts.added + counts.reinforced + counts.skipped) {
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(
        markerFile,
        JSON.stringify({
          version: 1,
          importedAt: new Date(now).toISOString(),
          sources: [notesFile, parkedFile],
          counts,
        }) + "\n",
        "utf8"
      );
    } catch (e) {
      return { ok: false, counts, error: String(e?.message ?? e) };
    }
    // 两源文件各拷一份到 archiveDir/legacy/<名>.orig（历史归档，导入后源文件由编译接管）
    if (archiveDir) {
      for (const f of [notesFile, parkedFile]) {
        const raw = readIfExists(f);
        if (!raw) continue;
        try {
          const dst = path.join(archiveDir, "legacy", path.basename(f) + ".orig");
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, raw, "utf8");
        } catch { /* 归档失败不阻断导入完成态 */ }
      }
    }
    return { ok: true, skipped: false, counts };
  }

  // 对账失败：详情落 import-report.txt（marker 同目录），不写 marker → 本会话跳过编译重写
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(markerFile), "import-report.txt"),
      [
        `import reconciliation failed ${new Date(now).toISOString()}`,
        JSON.stringify(counts, null, 2),
        `parsed(${counts.parsed}) != added+reinforced+skipped(${counts.added + counts.reinforced + counts.skipped})`,
        "常见原因：源文件存在退化 `- ` 行（前缀后无正文）或导入过程异常。修复源文件后重跑 maintain 重试。",
      ].join("\n") + "\n",
      "utf8"
    );
  } catch { /* 报告写失败不改变返回语义 */ }
  return { ok: false, counts };
}
