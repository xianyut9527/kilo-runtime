// 全局记忆 store v3：无界 JSONL 条目库 + 评分编译快照 + 检索/回流 + 写管线 + 观测。
// v3（2026-10-11 核心批）：lint 门禁 / 脱敏扩展 / quarantine / sid 体系 / estTokens 计量 /
// 项目亲和（createdIn+aff）/ usage 日去重 / 生命周期 v3 / 剔除序修订 / 观测与统计 /
// 存储韧性（meta 行 / 退避 rename / 坏行登记）/ pending 队列 / 快照备份。
// 约定同 v2：模块加载无副作用；除编译围栏常量外全部函数显式收路径与 now（离线可注入假时钟）；
// fs 用 node:fs 同步 API；零 LLM 依赖、零新 npm 依赖。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FENCE_BEGIN = "<!-- KILO-MEMORY-COMPILED:BEGIN -->";
export const FENCE_END = "<!-- KILO-MEMORY-COMPILED:END -->";
const DAY_MS = 86_400_000;

// ── 分词 / 相似度 ────────────────────────────────────────
export function tokenize(s) {
  const text = String(s ?? "").toLowerCase();
  const out = new Set();
  for (const w of text.match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= 2) out.add(w);
  }
  // CJK 无空格边界：取相邻二字 bigram（单字 run 降级取单字，否则整个 run 为 0 token 会漏检）
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// token 集 Jaccard ∈ [0,1]；空集按 0（避免 0/0 NaN 把空串判成全同）
export function jaccard(a, b) {
  const A = a instanceof Set ? a : tokenize(a);
  const B = b instanceof Set ? b : tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── 教训行解析（v3 兼容 [sid|tags] 前缀）──────────────────
// 支持：`- YYYY-MM-DD text`、`- YYYY-MM-DD/DD text`（跨日写法）、`- [tags] text`、
// v3 行格式 `- [sid|tags] text`（sid 丢弃不解析——行内 sid 仅供人读，检索走 resolveShortId）、
// tags/date 前缀互换组合。注释/标题/空行跳过；围栏区整块跳过；CRLF 兼容；
// 退化行（`- ` 后无正文）不产出——importOnce 靠原始行数差值暴露对账缺口。
const LESSON_TAG_PREFIX = /^\[(?:([a-z0-9][a-z0-9-]{2,15})\|)?([^\][\n]*)\]\s*/;
const LESSON_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:\/\d{1,2})?(?:\s+|$)/;

export function parseLessonLines(text) {
  const lessons = [];
  let inFence = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes(FENCE_BEGIN)) { inFence = true; continue; }
    if (line.includes(FENCE_END)) { inFence = false; continue; }
    if (inFence) continue;
    if (!line.startsWith("- ") || line.startsWith("#") || line.startsWith("<!--")) continue;
    let rest = line.slice(2);
    let date = null;
    let tags = [];
    // tags/date 前缀最多各一次、顺序不限：两轮循环逐个剥（sid 分支只在带 `|` 时命中，
    // 纯 `[tag]` 不会误判成 sid——分支要求显式竖线分隔符）
    for (let k = 0; k < 2; k++) {
      if (tags.length === 0) {
        const m = rest.match(LESSON_TAG_PREFIX);
        if (m) {
          tags = m[2].split(/[,，]/).map((t) => t.trim()).filter(Boolean);
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
    if (!body) continue;
    lessons.push({ date, tags, text: body });
  }
  return lessons;
}

// 围栏状态判定（从行 0 扫到 idx）；extractUnfenced 走同语义单遍扫描
export function isLineInFence(lines, idx) {
  let inFence = false;
  for (let i = 0; i <= idx && i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(FENCE_BEGIN)) inFence = true;
    else if (line.includes(FENCE_END)) inFence = false;
  }
  return inFence;
}

// 剔除围栏区（含标记行）：编译产物头两行围栏外但无 `- ` 行 → 再摄入恒零吸收
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

// ── 条目原语 / 脱敏（A2：统一掩码 + 口令/连接串模式）──────
export function normalizeText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

export function hashText(text) {
  return createHash("sha1").update(normalizeText(text), "utf8").digest("hex").slice(0, 16);
}

// id：m<base36 now>-<rand4>——稳定（无冒号/空格）；随机后缀防同毫秒碰撞
export function makeId(now) {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `m${Number(now).toString(36)}-${rand}`;
}
// A2 统一掩码：前 4 + *** + 后 2（保留类型指纹与尾指纹，全文不可回收）；≤6 整段 ***
export function maskValue(v) {
  const s = String(v ?? "");
  return s.length <= 6 ? "***" : s.slice(0, 4) + "***" + s.slice(-2);
}

