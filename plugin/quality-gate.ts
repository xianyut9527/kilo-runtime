// W3.7 质量门禁（三层交付检查的层 1 + 层 2）
//
// 层 1 步骤符合性：模型把 todo 标记 completed 时，交叉核对执行痕迹
//   （bash 命令 / 编辑文件 / 检索记录），「声称完成但无痕迹」即时回注警告。
//   启发式 fail-open：纯中文 todo、无可提取关键词的条目跳过审计（宁可漏报不误报）。
//   证据池含检索工具（read/grep/glob）——纯调研任务的痕迹此前不入池，必然误报。
// 层 2 测试缺口（W3.10 硬门禁）：编辑过代码文件 × 未跑过任何验证命令时，
//   todowrite「全部标记完成」在 before 钩子被直接否决（工具报错，比附注警告更难无视）。
//   逃生门：确认无法验证时显式登记 `echo "verify-skipped: 原因"`，跳过行为可审计，
//   不允许静默。仅代码后缀触发；文档/配置编辑不受限。
//   验证命令按「命令动词位」锚定识别——子串匹配会把 `git tag v0.1-test` 这类
//   含 test 字样的普通命令误判成「已验证」，方向是吞掉警告。
// 附加：edit/write 后按后缀跑静态检查（ruff / tsc --noEmit）——2026-09-22 改异步防抖：
//   编辑不再阻塞工具返回（5s 防抖 + 单飞后台跑，stderr 可观测），诊断积压在交付节点
//   强制冲刷回注（质量兜底不丢，成本集中支付一次）；tsc 加 --incremental（tsbuildinfo
//   存 Kilo 数据目录按项目哈希隔离，不污染用户项目；老 TS/写失败自动降级全量，损坏自动
//   删除重建）。工具可用性一次性探测、并发单飞共享一次 tsc、同文件 mtime 缓存复用语义不变。
// 层 3 全自动闭环（W3.9/W3.11）：交付节点（todo 全 completed + 高风险文件，或含代码改动
//   且跨 ≥5 文件——纯文档会话不烧审查费）由插件直调 dual-review 的 runDualReview。
//   审查对象自动构建：编辑文件清单 + git diff HEAD -- <本会话编辑的代码文件>（范围对齐本会话改动，
//   不审别会话的累积改动/tmp 脚本；含已暂存，截断防 prompt 爆炸）+ 未跟踪新文件全文（不在 diff 里，
//   审查者原本看不见），降级为会话证据池（脱敏命令）。
//   闭环硬约束（W3.11）：裁决存在「必须修复项」→ 阻断交付（before 钩子，修复须有新编辑，
//   重标记即自动复审，直到裁决通过）；自动审查上限 2 轮，超限放行并回注残余项升级人工确认；
//   接受残余风险须显式 echo "review-accepted: 原因"（可审计），防死循环烧钱。
//
// 设计红线：
//   - fail-closed 仅两处：层 2 测试缺口门禁与层 3 审查闭环（均带显式逃生门），
//     其余检查静默降级（try-catch 全包），只警告不拦截。
//   - 状态按 sessionID 分桶：Kilo 长驻进程服务多会话/子代理，进程级单例会让
//     「跑过验证」与「todo 快照」跨会话污染判定。桶上限 20 个，LRU 淘汰。
//     工具探测结果进程级共享（环境属性与会话无关）。
//   - bash 命令原文入桶前做凭证脱敏（authorization/token/key/password、URL 内嵌密码），
//     原文只用于关键词匹配，不回显。
// 2026-09-22 结果实证（P0-3）+ 审查素材缓存（P0-2）：
//   - bash 采集 exit code：证据池升级为 {cmd, exit, editV}，层 2 从「跑过验证命令」收紧为
//     「末次编辑后 exit===0 且退出形态可靠」（堵 compaction 丢失失败输出/合理化跳过/
//     跨会话盲区/撒谎四类尾巴）。退出码三段契约防御：output 显式字段 → metadata →
//     结果文本解析；全部落空 = 未知 → 降级旧口径放行（fail-open 不误杀）。遮蔽形态
//     （|| true / || echo / ; exit 0 / 无 pipefail 管道）只算「跑过」，不参与「跑赢」判定。
//   - 层 3 审查素材缓存：subject sha1 与上次完全一致 → 复用既有裁决（含未通过状态），
//     不为同一份 diff 重烧 2~4min 审查；diff/文件清单有任何变化立即失效。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runDualReview } from "./dual-review";

// 内联 DATA_DIR（不从 hx-client 导入——避免插件模块缓存交互导致 Kilo 7.7.6 config hook 级联崩溃）
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "kilo");

const TAG = "[quality-gate]";

// ── 进程级（环境属性，跨会话共享）────────────────────────────
let projectRoot = process.cwd();
const probe = { tsc: null, ruff: null }; // null=未探测，true/false=可用性
let tscInFlight = null; // 并发编辑单飞：共享同一次 tsc 全量输出
const DIAG_DEBOUNCE_MS = 5_000; // 编辑后防抖：5s 无新动作才真正跑诊断（编辑路径零阻塞）
let tscIncrementalOk = null; // null=未探测；false=项目 TS 过老/写失败，永久降级全量

// ── 会话级状态（sessionID 分桶）──────────────────────────────
const sessions = new Map(); // sessionID -> { commands, reads, lastTodos, edited, fileChecks }
const MAX_SESSIONS = 20;
const MAX_COMMANDS = 200;
const MAX_READS = 100;
const MAX_EDITED = 500;

