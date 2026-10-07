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
import { homedir, tmpdir } from "node:os";
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
  // 兜底改 tmpdir（层 3 r2 必修项①）：原 "." 兜底会在 homedir() 异常时把
  // tsc-cache/memory 探测路径落进当前工作目录（= 用户项目仓库），污染工作区。
  // tmpdir() 同异常（双重病态）→ null：两个消费点（memoryRootFor/tscbuildInfoFor）
  // 各自 try 包裹，null 时自然降级（探测返回 null / tsc 走全量无缓存），不会崩
  try {
    DATA_DIR = path.join(tmpdir(), "kilo");
  } catch {
    DATA_DIR = null;
  }
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
const probe = { tsc: null, ruff: null, eslint: null }; // null=未探测，true/false=可用性
const eslintConfigCache = new Map(); // dir(canonical) -> boolean，进程级缓存（与 probe 同构）
let tscInFlight = null; // 并发编辑单飞：共享同一次 tsc 全量输出
const DIAG_DEBOUNCE_MS = 5_000; // 编辑后防抖：5s 无新动作才真正跑诊断（编辑路径零阻塞）
const FLUSH_BUDGET_MS = 30_000; // 交付冲刷总预算：超时带陈旧标注返回，防交付节点分钟级阻塞
let tscIncrementalOk = null; // null=未探测；false=项目 TS 过老/写失败，永久降级全量

// ── 会话级状态（sessionID 分桶）──────────────────────────────
const sessions = new Map(); // sessionID -> { commands, reads, lastTodos, edited, fileChecks }
// 层 3 r4 必修②：原 20 桶 + Map 创建序驱逐（keys().next() 恒取最老「创建」的桶，
// 活跃与否无关）——Agent Manager 扇出下父会话最早创建、每轮都在用，第 21 个新会话
// 出现即被踢，层 2 门禁状态（验证账本/todo 快照）静默丢失 = 硬门禁绕过。
// 修复：touch 提升实现真 LRU + 容量 64（桶内 commands/reads/edited 已有各自上限，
// 64 桶最坏 MB 级，常驻宿主安全余量充足）。
const MAX_SESSIONS = 64;
const MAX_COMMANDS = 200;
const MAX_READS = 100;
const MAX_EDITED = 500;

function bucketOf(input) {
  const id = String(input?.sessionID ?? "__global__");
  let s = sessions.get(id);
  if (s) {
    // 真 LRU：任何一次访问都提升到队尾，驱逐对象恒为「最久未被使用」而非「最久未创建」
    sessions.delete(id);
    sessions.set(id, s);
    return s;
  }
  s = { commands: [], reads: [], lastTodos: [], edited: new Set(), fileChecks: new Map(), highRisk: new Set(), dualReviewed: false, dualReviewedAtCodeEditV: 0, planReviewed: false, reviewPending: null, reviewRounds: 0, editVersion: 0, codeEditV: 0, exitContractWarned: false, pendingDiags: new Set(), diagTimer: null, diagBusy: false, diagNotes: new Map(), reviewCache: null, reviewFailedAtCodeEditV: 0, reviewFailedAtRound: 0, reviewFailedCount: 0, driftChecked: false, highRiskDelegated: false, delegated: [], degradations: [], lastStaleCheck: 0, exitNudges: 0, exitNudgeAt: 0, exitNudgeFp: "", exitGateCapped: false, exitGateInFlight: false, lastStatus: "", exitCheckTimer: null, childUnsettled: new Map(), childReg: "", parentIDCache: undefined };
  sessions.set(id, s);
  if (sessions.size > MAX_SESSIONS) {
    // LRU 驱逐前清理挂起的定时器：否则回调会在已脱离 Map 的会话对象上空跑 tsc / 空注入门禁
    const oldestKey = sessions.keys().next().value;
    const evicted = sessions.get(oldestKey);
    if (evicted?.diagTimer) { clearTimeout(evicted.diagTimer); evicted.diagTimer = null; }
    if (evicted?.exitCheckTimer) { clearTimeout(evicted.exitCheckTimer); evicted.exitCheckTimer = null; }
    sessions.delete(oldestKey);
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

// ── diff→test 关联断言（2026-09-25 多模型审查采纳项 + 两轮层 3 审查修复）──
// 层 2 的「跑赢」只证明「命令 exit 0」，不证明「测到了」：改了 foo() 但全仓测试
// 无一引用 foo → 关键路径未覆盖，绿灯也是侥幸。本断言在交付节点做本地 grep 级
// 核对（零模型调用）：编辑过的代码模块名在测试文件中出现即视为有关联测试。
// 查无引用 → 回注警告（fail-open 只警告不拦截——存在性断言天然有误报面，硬拦会误杀）。
// 三态：无测试形态（独立目录或 colocate 任一存在）→ 静默跳过（无测试仓库不产生义务）；
// 有关联 → 通过；无关联 → 警告。git 真错误（非 exit 1）→ 降级跳过不误报。
// 核对墙钟有界：总预算 10s，超时未完成的部分静默放弃（并行发起 + 总墙钟截断，
// 绝不串行 8×8s 阻塞交付节点——第 2 轮审查必须项）。
// 纯函数核心经 _export 暴露离线回归。
const TEST_DIR_CANDIDATES = ["tests", "test", "__tests__", "spec"];
const COLOCATE_TEST_RE = /\.(?:test|spec)\.\w+$/; // colocate 形态：src/foo.test.ts 紧邻源码
const TEST_REF_LIMIT = 8;       // 核对上限（超出部分 dropped 可见，不产生虚假安全感）
const TEST_REF_TOTAL_MS = 10_000; // 总墙钟预算：并行执行 + 超时截断

function moduleBasenamesOf(codeEdits, limit = TEST_REF_LIMIT) {
  const names = new Set();
  let dropped = 0;
  for (const f of codeEdits ?? []) {
    const base = path.basename(String(f ?? ""))
      .replace(/\.(?:d|test|spec)\.\w+$/, "") // 声明/测试中段剥离：foo.d.ts → foo、login.test.ts → login
      .replace(/\.\w+$/, "");               // 尾部后缀剥离：quality-gate.ts → quality-gate
    if (!base || names.has(base)) continue;
    if (names.size >= limit) { dropped++; continue; }
    names.add(base);
  }
  return { names: [...names], dropped };
}

// 测试形态探测：独立测试目录或仓库中存在任何 colocate 测试文件。
// colocate 形态（第 2 轮审查必须项）：src/foo.test.ts 紧邻源码的仓库无独立测试目录，
// 旧口径会静默 skip → 系统性漏报。git ls-files 快速扫描 tracked 文件名即可判断。
// 仓库里一个 colocate 测试都没有 = 「无测试形态」，跳过不产生义务（与独立目录口径对称）。
async function detectTestShape(root) {
  for (const d of TEST_DIR_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(root, d))) return { kind: "dir", dirs: [d] };
    } catch { return null; }
  }
  // colocate 探测：git ls-files 足够（测试文件必然 tracked 才会被 grep 命中，口径一致）
  const { err, out } = await runCmd("git", ["ls-files", "*.test.*", "*.spec.*"], 5_000, root);
  if (!err && /(?:\.test|\.spec)\./.test(String(out ?? ""))) {
    // colocate 搜索面 = 测试文件 glob 本身：源文件内容里的自引用不算测试覆盖
    // （第 2 轮审查建议项「排除被编辑文件自身命中」的根治版——只搜测试文件，
    // 源码任何内容天然出局；也把搜索面收窄回大仓可接受范围）
    return { kind: "colocate", dirs: null, globs: ["*.test.*", "*.spec.*"] };
  }
  return null;
}

// hasTestRefFor(root, names)：返回 {skip: true} 或 {skip: false, missing}。
// 匹配语义（第 2 轮审查必须项）：词边界正则替代 -F 子串匹配——util/index/a 这类
// 短名不会被 utility/indexing 前缀假阳性命中；basename 经 re.escape 免注入。
// dir 形态只搜独立测试目录（非测试目录的字符串提及天然出局）；
// colocate 形态用 glob pathspec 只搜测试文件（源文件自身内容不算自证）。
// git grep 退出码：0=有匹配，1=无匹配（合法终态 → missing），其他=真错误 → skip。
// 并行发起 + 总墙钟截断（Promise + setTimeout race）：单模块结果不阻塞其他路，
// 最坏墙钟 TEST_REF_TOTAL_MS 而非 8×8s 串行——不阻塞交付节点。
async function hasTestRefFor(root, names) {
  if (!names || names.length === 0) return { skip: true };
  const shape = await detectTestShape(root);
  if (!shape) return { skip: true };
  const pathspec = shape.kind === "dir" ? ["--", shape.dirs] : ["--", ...shape.globs];
  const deadline = Date.now() + TEST_REF_TOTAL_MS;
  const results = await Promise.all(names.map(async (n) => {
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const p = new Promise((resolve) => {
      runCmd("git", ["grep", "-l", "--full-name", "-I", "-E", "-e", `\\b${esc}\\b`, ...pathspec], 8_000, root)
        .then(({ err, out }) => {
          if (err) resolve(err.code === 1 ? "miss" : "err");
          else resolve(String(out ?? "").split(/\r?\n/).some((l) => l.trim()) ? "hit" : "miss");
        });
    });
    const timer = new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()), "timeout"));
    return Promise.race([p, timer]);
  }));
  if (results.some((r) => r === "err")) return { skip: true }; // git 真错误 → 降级
  const missing = names.filter((_, i) => results[i] !== "hit");
  return { skip: false, missing };
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