// A2 写路径脱敏：sk-/eyJ 保持 v2 行为（sk-***/eyJ***，先替换防止被通用键值模式二次掩码）；
// v3 新增（全部 /i，只掩口令值、保留键名与 scheme）：
//   Authorization 头 / password|secret|token|api_key 类键值 / URL query token / 裸连接串 / 邮箱。
// 在 hash 之前执行——只差密钥的两条文本归并为同一条，密钥值永不入库。
export function redactSecrets(text) {
  return String(text ?? "")
    // PEM 私钥块整段掩码（含头尾行；RSA/EC/OPENSSH/ENCRYPTED/PGP BLOCK 全覆盖）——多行密钥任何片段不入库
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, "***private-key***")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    // 三段式 JWT 整串掩码（header.payload.signature 一次吞掉）——必须先于单段 eyJ 规则，防 payload/签名段漏掩
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "eyJ***")
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, "eyJ***")
    // AWS AKID（AKIA/ASIA 前 4 + 16 位大写数字）与 ≥32 连续 hex（摘要/会话 id 类秘密）——前 4 后 2 指纹掩码
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, (m) => maskValue(m))
    .replace(/\b[0-9a-f]{32,}\b/gi, (m) => maskValue(m))
    .replace(/(authorization\s*["'=:\s]*)(bearer\s+)?(\S+)/gi,
      (m, p, scheme, v) => p + (scheme ?? "") + maskValue(v))
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token)\s*["'=:\s]+(\S+)/gi,
      (m, key, v) => `${key} ${maskValue(v)}`)
    .replace(/([?&](?:token|key|secret|api[_-]?key|access[_-]?token|password)=)([^&\s"']+)/gi,
      (m, p, v) => p + maskValue(v))
    .replace(/\b(postgres(ql)?|mysql|redis|mongodb(\+srv)?|amqp):\/\/[^\s"']+/gi,
      (m, scheme) => `${scheme}://***`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
}

// ── A1 lint 门禁：violations=[{sev,msg}]；sev reject → 管线不写 ──
// ── A1 lint 门禁：violations=[{sev,msg}]，sev reject → 管线不写；warn 只提示不拦截 ──
// 基础词表：库内高频聚合标签（词表外合法标签保留但提示——聚合度决定域目录质量）
export const BASIC_TAGS = [
  "correction", "constraint", "gotcha", "workflow", "perf", "security",
  "test", "deploy", "api", "windows", "linux", "git", "memory", "tooling",
];
const TAG_LEGAL_RE = /^(?:[a-z0-9][a-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,12})$/;
export function lintEntry(text, tags) {
  const violations = [];
  const s = String(text ?? "").trim();
  const len = s.length;
  // 长度三档：<12 缺上下文拒收；>400 注入预算杀手拒收；241–400 提示精简
  if (len < 12) violations.push({ sev: "reject", msg: `正文过短（${len}<12 字符）：缺结论或上下文` });
  else if (len > 400) violations.push({ sev: "reject", msg: `正文过长（${len}>400 字符）：精简或拆成多条` });
  else if (len > 240) violations.push({ sev: "warn", msg: `正文偏长（${len}>240）：注入预算敏感，建议精简` });
  // 裸指代开头 → 三个月后无人能懂（已知局限：\b 仅 ASCII 词界，CJK 后接中文不命中）
  if (/^(?:它|这|该|那|此|上述|上文|刚才|这个|那个|it|this|that|these|those)\b/i.test(s)) {
    violations.push({ sev: "warn", msg: "以裸指代开头（它/这/it…）：请写出具体对象" });
  }
  // 模板软引导（不强制）：「当<条件>，<动作>（原因）」可检索性最好
  if (!/^当.{1,}，.{1,}（.{1,}）$/u.test(s)) {
    violations.push({ sev: "warn", msg: '建议模板「当<条件>，<动作>（原因）」' });
  }
  // tags：小写归一 → 合法性过滤（剔除+warn）→ 词表外提示（保留）→ 上限 5（截断+warn）→ 去重
  const raw = (Array.isArray(tags) ? tags : []).map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean);
  if (raw.length > 5) violations.push({ sev: "warn", msg: `标签超过 5 个（${raw.length}）：截取前 5` });
  const out = [];
  const seen = new Set();
  for (const tg of raw.slice(0, 5)) {
    if (seen.has(tg)) continue;
    seen.add(tg);
    if (!TAG_LEGAL_RE.test(tg)) { violations.push({ sev: "warn", msg: `非法标签已剔除：「${tg}」` }); continue; }
    if (!BASIC_TAGS.includes(tg)) violations.push({ sev: "warn", msg: `标签不在基础词表：「${tg}」（已保留）` });
    out.push(tg);
  }
  return { tags: out, violations };
}

// ── A3 投毒检测：外联指令（URL/curl/wget/裸主机名/IP:port…）AND 祈使词同时出现 → quarantine
// （隔离区不进编译，待人工放行）。裸包管理器安装命令（npm/pnpm/yarn/bun install）是合法工程
// 经验，白名单直通。祈使词含各包管理器/容器/eval（批次 B #2 扩面）。
// 裸主机名：常见 TLD 白名单（保守防误伤 file.txt/版本号类误报）+ IP[:port]，均无 scheme 也命中。
const SUSPICIOUS_FETCH_RE = /https?:\/\/|\bcurl\b|\bwget\b|\biwr\b|\binvoke-webrequest\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|sh|ru|cn|xyz|info|top|cc|su)(?:\/[^\s"']*)?\b/i;
const IMPERATIVE_RE = /\b(run|execute|exec|download|open|visit|fetch|install|npx|pnpm|yarn|pip|docker|eval)\b|执行|下载|访问|打开|安装|运行/i;
const BARE_NPM_RE = /^\s*(?:npm|pnpm|yarn|bun)\s+install\b/i;
export function isQuarantineCandidate(text) {
  const s = String(text ?? "");
  if (BARE_NPM_RE.test(s)) return false;
  return SUSPICIOUS_FETCH_RE.test(s) && IMPERATIVE_RE.test(s);
}

// ── A4 sid 体系 ──────────────────────────────────────────
// ── A4 sid 体系：短 id 供编译行/检索引用，库里唯一（检索正确性前提）──
// 首选 base36 随机 4 位（rnd 可注入确定性）；撞库 → sha1(id) 确定性扩长 5/6/8/12/16，直至唯一
export function assignSid(entries, entry, rnd = Math.random) {
  const taken = new Set(entries.filter((e) => e !== entry && e.sid).map((e) => e.sid));
  const hex = createHash("sha1").update(String(entry.id ?? ""), "utf8").digest("hex");
  for (const len of [4, 5, 6, 8, 12, 16]) {
    const cand = len === 4
      ? Math.floor(rnd() * 36 ** 4).toString(36).padStart(4, "0")
      : hex.slice(0, len);
    if (!taken.has(cand)) { entry.sid = cand; return entry.sid; }
  }
  entry.sid = hex; // 40 位全 hash 兜底（理论不可达）
  return entry.sid;
}

// 补齐旧条目 sid（loadStore 后、编译/落盘前调用——v2 库升级 v3 时统一固化）
export function ensureSids(entries, rnd = Math.random) {
  for (const e of entries) if (!e.sid) assignSid(entries, e, rnd);
  return entries;
}

// 短 id 解析：精确（完整 id 或 sid）→ 前缀唯一 → 后缀唯一；多命中 → {candidates,ambiguous}；
// 无命中 → null。后缀匹配要求 ≥3 字符（1–2 字符后缀误报率不可接受）
export function resolveShortId(entries, q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return null;
  const exact = entries.find((e) => e.id === s || String(e.sid ?? "").toLowerCase() === s);
  if (exact) return { entry: exact, kind: "exact" };
  const prefix = entries.filter((e) => String(e.sid ?? "").toLowerCase().startsWith(s) || e.id.toLowerCase().startsWith(s));
  if (prefix.length === 1) return { entry: prefix[0], kind: "prefix" };
  if (prefix.length > 1) {
    // 歧义回退（批次 B #3）：用各候选完整 id 的 sha1(id)[:s.length] 再匹配一次——assignSid 撞库
    // 扩长分配的 hash 型 sid 被另一条目的 rnd sid 短前缀遮蔽时，唯一命中直接解析；
    // 仍多命中才返回 ambiguous。sha1 口径与 assignSid 扩长路径完全一致。
    const bySha = prefix.filter((e) => createHash("sha1").update(String(e.id ?? ""), "utf8").digest("hex").slice(0, s.length) === s);
    if (bySha.length === 1) return { entry: bySha[0], kind: "prefix", resolvedBy: "sha1" };
    return { candidates: prefix, kind: "ambiguous" };
  }
  if (s.length < 3) return null;
  const suffix = entries.filter((e) => e.id.toLowerCase().endsWith(s) || String(e.sid ?? "").toLowerCase().endsWith(s));
  if (suffix.length === 1) return { entry: suffix[0], kind: "suffix" };
  if (suffix.length > 1) return { candidates: suffix, kind: "ambiguous" };
  return null;
}

// ── A5/A14 计量与评分 ────────────────────────────────────
// A5 token 成本估算：CJK 按字计 1，拉丁/数字 4 字符≈1 token，其余标点 2 字符≈1 token。
// 密度分母用它替代 v2 的 chars/60——混合中英文条目的成本计量不再偏差一倍以上。
const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;
export function estTokens(text) {
  const s = String(text ?? "");
  const cjk = (s.match(CJK_CHAR_RE) ?? []).length;
  const latin = (s.match(/[A-Za-z0-9]/g) ?? []).length;
  const other = s.length - cjk - latin;
  return Math.ceil(cjk + latin / 4 + other / 2);
}

// 基础分（v2 不变）：pinned 1000 + hits 对数 + 45d 半衰期新近分 + 14d 新条目保护 + correction/constraint 加权
export function score(entry, now) {
  const hits = entry.hits ?? 0;
  const created = entry.created ?? now;
  const lastUsed = entry.lastUsed ?? created; // 从未用过：以 created 作衰减锚
  const sinceUseDays = Math.max(0, (now - lastUsed) / DAY_MS);
  const ageDays = Math.max(0, (now - created) / DAY_MS);
  return (entry.pinned ? 1000 : 0)
    + 2.2 * Math.log(1 + hits)
    + 1.5 * (1 / (1 + sinceUseDays / 45))
    + (ageDays < 14 ? 1 : 0)
    + (/correction|constraint/i.test((entry.tags ?? []).join(",")) ? 0.6 : 0);
}

// 项目亲和计数：entry.aff = { [projectKey]: 使用次数 }，usage 回流时按 ws 累加
export function bumpAffinity(entry, ws) {
  const k = String(ws || "global");
  entry.aff = entry.aff ?? {};
  entry.aff[k] = (entry.aff[k] ?? 0) + 1;
}

// 亲和 key 上限 12：超出剪掉最小计数（并列剪字典序大者——保留序确定，同库多次编译结果稳定）
const AFF_CAP = 12;
export function projAffinity(entry) {
  const aff = entry.aff ?? {};
  const keys = Object.keys(aff);
  if (keys.length > AFF_CAP) {
    const sorted = keys.sort((a, b) => (aff[b] ?? 0) - (aff[a] ?? 0) || (a < b ? -1 : 1));
    for (const k of sorted.slice(AFF_CAP)) delete aff[k];
    entry.aff = aff;
  }
  return entry.aff ?? {};
}

// A14 有效分 = 基础分 × 亲和乘子（pinned 免疫——人工置顶的排序不被亲和机制改写）：
//   ① 本项目计数 ≥2 → ×(1 + 0.8×share)，share = 本项目计数 / 全库计数合计（项目相关性加成）
//   ② hits≥5 且其他项目合计 ≥3 且本项目为 0 → ×0.6（通用热门但本项目从未受益 → 让位）
export function effectiveScore(entry, now, projectKey) {
  const s = score(entry, now);
  if (entry.pinned) return s;
  const aff = entry.aff ?? {};
  let total = 0;
  for (const v of Object.values(aff)) total += v ?? 0;
  const cur = projectKey ? (aff[projectKey] ?? 0) : 0;
  let out = s;
  if (cur >= 2 && total > 0) out *= 1 + 0.8 * (cur / total);
  if ((entry.hits ?? 0) >= 5 && total - cur >= 3 && cur === 0) out *= 0.6;
  return out;
}

// 密度 = 有效分 / token 成本（A5 estTokens 替代 v2 chars/60——中英混排计量不再偏一倍）
export function density(entry, now, projectKey) {
  return effectiveScore(entry, now, projectKey) / Math.max(1, estTokens(entry.text ?? ""));
}

// ── A7 usage 回流（get+cite；按 (id,day) 批内日去重）───────
// A7 usage 回流：仅 t∈{get,cite} 计分（search 浏览不计分，防热条目自证循环）；
// 按 (id, UTC 日) 批内去重——同条同日多次读只计 1 分（防单会话循环刷分）；
// lastUsed 取组内首个事件 ts（事件时间，非编译时间）；ws 累加项目亲和。
// 返回 {applied, consumed, deduped}（v2 返回数字——统计口径升级）。
export function applyUsage(entries, usageEvents, now) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const groups = new Map(); // key=id|day → {entry, firstTs, ws}
  let consumed = 0;
  for (const ev of usageEvents) {
    if (!ev || (ev.t !== "get" && ev.t !== "cite")) continue;
    const e = byId.get(ev.id);
    if (!e) continue;
    consumed++;
    const ts = Number.isFinite(ev.ts) ? ev.ts : now;
    const key = `${ev.id}|${Math.floor(ts / DAY_MS)}`;
    if (!groups.has(key)) groups.set(key, { entry: e, firstTs: ts, ws: ev.ws });
  }
  for (const g of groups.values()) {
    g.entry.hits = (g.entry.hits ?? 0) + 1;
    g.entry.lastUsed = g.firstTs;
    bumpAffinity(g.entry, g.ws);
  }
  return { applied: groups.size, consumed, deduped: consumed - groups.size };
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

export function appendUsage(file, id, type, now, ws) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { t: type, id, ts: now };
  if (ws) row.ws = ws;
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

// usage 轮转：主文件只保留近 7 日事件（重放窗口），更早行并入 .old（1 代，防 usage 无界膨胀）
export function rotateUsage(file, now) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { kept: 0, rotated: 0 }; }
  const keep = [];
  const old = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let ts = 0;
    try { ts = JSON.parse(t).ts ?? 0; } catch { ts = 0; }
    (ts >= now - 7 * DAY_MS ? keep : old).push(t);
  }
  if (!old.length) return { kept: keep.length, rotated: 0 };
  try {
    const oldFile = `${file}.old`;
    const prev = fs.existsSync(oldFile) ? fs.readFileSync(oldFile, "utf8") : "";
    fs.writeFileSync(oldFile, prev + old.join("\n") + "\n", "utf8");
    fs.writeFileSync(file, keep.join("\n") + (keep.length ? "\n" : ""), "utf8");
  } catch { return { kept: keep.length, rotated: 0 }; }
  return { kept: keep.length, rotated: old.length };
}

// ── A8 生命周期 v3 ───────────────────────────────────────
// A8 生命周期 v3（编译时原地改 status，调用方落盘）：
//   trial→active：凭 hits≥1（被读过）或 source∈{user,evolve}（高可信来源直接转正）
//   trial→archived：age≥30d 仍零回流（探索槽只在 14–30d 窗口给它曝光机会，过期即出清）
//   active→archived：age>180d 零命中且非 pinned
//   quarantine/flagged/archived：不自动转换——隔离与人工标记态只能由 flagEntry/人工复位流转
export function recalcLifecycle(entries, now) {
  for (const e of entries) {
    const age = (now - (e.created ?? now)) / DAY_MS;
    if (e.status === "trial") {
      if ((e.hits ?? 0) > 0 || e.source === "user" || e.source === "evolve") e.status = "active";
      else if (age >= 30) e.status = "archived";
    } else if (e.status === "active") {
      if ((e.hits ?? 0) === 0 && age > 180 && !e.pinned) e.status = "archived";
    }
  }
}

// ── A13 写管线 / flag / pending ──────────────────────────
// A13 写管线（顺序硬约束）：脱敏 → lint（有 reject 不写）→ hash 精确 skip → Jaccard≥0.85 强化
// → 新增（投毒命中 → quarantine，否则 trial）。violations 随返回值透传给工具层拼接提示。
export function addWithPipeline(entries, { text, tags, date, source, ws, createdIn }, now) {
  const clean = normalizeText(redactSecrets(String(text ?? "")));
  const { tags: lintTags, violations } = lintEntry(clean, Array.isArray(tags) ? tags : []);
  if (violations.some((v) => v.sev === "reject")) return { action: "rejected", violations };
  const hash = hashText(clean);
  const exact = entries.find((e) => e.hash === hash);
  if (exact) return { action: "skip", id: exact.id, violations };

  const tokens = tokenize(clean);
  let best = null;
  let bestJ = 0;
  for (const e of entries) {
    // F（裁决三 #2）：合并目标仅限可注入态（trial/active）——相近文本撞上
    // quarantine/flagged/archived 时不强化（防内容被静默吞进不进编译的条目），
    // 接受重复代价新建条目；人工放行/复位后同文本再写会自然去重
    if (e.status !== "trial" && e.status !== "active") continue;
    const j = jaccard(tokens, tokenize(e.text ?? ""));
    if (j > bestJ) { bestJ = j; best = e; }
  }
  if (best && bestJ >= 0.85) {
    best.hits = (best.hits ?? 0) + 1;
    best.lastUsed = now;
    if (ws) bumpAffinity(best, ws);
    return { action: "reinforced", id: best.id, violations };
  }

  const created = date && Number.isFinite(Date.parse(date)) ? Date.parse(date) : now;
  const entry = {
    id: makeId(now),
    text: clean,
    hash,
    tags: lintTags,
    created,
    lastUsed: created,
    hits: 0,
    source: String(source ?? "agent"),
    status: isQuarantineCandidate(clean) ? "quarantine" : "trial",
    pinned: false,
    createdIn: createdIn ?? null, // v3：出生项目 key（试用槽排序优先项）
    aff: {},                      // v3：项目亲和计数
    flags: [],
  };
  entries.push(entry);
  return { action: "added", id: entry.id, entry, violations };
}

// v2 兼容壳：ingestSources/importOnce 走同一管线（无 ws/createdIn）
export function addOrReinforce(entries, input, now) {
  return addWithPipeline(entries, { ...input, ws: undefined, createdIn: undefined }, now);
}
// flag 流程：理由 4–200 字符；同条目同理由（trim 后相等）幂等拒（不递增不重复置态，裁决 #4）；
// 单条 flags≥3 拒；全库 flagged≥10 拒（防灌水淹没人工队列）；
// 首次 flag 记 prevStatus 供复位回滚；status 置 flagged（编译期所有槽位排除）。
export function flagEntry(entries, { id, reason }, now) {
  const r = resolveShortId(entries, id);
  // 先判模糊再判未命中：ambiguous 结果不带 entry，若先走 !r.entry 分支则 ambiguous 永不可达
  if (r && r.candidates) return { ok: false, code: "ambiguous" };
  if (!r || !r.entry) return { ok: false, code: "not-found" };
  const rs = String(reason ?? "").trim();
  if (rs.length < 4 || rs.length > 200) return { ok: false, code: "reason-length" };
  const e = r.entry;
  e.flags = Array.isArray(e.flags) ? e.flags : [];
  // 同因去重先于上限检查：幂等重试（队列重放/用户手滑）该报 duplicate 而非误导性的 capped
  if (e.flags.some((f) => f?.reason === rs)) return { ok: false, code: "duplicate" };
  if (e.flags.length >= 3) return { ok: false, code: "flag-capped" };
  if (entries.filter((x) => x.status === "flagged").length >= 10) return { ok: false, code: "flag-pool-full" };
  if (e.flags.length === 0) e.prevStatus = e.status ?? "trial";
  e.flags.push({ reason: rs, ts: now });
  e.status = "flagged";
  return { ok: true, id: e.id, flags: e.flags.length };
}

// pending 队列行格式：每行一个 JSON op——{op:"add",text,tags?,source?,ws?,createdIn?}、
// {op:"reinforce",id,ts}（write-through 锁竞争时强化排队，裁决 #2）或 {op:"flag",id,reason}。
// 坏行/未知 op 计入 bad（可丢数据，不炸队列）。
export function parsePendingOps(text) {
  const ops = [];
  let bad = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && (o.op === "add" || o.op === "flag" || o.op === "reinforce")) ops.push(o);
      else bad++;
    } catch { bad++; }
  }
  return { ops, bad };
}