function bucketOf(input) {
  const id = String(input?.sessionID ?? "__global__");
  let s = sessions.get(id);
  if (!s) {
    s = { commands: [], reads: [], lastTodos: [], edited: new Set(), fileChecks: new Map(), highRisk: new Set(), dualReviewed: false, reviewPending: null, reviewRounds: 0, editVersion: 0, codeEditV: 0, exitContractWarned: false, pendingDiags: new Set(), diagTimer: null, diagBusy: false, diagNotes: new Map(), reviewCache: null };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      // LRU 驱逐前清理挂起的诊断定时器：否则回调会在已脱离 Map 的会话对象上空跑 tsc
      const oldestKey = sessions.keys().next().value;
      const evicted = sessions.get(oldestKey);
      if (evicted?.diagTimer) { clearTimeout(evicted.diagTimer); evicted.diagTimer = null; }
      sessions.delete(oldestKey);
    }
  }
  return s;
}

// 凭证脱敏：保留命令结构供关键词匹配，抹掉敏感值
function scrubCommand(cmd) {
  return String(cmd ?? "")
    .slice(0, 500)
    // Bearer/Basic 后随令牌（含 "Authorization: Bearer xxx" 形态的真实令牌）
    .replace(/((?:authorization\s*:?\s*)?bearer\s+)\S+/gi, "$1***")
    .replace(/((?:authorization|basic)\s*:\s+)\S+/gi, "$1***")
    // flag 空格传值形态：--password xxx / --token xxx
    .replace(/(--(?:password|passwd|token|secret|api-key)\s+)\S+/gi, "$1***")
    // key=value / key: value 形态
    .replace(/((?:authorization|bearer|token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1***")
    // URL 内嵌凭证 user:pass@host
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1***@");
}

// 证据池条目统一取文本：新版为 {cmd, exit, editV}，旧版/测试夹具可能是纯字符串
function cmdText(c) {
  return typeof c === "string" ? c : String(c?.cmd ?? "");
}

// 退出码三段契约防御：output 显式字段 → metadata → 结果文本解析。
// 文本解析只认**独占一行的退出码声明**（多行模式行首锚定）——测试日志中的
// `Expected exit code: 0` 这类描述性文本不会被误采；成功时常无此行 → undefined=未知。
export function exitCodeOf(output) {
  const o = output ?? {};
  for (const k of ["exitCode", "exit", "code"]) {
    const v = o?.[k] ?? o?.metadata?.[k];
    if (typeof v === "number") return v;
  }
  const text = typeof o === "string" ? o : String(o?.output ?? o?.stdout ?? o?.stderr ?? "");
  const m = text.match(/^\s*exit(?:\s+code)?\s*[:=]\s*(\d{1,4})\s*$/im);
  return m ? Number(m[1]) : undefined;
}

function rememberCommand(s, cmd, exit, editV) {
  if (exit === undefined && !s.exitContractWarned) {
    // 防御日志（每会话一次，防刷屏也不永久静默）：钩子契约未采集到退出码
    // （调用方漏传参或 Kilo 结果无此信息）——该命令走「未知 → 降级旧口径」路径，
    // 静默削弱需在此留下排查线索
    s.exitContractWarned = true;
    console.error(`${TAG} exit code unavailable from hook contract（层 2 降级旧口径放行）: ${scrubCommand(cmd).slice(0, 80)}`);
  }
  s.commands.push({ cmd: scrubCommand(cmd), exit, editV });
  if (s.commands.length > MAX_COMMANDS) s.commands.shift();
}

// 验证命令识别：只认命令动词位（命令开头或 ; | || && 之后），自由子串会误放行
// （`git tag v0.1-test` 这类含 test 字样的普通命令不能算已验证）。
// 口径与 INSTRUCTIONS「测试或构建」对齐：build/type-check 计入；make/dotnet/phpunit
// 与直跑 test 前缀脚本（bun test-x.mjs——本仓离线测试的既定形态）也计入。
const VERIFY_CMD_RE =
  /(?:^|[;|]|&&|\|\|)\s*(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|lint|check|typecheck|type-check|build)\b|(?:npx|bunx)\s+(?:jest|vitest|tsc|eslint|ruff)\b|(?:jest|vitest|mypy|pytest|eslint|ruff|tsc)\s|go\s+(?:test|vet)\b|cargo\s+(?:test|check|clippy)\b|python[0-9.]*\s+-m\s+(?:pytest|unittest)\b|(?:mvn|gradlew?)\b[^;&|\n]*\btest\b|make\s+(?:test|check|lint)\b|dotnet\s+test\b|phpunit\b|(?:node|bun|deno|python[0-9.]*)\s+(?:[\w\/\\.-]*[\/\\])?tests?[\w\/\\.-]*\.(?:mjs|cjs|js|ts|tsx|py)\b)/i;
export { VERIFY_CMD_RE };

// ── 退出码遮蔽识别（P0-3 误报治理）──────────────────────────
// 这些形态下命令自身的 exit 不可信（失败会被吞成 0）：只算「跑过」，不参与「跑赢」判定。
// 注意：&& 不吞码（短路，左侧失败整体即失败）；|| false 不吞码（false 退出码为 1，
// 忠实保留前段失败）；|| exit N（N≠0）传播失败也不吞码——三者都不得标记为遮蔽。
// 已知残余（意图启发式的边界，宁少遮蔽不误杀）：tee/head 等透传后段技术上仍覆盖前段
// 退出码，此处按「用户意图是留档/截断而非掩盖」豁免；grep 会因匹配与否改变退出码，
// 已移出豁免（这类静默改写退出码的后段必须判遮蔽）。
const PIPE_PASS_THROUGH = /\|\s*(?:tee|head|tail|cat|less|more|wc|sort|uniq|column|iconv|tr)\b[^|;&]*/gi;
const SUCCESS_TAIL = /^(?:true|:|exit\s+0\b|echo)\b/i; // 以成功命令开头的分号尾段
export function exitMasked(cmd) {
  const c = String(cmd ?? "");
  // || true / || : / || echo ok / || exit 0 / 行尾悬挂 ||：|| 在失败侧续接返回 0 的后段
  if (/\|\|\s*(?:true|:|exit\s+0\b|echo\b)/i.test(c) || /\|\|\s*$/.test(c)) return true;
  // 分号链最终退出码由最后一个分号段决定：该段以成功命令开头，且所有 && 接续段
  // 都是成功命令（true && echo ok 整链退出码 0 吞掉前段失败；true && deploy 不吞）——遮蔽
  const tail = (c.split(";").pop() ?? "").trim();
  const segs = tail.split(/&&/i);
  if (SUCCESS_TAIL.test(tail) && segs.every((seg) => SUCCESS_TAIL.test(seg.trim()))) return true;
  // 无 pipefail 的管道：前段失败被后段吞掉。透传/截断类后段豁免（见头注），豁免后
  // 仍存在其他单管道 → 保守判遮蔽。pipefail 只认显式 `set ±o pipefail`（echo 文本/
  // 文件名里的 "pipefail" 字样不得误豁免）
  if (/(?<!\|)\|(?!\|)/.test(c) && !/\bset\s+[-+][a-zA-Z]*o\s+pipefail\b/i.test(c)) {
    if (/(?<!\|)\|(?!\|)/.test(c.replace(PIPE_PASS_THROUGH, " "))) return true;
  }
  return false;
}

// 层 2 判定（结果实证版）：
//   hasRanVerify —— 旧口径「跑过」：存在任何验证命令（无论 exit/时序/遮蔽），降级兜底用
//   hasVerified  —— 新口径「跑赢」：存在任一验证命令满足 exit===0、无遮蔽形态、发生在
//                   末次代码编辑之后（editV 为命令执行时的代码编辑计数）。exit 未知
//                   （钩子契约落空）不算跑赢，由 hasRanVerify 降级放行（fail-open 不误杀）
//   verifyFailureOf —— 最近一次验证「明确失败」（exit 非 0）：交付节点回注 + 层 2 拦截
function verifyScan(s) {
  const cmds = s.commands ?? [];
  for (let i = cmds.length - 1; i >= 0; i--) {
    const c = cmds[i];
    if (!VERIFY_CMD_RE.test(cmdText(c))) continue;
    return { idx: i, entry: c };
  }
  return null;
}

function hasRanVerify(s) {
  return verifyScan(s) !== null;
}

function hasVerified(s) {
  const curV = s.codeEditV ?? 0;
  if (curV <= 0) return false;
  // 新鲜可信通过：exit 0 + 无遮蔽 + 末次代码编辑之后（只看最近一条会漏掉
  // 「成功验证在前、遮蔽命令在后」的合法情形——遮蔽命令不构成可信负证据）
  let lastFreshPassIdx = -1;
  (s.commands ?? []).forEach((c, i) => {
    if (typeof c !== "object" || !VERIFY_CMD_RE.test(cmdText(c))) return;
    if (c.exit !== 0 || exitMasked(cmdText(c))) return;
    if (c.editV !== undefined && c.editV >= curV) lastFreshPassIdx = i;
  });
  if (lastFreshPassIdx < 0) return false;
  // 但新鲜通过之后不得再出现明确失败（exit 非 0 且无遮蔽 = 可信负证据，推翻此前通过）
  return !(s.commands ?? []).slice(lastFreshPassIdx + 1).some((c) => {
    if (typeof c !== "object" || !VERIFY_CMD_RE.test(cmdText(c))) return false;
    return typeof c.exit === "number" && c.exit !== 0 && !exitMasked(cmdText(c));
  });
}

function verifyFailureOf(s) {
  // 当前代码版本内的最近一次「明确失败」：editV 低于 codeEditV 的失败属于旧版本，
  // 回注会误导（代码已改、失败已不存在）。新鲜 exit 0 存在时 hasVerified 已先行放行。
  const curV = s.codeEditV ?? 0;
  let last = null;
  for (const c of s.commands ?? []) {
    if (typeof c !== "object" || !VERIFY_CMD_RE.test(cmdText(c))) continue;
    if (typeof c.exit === "number" && c.exit !== 0
        && c.editV !== undefined && c.editV >= curV) last = { cmd: cmdText(c), exit: c.exit };
  }
  return last;
}
export { hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker };

function rememberEdit(s, p) {
  if (typeof p !== "string" || !p) return;
  s.edited.add(p);
  s.editVersion = (s.editVersion ?? 0) + 1; // 层 3 闭环：编辑计数（所有文件），审查后有无修复靠它判定
  if (isCodeFile(p)) s.codeEditV = (s.codeEditV ?? 0) + 1; // 层 2 验证新鲜度：只数代码文件，验证后改文档不作废
  if (s.edited.size > MAX_EDITED) s.edited.delete(s.edited.values().next().value);
}

// 检索工具痕迹入池（层 1 证据）：纯调研任务的 read/grep/glob 若不入池，
// 「已完成调研 X」必然因无痕迹被误报——检索本身就是执行痕迹。
function rememberRead(s, tool, args) {
  const parts = [];
  const push = (v) => {
    if (typeof v === "string" && v) parts.push(v);
    else if (Array.isArray(v)) v.forEach(push);
  };
  push(args?.filePath);
  push(args?.path);
  push(args?.paths);
  push(args?.pattern);
  if (parts.length === 0) return;
  s.reads.push(`${tool}: ${parts.join(" ")}`.slice(0, 200));
  if (s.reads.length > MAX_READS) s.reads.shift();
}

// ── 层 2 硬门禁判定素材 ─────────────────────────────────────
// 只对代码后缀生效：文档/配置编辑没有「跑测试」的自然义务，硬拦即误报
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts", "py", "java", "kt", "kts",
  "go", "rs", "cs", "cpp", "cc", "c", "h", "hpp", "vue", "svelte", "rb", "php", "swift", "scala", "sql",
]);

