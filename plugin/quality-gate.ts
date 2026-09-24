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
//   强制冲刷回注（质量兜底不丢，成本集中支付一次）；冲刷有总预算上限（30s）+ 编辑计数
//   比对（复用层 2「末次编辑后」语义：等待期间又编辑 → 诊断不覆盖末次编辑，补跑一轮，
//   仍不覆盖则带陈旧标注返回，防防抖单飞下死等或分钟级阻塞）；tsc 加 --incremental
//   （tsbuildinfo 存 Kilo 数据目录按项目哈希隔离，不污染用户项目；老 TS/写失败自动降级
//   全量，损坏自动删除重建）。工具可用性一次性探测、并发单飞共享一次 tsc、同文件 mtime
//   缓存复用语义不变。
// 层 3 全自动闭环（W3.9/W3.11）：交付节点（todo 全 completed + 高风险文件，或含代码改动
//   且跨 ≥3 文件——纯文档会话不烧审查费）由插件直调 dual-review 的 runDualReview。
//   审查对象自动构建：编辑文件清单 + git diff HEAD -- <本会话编辑的代码文件>（范围对齐本会话改动，
//   不审别会话的累积改动/tmp 脚本；含已暂存，截断防 prompt 爆炸）+ 未跟踪新文件全文（不在 diff 里，
//   审查者原本看不见），降级为会话证据池（脱敏命令）。
//   闭环硬约束（W3.11）：裁决存在「必须修复项」→ 阻断交付（before 钩子，修复须有新编辑，
//   重标记即自动复审，直到裁决通过）；自动审查上限 2 轮，超限放行并回注残余项升级人工确认；
//   接受残余风险须显式 echo "review-accepted: 原因"（可审计），防死循环烧钱。
// ⑤⑥⑦⑧ 审计闭环（2026-09-24）：⑤ 残余必须修复项自动沉淀进项目记忆 Open Questions
//   （review_residual_<date>_<sha8> 行，与 kilo_memory_recall token 检索兼容）；
//   ⑥ 部署≠生效检测——插件代码部署更新后，运行中的旧进程仍执行内存里的旧逻辑
//   （plugin_deploy_no_hot_reload 实证），交付节点以内容指纹节流比对磁盘，发现自身
//   过期即告警升级人工（fail-open 不拦截，部署动作本身合法）；
//   ⑦ 会话内全部 fail-open/显式放行事件记 s.degradations 账本，交付节点一次性汇总回注——
//   覆盖所有静默降级分支（诊断工具异常/审查链路异常/证据降级），「查了也看不见」变可见；
//   ⑧ 二轮起审查不可解析（上游阵亡）或 runDualReview 抛错时，前轮未确认修复的
//   必须修复项不再丢失——沉淀项目记忆 + 入账本后按未审查交付。
//   以上全部零模型调用、纯本地 fs/字符串操作，不增加交付延迟（⑥ 内容比对 <1ms、节流限频）。
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
//   - 层 3 审查素材缓存：缓存键 = 审查器指纹（审查器版本 + 配置模型三元组，由
//     dual-review.reviewerFingerprint 提供）+ 素材 sha1，完全一致才复用既有裁决
//     （含未通过状态），不为同一份 diff 重烧 2~4min 审查；diff/文件清单/prompt 版本/
//     模型配置任何变化立即失效——绝不复用异构模型的旧裁决（2026-09-22 三模型裁决必须项）。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// runDualReview 走 hook 内动态 import——模块级爆炸半径隔离（非注册表原因：
// vE2 只迭代各插件文件自身的导出，import 链不参与注册，静态 import 不会"污染"什么）。
// 真实价值：静态 import 会把 dual-review 及其依赖链（lib/hx-client）的模块求值提前到
// quality-gate 加载期，且发生在 never-throw 工厂包装之前（import 提升，try/catch 罩不住）——
// 依赖链上任一模块级抛错都会让层1/2 宿主 quality-gate 陪葬 "failed to load plugin"，
// 三层门禁全灭。动态 import 把故障压缩到层 3 执行期：层1/2 照常强制，层3 降级报错。

// 内联 DATA_DIR（不从 hx-client 导入——避免插件模块缓存交互导致 Kilo 7.7.6 config hook 级联崩溃）
// 防御包裹：任何模块级抛错都会让 Kilo 报 "failed to load plugin" 并触发 config hook 级联崩溃
let DATA_DIR;
try {
  DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "kilo");
} catch {
  DATA_DIR = ".";
}