// pending 消费：add 走与 mem_add 完全同一管线（同 lint/去重/投毒语义），reinforce 幂等重放，
// flag 走 flagEntry；失败（rejected/flag 拒绝/未知 id）按 dropped/原地计数返回，不抛错。
export function applyPendingOps(entries, ops, now) {
  const counts = { added: 0, reinforced: 0, skipped: 0, deduped: 0, rejected: 0, flagged: 0, dropped: 0 };
  for (const op of ops) {
    if (op.op === "add") {
      const r = addWithPipeline(entries, op, now);
      const key = r.action === "skip" ? "skipped" : r.action;
      counts[key] = (counts[key] ?? 0) + 1;
    } else if (op.op === "reinforce") {
      // 幂等重放（裁决 #2）：崩溃发生在消费后、队列截空前 → 同 op 重放；
      // lastUsed>=op.ts 说明该次已计过，跳过防崩溃双计（skip 计入 deduped）
      const e = entries.find((x) => x.id === op.id);
      if (!e) { counts.dropped++; continue; }
      if ((e.lastUsed ?? 0) >= (op.ts ?? 0)) { counts.deduped++; continue; }
      e.hits = (e.hits ?? 0) + 1;
      e.lastUsed = op.ts ?? now;
      counts.reinforced++;
    } else {
      const r = flagEntry(entries, op, now);
      if (r.ok) counts.flagged++;
      else counts.dropped++;
    }
  }
  return counts;
}