function isCodeFile(f) {
  const m = String(f ?? "").match(/\.(\w+)$/);
  return !!m && CODE_EXT.has(m[1].toLowerCase());
}

// 显式跳过登记：`echo "verify-skipped: 原因"`（逃生门——跳过必须显式且可审计，不许静默）
const VERIFY_SKIP_RE = /verify-skipped\s*:/i;

function hasSkipMarker(s) {
  return (s.commands ?? []).some((c) => VERIFY_SKIP_RE.test(cmdText(c)));
}

// ── 层 3 闭环（审查未通过 → 阻断交付，修复后自动再审，直到通过或升级人工）──
const MAX_REVIEW_ROUNDS = 2; // 自动审查轮次上限：超限放行并回注残余项（升级人工），防死循环烧钱
const REVIEW_ACCEPT_RE = /review-accepted\s*:/i;

function hasAcceptMarker(s) {
  return (s.commands ?? []).some((c) => REVIEW_ACCEPT_RE.test(cmdText(c)));
}

// 从裁决文本解析结论。fail = 裁决「不通过」或「必须修复项」段非空；
// inconclusive = 文本里没有「## 裁决」段（上游失败/一路阵亡等），不阻断（fail-open）。
export function parseReviewVerdict(text) {
  const t = String(text ?? "");
  // 段落提取：以「## 」标题定位，截到下一个「## 」或 <details> 为止（正则刻意不含换行转义）
  const sectionAfter = (heading) => {
    const i = t.indexOf(heading);
    if (i < 0) return null;
    const rest = t.slice(i + heading.length);
    const end = rest.search(/##\s|<details>/);
    return (end < 0 ? rest : rest.slice(0, end)).trim();
  };
  const verdictSection = sectionAfter("## 裁决");
  const fixSection = sectionAfter("## 必须修复项") ?? "";
  // 「必须修复项」段剥掉「无/none」与列表符号后仍有实质内容 → 有必须修复项
  const stripped = fixSection.replace(/^(无|none)[.。]?/i, "").replace(/[-*•\s]+/g, "");
  const mustFixEmpty = stripped.length === 0;
  // 模型把选项原样回显（含「三选一」提示）时裁决段不可信，只按「必须修复项」段判定
  const echoOptions = /三选一/.test(verdictSection ?? "");
  return {
    fail: (!echoOptions && /不通过/.test(verdictSection ?? "")) || !mustFixEmpty,
    inconclusive: verdictSection === null,
    verdictLine: (verdictSection ?? "").slice(0, 100),
    fixSection: fixSection.slice(0, 600),
  };
}

function codeEditsOf(s) {
  return [...s.edited].filter(isCodeFile);
}

// 层 3 触发口径（before/after 钩子共用，防两处漂移）：
// 高风险文件命中即触发（文件数无关）；普通改动须含代码且跨 ≥5 文件。
// ≥3 口径 2026-09-22 上调为 ≥5：48h 遥测实测每次自动审查墙钟 5~8min（22 次共 35min），
// 常规 3~4 文件任务的质量收益不抵交付节点卡顿；纯文档会话依旧不烧审查费。
function isComplexDelivery(s, codeEdits) {
  return (s?.highRisk?.size ?? 0) > 0 || ((codeEdits?.length ?? 0) > 0 && (s?.edited?.size ?? 0) >= 5);
}
export { isComplexDelivery };

// ── todo 证据核对（层 1）──────────────────────────────────────
// 停用词：todo 文本里的动词虚词，提取实义 token 用于与证据串匹配
const STOPWORDS = new Set(
  ("实现 完成 添加 编写 更新 修复 运行 执行 集成 创建 新建 增加 删除 移除 支持 处理 优化 重构 " +
    "检查 确认 验证 确保 生成 输出 补充 修改 调整 发布 部署 配置 注册 登记 " +
    "the a an of for and or to in on with by is are be done all some").split(/\s+/)
);

function keywordsOf(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^\w\u4e00-\u9fff.-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function evidencePool(s) {
  return [...s.commands.map(cmdText), ...s.reads, ...s.edited].join("\n").toLowerCase();
}

function auditTodos(prev, next, pool) {
  const prevDone = new Set(
    (Array.isArray(prev) ? prev : []).filter((t) => t?.status === "completed").map((t) => t?.content ?? "")
  );
  const suspicious = [];
  const nowDone = (Array.isArray(next) ? next : []).filter((t) => t?.status === "completed");
  for (const t of nowDone) {
    const content = String(t?.content ?? "");
    if (!content || prevDone.has(content)) continue; // 之前就完成的，不在本次核对范围
    // 纯中文 todo：连续 CJK 无法可靠拆词，整串几乎不可能命中证据池，
    // 逐条审计只会系统性误报——跳过（fail-open，与设计意图一致）
    if (!/[A-Za-z0-9]/.test(content)) continue;
    const kws = keywordsOf(content);
    if (kws.length === 0) continue;
    const hit = kws.some((k) => pool.includes(k));
    if (!hit) suspicious.push(content.slice(0, 120));
  }
  return suspicious;
}

// ── 编辑后静态检查（附加层）───────────────────────────────────
function runCmd(cmd, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, out: `${stdout ?? ""}${stderr ?? ""}` }));
    } catch (e) {
      resolve({ err: e, out: "" });
    }
  });
}