// ⑥ 部署≠生效检测（2026-09-24 查漏补缺）：Kilo 不热加载插件——install.ps1 下发新版后，
// 运中的旧进程仍执行旧逻辑（plugin_deploy_no_hot_reload 实证：⑤⑦ 落地当轮残余项未沉淀即此因）。
// 加载期记自身指纹（源码 sha1，经 fileURLToPath 定位——URL 对象直读在部分平台有边缘兼容问题，
// 2026-09-24 层 3 终审反向审查捕获：new URL(x, "url") 非法 base 必抛 → 指纹恒 null → 检测成死代码）；
// 交付节点按会话节流复读磁盘比对——内容指纹而非 mtime，幂等重装（内容不变）不会误报；
// 发现过期告警 stderr + 降级账本，fail-open 不拦截。指纹不可得（打包/内联场景）→ 检测静默关闭。
let selfFingerprint = null;
try {
  selfFingerprint = createHash("sha1").update(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")).digest("hex");
} catch {
  selfFingerprint = null; // 读不到自身（打包/内联场景）→ 检测静默关闭
}
const STALE_DEPLOY_CHECK_INTERVAL_MS = 5 * 60_000; // 每会话至少 5min 才复检一次（节流为防极端高频 todowrite）

const TAG = "[quality-gate]";

// ── 进程级（环境属性，跨会话共享）────────────────────────────
let projectRoot;
try { projectRoot = process.cwd(); } catch { projectRoot = "."; }
const probe = { tsc: null, ruff: null }; // null=未探测，true/false=可用性
let tscInFlight = null; // 并发编辑单飞：共享同一次 tsc 全量输出
const DIAG_DEBOUNCE_MS = 5_000; // 编辑后防抖：5s 无新动作才真正跑诊断（编辑路径零阻塞）
const FLUSH_BUDGET_MS = 30_000; // 交付冲刷总预算：超时带陈旧标注返回，防交付节点分钟级阻塞
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
// 不得 export function：Kilo vE2 加载器把模块里每个导出函数都当插件工厂用
// (ctx, options) 调一遍——本函数签名 (output) 收到 (ctx对象, undefined) 时虽不抛，
// 但返回 undefined 进钩子数组 → "plugin config hook failed"(N.config on undefined)。
// 工具函数一律模块私有，经文件末尾的 _export 命名空间对象暴露给离线测试。
function exitCodeOf(output) {
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

// ── 退出码遮蔽识别（P0-3 误报治理）──────────────────────────
// 这些形态下命令自身的 exit 不可信（失败会被吞成 0）：只算「跑过」，不参与「跑赢」判定。
// 注意：&& 不吞码（短路，左侧失败整体即失败）；|| false 不吞码（false 退出码为 1，
// 忠实保留前段失败）；|| exit N（N≠0）传播失败也不吞码——三者都不得标记为遮蔽。
// 已知残余（意图启发式的边界，宁少遮蔽不误杀）：tee/head 等透传后段技术上仍覆盖前段
// 退出码，此处按「用户意图是留档/截断而非掩盖」豁免；grep 会因匹配与否改变退出码，
// 已移出豁免（这类静默改写退出码的后段必须判遮蔽）。
const PIPE_PASS_THROUGH = /\|\s*(?:tee|head|tail|cat|less|more|wc|sort|uniq|column|iconv|tr)\b[^|;&]*/gi;
const SUCCESS_TAIL = /^(?:true|:|exit\s+0\b|echo)\b/i; // 以成功命令开头的分号尾段
function exitMasked(cmd) {
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

// ── ⑤ 残余必须修复项沉淀（2026-09-24 审计闭环）────────────────
// 轮次上限放行 / review-accepted 带残余项交付时，fixSection 已随 todowrite 回注，
// 但回注是会话内瞬态信号——关窗即忘。此处把残余项落进项目记忆 project.md 的
// ## Open Questions 段（kilo_memory_recall 可检索的持久层），下次会话自动注入，
// 由用户/后续会话决定处理；插件不主动回滚记忆文件（写入与 Kilo 记忆归档格式同构：
// 段落下一行一条 `- key :: text`，kilo_memory_recall 按 token 检索天然兼容）。
// 记忆根定位复用 memory-bootstrap 的 canonicalRoot 布局：<dataDir>/memory/<dir>/
// manifest.json 的 canonical 字段 == projectRoot 时视为本项目记忆根（worktree 归并主仓）。
// 全程 try-catch fail-open：沉淀失败只打 stderr 日志，绝不影响交付主流程。
// 纯函数（前 3 个）经 _export 暴露给离线测试。

function memoryRootFor(root) {
  try {
    const memDir = path.join(DATA_DIR, "memory");
    if (!fs.existsSync(memDir)) return null;
    // 仅 canonical realpath 精确匹配（2026-09-24 层 3 审查必须修复项）：
    // basename 前缀兜底会让 proj / proj-v2 相似目录误命中 → 残余项串号写进
    // 错误项目的记忆。匹配失败即返回 null 放弃沉淀（宁可不沉淀，不串号）。
    let canonical = null;
    try { canonical = fs.realpathSync.native(root); } catch { return null; }
    for (const name of fs.readdirSync(memDir)) {
      const mf = path.join(memDir, name, "manifest.json");
      let m;
      try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch { continue; }
      if (m?.canonical === canonical) return path.join(memDir, name);
    }
    return null;
  } catch {
    return null;
  }
}

// 生成沉淀行：- review_residual_2026-09-24_a1b2c3d4 :: <fixSection 单行化>（截 600 与 reviewPending 同口径）
// key 带日期+素材指纹：同会话重复触发只追加一次（指纹相同→视为已沉淀，由调用方比对），
// 不同轮次内容变化 → 指纹变 → 追加新行，历史不覆盖（审计线索保留）。
function residualFixupLine(fixSection, salt) {
  const raw = String(fixSection ?? "")
    // 每行剥列表符号：沉淀行自身是「- key :: text」形态，嵌套列表符号会污染记忆行
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .join("；");
  // 按码点截断（UTF-16 slice 会劈裂 surrogate pair → 记忆文件乱码）
  const body = Array.from(raw).slice(0, 600).join("");
  if (!body) return null;
  const date = new Date().toISOString().slice(0, 10);
  const h = createHash("sha1").update(`${salt}\n${body}`).digest("hex").slice(0, 8);
  return `- review_residual_${date}_${h} :: 审查残余必须修复项（层 3 轮次上限放行/显式接受，待跟进）:: ${body}`;
}

// 在 markdown 的 ## <heading> 段末尾追加一行（保持段落结构：插在下一个 ## 或文件尾之前）
function insertUnderHeading(md, heading, line) {
  const text = String(md ?? "");
  const h = String(heading ?? "");
  if (!h.startsWith("##")) return text + `\n${line}\n`;
  // 段定位兼容文件头（段前无换行）与段前有内容两种形态
  let i = text.indexOf(`\n${h}`);
  if (i < 0 && text.startsWith(h)) i = 0;
  if (i < 0) return `${text}\n\n${h}\n\n${line}\n`; // 段缺失 → 补段落（writeIfAbsent 脚手架已含，防御性兜底）
  const after = i + h.length + (i === 0 ? 0 : 1);
  const end = text.indexOf("\n## ", after);
  const seg = end < 0 ? text.slice(after) : text.slice(after, end);
  if (seg.includes(line)) return text; // 幂等：同 key 已存在不重复追加
  const insertAt = end < 0 ? text.length : end;
  return `${text.slice(0, insertAt)}\n${line}${text.slice(insertAt)}`;
}

// 沉淀入口（fail-open）：写入 <memRoot>/project.md 的 ## Open Questions 段。
// 并发 lost update 防护（2026-09-24 层 3 二轮审查必须项处置）：tmp+rename 只保证
// 单次写原子，多会话并发读-改-写仍可能互相覆盖。采用「写后回读验证 + 有界重试」：
// rename 后立即回读确认自己的行存活，丢失（被并发写者覆盖）→ 基于最新内容重合再写，
// 3 次封顶放弃（fail-open，残余内容另有 ⑦ 账本与工具回注双通道兜底，不丢可见性）。
// 不上文件锁：审计侧通道的复杂度/收益不成立（gate_scope_narrowing 教训）。
async function persistResidualFixup(fixSection) {
  try {
    const memRoot = memoryRootFor(projectRoot);
    if (!memRoot) {
      // ⑤ 排查线索（此前静默）：记忆根定位失败 ≠ 正常情况——原生记忆未启用/manifest 缺失
      console.error(`${TAG} 残余项沉淀跳过：未定位到本项目记忆根（原生记忆未启用或 manifest 不含本路径）`);
      return false;
    }
    const file = path.join(memRoot, "project.md");
    const line = residualFixupLine(fixSection, projectRoot);
    if (!line) {
      console.error(`${TAG} 残余项沉淀跳过：fixSection 单行化后为空`);
      return false;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const md = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const next = insertUnderHeading(md, "## Open Questions", line);
      if (next === md) return true; // 已沉淀过（幂等）
      // 原子写：Node 在 Windows 走 MoveFileExW+REPLACE_EXISTING，rename 直接覆盖
      // （windows_rename_overwrite_rotation 教训：先 rm 反而引入丢档窗口）
      const tmp = `${file}.qg-tmp-${process.pid}-${Date.now() % 100000}-${attempt}`;
      fs.writeFileSync(tmp, next, "utf8");
      fs.renameSync(tmp, file);
      const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (after.includes(line)) {
        console.error(`${TAG} 残余必须修复项已沉淀进项目记忆 Open Questions（review_residual）`);
        return true;
      } // 行丢失 = 并发写者以旧内容覆盖 → 重试（下次循环从最新内容重合）
    }
    console.error(`${TAG} 残余项沉淀连续 3 次遇并发覆盖放弃（fail-open，内容仍见降级账本与交付回注）`);
    return false;
  } catch (e) {
    console.error(TAG, "残余项沉淀失败（fail-open，不影响交付）:", e?.message ?? e);
    return false;
  }
}

// 沉淀安全包装（终审必须修复项）：persistResidualFixup 内部虽全 try-catch，防御性隔离
// await 点——任何意外抛错都不得跳过调用方的降级入账与 reviewPending 清理（false=未沉淀）
async function persistResidualSafe(fixSection) {
  try {
    return await persistResidualFixup(fixSection);
  } catch (e) {
    console.error(TAG, "persistResidualFixup 意外抛错（已隔离）:", e?.message ?? e);
    return false;
  }
}

// ── ⑦ 降级/放行审计账本（2026-09-24 审计闭环）──────────────────
// 会话内所有 fail-open / 显式放行事件记账（s.degradations），交付节点一次性回注。
// 动机：各通道放行时的回注散落在不同 todowrite 结果里，模型容易只见单条；
// 交付节点汇总一条「本次交付带了哪些降级」的完整清单，把「查了也看不见」变可见。
// 记账零成本（push 一行字符串），回注纯本地拼接，无任何模型调用——不拖慢交付。
const MAX_DEGRADATIONS = 40;
function recordDegradation(s, kind, detail) {
  try {
    if (!Array.isArray(s.degradations)) s.degradations = [];
    const entry = `${kind}: ${String(detail ?? "").slice(0, 200)}`;
    if (s.degradations.includes(entry)) return; // 同事件不重复记（幂等）
    s.degradations.push(entry);
    // 突发大超限时一次裁到位（splice），shift 逐个淘汰在批量记账场景会反复越界
    if (s.degradations.length > MAX_DEGRADATIONS) s.degradations.splice(0, s.degradations.length - MAX_DEGRADATIONS);
  } catch { /* 记账失败静默 */ }
}

// 汇总（纯函数）：账本 → 交付回注文本；无降级返回 null（零噪音）
function degradationSummary(s) {
  const list = s?.degradations;
  if (!Array.isArray(list) || list.length === 0) return null;
  const uniq = [...new Set(list)];
  return `本次交付包含以下降级/放行（逐条已显式留痕，交付说明须如实引用）：\n${uniq.map((x) => `  - ${x}`).join("\n")}`;
}

// ── ⑥ 部署≠生效检测（2026-09-24 查漏补缺）──────────────────────
// 纯函数（经 _export 暴露离线回归）：磁盘当前插件源码指纹 vs 加载期指纹。
// 内容指纹而非 mtime：幂等重装（install 幂等跳过/touch）不误报；指纹不可得（任一侧
// 读失败/打包内联场景）→ 恒 false 静默关闭（fail-open，绝不因检测自身故障拦截交付）。
function staleDeployOf(diskFingerprint, loadedFingerprint) {
  if (!diskFingerprint || !loadedFingerprint) return false;
  return diskFingerprint !== loadedFingerprint;
}

// 交付节点入口（按会话节流——进程级单变量会让并发会话互相静默，终审建议项）：
// 过期 → stderr 告警 + 降级账本（升级人工重载），fail-open。
function probeStaleDeploy(s) {
  try {
    const now = Date.now();
    if (now - (s.lastStaleCheck ?? 0) < STALE_DEPLOY_CHECK_INTERVAL_MS) return; // 会话内节流
    s.lastStaleCheck = now;
    if (!selfFingerprint) return; // 自身指纹不可得 → 检测关闭
    let disk = null;
    try { disk = createHash("sha1").update(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")).digest("hex"); } catch { return; }
    if (staleDeployOf(disk, selfFingerprint)) {
      console.error(`${TAG} 部署≠生效：磁盘插件代码已更新，但本进程仍执行旧逻辑——本次交付的检查口径可能过期，请重载 Kilo/VS Code 窗口后复核关键交付`);
      recordDegradation(s, "插件部署后未重载（⑥ 部署≠生效）", "运行中进程执行旧检查逻辑，交付口径可能过期——建议重载后复核");
    }
  } catch { /* 检测失败静默（fail-open） */ }
}

// ── 层 3 闭环（审查未通过 → 阻断交付，修复后自动再审，直到通过或升级人工）──
const MAX_REVIEW_ROUNDS = 2; // 自动审查轮次上限：超限放行并回注残余项（升级人工），防死循环烧钱
const REVIEW_ACCEPT_RE = /review-accepted\s*:/i;

function hasAcceptMarker(s) {
  return (s.commands ?? []).some((c) => REVIEW_ACCEPT_RE.test(cmdText(c)));
}

// 从裁决文本解析结论。fail = 裁决「不通过」或「必须修复项」段非空；
// inconclusive = 文本里没有「## 裁决」段（上游失败/一路阵亡等），不阻断（fail-open）。
function parseReviewVerdict(text) {
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
  return [...(s?.edited ?? [])].filter(isCodeFile);
}

// ── 层 2 dist 新鲜度（待办④：推广 install.ps1 的检查到交付节点）────────────
// 会话编辑过 provider/<pkg>/src × dist/index.js 不比 src 新 → 测试跑的是旧行为
// （即使 exit 0 也是假信心），install -Check 还会拦下发。交付节点先行拦下要求重建。
// 只比「会话编辑过的文件」：git checkout/touch 等非会话变更属 install -Check 职责，不归层 2。
function providerEditsOf(editedPaths) {
  const m = new Map(); // pkg → 该包 src 下被编辑文件的相对路径列表
  for (const p of editedPaths ?? []) {
    const hit = String(p).match(/(?:^|[\\/])provider[\\/]([^\\/]+)[\\/]src[\\/](.+)/i);
    const pkg = hit?.[1];
    if (!pkg || pkg === "." || pkg === "..") continue; // 点段逃逸防护
    if (!m.has(pkg)) m.set(pkg, []);
    m.get(pkg).push(hit[2]);
  }
  return m;
}

// 产物入口硬编码 dist/index.js：本仓唯一自研 provider（hx-failover）的 build 产物即此，
// 从 package.json main/exports 动态解析属过度工程——出现第二个 provider 时再泛化。
function distStaleOf(root, pkg, srcFiles) {
  try {
    const pkgDir = path.join(root, "provider", pkg);
    const dist = path.join(pkgDir, "dist", "index.js");
    if (!fs.existsSync(dist)) {
      // 编辑过 src 而 dist 不存在 = 从未构建，恰是要拦的假信心场景（非 fail-open）
      return { stale: true, missing: true };
    }
    const distMtime = fs.statSync(dist).mtimeMs;
    let newestEdit = -Infinity;
    for (const rel of srcFiles ?? []) {
      const full = path.join(pkgDir, "src", rel);
      if (!fs.existsSync(full)) continue; // 编辑后被删除/重命名：跳过，无 mtime 可比
      newestEdit = Math.max(newestEdit, fs.statSync(full).mtimeMs);
    }
    // >= ：物理上 build 写 dist 晚于编辑 src，mtimeMs 亚秒精度下相等概率≈0，
    // 取 >= 防极瞬间漏拦；未来时间戳等病态情形由 verify-skipped 逃生门兜底
    return { stale: newestEdit >= distMtime, missing: false };
  } catch (e) {
    console.error(TAG, "distStaleOf 探测失败（fail-open 放行）：", e?.message ?? e);
    return { stale: false, missing: false, error: String(e?.message ?? e).slice(0, 120) }; // fs 异常 fail-open 但必留日志，不静默
  }
}

// 层 3 触发口径（before/after 钩子共用，防两处漂移）：
// 高风险文件命中即触发（文件数无关）；普通改动须含代码且跨 ≥3 文件。
// ⚠️ 「跨 ≥3 文件」按 s.edited 计**全部编辑文件（含文档）**，非仅代码文件——
// 「1 代码 + 2 文档」也会触发；口径与旧 ≥5 时代一致，阈值降低后触发面相应扩大。
// 阈值 2026-09-22 两调：先 ≥3→≥5（48h 遥测 22 次审查累计墙钟 35min，触发过频），
// 同日用户决策回调 ≥3——人工复检多遍的返工成本高于单次自动审查（输出限长前
// 5~8min/次、限长后 2~4min/次，见 README 性能基线），质量优先；纯文档会话不烧审查费。
function isComplexDelivery(s, codeEdits) {
  return (s?.highRisk?.size ?? 0) > 0 || ((codeEdits?.length ?? 0) > 0 && (s?.edited?.size ?? 0) >= 3);
}

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
  return [...(s?.commands ?? []).map(cmdText), ...(s?.reads ?? []), ...(s?.edited ?? [])].join("\n").toLowerCase();
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
  if (!(await probeTool("tsc"))) {
    recordDegradation(s, "静态检查缺位（tsc 不可用）", "工具探测失败，TS 诊断静默跳过——交付前建议人工 tsc --noEmit 复核");
    return [];
  }
  if (tsconfigMtimeOf(dir) === null) return []; // 无 tsconfig（非 TS 项目）→ 跳过
  const mtimeMs = fileMtime(file);
  const cached = s.fileChecks.get(file);
  if (cached && cached.kind === "ts" && cached.mtimeMs === mtimeMs) return cached.diags;
  const { err, out } = await runTscOnce(dir);
  if (err) {
    recordDegradation(s, "静态检查异常（tsc 运行失败）", `${file.split(/[\\/]/).pop()}：${String(err?.message ?? err).slice(0, 80)}——诊断可能缺失`);
  }
  const lines = String(out ?? "").split(/\r?\n/).filter((l) => /\((\d+),(\d+)\)|error TS\d+/.test(l));
  const diags = lines.filter((l) => l.includes(file));
  s.fileChecks.set(file, { kind: "ts", mtimeMs, diags });
  return diags;
}

async function ruffDiagnose(file, dir, s) {
  if (!(await probeTool("ruff"))) {
    recordDegradation(s, "静态检查缺位（ruff 不可用）", "工具探测失败，Python 诊断静默跳过——交付前建议人工 ruff check 复核");
    return [];
  }
  const mtimeMs = fileMtime(file);
  const cached = s.fileChecks.get(file);
  if (cached && cached.kind === "py" && cached.mtimeMs === mtimeMs) return cached.diags;
  const { err, out } = await runCmd("ruff", ["check", "--no-cache", "--output-format=concise", file], 10_000, dir);
  if (err) {
    recordDegradation(s, "静态检查异常（ruff 运行失败）", `${file.split(/[\\/]/).pop()}：${String(err?.message ?? err).slice(0, 80)}——诊断可能缺失`);
  }
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

// 可诊断后缀（staticDiagnose 实际处理集）：入队过滤用——文档/其他代码后缀不进
// pendingDiags 空转，也避免文档编辑触发冲刷的第二轮补跑
const DIAGNOSABLE_EXT = new Set(["ts", "tsx", "mts", "cts", "py"]);
function isDiagnosable(f) {
  const m = String(f ?? "").match(/\.(\w+)$/);
  return !!m && DIAGNOSABLE_EXT.has(m[1].toLowerCase());
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

// hasBudget：可选墙钟预算判定（交付冲刷传入；后台防抖路径不传 = 不限）。
// 预算耗尽时剩余文件放回 pendingDiags（下次防抖/冲刷重试），不丢也不无限拖交付。
async function runDiags(s, hasBudget) {
  if (s.diagBusy) return; // 上一次还在跑：文件已入 pendingDiags，下轮防抖会再跑
  s.diagBusy = true;
  const files = [...s.pendingDiags];
  s.pendingDiags.clear();
  try {
    for (let i = 0; i < files.length; i++) {
      if (hasBudget && !hasBudget()) {
        for (let j = i; j < files.length; j++) s.pendingDiags.add(files[j]);
        break;
      }
      const diags = await staticDiagnose(files[i], projectRoot, s);
      if (diags && diags.length > 0) s.diagNotes.set(files[i], diags);
    }
    if (files.length > 0) {
      const bad = [...s.diagNotes.keys()].length;
      console.error(`${TAG} 后台静态检查完成：${files.length} 个文件，${bad} 个有诊断待交付冲刷`);
    }
  } catch (e) {
    console.error(TAG, "async diagnose failed:", e?.message ?? e);
    // ⑦：后台诊断整轮异常 → 诊断静默缺失，经 diagNotes 占位行让交付冲刷回注可见 + 入账本
    try {
      s.diagNotes.set("<async-diagnose-failed>", [String(e?.message ?? e).slice(0, 200)]);
      recordDegradation(s, "后台静态检查异常（诊断可能缺失）", String(e?.message ?? e).slice(0, 120));
    } catch { }
  } finally {
    s.diagBusy = false;
  }
}

// 冲刷新鲜度判定（纯函数供离线回归）：诊断是否覆盖末次代码编辑——编辑计数未变、
// 无新积压、后台不在跑三者同时成立（与层 2 hasVerified 的「末次编辑后」语义同构；
// 只比 codeEditV：文档编辑不产生代码诊断，不应触发补跑轮）
function diagCoversLastEdit(s, v0) {
  return (s?.codeEditV ?? 0) === (v0 ?? 0) && (s?.pendingDiags?.size ?? 0) === 0 && !s?.diagBusy;
}

// 冲刷异常/不新鲜入账本（⑦：交付时诊断缺口必须可见，不许只留 stderr）
function recordFlushGap(s, kind, detail) {
  recordDegradation(s, kind, detail);
}

// 交付节点冲刷（三模型裁决必须项——预算上限 + 编辑计数比对）：
//   - 总预算 FLUSH_BUDGET_MS：含 runDiags + 等后台轮，超时不再死等，带陈旧标注返回
//     （防防抖单飞下交付节点分钟级阻塞）；
//   - 最多两轮：等待期间又发生代码编辑 → 诊断不覆盖末次编辑 → 补跑一轮兜新鲜度；
//     两轮后仍不覆盖（持续编辑中）→ 陈旧标注返回，不无限追。
async function flushDiags(s) {
  const t0 = Date.now();
  const hasBudget = () => Date.now() - t0 < FLUSH_BUDGET_MS;
  let stale = false;
  for (let pass = 0; pass < 2 && hasBudget(); pass++) {
    const v0 = s.codeEditV ?? 0;
    if (s.diagTimer) { clearTimeout(s.diagTimer); s.diagTimer = null; }
    if (s.pendingDiags.size > 0 && !s.diagBusy && hasBudget()) await runDiags(s, hasBudget);
    // 正在后台跑的轮次：等它落地（预算内）
    while (s.diagBusy && hasBudget()) await new Promise((r) => setTimeout(r, 200));
    if (s.diagBusy) { stale = true; break; } // 预算耗尽而后台仍在跑：不再死等
    if (diagCoversLastEdit(s, v0)) { stale = false; break; } // 诊断覆盖末次编辑，干净
    stale = true; // 等待期间有新编辑/新积压 → 补跑一轮
  }
  if (s.diagNotes.size === 0) return null;
  const parts = [...s.diagNotes.entries()].map(([f, diags]) =>
    `${f}（共 ${diags.length} 条）：\n  ${diags.slice(0, 20).join("\n  ")}`);
  s.diagNotes.clear();
  const staleNote = stale
    ? "（注意：部分诊断未覆盖末次编辑——冲刷期间仍有编辑或超等待预算，修复后建议重新交付验证）"
    : "";
  if (stale) recordDegradation(s, "交付冲刷诊断不新鲜", "部分诊断未覆盖末次编辑（冲刷期间仍有编辑/超预算），结果可能过期");
  return `静态检查诊断（后台汇总${staleNote}，需修复后再交付）：\n${parts.join("\n")}`;
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
// 2026-09-22 真根因修复：此处曾 export——Kilo vE2 加载器把每个导出函数都当插件工厂
// 调 (ctx, options)，本函数 (root, s, ...) 收到 (ctx对象, undefined) 时第 566 行
// [...s.edited] 以 s=undefined 求值 → "failed to load plugin"(s.edited) →
// 钩子数组污染 → "plugin config hook failed"(N.config) → provider 全挂（模型选择器空）。
// 绝不得恢复 export；测试经文件末尾 _export 命名空间访问。
async function reviewSubject(root, s, editedList) {
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

const QualityGateImpl = async ({ directory } = {}) => {
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
        // 触发口径与 after 钩子一致：高风险文件，或含代码改动且跨 ≥3 文件——
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
        // dist 新鲜度：provider src 改了未重建 dist → 即使下面的验证 exit 0 也是旧行为
        // （fail-closed：先于 hasVerified 判定，防止「测试通过」掩盖过期产物）
        const provEdits = providerEditsOf(codeEdits);
        const stalePkgs = [];
        for (const pkg of provEdits.keys()) {
          const st = distStaleOf(projectRoot, pkg, provEdits.get(pkg));
          if (st.error) recordDegradation(s, "dist 新鲜度探测异常（按新鲜放行）", `provider/${pkg}：${st.error}`);
          if (st.stale) stalePkgs.push(pkg);
        }
        if (stalePkgs.length > 0) {
          throw new Error(
            `[quality-gate] 层 2 dist 新鲜度：本会话编辑过 ${stalePkgs.map((p) => `provider/${p}/src`).join("、")}，` +
            `但对应 dist/index.js 比 src 旧——验证跑的是旧行为，install -Check 也会拦截下发。` +
            `在 ${stalePkgs.map((p) => `provider/${p}`).join("、")} 跑 npm run build 重建后再标记全部完成；` +
            `确无法构建则执行 echo "verify-skipped: <原因>" 显式登记。`
          );
        }
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
            if (isDiagnosable(file)) { // 只有可诊断后缀入队：文档/其他后缀不空转防抖队列
              s.pendingDiags.add(file); // 刚写过 mtime 必变，mtime 缓存必失效 → 一律入队防抖
              scheduleDiags(s);
            }
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
            // ⑥ 部署≠生效检测（节流，fail-open）：运行中进程可能还在执行旧插件逻辑
            probeStaleDeploy(s);
            try {
              const flushText = await flushDiags(s);
              if (flushText) {
                notes.push(`⚠️ ${flushText}`);
                console.error(`${TAG} 交付冲刷：后台静态检查有未修复诊断，已回注`);
              }
            } catch (e) {
              console.error(TAG, "flush diags failed:", e?.message ?? e);
              recordDegradation(s, "交付冲刷异常（诊断可能缺失）", String(e?.message ?? e).slice(0, 120));
            }
          }
          if (codeEdits.length > 0 && !hasRanVerify(s)) {
            if (hasSkipMarker(s)) {
              recordDegradation(s, "验证显式跳过（verify-skipped）", "原因见命令记录");
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
              recordDegradation(s, "验证退出码未知（降级旧口径放行）", "钩子契约未采集到退出码");
              notes.push(
                `ℹ️ 验证命令退出码未知（钩子契约未采集到），本次按旧口径放行——建议贴出验证输出佐证。`
              );
            }
          }
          if (allDone && hasAcceptMarker(s) && s.reviewPending) {
            // ⑤：review-accepted 带残余项交付 → 同样沉淀（显式接受 ≠ 残余项消失）
            const persisted = await persistResidualSafe(s.reviewPending.fixSection);
            recordDegradation(s, `残余风险显式接受（review-accepted）${persisted ? "（残余项已沉淀项目记忆 Open Questions）" : "（残余项沉淀失败）"}`, s.reviewPending.fixSection);
          }
          if (allDone && hasAcceptMarker(s) && !s.reviewPending && !s.dualReviewed && isComplexDelivery(s, codeEdits)) {
            // ⑦ 补口：accept 早于任何审查（无 reviewPending、无裁决）——「接受了不存在的残余」
            // 或纯规避审查，必须留痕可见
            recordDegradation(s, "review-accepted 但从未生成审查裁决", "显式接受先于审查执行，接受对象不明——建议交付后人工补审");
          }

          // 层 3 全自动执行 + 闭环：todo 全部 completed（交付节点）+ 高风险/复杂改动
          // + 本会话审查未通过/未做过 → 插件直调 runDualReview（正反审查+裁决）。
          // 闭环语义：裁决未通过 → 记录 must-fix 并阻断本次交付（before 钩子），
          // 修复后重新标记完成 → 此处自动再审；通过才置 dualReviewed。
          // 轮次上限（MAX_REVIEW_ROUNDS）后仍不过 → 放行并回注残余项（升级人工，防死循环）。
          // 无法解析的裁决（上游失败等）→ fail-open 不阻断（质量降质但不卡交付）。
          // P0-2 素材缓存（缓存键完整版，2026-09-22 三模型裁决必须项）：
          // 键 = 审查器指纹（审查器版本 + 配置模型三元组，reviewerFingerprint 提供）
          //   + 素材 sha1。改 prompt/换模型后指纹即变，缓存失效——绝不为同一份 diff
          // 复用异构模型的旧裁决；指纹不可得（配置读失败）→ 键掺时变值保证不命中，
          // 宁可重烧一次审查也不冒陈旧裁决风险。
          const complex = isComplexDelivery(s, codeEdits);
          if (allDone && complex && !s.dualReviewed && !hasAcceptMarker(s)) {
            const editedList = [...s.edited].slice(0, 30).join("\n");
            const subject = await reviewSubject(projectRoot, s, editedList);
            // ⑦ 补口：git 失败降级为会话证据池——审查视野缩水必须可见
            if (subject.includes("会话内执行过的命令")) {
              recordDegradation(s, "审查素材降级（git diff 不可得）", "退化为会话证据池，审查视野受限——建议人工核对 diff");
            }
            let drExport = null;
            let reviewerFp = "";
            try {
              drExport = (await import("./dual-review"))._export;
              reviewerFp = await drExport.reviewerFingerprint();
            } catch (e) {
              reviewerFp = `fp-unavailable-${Date.now()}`;
              console.error(TAG, "审查器指纹不可得（缓存本次不复用）:", e?.message ?? e);
            }
            const subjectKey = createHash("sha1").update(`${reviewerFp}\n${subject}`).digest("hex");
            let verdict = null;
            if (s.reviewCache && s.reviewCache.key === subjectKey) {
              verdict = s.reviewCache.verdict;
              console.error(`${TAG} 层 3 审查素材+审查器指纹一致（hash 命中），复用既有裁决，不重复烧审查`);
              appendToResult(output, `\n${TAG} 层 3 审查素材与审查器配置均未变化（hash 命中），复用既有裁决，不重复烧审查。`);
            } else {
              // 无进度通道（终裁见 lib/hx-client.ts）：审查 2~4min 的黑盒期属框架限制，
              // 结果耗时由下方 appendToResult 回注，不再做不可见的 stderr 心跳
              const reviewT0 = Date.now();
              try {
                verdict = await (drExport ?? (await import("./dual-review"))._export).runDualReview(subject);
                const reviewSecs = ((Date.now() - reviewT0) / 1000).toFixed(1);
                appendToResult(output, `\n${TAG} 层 3 双向审查（自动执行，正反异源模型+裁决，耗时 ${reviewSecs}s）\n${verdict}`);
                s.reviewCache = { key: subjectKey, verdict };
              } catch (e) {
                console.error(TAG, "auto dual review failed:", e?.message ?? e);
                // ⑧：runDualReview 抛错且前轮有未确认修复的残余项 → 不能随 throw 丢失
                if (s.reviewPending?.fixSection) {
                  const persisted = await persistResidualSafe(s.reviewPending.fixSection);
                  recordDegradation(s, `审查执行异常，前轮残余必须修复项未确认修复${persisted ? "（已沉淀项目记忆 Open Questions）" : "（沉淀失败，人工须记录）"}`, s.reviewPending.fixSection);
                  s.reviewPending = null; // 已沉淀持久层，会话内状态清掉防二次入账
                } else {
                  recordDegradation(s, "审查执行异常（本次按未审查交付）", String(e?.message ?? e).slice(0, 120));
                }
                // 终审建议项：与 inconclusive 路径同构「一次为限」——执行异常也置 dualReviewed，
                // 防同会话后续交付节点对同一素材反复重烧审查（隧道抖动重试的期望收益低于重复成本）
                s.dualReviewed = true;
              }
            }
            if (verdict != null) {
              const v = parseReviewVerdict(verdict);
              if (v.inconclusive) {
                // 上游失败/一路阵亡：不阻断（fail-open），但一次为限防重复烧钱。
                // ⑧：第 2 轮起 inconclusive 意味着前轮必须修复项未被确认修复——
                // 随放行丢失前先沉淀（轮次上限放行路径同构，只是触发者不同）
                if (s.reviewRounds > 0 && s.reviewPending?.fixSection) {
                  const persisted = await persistResidualSafe(s.reviewPending.fixSection);
                  recordDegradation(s, `审查第 ${s.reviewRounds + 1} 轮上游失败，前轮残余未确认修复${persisted ? "（已沉淀项目记忆 Open Questions）" : "（沉淀失败，人工须记录）"}`, s.reviewPending.fixSection);
                }
                s.reviewPending = null; // 无条件清（空 fixSection 防御性清理，防 before 钩子按旧裁决误拦）
                s.dualReviewed = true;
                recordDegradation(s, "审查上游失败（按未审查交付）", (v.verdictLine || "裁决不可解析").slice(0, 120));
                appendToResult(output, `\n${TAG} ⚠️ 审查结果无法解析（上游失败），本次按未审查交付，请人工留意。`);
              } else if (v.fail) {
                s.reviewRounds += 1;
                if (s.reviewRounds >= MAX_REVIEW_ROUNDS) {
                  s.dualReviewed = true;
                  // ⑤ 残余项沉淀进项目记忆 Open Questions（fail-open，关闭即忘 → 持久可见）
                  const persisted = await persistResidualSafe(v.fixSection);
                  recordDegradation(s, `审查 ${s.reviewRounds} 轮未过按上限放行${persisted ? "（残余项已沉淀项目记忆 Open Questions）" : "（残余项沉淀失败，人工须记录）"}`, v.fixSection);
                  appendToResult(
                    output,
                    `\n${TAG} ⚠️ 已连续 ${s.reviewRounds} 轮审查未通过，达到自动审查上限，放行交付。\n` +
                      `残余必须修复项（交付前请人工确认${persisted ? "，已沉淀进项目记忆 Open Questions 待后续会话跟进" : ""}）：\n${v.fixSection}`
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
          // ⑦ 交付节点降级/放行汇总回注（账本非空才出声，零降级零噪音）
          if (allDone) {
            const degr = degradationSummary(s);
            if (degr) notes.push(`⚠️ ${degr}`);
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

// never-throw 包装（爆炸半径收口，2026-09-22）：Kilo 启动时逐个求值插件工厂，
// 任一工厂抛错会记 "failed to load plugin" 并在插件注册表留洞 →
// "plugin config hook failed"（N.config）→ provider 列表/鉴权全挂 → 模型选择器空。
// 工厂期异常只应禁用本插件，绝不能污染 provider 面：这里兜住并返回空钩子对象。
export const QualityGate = async (ctx = {}) => {
  try {
    return await QualityGateImpl(ctx);
  } catch (e) {
    console.error(TAG, "init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};

// Kilo vE2 契约：模块唯一函数导出 = 工厂（QualityGate/default 同引用被 Set 去重）。
// 工具函数经此命名空间对象暴露给离线测试（scripts/test-quality-gate.mjs）——
// 对象无 server 属性，kE2 的 a5M 检查直接跳过，绝不会被当工厂调 (ctx, options)。
// 这是 "failed to load plugin"(s.edited) / "plugin config hook failed"(N.config)
// 真根因修复的核心机制——2026-09-22 启动崩溃复盘（逆向 kilo.exe vE2/iE2/kE2 确认）。
export const _export = {
  exitCodeOf, exitMasked, parseReviewVerdict, reviewSubject, isComplexDelivery,
  hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker, diagCoversLastEdit,
  providerEditsOf, distStaleOf, residualFixupLine, insertUnderHeading, degradationSummary,
  staleDeployOf,
  VERIFY_CMD_RE, HIGH_RISK_RE,
};

export default QualityGate;