// 沉淀入口薄包装（F 修复）：固定写进 Open Questions 段的一行式留痕（unreviewedMarkerLine）。
// 与 persistResidualSafe 同隔离语义——沉淀失败绝不影响交付主流程（false=未沉淀）。
async function persistLineSafe(line) {
  try {
    const memRoot = memoryRootFor(projectRoot);
    if (!memRoot) return false;
    const file = path.join(memRoot, "project.md");
    const md = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = insertUnderHeading(md, "## Open Questions", line);
    if (next === md) return true; // 幂等：已沉淀过
    const tmp = `${file}.qg-tmp-${process.pid}-${Date.now() % 100000}`;
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(TAG, "unreviewed 留痕沉淀失败（fail-open，不影响交付）:", e?.message ?? e);
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
const MAX_REVIEW_FAILURES = 2; // F 修复：inconclusive/执行异常连续失败重审上限——fail-open 放行有重试但不过度
const REVIEW_ACCEPT_RE = /review-accepted\s*:/i;

function hasAcceptMarker(s) {
  return (s.commands ?? []).some((c) => REVIEW_ACCEPT_RE.test(cmdText(c)));
}

// F 修复（2026-09-26 层 3 fail-open 永久免审闭环缺口）：
// inconclusive/执行异常路径直接置 dualReviewed=true → 同会话后续交付节点永远不再重审——
// 「失败一次 = 永久免审」违背「失败后修复重试」的闭环语义。正确口径：
//   失败时记下当时的 codeEditV（reviewFailedAtCodeEditV）与轮次，保留 dualReviewed=true
//   （本次交付照常放行，fail-open 不变）；其后若有**新的代码编辑**，交付节点允许重审一次；
//   连续 MAX_REVIEW_FAILURES 次失败（每次都在新编辑后重试仍失败）→ 永久放行并沉淀标记。
// 纯函数（经 _export 暴露离线回归）：true = 交付节点应重审。
function reviewRetryAllowed(s) {
  try {
    const s0 = s ?? {};
    // 起点从未失败过 → 不适用（由常规 !dualReviewed 触发口径覆盖）
    if (!s0.reviewFailedAtCodeEditV) return false;
    // 连续失败次数已达上限 → 永久放行（unreviewedMarkerLine 由调用方沉淀）
    if ((s0.reviewFailedCount ?? 0) >= MAX_REVIEW_FAILURES) return false;
    // 失败后无新代码编辑 → 不重审（同一素材重烧期望收益为负，防抖）
    if ((s0.codeEditV ?? 0) <= (s0.reviewFailedAtCodeEditV ?? 0)) return false;
    return true;
  } catch {
    return false;
  }
}

// F 修复：连续失败永久放行时的持久层留痕（写法与 residualFixupLine 同构，走同一沉淀通道）。
// 幂等性由 insertUnderHeading 的 seg.includes(line) 提供——同会话重复触发只追加一次。
function unreviewedMarkerLine() {
  const date = new Date().toISOString().slice(0, 10);
  return `- review_unreviewed_${date} :: 本会话复杂交付审查连续失败未复审（层 3 fail-open 放行）:: 待下次会话或人工补审；建议对当日 diff 跑一次 dual_review 确认`;
}

// F 修复：永久放行降级明细的失败概况前缀——显式判空（不用 `?? 0`：无记录与「第 0 轮」语义
// 不同，强转会篡改审计文本）；轮次显示为 1-based（reviewRounds 内部 0-based，复审审查项）。
// 类型强制（Number(...)）：容忍外部/序列化输入的字符串数字（如 "2"），非法值走判空分支。
function reviewFailPrefix(s) {
  const nRaw = Number(s?.reviewFailedCount);
  const rRaw = Number(s?.reviewFailedAtRound);
  const n = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 0;
  const round = Number.isFinite(rRaw) && rRaw >= 0 ? rRaw + 1 : null;
  return round === null ? `连续 ${n} 次失败；` : `连续 ${n} 次失败（最近一次在第 ${round} 轮）；`;
}

// ── B 修复：验收清单压缩锚点（2026-09-26）────────────────────────
// 痛点：验收清单只活在 s.lastTodos（内存）+ 首条 todo 文本里，上下文压缩后丢失——
// 模型继续干活却忘了「干到什么程度算完」，交付质量随压缩劣化。
// 方案：quality-gate 也注册 experimental.session.compacting 钩子，把未完成 todo
// 追加进 out.context（与 compaction-anchor 插件共存：对方已注入时**追加**而非覆盖，
// 双方都按自己的标记幂等，钩子顺序不可知也不互踩——2026-09-26 层 3 审查必须修复项 B）。
// 纯函数（经 _export 暴露离线回归）：todos → 锚点行数组；全完成/空 → []（零噪音）。
const TODO_ANCHOR_TAG = "验收清单（quality-gate 注入）";
// 幂等判定用唯一 ID（审查建议项：纯中文标记可被模型输出碰撞 → 误判已注入而跳过）
const TODO_ANCHOR_ID = "__KILO_QG_TODO_ANCHOR__";
function todoAnchorLines(todos) {
  try {
    const list = Array.isArray(todos) ? todos : [];
    if (list.length === 0) return [];
    const done = list.filter((t) => String(t?.status ?? "") === "completed").length;
    const undone = list
      .map((t) => String(t?.content ?? "").replace(/\s+/g, " ").trim())
      .filter((c, i) => c && String(list[i]?.status ?? "") !== "completed");
    if (undone.length === 0) return [];
    // 按码点截断 120（surrogate pair 劈裂 → 记忆/锚点乱码，Array.from 与 residualFixupLine 同口径）
    const clip = (s) => {
      const a = Array.from(s);
      return a.length > 120 ? a.slice(0, 120).join("") + "…" : s;
    };
    const lines = [
      `- ${TODO_ANCHOR_TAG} ${TODO_ANCHOR_ID}：任务进度 ${done}/${list.length}（压缩恢复后先对照自查再继续）：`,
      ...undone.slice(0, 15).map((c) => `  - [ ] ${clip(c)}`),
    ];
    if (undone.length > 15) lines.push(`  - （另有 ${undone.length - 15} 条未完成项未列出，见最近 todowrite）`);
    return lines;
  } catch {
    return [];
  }
}

// ── C 修复：漂移自检（2026-09-26）────────────────────────────────
// 痛点：验收清单立完，执行到后半段模型注意力已从清单滑走（方向漂移/镀金/漏项），
// 直到交付审查才发现 → 返工面∝全部工作量。中段低成本自检把漂移拦在半程。
// 纯函数（经 _export 暴露离线回归）：返回 true = 该提醒一次（桶内 driftChecked 保证只提醒一次）。
// 内聚 guard：done < total（全完成时不提醒——不依赖调用点的 !allDone，函数自洽可复用）。
function driftCheckDue(s) {
  try {
    const s0 = s ?? {};
    if (s0.driftChecked) return false;
    const todos = Array.isArray(s0.lastTodos) ? s0.lastTodos : [];
    if (todos.length < 2) return false; // 单条清单无「漂移」可言，不空提醒
    const done = todos.filter((t) => String(t?.status ?? "") === "completed").length;
    if (done >= todos.length) return false; // 全完成：交付节点接管，不重复提醒
    // 门槛：完成过半才提醒——太早=清单刚立还没执行方向无从漂移，纯噪音
    return done > 0 && done / todos.length >= 0.5;
  } catch {
    return false;
  }
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
// 口径 = 内容指纹优先（2026-10-01 改造，与 install.ps1 0e5beb0 同源；替代原纯 mtime）：
// git checkout/还原会把 src 与 dist 的 mtime 同步（install.ps1 当年换口径的实证根因），
// 原 mtime 比对在「编辑过 src 后经 git 操作」的交付上会假报新鲜——dab55da 实证：src 改了
// 未重建 dist，交付节点层 2 未拦，运行旧 dist 四天后才由 install -Check 指纹比对捕获。
// build.mjs 在 dist 首行嵌入 src/index.js 的 sha256，指纹比对不依赖文件系统时间。
// src 内非 index.js 的编辑：多入口会被 build.mjs 断言 fail-fast 拦截，未重建窗口期
// 用 mtime 兜底（>= 原口径）；无有效指纹的 dist 整体回落 mtime 口径（与旧行为一致）。
function distStaleOf(root, pkg, srcFiles) {
  try {
    const pkgDir = path.join(root, "provider", pkg);
    const dist = path.join(pkgDir, "dist", "index.js");
    if (!fs.existsSync(dist)) {
      // 编辑过 src 而 dist 不存在 = 从未构建，恰是要拦的假信心场景（非 fail-open）
      return { stale: true, missing: true, fingerprint: "absent" };
    }
    const distMtime = fs.statSync(dist).mtimeMs;
    let newestEdit = -Infinity;
    let nonIndexEdit = -Infinity; // index.js 的变更由指纹锚定，mtime 兜底只看其余 src 编辑
    for (const rel of srcFiles ?? []) {
      const full = path.join(pkgDir, "src", rel);
      if (!fs.existsSync(full)) continue; // 编辑后被删除/重命名：跳过，无 mtime 可比
      const mt = fs.statSync(full).mtimeMs;
      newestEdit = Math.max(newestEdit, mt);
      if (String(rel).replace(/\\/g, "/") !== "index.js") nonIndexEdit = Math.max(nonIndexEdit, mt);
    }
    const srcIndex = path.join(pkgDir, "src", "index.js");
    if (fs.existsSync(srcIndex)) {
      // 严格整行匹配（与 install.ps1 同口径）：BOM/CR/旧版无指纹产物归入 absent 类
      const banner = fs.readFileSync(dist, "utf8").replace(/^\uFEFF/, "").split("\n", 1)[0].replace(/\r$/, "");
      const m = banner.match(/^\/\/\s*kilo-build:\s*src-sha256=([0-9a-f]{64})$/);
      if (m) {
        const srcHash = createHash("sha256").update(fs.readFileSync(srcIndex, "utf8")).digest("hex");
        if (m[1] !== srcHash) return { stale: true, missing: false, fingerprint: "mismatch" };
        return { stale: nonIndexEdit >= distMtime, missing: false, fingerprint: "match" };
      }
    }
    // 无指纹/无 src/index.js：回落 mtime 全量口径（>= 防亚秒精度漏拦；病态时间戳由 verify-skipped 兜底）
    return { stale: newestEdit >= distMtime, missing: false, fingerprint: "absent" };
  } catch (e) {
    console.error(TAG, "distStaleOf 探测失败（fail-open 放行）：", e?.message ?? e);
    return { stale: false, missing: false, fingerprint: "error", error: String(e?.message ?? e).slice(0, 120) }; // fs 异常 fail-open 但必留日志，不静默
  }
}

// 层 3 触发口径（before/after 钩子共用，防两处漂移）：
// 高风险文件命中即触发（文件数无关）；普通改动须 ≥3 个**代码文件**。
// 2026-10-07 口径切换（用户预授权）：计数从 s.edited（全部编辑文件，含文档）改为 codeEdits
// （仅代码文件）——「1 代码 + 2 文档」不再触发，文档不计入触发面。
// 阈值沿革：≥3（全文件）→≥5（全文件，48h 遥测 22 次审查累计墙钟 35min，2026-09-22）
// →回调 ≥3（全文件，同日用户决策：人工复检返工成本高于单次自动审查，质量优先）
// →≥3（codeEdits，2026-10-07 用户指示嫌频时改按代码文件计数而非再调数字）。
// 纯文档会话不烧审查费（层 2 同样豁免文档，口径对齐）。
function isComplexDelivery(s, codeEdits) {
  return (s?.highRisk?.size ?? 0) > 0 || (codeEdits?.length ?? 0) >= 3;
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

// 诊断工具「真失败」判定（纯函数，经 _export 离线回归）：tsc/eslint/ruff 的 exit 1 =
// 检出问题（正常诊断产出，绝非工具异常）；exit 2 = 配置/内部错误；非数字 code
// （超时被杀/ENOENT/信号）= 真失败。只有真失败才记降级账本——否则每个有真实
// lint/类型错误的文件都记一条「工具运行失败」，污染审计账本（狼来了效应，
// 2026-09-26 层 3 审查对 eslint 的必须修复项，此处统一三工具口径）。
// ⚠️ 策略锚定：本插件约定「exit 1 一律视为诊断产出」——含 eslint --max-warnings=N 触发
// 的 exit 1（warn 超阈值在门禁语义里仍是「有诊断待处理」，不属工具异常）。改此约定需
// 同步改 test-quality-gate.mjs 的策略断言（防漂移）。
// ⚠️ 信号场景：Node 子进程被信号终止时 err.code === null（signal 非空），typeof !== "number"
// 走 true 判失败——正确，勿"优化"成 code > 1（null > 1 为 false 会漏判）。
function diagRunFailureOf(err) {
  if (!err) return false;
  if (typeof err.code !== "number") return true;
  return err.code !== 0 && err.code !== 1;
}

// 委派痕迹登记（C 修复支撑）：task/agent_manager 的调用参数不落入 commands/reads/edited，
// 需独立登记。用专用 s.delegated 数组（不复用 reads）——避免用户文件路径 `delegate: ...`
// 伪造痕迹；tool 名统一小写归一，覆盖 Task/Agent_Manager 等大小写变体。
// ⚠️ s.delegated 仅供「高风险越级提醒」判定使用，**严禁作为阻断/门禁决策依据**——它是
// 基于工具名的启发式痕迹，漏报已按 fail-safe 方向取舍（见 isDelegateCall）。
// ⚠️ 只认显式委派工具名白名单（DELEGATE_TOOLS），**绝不以 `subagent_type` 参数存在即判委派**——
// 普通/自定义工具恰带同名参数会被误判为委派，从而错误抑制高风险提醒（2026-09-26 层 3 复审
// 必须修复项）。白名单外的工具（含未来别名）一律不登记：漏登记只多一条咨询性提醒（fail-safe
// 方向），误登记则静默吞掉提醒（fail-open 反方向），两害相权取漏报。
// 维护：新增委派类工具须同步此白名单（fail-safe 取舍的前提是全量登记已知委派名）。
const DELEGATE_TOOLS = new Set(["task", "agent_manager"]);
function isDelegateCall(tool) {
  return DELEGATE_TOOLS.has(String(tool ?? "").trim().toLowerCase());
}

// 工具可用性一次性探测：缺失/离线环境永久跳过，不再每轮编辑烧满超时
async function probeTool(name) {
  if (probe[name] !== null) return probe[name];
  // 修复 G：eslint 走 npx eslint --version（与 tsc 同走 npx），其余直跑 <tool> --version
  const { err } = name === "tsc" || name === "eslint"
    ? await runCmd("npx", [name, "--version"], 8_000, projectRoot)
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

// eslint 配置探测（修复 G）：检测目录是否存在 eslint 配置文件。
// 进程级缓存（按 canonical dir，与 probe 同构）——**只缓存 true**（审查建议项）：
// false 不缓存——JS 项目中途新增 eslint 配置是常见流（装依赖带配置进来），
// 缓存 false 会让本会话后续 JS 编辑永远无诊断；true 后删配置是罕见误操作，
// 缓存 true 只导致多跑一次 eslint（无配置目录跑 eslint 会自身报错入降级账本，可见）。
// 全 try-catch fail-open，拿不到即返回 false（不跑诊断）。
const ESLINT_CONFIG_FILES = [
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
];
function eslintConfigIn(dir) {
  try {
    const d = String(dir ?? "");
    if (!d) return false;
    let key = d;
    try { key = fs.realpathSync.native(d); } catch { /* 保留原路径作 key */ }
    if (eslintConfigCache.get(key) === true) return true; // 只缓存 true（false 每次重探）
    let found = false;
    for (const name of ESLINT_CONFIG_FILES) {
      try {
        if (fs.existsSync(path.join(d, name))) { found = true; break; }
      } catch { /* 单文件探测失败继续下一个 */ }
    }
    if (found) eslintConfigCache.set(key, true);
    return found;
  } catch {
    return false;
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
  // 退出码语义（与 eslint/ruff 同口径，见 diagRunFailureOf）：tsc --noEmit 检出类型错误 =
  // exit 1（正常诊断产出，绝不是异常）；只有真失败（exit≥2 / 超时被杀 / ENOENT）才记降级。
  if (diagRunFailureOf(err)) {
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
  // 退出码语义（与 eslint/tsc 同口径，见 diagRunFailureOf）：ruff check 检出问题 = exit 1
  // （正常诊断产出）；只有真失败才记降级。
  if (diagRunFailureOf(err)) {
    recordDegradation(s, "静态检查异常（ruff 运行失败）", `${file.split(/[\\/]/).pop()}：${String(err?.message ?? err).slice(0, 80)}——诊断可能缺失`);
  }
  const diags = String(out ?? "").split(/\r?\n/).filter((l) => l.trim());
  s.fileChecks.set(file, { kind: "py", mtimeMs, diags });
  return diags;
}

// 修复 G：JS/JSX/MJS/CJS eslint 诊断（填补层 2 虚假安全网——VERIFY_CMD_RE 把
// npm run lint / npx eslint 算作层 2「跑赢」依据，但插件此前从未对 JS 跑过任何诊断）。
// 仅当目录存在 eslint 配置时真跑（JS 无 lint 配置是常态，不跑不记降级）。
// eslint 退出码语义（2026-09-26 层 3 审查必须修复项）：0=干净；1=有 lint 问题（正常诊断产出，
// 绝不是异常）；2=配置/崩溃真失败。runCmd 把非零退出统一算 err → 必须按 exit code 分流，
// 否则每个有真实 lint 问题的文件都记一条降级，污染审计账本（狼来了效应）。
async function eslintDiagnose(file, dir, s) {
  if (!eslintConfigIn(dir)) return []; // 无 eslint 配置 → 不跑（JS 无配置是常态，不算降级）
  if (!(await probeTool("eslint"))) {
    recordDegradation(s, "静态检查缺位（eslint 不可用）", "工具探测失败，JS 诊断静默跳过——交付前建议人工 eslint 复核");
    return [];
  }
  const mtimeMs = fileMtime(file);
  const cached = s.fileChecks.get(file);
  if (cached && cached.kind === "eslint" && cached.mtimeMs === mtimeMs) return cached.diags;
  const { err, out } = await runCmd(
    "npx",
    ["eslint", "--no-error-on-unmatched-pattern", file],
    15_000, // Windows npx 冷启动 3-8s + 规则集加载，10s 余量不足（审查建议项）
    dir,
  );
  // 退出码分流见 diagRunFailureOf（单一真源）：0/1 都有有效产出（exit 1 = lint 诊断本体），
  // 只有真失败才记降级。
  if (diagRunFailureOf(err)) {
    recordDegradation(s, "静态检查异常（eslint 运行失败）", `${file.split(/[\\/]/).pop()}：${String(err?.message ?? err).slice(0, 80)}——诊断可能缺失`);
  }
  const diags = String(out ?? "").split(/\r?\n/).filter((l) => l.trim());
  s.fileChecks.set(file, { kind: "eslint", mtimeMs, diags });
  return diags;
}

async function staticDiagnose(file, dir, s) {
  const ext = (file.match(/\.(\w+)$/) ?? [])[1]?.toLowerCase();
  // 分流顺序：py → ts 系（ts/tsx/mts/cts，tsc 只在有 tsconfig 时跑）→ eslint 系（js/jsx/mjs/cjs）
  if (ext === "py") return ruffDiagnose(file, dir, s);
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return tsDiagnose(file, dir, s);
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return eslintDiagnose(file, dir, s);
  return null; // 其他后缀暂不做
}

// 可诊断后缀（staticDiagnose 实际处理集）：入队过滤用——文档/其他代码后缀不进
// pendingDiags 空转，也避免文档编辑触发冲刷的第二轮补跑
// 修复 G：js/jsx/mjs/cjs 入队（eslint 分支只在配置存在时真跑，入队不过滤 js——
// 入队后 staticDiagnose 内部按配置存在与否分流，无配置直接返回 [] 不空转）
const DIAGNOSABLE_EXT = new Set(["ts", "tsx", "mts", "cts", "py", "js", "jsx", "mjs", "cjs"]);
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
  if (s.diagNotes.size === 0 && s.pendingDiags.size === 0) return null;
  const parts = [...s.diagNotes.entries()].map(([f, diags]) =>
    `${f}（共 ${diags.length} 条）：\n  ${diags.slice(0, 20).join("\n  ")}`);
  s.diagNotes.clear();
  // 审查建议项：预算耗尽时剩余积压文件显式留痕，不静默截断（否则产生「部分诊断」假象）
  if (s.pendingDiags.size > 0) {
    const remaining = [...s.pendingDiags].map((f) => f.split(/[\\/]/).pop()).slice(0, 5).join(", ");
    recordDegradation(s, "交付冲刷预算耗尽，部分文件未诊断", `${s.pendingDiags.size} 个文件未跑静态检查（${remaining}${s.pendingDiags.size > 5 ? " 等" : ""}）——下次编辑防抖会补跑，交付前建议人工复核`);
    parts.push(`⚠️ 预算耗尽：${s.pendingDiags.size} 个文件未诊断（${remaining}${s.pendingDiags.size > 5 ? " 等" : ""}）`);
  }
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
  // 意图锚点（2026-09-25 多模型审查采纳项）：验收清单并入审查素材——审查者从
  // 「只见 diff」升级为「diff + 任务目标/验收标准」，按「改动是否达成验收」审，
  // 降误报（把既有策略当缺陷）与漏报（改动偏离验收却无人对照）。s.lastTodos 由
  // todowrite 钩子维护（content+status 快照），非 todowrite 会话为空数组自然跳过。
  // 压缩有界：逐条 160 封顶（Array.from 代理对安全截断——层 3 审查项）+ 总条数
  // 20 上限（防长清单挤占 diff 预算，素材整体另有 24000 截断兜底）；status 随行
  // 标注（未完成项呈现为「待办」而非「应达成」，不误导审查者——层 3 正向审查项）。
  const todoLines = (Array.isArray(s?.lastTodos) ? s.lastTodos : [])
    .map((t) => {
      const c = String(t?.content ?? "").trim();
      if (!c) return "";
      const clipped = Array.from(c).length > 160 ? Array.from(c).slice(0, 160).join("") + "…" : c;
      return t?.status === "completed" ? `- ${clipped}` : `- [待办 ${String(t?.status ?? "pending")}] ${clipped}`;
    })
    .filter(Boolean)
    .slice(0, 20); // 先滤空再限 20：空项不占配额（第 2 轮审查建议项）
  if (todoLines.length > 0) {
    parts.push(`本次任务的验收清单（交付时应逐条达成，审查时对照）：\n${todoLines.join("\n")}`);
  }
  // planReviewed 消费点（审查建议项「死状态」）：图纸期（写码前）已跑过 dual_review 的会话
  // 在素材中声明——交付期审查者可参考图纸裁决基线，重点核对「实现是否兑现已审图纸」。
  if (s?.planReviewed) {
    parts.push("（注：本会话写码前已做过图纸审查（planReviewed），交付审查请重点核对实现与已审方案的一致性）");
  }
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

// ── 回合出口门禁（2026-10-03 收口审计专项）────────────────────
// 实证缺口：kilo.db 近 7 天审计，14 个带 todo 会话终止时清单未落定（9 模型提前收口 /
// 3 APIError 杀循环 / 1 length 烧尽 / 1 用户中止）。既有门禁只挂「todo 全 completed」
// 交付节点，对「带着 pending/in_progress 结束回合」零拦截——本门禁补上出口这条边。
// 机制：session.idle（及 session.error 落定后的延迟复检）时，未落定清单 → 经插件 client
// 注入一条续跑/表态指令（promptAsync）。防误伤六豁免 + 同快照封顶 2 次 + 快照变更重置，
// 全部 fail-open：门禁自身故障绝不影响宿主（钩子抛错会污染插件注册表，2026-09-22 教训）。
// v2 子代理终局聚合（同日按建议优化）：子会话豁免不注入，但未落定清单登记进父桶
// （childUnsettled）→ 父侧 todowrite 回注 / 父出口聚合注入（reason=child-unsettled），
// 补上「父会话续派前核对子代理未完成项」的机制通道；子补完终局则登记撤销。
const MAX_EXIT_NUDGES = 2;
const EXIT_NUDGE_COOLDOWN_MS = 15_000;
const EXIT_ERROR_SETTLE_MS = 12_000; // error 事件延迟复检窗：给 failover/重试想循环落定时间，防 busy 期注入
// 一次性诊断：ctx.client 缺失/形状不符时门禁会静默停用——必须留一条可查日志，
// 否则升级 Kilo 后契约漂移表现为「门禁从不触发」而无人察觉（7.8.x 版本漂移风险实证）。
let exitGateClientWarned = false;

// 纯函数（经 _export 离线回归）：未落定项数组；空清单/全落定 → null。
// 单条清单仅在 in_progress（明确干到一半）时纳入——pending 单条多为纯问答记账，噪音大于收益。
function todosIncomplete(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  const undone = arr.filter((t) => {
    const st = String(t?.status ?? "");
    return st !== "completed" && st !== "cancelled";
  });
  if (undone.length === 0) return null;
  if (arr.length === 1) return String(arr[0]?.status ?? "") === "in_progress" ? undone : null;
  return undone;
}

// 合法停点识别：末条文本以问题/请示收尾 → 等待用户是正确行为，不注入。
// 只宽认尾部窗口（防中段无关问号误豁免）；短语表宁多勿漏——误豁免方向安全（少注入不错注入）。
// 「等待用户：」是 INSTRUCTIONS 规定的显式停点标记（门禁注入文本亦要求模型回这句），
// 必须被识别，否则遵从纪律的模型反被二次注入（2026-10-03 查漏修复）；英文项目同理。
function asksUser(text) {
  const t = String(text ?? "").replace(/[\s`#*>-]+$/g, "");
  if (!t) return false;
  const tail = Array.from(t).slice(-160).join("");
  return (
    /[?？]\s*$/.test(tail) ||
    /等待用户|请指示|请确认|请选|请回复|等你|等您|需要你|是否继续|要不要|waiting for you|awaiting your|let me know/i.test(tail)
  );
}

// error 落定复检判据（纯函数，经 _export 离线回归）：busy/retry = failover/重试想循环尚未
// 落定 → 放弃本次复检（真 idle 时另有即时路径接管）；状态未知（""）偏向检查。
function errorSettleDue(lastStatus) {
  return !(lastStatus === "busy" || lastStatus === "retry");
}

// ── v2 子代理终局聚合（2026-10-03 按建议优化）───────────────────
// 痛点：子代理带半截清单终局时，既有设计对子会话豁免注入（防与父会话文件竞争），
// 但父侧只收到 runtime 的完成通知——「报告=完成」的默认信任没有清单证据，
// INSTRUCTIONS 出口纪律「父会话续派前核对未完成项」缺机制支撑。
// 方案：子会话未落定清单登记进父桶 s.childUnsettled（childID → {items,at,reported}），
// 双通道上报父侧：① 父任意 todowrite 的结果回注（工具结果直达模型视野，标记 reported
// 防出口重复烧额度）；② 父出口门禁聚合注入（与父自身未落定清单共用 cap/冷却指纹矩阵，
// reason=child-unsettled）。子会话补完后终局 → 登记撤销，防陈旧提醒。
// 已知边界：孙代（子-子代理）聚合只到直接父一层；子代理自身不再收到注入（豁免不变）。
const CHILD_UNSETTLED_MAX = 10; // 扇出上限保护：超限的新子不登记（父侧 runtime 通知仍在）

// 未上报的子聚合项（纯投影，经 _export 供离线回归断言 reported 状态）
function pendingChildrenOf(s) {
  const out = [];
  if (s?.childUnsettled instanceof Map) {
    for (const [id, e] of s.childUnsettled) {
      if (e && !e.reported) out.push({ id, items: (e.items ?? []).slice(), at: e.at ?? 0 });
    }
  }
  return out;
}

// 子终局时效标签：聚合项登记时间（at）→ 父侧判断「多新/多陈旧」的依据
//（刚登记的先核对产物，几天前的多半已在其他回合处理——at 若无人读取即死状态，
// 2026-10-03 审查要求「引入未使用」清零而接入展示）
function childAgeLabel(at, now) {
  const sec = Math.max(0, Math.floor(((Number(now) || 0) - (Number(at) || 0)) / 1000));
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function childUnsettledText(kids, now = Date.now()) {
  const list = kids ?? [];
  const shown = list.slice(0, 5).map((k) => `${String(k.id ?? "").slice(0, 28)}（${childAgeLabel(k.at, now)}登记，${(k.items ?? []).length} 项：${(k.items ?? []).slice(0, 3).map((i) => `[${String(i).slice(0, 70)}]`).join(" ")}）`);
  if (list.length > shown.length) shown.push(`另有 ${list.length - shown.length} 条（出口门禁将随后续事件补报）`);
  return shown.join("；");
}

// 子侧登记（父桶可能不存在——bucketOf 建桶是合理副作用，父会话本就活着）。
// 返回值 = 是否真登记（调用方据此决定 childReg 标记；审查修复：静默丢弃会让父侧
// 永久漏提醒且不可见——容量满优先淘汰已上报项，全未上报则记降级账本升级人工）。
function registerChildUnsettled(childID, parentID, undone) {
  try {
    const p = bucketOf({ sessionID: parentID });
    if (!(p.childUnsettled instanceof Map)) p.childUnsettled = new Map();
    if (!p.childUnsettled.has(childID) && p.childUnsettled.size >= CHILD_UNSETTLED_MAX) {
      let evict = null;
      for (const [id, e] of p.childUnsettled) if (e?.reported) { evict = id; break; }
      if (evict) p.childUnsettled.delete(evict);
      else {
        recordDegradation(p, "子代理终局聚合上限（未上报子项满 10）", `${childID} 的未落定清单未登记（父侧 runtime 完成通知仍在，建议手动核对子任务）`);
        return false;
      }
    }
    // items 存前归一：换行折叠为空格（多行内容会破坏注入口/回注的列表结构）
    const src = (undone ?? []).slice(0, 5).map((t) => `${String(t?.status ?? "pending")}:${String(t?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`);
    if ((undone ?? []).length > 5) src.push(`+${(undone ?? []).length - 5} 项未列出`); // 截断可见（审查修复：父不知清单被截）
    p.childUnsettled.set(childID, { items: src, at: Date.now(), reported: false });
    return true;
  } catch { return false; /* 登记失败静默：子侧豁免照常 */ }
}

function removeChildUnsettled(parentID, childID) {
  try {
    const p = sessions.get(String(parentID)); // 只读：父桶不在了说明聚合项已随 LRU 蒸发
    if (p?.childUnsettled instanceof Map) p.childUnsettled.delete(childID);
  } catch { /* 静默 */ }
}

// cap 降级登记（本地预检与完整路径共用，幂等：已登记不重复）
function recordExitCap(s, undone, kids) {
  if (s.exitGateCapped) return;
  s.exitGateCapped = true;
  const detail = (undone ?? []).slice(0, 3).map((t) => String(t?.content ?? "").slice(0, 40)).join(" / ")
    || (kids ?? []).map((k) => String(k?.id ?? "")).join(" / ");
  recordDegradation(s, "回合出口门禁提醒已达上限而清单仍未落定（升级人工）", detail);
}

// 未落定快照指纹：todowrite 清单内容/状态变化、或子聚合项集合变化 → 指纹变化 → 封顶计数重置。
// 动机（审查 r1#7）：多轮长会话累计 cap=2 会让前段白烧、后段真提前收口反而没人管。
// v2：children 并入指纹——新子代理终局 = 新快照，父侧重新获得 2 次提醒额度。
function exitNudgeFingerprint(todos, children) {
  const base = (Array.isArray(todos) ? todos : [])
    .map((t) => `${String(t?.status ?? "")}:${String(t?.content ?? "").slice(0, 60)}`)
    .join("|");
  const kids = (Array.isArray(children) ? children : [])
    .map((c) => `${c?.id ?? ""}:${(c?.items ?? []).join(",")}`)
    .join(";");
  return (kids ? `${base}|c:${kids}` : base).slice(0, 2000);
}

// 判定矩阵（纯函数，经 _export 离线回归）。对 s 的唯一副作用是「快照变更→计数重置」登记
// （exitNudges/exitNudgeFp），语义属门禁账本而非决策逻辑，测试可直接断言桶状态。
// v2：undone（父自身未落定项）与 children（子聚合项）任一存在即可能注入；
// 自身落定但 children 非空 → reason=child-unsettled。isChild 分支在接线层已提前返回，
// 此处保留作纵深防御（豁免优先级不变）。
function exitGateVerdict(s, { now, hasWork, isChild, aborted, errored, askingUser, undone, children, fingerprint }) {
  const hasOwn = !!undone && undone.length > 0;
  const hasKids = Array.isArray(children) && children.length > 0;
  if (!hasOwn && !hasKids) return { act: false, reason: "all-settled" };
  if (s.exitNudgeFp !== fingerprint) {
    s.exitNudges = 0;
    s.exitNudgeFp = fingerprint;
    // 查漏修复 A（2026-10-03 二轮）：capped 标记同样跟快照走——否则旧清单烧过 cap 后，
    // 新清单再烧 cap 的升级人工事件被永久拦截、账本静默缺失（recordDegradation 去重
    // 按 detail 文本区分，事件本身必须能再入一次）。
    s.exitGateCapped = false;
  }
  if ((s.exitNudges ?? 0) >= MAX_EXIT_NUDGES) return { act: false, reason: "nudge-cap" };
  if (now - (s.exitNudgeAt ?? 0) < EXIT_NUDGE_COOLDOWN_MS) return { act: false, reason: "cooldown" };
  if (!hasWork) return { act: false, reason: "no-work" };
  if (isChild) return { act: false, reason: "child-session" };
  if (aborted) return { act: false, reason: "user-aborted" };
  if (askingUser) return { act: false, reason: "awaiting-user" };
  if (!hasOwn) return { act: true, reason: "child-unsettled" };
  return { act: true, reason: errored ? "auto-resume-error" : "todos-pending" };
}

// 注入文本：自解释（来源/计数/收口三选一/上限语义），三种正确行为对应三种病
// （继续干 / 全部落定并注明 / 显式声明等待），杜绝「无声半收口」形态。
// v2：children 子聚合块并入文本；undone 与 children 都可能有（混合场景两段都给）。
function exitNudgeText(undone, n, reason, total, children, now = Date.now()) {
  const und = Array.isArray(undone) ? undone : [];
  const kids = Array.isArray(children) ? children : [];
  const head = und.length > 0
    ? `[quality-gate 回合出口门禁 #${n}/${MAX_EXIT_NUDGES}] 本回合已结束，但验收清单未落定（${(Number(total) || 0) - und.length}/${total} 完成）：\n${und.slice(0, 5).map((t) => `  - [${String(t?.status ?? "pending")}] ${String(t?.content ?? "").slice(0, 80)}`).join("\n")}\n\n`
    : `[quality-gate 回合出口门禁 #${n}/${MAX_EXIT_NUDGES}] 本回合已结束，但子任务侧仍有未落定事项：\n`;
  const kidShown = kids.slice(0, 5).map((k) => `  - 子会话 ${String(k.id ?? "").slice(0, 28)}（${childAgeLabel(k.at, now)}登记，${(k.items ?? []).length} 项）：${(k.items ?? []).slice(0, 3).map((i) => `[${String(i).slice(0, 70)}]`).join(" ")}`);
  if (kids.length > kidShown.length) kidShown.push(`  - （另有 ${kids.length - kidShown.length} 个子会话未列出，将随后续事件补报）`);
  const kidBlock = kids.length > 0
    ? `以下子代理终局时清单未落定，续派或收口前逐条核对（不得默认「报告=完成」）：\n${kidShown.join("\n")}\n\n`
    : "";
  const ownBody =
    reason === "auto-resume-error"
      ? "上一回合因 API 错误终止，请从首个未落定项继续执行（先核对文件与 todo 实际状态，勿重复已完成工作）。\n"
      : "任务确实未完 → 立即从未落定项继续，todo 随做随更新；交付确已完成 → 把剩余条目全部置 completed 或 cancelled（cancel 在交付说明给理由）；确在等用户决策 → 明确回一句「等待用户：<所问事项>」，不得无声收口。\n";
  const kidBody = "子任务确已完成 → 核对其实际产物后在交付说明注明；未完成 → 重新派发补完（有 task_id 的同会话续跑，勿盲目重派）；确在等用户决策 → 明确回一句「等待用户：<所问事项>」，不得无声收口。\n";
  return `${head}${kidBlock}${und.length > 0 ? ownBody : ""}${kids.length > 0 ? kidBody : ""}（同一清单状态下提醒达 ${MAX_EXIT_NUDGES} 次后门禁不再注入，记入降级账本升级人工。）`;
}

const QualityGateImpl = async ({ directory, client } = {}) => {
  // 工作区根由 Kilo 注入（同 compaction-anchor/memory-bootstrap 契约）；
  // 用它而非 process.cwd()，否则 worktree/monorepo 场景下 tsconfig 探测必败、检查静默关闭
  if (directory) projectRoot = directory;

  // 并发互斥（查漏修复 B，2026-10-03 二轮）：idle 即时路径与 error 延迟复检可同窗进入，
  // 而冷却/计数判定要等消息读取+发送完成才更新——无锁时两路会先后通过判定双重注入，
  // 一次烧光两条额度。加锁后第二路直接跳过（真需要提醒时后续 idle 仍会接管）。
  async function exitGateCheck(sid) {
    const s = sessions.get(sid);
    if (!s) return; // 无桶会话在主体内同样早退，这里不为其加锁
    if (s.exitGateInFlight) return;
    s.exitGateInFlight = true;
    try {
      await exitGateCheckInner(sid);
    } finally {
      s.exitGateInFlight = false;
    }
  }

  // 门禁检查主体（idle 即时 / error 延迟复检共用）。全程 fail-open：
  // 任何一步取不到可信信息（读消息失败/parentID 不可得）都偏向「不注入」——
  // 错误方向只会漏一次提醒，反向（误注入子代理/中止会话）会引发文件竞争与用户冒犯。
  async function exitGateCheckInner(sid) {
    try {
      if (!client || typeof client.session?.promptAsync !== "function") {
        if (!exitGateClientWarned) {
          exitGateClientWarned = true;
          console.error(TAG, "出口门禁：ctx.client 不可用（无 promptAsync），门禁停用——核对该 Kilo 版本的插件 ctx 契约");
        }
        return;
      }
      const s = sessions.get(sid); // 只读：从未 todowrite 过的会话无桶，自然跳过（绝不 bucketOf 建桶）
      if (!s) return;
      const own = Array.isArray(s.lastTodos) ? s.lastTodos : [];
      const undone = todosIncomplete(own);
      if (!undone && s.childReg) {
        // v2 撤销：子代理后续补完（清单全落定）→ 从父侧聚合登记移除，防陈旧提醒
        removeChildUnsettled(s.childReg, sid);
        s.childReg = "";
      }
      const kids = pendingChildrenOf(s);
      if (!undone && kids.length === 0) return; // 自身落定且无未上报子聚合项（含无清单且从未被登记）
      const hasWork = (s.edited?.size ?? 0) > 0 || (s.commands?.length ?? 0) > 0 || (s.delegated?.length ?? 0) > 0;
      // 本地预检早退（按建议优化②）：已知父会话（parentIDCache === ""，首次检查时定案缓存）
      // 的判定矩阵前段（cap/冷却/no-work；all-settled 已在上方早退）纯本地可定案——命中即
      // 返回，跳过两次 HTTP（消息/session.get）。远端相关豁免（child-session/user-aborted/
      // awaiting-user）在矩阵中均位于这些检查之后，不会改变本地结论；子会话（cache 非空）
      // 与未知会话照走完整路径（aborted 判定必须取远端）。
      if (s.parentIDCache === "") {
        const vLocal = exitGateVerdict(s, { now: Date.now(), hasWork, isChild: false, aborted: false, errored: false, askingUser: false, undone, children: kids, fingerprint: exitNudgeFingerprint(own, kids) });
        if (!vLocal.act) {
          if (vLocal.reason === "nudge-cap") recordExitCap(s, undone, kids);
          return;
        }
      }
      let aborted = false;
      let errored = false;
      let askingUser = false;
      try {
        const res = await client.session.messages({ path: { id: sid } });
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        const lastAssistant = list.slice().reverse().find((m) => m?.info?.role === "assistant");
        if (!lastAssistant) return; // 无 assistant 回复可依据：不注入
        const errName = String(lastAssistant?.info?.error?.name ?? "");
        aborted = errName === "MessageAbortedError";
        errored = !!lastAssistant?.info?.error && !aborted;
        const parts = Array.isArray(lastAssistant.parts) ? lastAssistant.parts : [];
        askingUser =
          parts.some((p) => p?.type === "tool" && /question/i.test(String(p.tool ?? ""))) ||
          asksUser(parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n"));
      } catch (e) {
        // 末条消息不可得：保守不注入，但必须可见——契约漂移时这里会持续报错而非静默停摆
        console.error(TAG, "出口门禁：读取会话消息失败，跳过：", e?.message ?? e);
        return;
      }
      let isChild = false;
      let parentID = "";
      try {
        const sg = await client.session.get({ path: { id: sid } });
        parentID = String(sg?.data?.parentID ?? "");
        isChild = !!parentID;
        s.parentIDCache = parentID; // 定案缓存：parentID 会话生命周期内不变，供本地预检早退
      } catch (e) {
        isChild = true; // parentID 不可得 → 保守当子代理（子代理收口归父会话衔接，注入会引发文件竞争）
        console.error(TAG, "出口门禁：parentID 不可得，按子代理保守跳过：", e?.message ?? e);
      }
      if (isChild) {
        // v2 子代理终局聚合：子会话不注入（原豁免不变），未落定清单登记进父桶，
        // 由父侧 todowrite 回注 / 出口注入统一核对。aborted 子代理跳过登记：
        // 用户手停子任务的语义父侧已收到 runtime 通知，再聚合是重复噪音。
        // 已知边界：孙代聚合只到直接父一层（子-子代理罕见，不递归上报）。
        if (parentID && undone && !aborted) {
          if (registerChildUnsettled(sid, parentID, undone)) s.childReg = parentID; // 登记成功才记撤销锚点
        } else if (parentID && aborted && s.childReg) {
          // 审查修复：先登记后被中止的子代理 → 撤销父侧陈旧项（不撤销则父收到过期未落定提醒）
          removeChildUnsettled(parentID, sid);
          s.childReg = "";
        }
        return;
      }
      // 本地预检以实际输入即可定案的路径不变（isChild 已在上方提前返回，此处恒 false 为纵深防御）
      const fingerprint = exitNudgeFingerprint(own, kids);
      const v = exitGateVerdict(s, { now: Date.now(), hasWork, isChild: false, aborted, errored, askingUser, undone, children: kids, fingerprint });
      if (!v.act) {
        if (v.reason === "nudge-cap") recordExitCap(s, undone, kids);
        return;
      }
      // 陈旧撤销竞态防护（审查修复）：kids 快照取自两次 await 之前，等待窗内子代理可能
      // 已补完并撤销父侧登记——发送前重查 pending，全撤且父自身也落定则放弃本次注入
      // （宁漏一次提醒，不拿陈旧清单烧额度）
      const pendingNow = pendingChildrenOf(s);
      const kidsSend = kids.filter((k) => pendingNow.some((n) => n.id === k.id));
      if (!undone && kidsSend.length === 0) return;
      const promptText = exitNudgeText(undone, (s.exitNudges ?? 0) + 1, v.reason, own.length, kidsSend);
      // 发送成功才计数：失败不烧上限额度（审查 r1#8）
      await client.session.promptAsync({
        path: { id: sid },
        body: {
          parts: [{ type: "text", text: promptText }],
          messageID: `msg_quality_gate_exit_${sid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        },
      });
      s.exitNudges = (s.exitNudges ?? 0) + 1;
      s.exitNudgeAt = Date.now();
      // v2：仅标记本次注入文本实际覆盖（前 5 条）的子聚合项 reported——审查修复：
      // 标记范围大于送达范围会让未列出的子项被静默抑制（指纹变化 → 后续事件补报）；
      // 发送失败路径不到达此处，保持 unreported 等待下次事件重试
      for (const k of kidsSend.slice(0, 5)) {
        const e = s.childUnsettled instanceof Map ? s.childUnsettled.get(k.id) : null;
        if (e) e.reported = true;
      }
      console.error(`${TAG} 出口门禁注入(${v.reason}) session=${sid} nudge=${s.exitNudges}/${MAX_EXIT_NUDGES}`);
    } catch (e) {
      console.error(TAG, "exit gate check failed:", e?.message ?? e); // fail-open
    }
  }

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
        // 触发口径与 after 钩子一致：高风险文件，或 ≥3 个代码文件（2026-10-07 起 codeEdits 口径）——
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
        // dist 新鲜度（内容指纹口径）：provider src 改了未重建 dist → 即使下面的验证 exit 0 也是旧行为
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
            `但对应 dist/index.js 未锚定当前 src 内容（构建指纹失配/过期）——验证跑的是旧行为，install -Check 也会拦截下发。` +
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

        // ①''' 委派痕迹入证据（C 修复「高风险越级提醒」的探测依据）：
        // 该提醒判定「本会话是否已有 general/task 委派痕迹」——但 task/agent_manager 调用的
        // 子代理名只在工具参数里，不落到 commands/reads/edited 任一处。此处显式登记到专用
        // s.delegated（不复用 reads——防用户路径伪造），且**不 return**（不阻断本工具其它
        // 通用登记路径，2026-09-26 层 3 审查必须修复项：after 早退会漏记副作用）。
        if (isDelegateCall(tool)) {
          const hint = String(args?.subagent_type ?? args?.description ?? args?.name ?? tool).slice(0, 120);
          s.delegated.push(`${String(tool).toLowerCase()} ${hint}`);
          if (s.delegated.length > 50) s.delegated.shift(); // 有界：防长会话无限累积
        }

        // ①'' dual_review 调用登记（层 3 自动闭环：完成节点查此标志）
        // 手动补审同时清 reviewPending：显式复审过的会话不应再被 before 钩子按旧裁决误拦。
        // 图纸/交付分流（2026-09-26）：写码前调 dual_review 审的是「验收清单+方案」（图纸），
        // 不得豁免写码后的交付自动审查（INSTRUCTIONS「图纸审查不计入交付审查豁免」的代码支撑）——
        // 只有发生过代码编辑（codeEditV>0）的审查才视为交付期审查置 dualReviewed。
        // 手动补审通过 = 显式复审闭环（审查建议项）：同步清零失败计数，否则两败永久放行后
        // 手动补审通过，后续 codeEditV 前进仍被 reviewRetryAllowed 的 count 闸抑制——
        // 「人工已确认通过」却永远失去自动重审，语义矛盾。
        // C1 修复（2026-09-27 层 3 补审漏洞）：豁免绑定审查时的代码版本 dualReviewedAtCodeEditV——
        // 手动补审后继续编辑代码（codeEditV 前进）→ 交付节点版本不对齐 → 自动审查照常触发，
        // 「审查时点之后的新改动」绝不静默跳审（subject 可能窄于全量 diff，旧裁决不覆盖新 diff）。
        if (tool === "dual_review") {
          if ((s.codeEditV ?? 0) > 0) {
            s.dualReviewed = true;
            s.dualReviewedAtCodeEditV = s.codeEditV;
            s.reviewPending = null;
            s.reviewFailedAtCodeEditV = 0;
            s.reviewFailedAtRound = 0;
            s.reviewFailedCount = 0;
          } else {
            s.planReviewed = true;
          }
          return;
        }

        // ② 记录编辑 + 异步防抖静态检查（P0-1：编辑路径零阻塞，诊断由交付节点冲刷回注）
        if (tool === "edit" || tool === "write") {
          const file = String(args?.filePath ?? args?.path ?? "");
          if (file) {
            rememberEdit(s, file);
            // 层 3 高风险触发登记（isComplexDelivery 依赖 s.highRisk.size>0）：高风险文件命中
            // 即触发交付审查，文件数无关——此登记与下方提醒是两件事，绝不可互相替代（曾误删）。
            if (isHighRiskFile(file)) s.highRisk.add(file);
            // C 修复（高风险越级提醒，一次性）：高风险文件由主 agent 直接编辑，但会话里
            // 没有任何委派痕迹（task/general）→ 与 INSTRUCTIONS「高风险实现委派 general@max」
            // 路由冲突，提醒一次由模型自行决断（提醒不拦截，宁漏报不误报——
            // 委派痕迹探测基于命令文本，无法覆盖所有委派形态）。
            if (isHighRiskFile(file) && !s.highRiskDelegated) {
              s.highRiskDelegated = true; // 一次性封顶，重复编辑不重复提醒
              // 只认显式委派登记（①''' 落池的 s.delegated）——独立数组 + 前缀标记，
              // 不复用 reads 松散匹配（edited 里的路径 src/task-runner.ts 会假性抑制提醒）。
              const delegated = (s.delegated ?? []).length > 0;
              if (!delegated) {
                appendToResult(
                  output,
                  `\n${TAG} ⚠️ 高风险文件提醒：正在直接编辑高风险路径（${file.split(/[\\/]/).pop()}）。` +
                    `INSTRUCTIONS 约定高风险实现应委派 general（高执行档）执行——若是小幅机械修补可直接继续，` +
                    `若是高风险实现主体请停下委派；忽略本提醒继续即可（只提醒这一次）。`
                );
              }
            }
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
          // v2 子代理终局聚合（todowrite 回注通道）：工具结果直达模型视野，标注后记
          // reported——同集合不再走出口注入重复烧额度；无后续 todowrite 的子项仍由出口路径兜底
          const kidsView = pendingChildrenOf(s);
          if (kidsView.length > 0) {
            notes.push(
              `ℹ️ 子代理终局未落定清单（续派/收口前逐条核对，不得默认「报告=完成」）：${childUnsettledText(kidsView)}——` +
                `已完成请核对其实际产物后在交付说明注明；未完成重新派发补完（有 task_id 的同会话续跑）。`
            );
            // 只标记回注文本实际展示的前 5 条（childUnsettledText 同界）——未展示的
            // 保持 unreported，由出口注入补报（审查修复：标记范围不得大于送达范围）
            for (const k of kidsView.slice(0, 5)) {
              const e = s.childUnsettled instanceof Map ? s.childUnsettled.get(k.id) : null;
              if (e) e.reported = true;
            }
          }
          const codeEdits = codeEditsOf(s);
          const allDone = todos.length > 0 && todos.every((t) => t?.status === "completed");
          // C 修复：完成过半的漂移自检（一次性）——对照验收清单自查方向，
          // 把镀金/漏项/漂移拦在半程而非交付审查（s.driftChecked 保证零重复提醒）
          if (!allDone && driftCheckDue(s)) {
            s.driftChecked = true;
            notes.push(
              `🧭 进度过半自查：对照验收清单（首条 todo）逐条核对——当前改动是否仍指向原验收标准？` +
                `有无镀金/漏项/方向漂移？发现偏离立即纠正，不要拖到交付审查。`
            );
          }
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
          // diff→test 关联断言（只警告不拦截，fail-open）：跑赢 ≠ 测到了——
          // 编辑过的代码模块在测试目录无任何引用 → 关键路径疑似未覆盖，绿灯也是侥幸。
          // 仅在已跑赢（或显式跳过）时核对：没跑测试的场景层 2 已拦，此处不重复噪音。
          if (allDone && codeEdits.length > 0 && (hasVerified(s) || hasSkipMarker(s))) {
            try {
              const { names, dropped } = moduleBasenamesOf(codeEdits);
              const res = await hasTestRefFor(projectRoot, names);
              if (!res.skip && res.missing.length > 0) {
                notes.push(
                  `⚠️ diff→test 关联断言：以下编辑过的代码模块在测试文件中无任何引用：` +
                    `${res.missing.join(", ")}——测试绿灯可能未覆盖这些改动路径。` +
                    `确认已有测试覆盖（改名/间接调用请在交付说明说明），或补一条对应测试再交付。` +
                    (dropped > 0 ? `（核对上限 ${TEST_REF_LIMIT}，另有 ${dropped} 个模块未核对）` : "")
                );
              } else if (!res.skip && dropped > 0) {
                notes.push(
                  `ℹ️ diff→test 关联断言：核对上限 ${TEST_REF_LIMIT}，另有 ${dropped} 个编辑模块未核对（前 ${TEST_REF_LIMIT} 个均有关联测试）。`
                );
              }
            } catch (e) {
              console.error(TAG, "test-ref check failed:", e?.message ?? e); // fail-open：断言异常不拦交付
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
          // F 修复：dualReviewed=true 的 fail-open 放行不再永久免审——失败后有新代码编辑
          // 时允许重审一次（reviewRetryAllowed），连续 MAX_REVIEW_FAILURES 次失败永久放行。
          // C1 修复（2026-09-27）：手动补审的豁免绑定 dualReviewedAtCodeEditV——审查后
          // 又有新代码编辑（版本不对齐）→ 豁免失效，交付节点照常自动审查；
          // 版本对齐（无新代码编辑）→ 维持「人工已确认通过」豁免。
          const dualReviewedFresh = s.dualReviewed && (s.codeEditV ?? 0) === (s.dualReviewedAtCodeEditV ?? 0);
          if (allDone && complex && !hasAcceptMarker(s) && (!dualReviewedFresh || reviewRetryAllowed(s))) {
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
                // 防同会话后续交付节点对同一素材反复重烧审查（隧道抖动重试的期望收益低于重复成本）。
                // F 修复：置位同时记失败版本，失败后有新代码编辑时交付节点可重审一次；
                // 连续 MAX_REVIEW_FAILURES 次 → 永久放行 + unreviewed 留痕（与 inconclusive 同口径）。
                s.dualReviewed = true;
                s.dualReviewedAtCodeEditV = s.codeEditV; // C1 修复：fail-open 放行也绑定版本（语义一致）
                s.reviewFailedAtCodeEditV = s.codeEditV;
                s.reviewFailedAtRound = s.reviewRounds;
                s.reviewFailedCount = (s.reviewFailedCount ?? 0) + 1;
                if (s.reviewFailedCount >= MAX_REVIEW_FAILURES) {
                  const marker = unreviewedMarkerLine();
                  const marked = await persistLineSafe(marker);
                  recordDegradation(s, "审查重试连续失败，本次会话永久放行未审交付", `${reviewFailPrefix(s)}unreviewed 留痕${marked ? "已沉淀项目记忆 Open Questions" : "沉淀失败（人工须记录）"}`);
                  // 审查建议项：持久层沉淀失败（磁盘满/权限）→ output 内联兜底，审计行不丢
                  if (!marked) appendToResult(output, `\n${TAG} 📌 ${marker}`);
                }
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
                s.dualReviewedAtCodeEditV = s.codeEditV; // C1 修复：inconclusive 放行同样绑定版本
                // F 修复：inconclusive 放行同执行异常记账——新编辑后重审一次，连续两败永久放行
                s.reviewFailedAtCodeEditV = s.codeEditV;
                s.reviewFailedAtRound = s.reviewRounds;
                s.reviewFailedCount = (s.reviewFailedCount ?? 0) + 1;
                if (s.reviewFailedCount >= MAX_REVIEW_FAILURES) {
                  const marker = unreviewedMarkerLine();
                  const marked = await persistLineSafe(marker);
                  recordDegradation(s, "审查重试连续失败，本次会话永久放行未审交付", `${reviewFailPrefix(s)}unreviewed 留痕${marked ? "已沉淀项目记忆 Open Questions" : "沉淀失败（人工须记录）"}`);
                  if (!marked) appendToResult(output, `\n${TAG} 📌 ${marker}`);
                }
                recordDegradation(s, "审查上游失败（按未审查交付）", (v.verdictLine || "裁决不可解析").slice(0, 120));
                appendToResult(output, `\n${TAG} ⚠️ 审查结果无法解析（上游失败），本次按未审查交付，请人工留意。`);
              } else if (v.fail) {
                s.reviewRounds += 1;
                if (s.reviewRounds >= MAX_REVIEW_ROUNDS) {
                  s.dualReviewed = true;
                  s.dualReviewedAtCodeEditV = s.codeEditV; // C1 修复：上限放行同样绑定版本
                  // ⑤ 残余项沉淀进项目记忆 Open Questions（fail-open，关闭即忘 → 持久可见）
                  const persisted = await persistResidualSafe(v.fixSection);
                  recordDegradation(s, `审查 ${s.reviewRounds} 轮未过按上限放行${persisted ? "（残余项已沉淀项目记忆 Open Questions）" : "（残余项沉淀失败，人工须记录）"}`, v.fixSection);
                  // F 修复：轮次上限放行也是「有未闭环残余的放行」——记失败版本，新编辑后可再试；
                  // 连续 MAX_REVIEW_FAILURES 次仍不过 → 永久放行 + unreviewed 留痕持久可见
                  s.reviewFailedAtCodeEditV = s.codeEditV;
                  s.reviewFailedAtRound = s.reviewRounds;
                  s.reviewFailedCount = (s.reviewFailedCount ?? 0) + 1;
                  if (s.reviewFailedCount >= MAX_REVIEW_FAILURES) {
                    const marker = unreviewedMarkerLine();
                    const marked = await persistLineSafe(marker);
                    recordDegradation(s, "审查重试连续失败，本次会话永久放行未审交付", `${reviewFailPrefix(s)}unreviewed 留痕${marked ? "已沉淀项目记忆 Open Questions" : "沉淀失败（人工须记录）"}`);
                    if (!marked) appendToResult(output, `\n${TAG} 📌 ${marker}`);
                  }
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
                s.dualReviewedAtCodeEditV = s.codeEditV; // C1 修复：通过裁决同样绑定版本，新编辑后重审
                s.reviewPending = null;
                // F 修复：重审通过 → 失败计数清零（闭环完成，后续复杂交付重新起算）
                s.reviewFailedAtCodeEditV = 0;
                s.reviewFailedAtRound = 0;
                s.reviewFailedCount = 0;
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

    // 回合出口门禁事件面。契约（2026-10-03 对运行中 7.8.3 二进制反编译实证）：
    // 插件 event 钩子分发为 `hooks.event?.({ event: { id, type, properties } })`（properties=事件 data）；
    // session.idle properties={sessionID}、session.error={sessionID?, error}、session.status={sessionID, status}。
    // session.error 不直接注入：延迟 EXIT_ERROR_SETTLE_MS 复检，且复检时 lastStatus 仍 busy/retry
    // （failover/重试想循环未落定）就放弃——真 idle 时另有即时路径接管。
    event: async (input) => {
      try {
        const ev = input?.event;
        if (!ev) return;
        const sid = ev.properties?.sessionID ?? ev.properties?.info?.id;
        if (!sid) return;
        const key = String(sid);
        if (ev.type === "session.status") {
          const s0 = sessions.get(key);
          if (s0) s0.lastStatus = String(ev.properties?.status?.type ?? "");
          return;
        }
        if (ev.type === "session.idle") {
          await exitGateCheck(key);
          return;
        }
        if (ev.type === "session.error") {
          const s1 = sessions.get(key);
          if (!s1) return;
          if (s1.exitCheckTimer) clearTimeout(s1.exitCheckTimer);
          s1.exitCheckTimer = setTimeout(() => {
            s1.exitCheckTimer = null;
            if (!errorSettleDue(s1.lastStatus)) return;
            exitGateCheck(key);
          }, EXIT_ERROR_SETTLE_MS);
        }
      } catch (e) {
        console.error(TAG, "event hook failed:", e?.message ?? e); // fail-open：事件面故障不得上抛
      }
    },

    // B 修复：验收清单压缩锚点——与 compaction-anchor 插件共用
    // experimental.session.compacting 钩子（Kilo 对多插件同钩子为顺序聚合，顺序不可知）。
    // 双方契约：一律**追加合并**（out.context = [...existing, ...lines]），按各自标记幂等——
    // 无论谁先跑，两份锚点都存活，绝不互相覆盖（2026-09-26 层 3 审查必须修复项 B）。
    // 兜底（审查建议项）：锚点同时记降级账本——若 Kilo 未来改为 last-writer-wins 聚合
    // （output 副本隔离），压缩上下文丢失清单锚点时，交付节点的账本汇总仍可见未完成项。
    "experimental.session.compacting": async (input, output) => {
      try {
        const out = output ?? {};
        const existing = Array.isArray(out.context) ? out.context : [];
        const s = bucketOf(input);
        const lines = todoAnchorLines(s.lastTodos);
        if (lines.length === 0) return;
        recordDegradation(s, "压缩时验收清单未完成（锚点已注入，恢复后对照自查）", lines.join(" | ").slice(0, 200));
        if (existing.some((l) => String(l ?? "").includes(TODO_ANCHOR_ID))) return; // 幂等：钩子被调两次只注入一次（唯一 ID 防碰撞）
        out.context = [...existing, ...lines];
      } catch (e) {
        console.error(TAG, "compacting hook failed:", e?.message ?? e); // fail-open：锚点失败不阻断压缩
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
  staleDeployOf, moduleBasenamesOf, hasTestRefFor,
  eslintConfigIn, reviewRetryAllowed, todoAnchorLines, unreviewedMarkerLine, driftCheckDue,
  diagRunFailureOf, isDelegateCall, reviewFailPrefix,
  todosIncomplete, asksUser, errorSettleDue, exitNudgeFingerprint, exitGateVerdict, exitNudgeText,
  pendingChildrenOf, childUnsettledText, registerChildUnsettled, removeChildUnsettled, childAgeLabel,
  bucketOf, // 离线回归测试缝：断言钩子对会话桶的登记副作用（如 s.highRisk/s.delegated），只读使用
  VERIFY_CMD_RE, HIGH_RISK_RE,
};

export default QualityGate;