// 工具可用性一次性探测：缺失/离线环境永久跳过，不再每轮编辑烧满超时
async function probeTool(name) {
  if (probe[name] !== null) return probe[name];
  const { err } = name === "tsc"
    ? await runCmd("npx", ["tsc", "--version"], 8_000, projectRoot)
    : await runCmd(name, ["--version"], 8_000, projectRoot);
  probe[name] = !err;
  if (!probe[name]) console.error(`${TAG} ${name} 不可用（探测失败），静态检查跳过该工具`);
  return probe[name];
}

function tsconfigMtimeOf(dir) {
  try {
    const p = path.join(dir, "tsconfig.json");
    if (!fs.existsSync(p)) return null;
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// 单飞：并发到达的多个编辑共享同一次 tsc 运行（--incremental 暖机秒级，失败自动降级全量）
// tsbuildinfo 放 Kilo 数据目录按项目哈希隔离——不写进用户项目（不污染仓库/不进 git status）
let tsbuildInfoPath = null;
function tsbuildInfoFor(dir) {
  if (tsbuildInfoPath !== null) return tsbuildInfoPath;
  try {
    const h = createHash("sha1").update(fs.realpathSync(dir)).digest("hex").slice(0, 12);
    const d = path.join(DATA_DIR, "tsc-cache");
    fs.mkdirSync(d, { recursive: true });
    tsbuildInfoPath = path.join(d, `${h}.tsbuildinfo`);
  } catch {
    tsbuildInfoPath = ""; // 拿不到数据目录 → 不传 --incremental（全量）
  }
  return tsbuildInfoPath;
}

function runTscOnce(dir) {
  if (!tscInFlight) {
    const args = ["tsc", "--noEmit", "--pretty", "false"];
    const tsb = tscIncrementalOk !== false ? tsbuildInfoFor(dir) : "";
    if (tsb) args.push("--incremental", `--tsBuildInfoFile`, tsb);
    tscInFlight = runCmd("npx", args, 20_000, dir)
      .then((r) => {
        // 首次带增量参数运行：TS 过老报未知选项 → 永久降级全量，本次立即重跑出真诊断
        if (tsb && tscIncrementalOk === null && /unknown option|TS5023|TS6046/i.test(r.out)) {
          tscIncrementalOk = false;
          console.error(`${TAG} tsc 不支持 --incremental，降级全量检查`);
          try { fs.rmSync(tsb, { force: true }); } catch { }
          return runCmd("npx", ["tsc", "--noEmit", "--pretty", "false"], 20_000, dir);
        }
        if (tsb && tscIncrementalOk === null) tscIncrementalOk = true;
        return r;
      })
      .finally(() => { tscInFlight = null; });
  }
  return tscInFlight;
}

async function tsDiagnose(file, dir, s) {
  if (!(await probeTool("tsc"))) return [];
  if (tsconfigMtimeOf(dir) === null) return []; // 无 tsconfig（非 TS 项目）→ 跳过
  const mtimeMs = fileMtime(file);
  const cached = s.fileChecks.get(file);
  if (cached && cached.kind === "ts" && cached.mtimeMs === mtimeMs) return cached.diags;
  const { out } = await runTscOnce(dir);
  const lines = String(out ?? "").split(/\r?\n/).filter((l) => /\((\d+),(\d+)\)|error TS\d+/.test(l));
  const diags = lines.filter((l) => l.includes(file));
  s.fileChecks.set(file, { kind: "ts", mtimeMs, diags });
  return diags;
}

async function ruffDiagnose(file, dir, s) {
  if (!(await probeTool("ruff"))) return [];
  const mtimeMs = fileMtime(file);
  const cached = s.fileChecks.get(file);
  if (cached && cached.kind === "py" && cached.mtimeMs === mtimeMs) return cached.diags;
  const { out } = await runCmd("ruff", ["check", "--no-cache", "--output-format=concise", file], 10_000, dir);
  const diags = String(out ?? "").split(/\r?\n/).filter((l) => l.trim());
  s.fileChecks.set(file, { kind: "py", mtimeMs, diags });
  return diags;
}

async function staticDiagnose(file, dir, s) {
  const ext = (file.match(/\.(\w+)$/) ?? [])[1]?.toLowerCase();
  if (ext === "py") return ruffDiagnose(file, dir, s);
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return tsDiagnose(file, dir, s);
  return null; // 其他后缀 v1 不做（js/eslint 与 go vet 后续按需加）
}

// ── 异步诊断调度（P0-1：编辑路径零阻塞）──────────────────────
// 编辑 → 登记待诊文件 + 5s 防抖 → 后台单飞跑诊断 → 结果进 s.diagNotes（stderr 可观测）
// → 交付节点（todowrite 全 completed）flushDiags 强制等待冲刷回注。质量兜底不丢，
//  成本从「每次编辑都阻塞」变成「交付时集中付一次」。
function scheduleDiags(s) {
  if (s.pendingDiags.size === 0) return;
  if (s.diagTimer) clearTimeout(s.diagTimer);
  s.diagTimer = setTimeout(() => { s.diagTimer = null; void runDiags(s); }, DIAG_DEBOUNCE_MS);
  // 定时器只需让事件循环等到它触发：unref 防止 Kilo 关闭时被挂起进程拖住
  try { s.diagTimer.unref?.(); } catch { }
}

async function runDiags(s) {
  if (s.diagBusy) return; // 上一次还在跑：文件已入 pendingDiags，下轮防抖会再跑
  s.diagBusy = true;
  const files = [...s.pendingDiags];
  s.pendingDiags.clear();
  try {
    for (const f of files) {
      const diags = await staticDiagnose(f, projectRoot, s);
      if (diags && diags.length > 0) s.diagNotes.set(f, diags);
    }
    if (files.length > 0) {
      const bad = [...s.diagNotes.keys()].length;
      console.error(`${TAG} 后台静态检查完成：${files.length} 个文件，${bad} 个有诊断待交付冲刷`);
    }
  } catch (e) {
    console.error(TAG, "async diagnose failed:", e?.message ?? e);
  } finally {
    s.diagBusy = false;
  }
}

// 交付节点冲刷：跳过防抖立即跑完积压诊断（若有），返回所有未修复诊断的回注文本
async function flushDiags(s) {
  if (s.diagTimer) { clearTimeout(s.diagTimer); s.diagTimer = null; }
  if (s.pendingDiags.size > 0 && !s.diagBusy) await runDiags(s);
  // 正在后台跑的最后一轮：等它落地（有界等待防卡交付）
  let waited = 0;
  while (s.diagBusy && waited < 21_000) {
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  if (s.diagNotes.size === 0) return null;
  const parts = [...s.diagNotes.entries()].map(([f, diags]) =>
    `${f}（共 ${diags.length} 条）：\n  ${diags.slice(0, 20).join("\n  ")}`);
  s.diagNotes.clear();
  return `静态检查诊断（后台汇总，需修复后再交付）：\n${parts.join("\n")}`;
}

// ── 回注通道 ─────────────────────────────────────────────────
// 契约防御：tool.execute.after 的结果文本挂在 output.output（字符串）。
// 拿不到就静默放弃回注（检查白做也不伤主流程），并打 stderr 日志供排查。
function appendToResult(output, text) {
  try {
    if (output && typeof output === "object" && typeof output.output === "string") {
      output.output = output.output + "\n" + text;
      return;
    }
  } catch { /* 回注失败不影响工具本身 */ }
  console.error(`${TAG} result channel unavailable, note dropped: ${text.slice(0, 120)}`);
}

// ── 高风险路径识别（层 3 自动执行的依据）──────────────────────
// 命中即视为复杂/高风险改动：交付节点若本会话未做过双向审查，插件直调 runDualReview 自动执行。
// 范围参照 INSTRUCTIONS「高风险」口径：认证/权限/支付/数据迁移/公共契约/核心配置。
// 两种命中形态：① 文件名以关键词开头（auth.ts / order-query.ts）；
// ② 关键词是完整路径段（目录名——src/auth/utils.ts 这类文件名不含关键词的同样命中；
//    正因目录语义，order-system/ 这类仅前缀相似的目录不会误命中）。
const HIGH_RISK_RE =
  /(?:^|[/\\])(?:auth|authentication|login|session|token|jwt|permission|acl|rbac|payment|pay|billing|charge|wallet|order|transaction|migration|migrate|ddl|schema|contract|api[-_]?design|public)(?:[-_.\w]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|cs|sql)$|[/\\])/i;
export { HIGH_RISK_RE };

function isHighRiskFile(file) {
  return HIGH_RISK_RE.test(String(file ?? ""));
}

function extractArgs(input, output) {
  return input?.args ?? output?.args ?? input?.call?.args ?? {};
}

function extractTool(input) {
  return String(input?.tool ?? input?.toolName ?? "");
}

// ── 层 3 全自动：审查对象自动构建 ─────────────────────────────
// 范围对齐「本会话改动」而非「整个工作区未提交改动」：git diff 只取本会话编辑过的代码文件
// （git diff HEAD -- <pathspec>）。多会话共享工作区且 HEAD 不动时，git diff HEAD 会把所有
// 会话的累积改动 + tmp 脚本都算进来，审错范围（2026-09-17 事故：正向模型审了旧 diff）。
// 已暂存改动仍可见（git diff HEAD 含 staged）；未跟踪新文件不在 diff 里——按「diff 中未出现」
// 逐个补读全文（有界：最多 8 个 × 4000 字符）；无 git（非 repo / 命令失败）则降级为会话证据池。
// 已提交的改动不在任何 diff 里（会话中途 commit 的场景）——由文件名清单兜底可见性。
export async function reviewSubject(root, s, editedList) {
  const parts = [`本次会话编辑了以下文件：\n${editedList}`];
  // pathspec 数量设上限：edited 可达 MAX_EDITED(500)，全列进命令行会超 Windows 32767 字符上限
  // 导致 git 进程启动失败（ENAMETOOLONG）。审查素材本就截断到 24000 字符，前 100 个代码文件的
  // diff 已足够覆盖视野，其余靠文件名清单可见。超出 100 个的情况 = 超大改动，单轮审查也看不完。
  const editedCodeFiles = [...s.edited].filter(isCodeFile).slice(0, 100);
  let diffText = "";
  if (editedCodeFiles.length > 0) {
    try {
      // git diff HEAD -- <path...> 只输出给定路径的改动；路径不存在/已删除 git 静默跳过
      const { out } = await runCmd(
        "git",
        ["diff", "HEAD", "--unified=3", "--no-color", "--", ...editedCodeFiles],
        10_000,
        root,
      );
      diffText = String(out ?? "");
    } catch { /* 非 git 环境：走降级 */ }
  }
  if (diffText.trim().length > 50) parts.push(`对应 git diff：\n${diffText}`);
  const unseen = editedCodeFiles.filter((f) => !diffText.includes(path.basename(f))).slice(0, 8);
  for (const f of unseen) {
    try {
      const content = fs.readFileSync(f, "utf8");
      if (content.trim()) parts.push(`### ${f}（完整内容——未出现在 diff 中，新文件）\n${content.slice(0, 4000)}`);
    } catch { /* 文件已移走则跳过 */ }
  }
  if (diffText.trim().length <= 50 && unseen.length === 0) {
    parts.push(`会话内执行过的命令（已脱敏）：\n${s.commands.slice(-30).map(cmdText).join("\n") || "（无）"}`);
  }
  return parts.join("\n\n").slice(0, 24000);
}

export const QualityGate = async ({ directory } = {}) => {
  // 工作区根由 Kilo 注入（同 compaction-anchor/memory-bootstrap 契约）；
  // 用它而非 process.cwd()，否则 worktree/monorepo 场景下 tsconfig 探测必败、检查静默关闭
  if (directory) projectRoot = directory;
  return {
    // 层 2 硬门禁（fail-closed 点之一，另一处是层 3 审查闭环）：编辑过代码文件 × 未验证/未登记跳过
    // → 否决 todowrite 的「全部标记完成」。报错即行动指引（跑验证或显式登记跳过）。
    "tool.execute.before": async (input, output) => {
      try {
        if (extractTool(input) !== "todowrite") return;
        const args = extractArgs(input, output);
        const todos = Array.isArray(args?.todos) ? args.todos : null;
        if (!todos || todos.length === 0) return;
        if (!todos.every((t) => t?.status === "completed")) return; // 只拦「全部完成」的交付节点
        const s = bucketOf(input);
        const codeEdits = codeEditsOf(s);
        // 层 3 闭环硬阻断（交付前）：上轮审查未通过且其后没有任何新编辑（= 未尝试修复）→ 否决。
        // 修复过文件则放行本次 todowrite，由 after 钩子在交付节点重新审查（修复→再审循环）。
        // 触发口径与 after 钩子一致：高风险文件，或含代码改动且跨 ≥5 文件——
        // 纯文档会话不送付费审查（层 2 同样豁免文档，口径对齐）。
        const complexEarly = isComplexDelivery(s, codeEdits);
        if (complexEarly && s.reviewPending && !hasAcceptMarker(s) && s.editVersion === s.reviewPending.editVersion) {
          const p = s.reviewPending;
          throw new Error(
            `[quality-gate] 层 3 闭环：双向审查未通过（${p.verdictLine || "有条件通过"}），存在未处理的必须修复项：\n${p.fixSection}\n\n` +
              `二选一：① 逐条修复后重新标记全部完成——将自动触发第 ${s.reviewRounds + 1}/${MAX_REVIEW_ROUNDS} 轮审查；` +
              `② 确认接受残余风险则执行 echo "review-accepted: <原因>"（可审计）后重试。`
          );
        }
        if (codeEdits.length === 0) return; // 非代码编辑不受限
        if (hasSkipMarker(s)) return;
        // 结果实证（P0-3）：只认末次代码编辑后 exit 0 的验证命令；
        // 跑过但失败 → 拦下要求修复重跑；exit 未知（契约落空/遮蔽形态）→ 降级旧口径放行
        if (hasVerified(s)) return;
        const failure = verifyFailureOf(s);
        if (failure) {
          throw new Error(
            `[quality-gate] 层 2 结果实证：验证命令已运行但失败（exit=${failure.exit}）：\n  ${failure.cmd.slice(0, 160)}\n` +
              `「跑过」不算数，要「跑赢」——修复后重跑该验证拿到 exit 0 再标记全部完成；` +
              `确无法验证则执行 echo "verify-skipped: <原因>" 显式登记。`
          );
        }
        if (hasRanVerify(s)) return; // 降级：有验证痕迹但退出码未知（fail-open，与旧口径一致）
        const names = codeEdits.slice(0, 3).map((f) => f.split(/[\\/]/).pop()).join(", ");
        throw new Error(
          `[quality-gate] 层 2 硬门禁：本次会话编辑过 ${codeEdits.length} 个代码文件（${names}${codeEdits.length > 3 ? " 等" : ""}），` +
            `但未运行任何测试/静态检查命令，todo 不允许标记为全部完成。二选一：` +
            `① 真跑验证（npm test / npx tsc --noEmit / ruff check 等，贴出命令与结果，「应该能过」不算）；` +
            `② 确认无法验证时显式登记跳过原因——执行 echo "verify-skipped: <原因>" 后重试标记（跳过会被审计）。`
        );
      } catch (e) {
        // 门禁报错本身就是否决信号，必须重抛；其余异常 fail-open 不拦
        if (String(e?.message ?? e).includes("[quality-gate]")) throw e;
        console.error(TAG, "before-gate failed:", e?.message ?? e);
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const tool = extractTool(input);
        const args = extractArgs(input, output);
        const s = bucketOf(input);

        // ① 记录 bash 命令（脱敏后入证据池 + 验证判定）；P0-3 同时采集退出码
        //    （三段契约防御，拿不到=undefined，层 2 降级旧口径）
        if (tool === "bash" || tool === "shell") {
          const cmd = typeof args === "string" ? args : String(args?.command ?? "");
          rememberCommand(s, cmd, exitCodeOf(output), s.codeEditV ?? 0);
          return;
        }

        // ①' 检索工具痕迹入证据池（层 1：纯调研任务的执行痕迹）
        if (["read", "grep", "glob", "list"].includes(tool)) {
          rememberRead(s, tool, args);
          return;
        }

        // ①'' dual_review 调用登记（层 3 自动闭环：完成节点查此标志）
        // 手动补审同时清 reviewPending：显式复审过的会话不应再被 before 钩子按旧裁决误拦
        if (tool === "dual_review") {
          s.dualReviewed = true;
          s.reviewPending = null;
          return;
        }

        // ② 记录编辑 + 异步防抖静态检查（P0-1：编辑路径零阻塞，诊断由交付节点冲刷回注）
        if (tool === "edit" || tool === "write") {
          const file = String(args?.filePath ?? args?.path ?? "");
          if (file) {
            rememberEdit(s, file);
            if (isHighRiskFile(file)) s.highRisk.add(file);
            s.pendingDiags.add(file); // 刚写过 mtime 必变，mtime 缓存必失效 → 一律入队防抖
            scheduleDiags(s);
          }
          return;
        }

        // ③ todowrite：步骤符合性核对 + 测试缺口检测 + 层 3 双向审查自动执行
        if (tool === "todowrite") {
          const todos = Array.isArray(args?.todos) ? args.todos : null;
          if (!todos) return;
          const pool = evidencePool(s);
          const suspicious = auditTodos(s.lastTodos, todos, pool);
          s.lastTodos = todos.map((t) => ({ content: t?.content ?? "", status: t?.status ?? "" }));

          const notes = [];
          if (suspicious.length > 0) {
            notes.push(
              `⚠️ 步骤符合性核对：以下条目标记 completed 但未发现对应执行痕迹（bash/编辑/检索），` +
                `请补做或明确说明，不要留空口声明：\n` +
                suspicious.map((x) => `  - ${x}`).join("\n")
            );
          }
          const codeEdits = codeEditsOf(s);
          const allDone = todos.length > 0 && todos.every((t) => t?.status === "completed");
          // P0-1b：交付节点强制冲刷积压诊断（编辑已零阻塞，成本集中在此付一次）
          if (allDone) {
            try {
              const flushText = await flushDiags(s);
              if (flushText) {
                notes.push(`⚠️ ${flushText}`);
                console.error(`${TAG} 交付冲刷：后台静态检查有未修复诊断，已回注`);
              }
            } catch (e) {
              console.error(TAG, "flush diags failed:", e?.message ?? e);
            }
          }
          if (codeEdits.length > 0 && !hasRanVerify(s)) {
            if (hasSkipMarker(s)) {
              notes.push(
                `ℹ️ 已登记跳过验证（verify-skipped，原因在命令记录中可审计）——交付说明必须引用该原因。`
              );
            } else {
              // 兜底：正常情况下 before 硬门禁已否决此状态；若 before 契约失效仍在此警告
              notes.push(
                `⚠️ 测试缺口：本次会话已编辑 ${codeEdits.length} 个代码文件，但未跑过任何测试/静态检查命令。` +
                  `交付前必须真跑（贴出命令与结果，「应该能过」不算）；确无法验证则 echo "verify-skipped: 原因" 显式登记。`
              );
            }
          } else if (codeEdits.length > 0 && !hasVerified(s) && !hasSkipMarker(s)) {
            // 「跑过」但没「跑赢」且未被 before 拦下（= 退出码未知降级放行）→ 提示性回注
            const failure = verifyFailureOf(s);
            if (failure) {
              notes.push(
                `⚠️ 结果实证：验证命令运行失败（exit=${failure.exit}）：${failure.cmd.slice(0, 160)}。` +
                  `修复后重跑拿到 exit 0 再交付，「跑过」不算数。`
              );
            } else {
              notes.push(
                `ℹ️ 验证命令退出码未知（钩子契约未采集到），本次按旧口径放行——建议贴出验证输出佐证。`
              );
            }
          }

          // 层 3 全自动执行 + 闭环：todo 全部 completed（交付节点）+ 高风险/复杂改动
          // + 本会话审查未通过/未做过 → 插件直调 runDualReview（正反审查+裁决）。
          // 闭环语义：裁决未通过 → 记录 must-fix 并阻断本次交付（before 钩子），
          // 修复后重新标记完成 → 此处自动再审；通过才置 dualReviewed。
          // 轮次上限（MAX_REVIEW_ROUNDS）后仍不过 → 放行并回注残余项（升级人工，防死循环）。
          // 无法解析的裁决（上游失败等）→ fail-open 不阻断（质量降质但不卡交付）。
          // P0-2 素材缓存：审查素材 sha1 与上次完全一致 → 复用既有裁决，不为同一份 diff
          // 重烧 2~4min；diff/文件清单有任何变化即失效。
          // 与 before 钩子同一口径：高风险文件，或含代码改动且跨 ≥5 文件（纯文档不烧审查费）
          const complex = isComplexDelivery(s, codeEdits);
          if (allDone && complex && !s.dualReviewed && !hasAcceptMarker(s)) {
            const editedList = [...s.edited].slice(0, 30).join("\n");
            const subject = await reviewSubject(projectRoot, s, editedList);
            const subjectKey = createHash("sha1").update(subject).digest("hex");
            let verdict = null;
            if (s.reviewCache && s.reviewCache.key === subjectKey) {
              verdict = s.reviewCache.verdict;
              console.error(`${TAG} 层 3 审查素材与上次完全一致（hash 命中），复用既有裁决，不重复烧审查`);
              appendToResult(output, `\n${TAG} 层 3 审查素材与上次完全一致（hash 命中），复用既有裁决，不重复烧审查。`);
            } else {
              const reviewT0 = Date.now();
              // 钩子无 ctx.metadata 通道：runDualReview 内部已把进度标题降级 stderr
              // （阶段首现立即输出、同阶段 10s 节流）；上游首字未到时 onDelta 不触发，
              // 补一个 30s 心跳兜住这段死区，消除「黑盒卡死」观感
              console.error(`${TAG} 层 3 双向审查执行中（正反两路异源模型 + 裁决，输出已限长，预计 2~4min）…`);
              const hb = setInterval(() => {
                console.error(`${TAG} 层 3 审查仍在进行… ${Math.round((Date.now() - reviewT0) / 1000)}s`);
              }, 30_000);
              try {
                verdict = await runDualReview(subject);
                const reviewSecs = ((Date.now() - reviewT0) / 1000).toFixed(1);
                appendToResult(output, `\n${TAG} 层 3 双向审查（自动执行，正反异源模型+裁决，耗时 ${reviewSecs}s）\n${verdict}`);
                s.reviewCache = { key: subjectKey, verdict };
              } catch (e) {
                console.error(TAG, "auto dual review failed:", e?.message ?? e);
              } finally {
                clearInterval(hb);
              }
            }
            if (verdict != null) {
              const v = parseReviewVerdict(verdict);
              if (v.inconclusive) {
                // 上游失败/一路阵亡：不阻断（fail-open），但一次为限防重复烧钱
                s.dualReviewed = true;
                appendToResult(output, `\n${TAG} ⚠️ 审查结果无法解析（上游失败），本次按未审查交付，请人工留意。`);
              } else if (v.fail) {
                s.reviewRounds += 1;
                if (s.reviewRounds >= MAX_REVIEW_ROUNDS) {
                  s.dualReviewed = true;
                  appendToResult(
                    output,
                    `\n${TAG} ⚠️ 已连续 ${s.reviewRounds} 轮审查未通过，达到自动审查上限，放行交付。\n` +
                      `残余必须修复项（交付前请人工确认）：\n${v.fixSection}`
                  );
                } else {
                  s.reviewPending = { editVersion: s.editVersion, verdictLine: v.verdictLine, fixSection: v.fixSection };
                  appendToResult(
                    output,
                    `\n${TAG} ❌ 审查未通过，交付已阻断：必须修复项未处理。修复后重新标记全部完成将自动再审（第 ${s.reviewRounds + 1}/${MAX_REVIEW_ROUNDS} 轮）；` +
                      `确认接受残余风险则 echo "review-accepted: <原因>"。`
                  );
                }
              } else {
                s.dualReviewed = true;
                s.reviewPending = null;
                appendToResult(output, `\n${TAG} ✅ 审查通过，闭环结束。`);
              }
            }
          }
          if (notes.length > 0) {
            appendToResult(output, `\n${TAG} 交付检查\n${notes.join("\n\n")}`);
          }
        }
      } catch (e) {
        console.error(TAG, "audit failed:", e?.message ?? e);
      }
    },
  };
};

export default QualityGate;