// ── A12 存储韧性 ─────────────────────────────────────────
// JSONL 读：坏行跳过并计数；首行 `{"_meta":true,...}` 为库元信息行（v3 起保存时写入），
// 解析进 meta（v2 无 meta 行的库 → meta=null，调用方按 v1/v2 兼容读、保存时升 v3）
export function loadStore(file) {
  const entries = [];
  let badLines = 0;
  let meta = null;
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { entries, badLines, meta }; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e._meta === true) { meta = e; continue; }
      if (e && typeof e.id === "string" && typeof e.text === "string") entries.push(e);
      else badLines++;
    } catch { badLines++; }
  }
  return { entries, badLines, meta };
}
const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]); // Windows rename 占用类错误

// 同步 sleep（rename 重试用）：Atomics.wait 阻塞当前线程且不烧 CPU busy loop
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A12 rename 退避重试 [150,600,2000]ms（EPERM/EACCES/EBUSY，杀软/索引器短暂占用可自愈）；
// 终败保留 .tmp 向上抛——.tmp 是排查锚点，清掉反而丢失现场（never-throw 由插件壳兜底）
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt < 3 && RENAME_RETRYABLE.has(e?.code)) { sleepSync([150, 600, 2000][attempt]); continue; }
      throw e;
    }
  }
}

// 原子落盘（v3）：先 ensureSids 惰性固化短 id（v2 库首次保存即升级），首行写
// `{"_meta":true,"v":3}` 版本戳；旧版先拷 .prev（回滚锚点）再 rename。不做先删后写——
// rename 原子性保证读者永远看到完整文件。
export function saveStoreAtomic(file, entries) {
  ensureSids(entries);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const payload = JSON.stringify({ _meta: true, v: 3 }) + "\n"
    + entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  fs.writeFileSync(tmp, payload, "utf8");
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.prev`); } catch { /* prev 备份失败不阻断主写入 */ }
  }
  renameWithRetry(tmp, file);
}

// A12 损坏行登记：`[16位行hash] 前120字符样本` 追加进隔离文件，行 hash 去重——
// 同一坏行不因每轮 maintain 重复刷屏；返回本次新登记条数
export function appendCorruptUnique(file, lines) {
  const rows = (Array.isArray(lines) ? lines : [lines]).map((l) => String(l ?? "")).filter(Boolean);
  if (!rows.length) return 0;
  const seen = new Set();
  try {
    for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\[([0-9a-f]{16})\]/);
      if (m) seen.add(m[1]);
    }
  } catch { /* 首次无文件，视为空集 */ }
  const fresh = [];
  for (const r of rows) {
    const h = createHash("sha1").update(r, "utf8").digest("hex").slice(0, 16);
    if (!seen.has(h)) { seen.add(h); fresh.push(`[${h}] ${r.slice(0, 120)}`); }
  }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.join("\n") + "\n", "utf8");
  }
  return fresh.length;
}

// ── A9 编译 ──────────────────────────────────────────────
// ── A9 编译 ──────────────────────────────────────────────
// 槽位互斥：精选=active+trial（被试用/探索选中者不再进精选）；pinned 不进试用/探索槽。
const BUDGET = {
  header: 200,        // 围栏外头两行
  domain: 320,        // 域目录行
  domainTags: 12,
  domainTagChars: 12,
  curated: 2200,      // 精选正文（pinned 豁免字符预算）
  trial: 360,
  trialCount: 3,
  explore: 300,
  exploreCount: 1,
  pinnedDisplay: 500, // pinned 常规展示截断
  pinnedCapText: 60,  // 字节硬顶第④步 pinned 截断保行头
  hardBytes: 10240,   // UTF-8 字节硬顶
};
const COMPILED_HEADER = "# Global Memory（编译产物 · 勿手工编辑）";
const COMPILED_NOTE = "<!-- 由 memory-store 插件自动生成：追加经验用 mem_add；检索用 mem_search/mem_get；引用用 mem_cite。 -->";

function sha1hex(s) {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// v3 行格式：`- [sid|tags] text`（空 tags 渲染 `[sid|]`）——行首 sid 让 mem_cite/mem_flag 可直接引用
function renderLine(entry, textMax) {
  const prefix = `[${entry.sid ?? ""}|${(entry.tags ?? []).join(",")}] `;
  const body = truncate(String(entry.text ?? ""), textMax);
  return `- ${prefix}${body}`;
}

// 行长受限渲染（试用/探索小预算槽）：行上限换算成正文截断上限
function renderLineWithin(entry, maxLine) {
  const prefix = `[${entry.sid ?? ""}|${(entry.tags ?? []).join(",")}] `;
  return renderLine(entry, Math.max(1, maxLine - 2 - prefix.length - 1));
}

// 探索槽选取：候选按 sha1(`${id}:${day}`) 确定性排序取首个；stateFile 记 {day,id}——
// 同日且 id 仍有效则复用（同日多轮编译注入内容稳定）。状态读写失败降级为无状态。
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
    } catch { /* 持久化失败降级为内存态 */ }
  }
  return { id, state };
}

// 编译主函数。opts：{exploreStateFile, projectKey, usageAggregatedAlready}（usage 由 applyUsage
// 预写入 entries，这里只读）。entries 的 status/sid 已原地更新，调用方须 saveStoreAtomic 落盘。
// 返回 {markdown, stats}；stats.slotIds={s,t,e} 与 evictions=[{slot,id,reason}] 供 injection-log。
export function buildCompiled(entries, opts = {}, now = Date.now()) {
  const projectKey = opts.projectKey ?? null;
  recalcLifecycle(entries, now);
  ensureSids(entries);
  // D（裁决三 #6）：12-key 亲和剪枝进生产路径——loadStore 直进的库不经 addWithPipeline，
  // 只在写路径剪枝时旧库/导入库的 aff 会无限膨胀；此处锁内单写者执行，原地修剪安全
  for (const e of entries) projAffinity(e);

  // 探索槽（A8 v3 池）：hits==0、age≥14d、非 pinned、status=active 或（trial 且未满 30d）；
  // archived/quarantine/flagged 一律不进——归档是终态，隔离/标记态必须人工流转
  const exploreCandidates = entries.filter((e) => {
    if (e.pinned || (e.hits ?? 0) > 0) return false;
    const age = (now - (e.created ?? now)) / DAY_MS;
    if (age < 14) return false;
    if (e.status === "active") return true;
    return e.status === "trial" && age < 30;
  });
  const explore = pickExplore(exploreCandidates, opts.exploreStateFile, now);

  // 试用槽：createdIn===projectKey 优先（本项目的经验本项目先用），同级按 created 新→旧
  const trialPool = entries
    .filter((e) => e.status === "trial" && !e.pinned)
    .sort((a, b) =>
      ((a.createdIn === projectKey ? 0 : 1) - (b.createdIn === projectKey ? 0 : 1))
      || (b.created ?? 0) - (a.created ?? 0)
    );
  const trialLines = [];
  let trialChars = 0;
  for (const e of trialPool) {
    if (trialLines.length >= BUDGET.trialCount) break;
    let line = renderLineWithin(e, 500);
    if (trialChars + line.length > BUDGET.trial) {
      if (trialLines.length > 0) break;
      line = renderLineWithin(e, BUDGET.trial); // 首条必现（一条 400 字新条目不让试用段空转）
    }
    trialChars += line.length;
    trialLines.push({ entry: e, line });
  }
  const excludeIds = new Set([...trialLines.map((x) => x.entry.id), ...(explore.id ? [explore.id] : [])]);

  // 精选槽：pinned 置顶，其余按密度（有效分/token 成本——亲和乘子在 effectiveScore 内）
  const curatedPool = entries
    .filter((e) => (e.status === "active" || e.status === "trial") && !excludeIds.has(e.id))
    .sort((a, b) =>
      ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      || (density(b, now, projectKey) - density(a, now, projectKey))
      || (score(b, now) - score(a, now))
      || ((a.created ?? 0) - (b.created ?? 0))
    );
  const curatedLines = [];
  let curatedChars = 0;
  for (const e of curatedPool) {
    const line = renderLine(e, e.pinned ? BUDGET.pinnedDisplay : 500);
    if (!e.pinned) {
      if (curatedChars + line.length > BUDGET.curated) break;
      curatedChars += line.length;
    }
    curatedLines.push({ entry: e, line, pinned: !!e.pinned });
  }

  // 域目录：top12 tag（名截 12 字符），超宽从尾丢 tag；N=全库条数
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

  // 组装 + 字节硬顶。剔除序（v3 修订）：①精选非 pinned（最低密度先出）②试用（保底 1 条）
  // ③探索 ④pinned 先截 text 到 60 字符保行头（截断不报告），仍超再整条移出（报告 cap）。
  let noteLine = COMPILED_NOTE;
  const assemble = () => {
    const lines = [COMPILED_HEADER, noteLine, FENCE_BEGIN, "## 域目录", domainLine];
    if (curatedLines.length) lines.push("## 精选", ...curatedLines.map((c) => c.line));
    if (trialLines.length) lines.push("## 试用", ...trialLines.map((x) => x.line));
    if (explore.id) {
      const e = entries.find((x) => x.id === explore.id);
      if (e) lines.push("## 探索", renderLineWithin(e, BUDGET.explore));
    }
    lines.push(FENCE_END);
    return lines.join("\n") + "\n";
  };
  const evictions = [];
  const over = () => Buffer.byteLength(assemble(), "utf8") > BUDGET.hardBytes;
  let markdown = assemble();
  // 剔除必须作用于主数组（filter 产生副本会令 splice 落空 → 死循环），故按槽各写一个 evict
  const evictFromCurated = (pinned, cmp) => {
    const victim = curatedLines.filter((c) => c.pinned === pinned).sort(cmp)[0];
    curatedLines.splice(curatedLines.indexOf(victim), 1);
    evictions.push({ slot: "curated", id: victim.entry.id, reason: "cap" });
    markdown = assemble();
  };
  const evictFromTrial = (cmp) => {
    const victim = [...trialLines].sort(cmp)[0];
    trialLines.splice(trialLines.indexOf(victim), 1);
    evictions.push({ slot: "trial", id: victim.entry.id, reason: "cap" });
    markdown = assemble();
  };
  while (over() && curatedLines.some((c) => !c.pinned)) {
    evictFromCurated(false, (a, b) => density(a.entry, now, projectKey) - density(b.entry, now, projectKey));
  }
  while (over() && trialLines.length > 1) {
    evictFromTrial((a, b) => score(a.entry, now) - score(b.entry, now));
  }
  if (over() && explore.id) {
    evictions.push({ slot: "explore", id: explore.id, reason: "cap" });
    explore.id = null;
    markdown = assemble();
  }
  if (over()) {
    for (const c of curatedLines) if (c.pinned) c.line = renderLine(c.entry, BUDGET.pinnedCapText);
    markdown = assemble();
  }
  while (over() && curatedLines.some((c) => c.pinned)) {
    evictFromCurated(true, (a, b) => score(a.entry, now) - score(b.entry, now));
  }
  // 兜底：条目剔光仍超（极端）→ 截域目录/头注释 → 仍超硬截空围栏
  if (over()) {
    while (over() && domainLine.length > 80) { domainLine = truncate(domainLine, Math.floor(domainLine.length / 2)); markdown = assemble(); }
    while (over() && noteLine.length > 40) { noteLine = truncate(noteLine, 40); markdown = assemble(); }
    if (over()) markdown = `${COMPILED_HEADER}\n${COMPILED_NOTE}\n${FENCE_BEGIN}\n${FENCE_END}\n`;
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
    slotIds: { s: curatedLines.map((c) => c.entry.id), t: trialLines.map((x) => x.entry.id), e: explore.id ?? null },
    evictions,
    usageAggregatedAlready: !!opts.usageAggregatedAlready,
  };
  return { markdown, stats };
}

// ── A10/A11 观测与统计 ───────────────────────────────────
// injection-log 行：{ts,day,projectKey,slotIds:{s,t,e},bytes,evictions}——每次维护编译落一行，
// /evolve 步骤 5 与 computeStats 的原料
export function makeInjectionLogRow({ projectKey, slotIds, bytes, evictions }, now) {
  return {
    ts: now,
    day: Math.floor(now / DAY_MS),
    projectKey: String(projectKey ?? "global"),
    slotIds: { s: slotIds?.s ?? [], t: slotIds?.t ?? [], e: slotIds?.e ?? null },
    bytes: bytes ?? 0,
    evictions: Array.isArray(evictions) ? evictions : [],
  };
}

// 写前快照：跨日才拷（同日多轮编译不重复占代数）→ backupDir/notes-YYYYMMDD.jsonl；
// 滚动保留 keep 代（默认 30），超限剪最旧。快照是可丢数据：不抛错，但失败经 out.error 上报
//（A，裁决三 #1：调用点必须 report，不允许静默）。
export function snapshotNotes({ notesFile, backupDir, keep = 30 }, now) {
  const out = { snapshot: null, pruned: 0, error: null };
  try {
    const raw = fs.readFileSync(notesFile, "utf8");
    if (!raw.trim()) return out;
    const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    fs.mkdirSync(backupDir, { recursive: true });
    const dst = path.join(backupDir, `notes-${day}.jsonl`);
    if (!fs.existsSync(dst)) {
      fs.writeFileSync(dst, raw, "utf8");
      out.snapshot = dst;
    }
    const snaps = fs.readdirSync(backupDir).filter((f) => /^notes-\d{8}\.jsonl$/.test(f)).sort();
    while (snaps.length > keep) {
      const victim = snaps.shift();
      try { fs.rmSync(path.join(backupDir, victim), { force: true }); out.pruned++; }
      catch { break; }
    }
  } catch (e) {
    // 源缺失（首跑 store 尚未创建）= 无快照可拍，非失败；其余 IO 失败必须可观测（E）
    if (e?.code !== "ENOENT") out.error = String(e?.message ?? e);
  }
  return out;
}

// A11 stats.json 聚合（/evolve 步骤 5 审阅入口）。输入由插件壳装配，全部可缺省（缺输入按 0/null 降级）：
//   injectionRows=search-log 之外的 injection-log.jsonl 行；searchRows=search-log.jsonl 行；entries=当前库
export function computeStats({ injectionRows = [], searchRows = [], entries = [] } = {}, now = Date.now()) {
  const last = injectionRows[injectionRows.length - 1] ?? null;
  const d7 = now - 7 * DAY_MS;
  const d30 = now - 30 * DAY_MS;
  const s7 = searchRows.filter((r) => (r.ts ?? 0) >= d7);
  const hit7 = s7.filter((r) => (r.n ?? 0) > 0).length;
  return {
    v: 3,
    compiles: injectionRows.length,
    lastBytes: last?.bytes ?? 0,
    lastSlots: { s: last?.slotIds?.s?.length ?? 0, t: last?.slotIds?.t?.length ?? 0, e: last?.slotIds?.e ? 1 : 0 },
    hitRate7d: s7.length ? hit7 / s7.length : null,
    trialActive7d: entries.filter((e) => e.status === "active" && (e.created ?? 0) >= d7).length,
    exploreFetched: injectionRows.filter((r) => r.slotIds?.e).length,
    zeroQueries30d: entries.filter((e) => (e.hits ?? 0) === 0 || (e.lastUsed ?? e.created ?? 0) < d30).length,
    adds7d: entries.filter((e) => (e.created ?? 0) >= d7).length,
    flagsOpen: entries.filter((e) => e.status === "flagged").length,
    evictions: injectionRows.reduce((a, r) => a + (r.evictions?.length ?? 0), 0),
  };
}

export function makeSearchLogRow(q, n, now) {
  // q 脱敏（查询串本身可能带密钥/邮箱）+ 截 60：日志是长期文件，不成为二次泄漏源
  return { ts: now, day: Math.floor(now / DAY_MS), q: redactSecrets(String(q ?? "")).slice(0, 60), n };
}
// ── 摄入 ─────────────────────────────────────────────────
function readIfExists(file) {
  if (!file) return "";
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// 常规摄入：inbox（agent 兜底写通道）+ legacy notes 围栏外区（skipLegacy 控制）。
// v3 走 addWithPipeline 同一管线（lint/脱敏/去重/投毒语义与 mem_add 完全一致）；
// 成功消费的 inbox 原始行追加 consumed（带时间戳头）后把 inbox 截空——「截空即确认」。
// store 仅在有实际写入动作时落盘（纯 skip/rejected 不写）。
export function ingestSources({ notesFile, inboxFile, storePath, consumedFile, skipLegacy }, now) {
  const counts = { added: 0, reinforced: 0, skipped: 0, rejected: 0, quarantined: 0, consumed: 0 };

  const applyLessons = (lessons, source) => {
    const { entries } = loadStore(storePath);
    for (const l of lessons) {
      const r = addWithPipeline(entries, { text: l.text, tags: l.tags, date: l.date, source }, now);
      // 动作名与计数字段对齐（直用 r.action 当键会静默长出 NaN 野键，v2 已证）；
      // quarantine 条目是真实写入（占库不占编译），单列计数便于对账与人工巡检
      if (r.action === "skip") counts.skipped++;
      else if (r.action === "reinforced") counts.reinforced++;
      else if (r.action === "rejected") counts.rejected++;
      else if (r.entry?.status === "quarantine") counts.quarantined++;
      else counts.added++;
    }
    if (counts.added || counts.reinforced || counts.quarantined) saveStoreAtomic(storePath, entries);
  };

  // ① inbox：解析产出条数与消费行数分开记；half-baked 行不无限重试（consumed 头有时间戳可对账）
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
    fs.writeFileSync(inboxFile, "", "utf8");
    applyLessons(lessons, "inbox");
  }

  // ② legacy notes：只吃围栏外区——notesFile 编译后就是产物本体，围栏保证编译区零再摄入
  if (!skipLegacy && notesFile) {
    const raw = readIfExists(notesFile);
    if (raw.trim()) {
      applyLessons(parseLessonLines(extractUnfenced(raw)), "import");
    }
  }

  return counts;
}

// legacy 一次性导入（GLOBAL-NOTES.md + parked → store）：marker（imported.json）存在即幂等跳过。
// 对账口径（v3）：原始 `- ` 行数 == added+quarantined+reinforced+skipped+rejected（每解析行恰好
// 归入一类；quarantine 是写入态、rejected 是拒收态，都必须在对账里现形）。
// 解析器吞掉的退化行由「原始行数 vs 对账和」的差值暴露——不通过则写 import-report.txt、
// 不写 marker（下次 maintain 重试），store 仍落盘（重跑靠 hash 去重自愈）。
export function importOnce({ notesFile, parkedFile, storePath, markerFile, archiveDir }, now) {
  if (fs.existsSync(markerFile)) return { ok: true, skipped: true };

  const notesRaw = readIfExists(notesFile);
  const parkedRaw = readIfExists(parkedFile);
  const combined = notesRaw + "\n" + parkedRaw;
  // 对账口径与解析器同语义：围栏区（编译产物本体）不算导入候选——write-through 先于首次
  // maintain 时 GLOBAL-NOTES.md 已含围栏内条目行，裸行计数会误算进 parsed 致对账恒败、maintain 早退
  const unfencedCombined = extractUnfenced(combined);
  const counts = {
    parsed: unfencedCombined.split(/\r?\n/).filter((l) => l.trim().startsWith("- ")).length,
    added: 0,
    reinforced: 0,
    skipped: 0,
    rejected: 0,
    quarantined: 0,
  };

  const { entries } = loadStore(storePath);
  for (const l of parseLessonLines(combined)) {
    const r = addWithPipeline(entries, { text: l.text, tags: l.tags, date: l.date, source: "import" }, now);
    if (r.action === "skip") counts.skipped++;
    else if (r.action === "reinforced") counts.reinforced++;
    else if (r.action === "rejected") counts.rejected++;
    else if (r.entry?.status === "quarantine") counts.quarantined++;
    else counts.added++;
  }

  saveStoreAtomic(storePath, entries); // 先落盘；对账失败靠重跑 hash 去重自愈

  const accounted = counts.added + counts.quarantined + counts.reinforced + counts.skipped + counts.rejected;
  if (counts.parsed === accounted) {
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(
        markerFile,
        JSON.stringify({
          version: 3,
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

  // 对账失败：详情落 import-report.txt，不写 marker → 本会话跳过编译重写
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(markerFile), "import-report.txt"),
      [
        `import reconciliation failed ${new Date(now).toISOString()}`,
        JSON.stringify(counts, null, 2),
        `parsed(${counts.parsed}) != accounted(${accounted})`,
        "常见原因：源文件存在退化 `- ` 行或导入异常。修复源文件后重跑 maintain 重试。",
      ].join("\n") + "\n",
      "utf8"
    );
  } catch { /* 报告写失败不改变返回语义 */ }
  return { ok: false, counts };
}
