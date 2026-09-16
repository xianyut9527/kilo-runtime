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
// 附加：edit/write 后按后缀跑静态检查（ruff / tsc --noEmit），诊断即时回注。
//   工具可用性一次性探测（缺失则永久跳过，不再每轮烧超时）；并发编辑单飞共享一次 tsc；
//   同文件未变更（mtime 未变）直接复用上次诊断，tsc 全量运行不再受时间窗陈旧性影响。
// 层 3 全自动闭环（W3.9/W3.11）：交付节点（todo 全 completed + 高风险文件，或含代码改动
//   且跨 ≥3 文件——纯文档会话不烧审查费）由插件直调 dual-review 的 runDualReview。
//   审查对象自动构建：编辑文件清单 + git diff HEAD（含已暂存，截断防 prompt 爆炸）
//   +未跟踪新文件全文（不在 diff 里，审查者原本看不见），降级为会话证据池（脱敏命令）。
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

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runDualReview } from "./dual-review";

const TAG = "[quality-gate]";

// ── 进程级（环境属性，跨会话共享）────────────────────────────
let projectRoot = process.cwd();
const probe = { tsc: null, ruff: null }; // null=未探测，true/false=可用性
let tscInFlight = null; // 并发编辑单飞：共享同一次 tsc 全量输出

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
    s = { commands: [], reads: [], lastTodos: [], edited: new Set(), fileChecks: new Map(), highRisk: new Set(), dualReviewed: false, reviewPending: null, reviewRounds: 0, editVersion: 0 };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
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

function rememberCommand(s, cmd) {
  s.commands.push(scrubCommand(cmd));
  if (s.commands.length > MAX_COMMANDS) s.commands.shift();
}

// 验证命令识别：只认命令动词位（命令开头或 ; | || && 之后），自由子串会误放行
// （`git tag v0.1-test` 这类含 test 字样的普通命令不能算已验证）。
// 口径与 INSTRUCTIONS「测试或构建」对齐：build/type-check 计入；make/dotnet/phpunit
// 与直跑 test 前缀脚本（bun test-x.mjs——本仓离线测试的既定形态）也计入。
const VERIFY_CMD_RE =
  /(?:^|[;|]|&&|\|\|)\s*(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|lint|check|typecheck|type-check|build)\b|(?:npx|bunx)\s+(?:jest|vitest|tsc|eslint|ruff)\b|(?:jest|vitest|mypy|pytest|eslint|ruff|tsc)\s|go\s+(?:test|vet)\b|cargo\s+(?:test|check|clippy)\b|python[0-9.]*\s+-m\s+(?:pytest|unittest)\b|(?:mvn|gradlew?)\b[^;&|\n]*\btest\b|make\s+(?:test|check|lint)\b|dotnet\s+test\b|phpunit\b|(?:node|bun|deno|python[0-9.]*)\s+(?:[\w\/\\.-]*[\/\\])?test[\w.-]*\.(?:mjs|cjs|js|ts|tsx|py)\b)/i;
export { VERIFY_CMD_RE };

function hasRanVerify(s) {
  return s.commands.some((c) => VERIFY_CMD_RE.test(c));
}

function rememberEdit(s, p) {
  if (typeof p !== "string" || !p) return;
  s.edited.add(p);
  s.editVersion = (s.editVersion ?? 0) + 1; // 层 3 闭环：编辑计数，审查后有无修复靠它判定
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
  return s.commands.some((c) => VERIFY_SKIP_RE.test(c));
}

// ── 层 3 闭环（审查未通过 → 阻断交付，修复后自动再审，直到通过或升级人工）──
const MAX_REVIEW_ROUNDS = 2; // 自动审查轮次上限：超限放行并回注残余项（升级人工），防死循环烧钱
const REVIEW_ACCEPT_RE = /review-accepted\s*:/i;

function hasAcceptMarker(s) {
  return s.commands.some((c) => REVIEW_ACCEPT_RE.test(c));
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
  return [...s.commands, ...s.reads, ...s.edited].join("\n").toLowerCase();
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

// 单飞：并发到达的多个编辑共享同一次 tsc 全量运行
function runTscOnce(dir) {
  if (!tscInFlight) {
    tscInFlight = runCmd("npx", ["tsc", "--noEmit", "--pretty", "false"], 20_000, dir)
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
// git diff（对 HEAD，含已暂存改动——只 diff 工作区会漏掉 git add 过的内容）有内容则取
// （真实改动最可靠的审查素材），截断防 prompt 爆炸；未跟踪新文件不在 git diff 里——
// 审查者原本只看得见文件名，按「diff 中未出现」逐个补读全文（有界：最多 8 个 × 4000 字符）；
// 无 git（非 repo / 命令失败）则降级为会话证据池（编辑文件列表 + 脱敏命令）。
// 已提交的改动不在任何 diff 里（会话中途 commit 的场景）——由文件名清单兜底可见性。
export async function reviewSubject(root, s, editedList) {
  const parts = [`本次会话编辑了以下文件：\n${editedList}`];
  let diffText = "";
  try {
    const { out } = await runCmd("git", ["diff", "HEAD", "--unified=3", "--no-color"], 10_000, root);
    diffText = String(out ?? "");
  } catch { /* 非 git 环境：走降级 */ }
  if (diffText.trim().length > 50) parts.push(`对应 git diff：\n${diffText}`);
  const unseen = [...s.edited].filter(isCodeFile).filter((f) => !diffText.includes(path.basename(f))).slice(0, 8);
  for (const f of unseen) {
    try {
      const content = fs.readFileSync(f, "utf8");
      if (content.trim()) parts.push(`### ${f}（完整内容——未出现在 diff 中，新文件）\n${content.slice(0, 4000)}`);
    } catch { /* 文件已移走则跳过 */ }
  }
  if (diffText.trim().length <= 50 && unseen.length === 0) {
    parts.push(`会话内执行过的命令（已脱敏）：\n${s.commands.slice(-30).join("\n") || "（无）"}`);
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
        // 触发口径与 after 钩子一致：高风险文件，或含代码改动且跨 ≥3 文件——
        // 纯文档会话不送付费审查（层 2 同样豁免文档，口径对齐）。
        const complexEarly = s.highRisk.size > 0 || (codeEdits.length > 0 && s.edited.size >= 3);
        if (complexEarly && s.reviewPending && !hasAcceptMarker(s) && s.editVersion === s.reviewPending.editVersion) {
          const p = s.reviewPending;
          throw new Error(
            `[quality-gate] 层 3 闭环：双向审查未通过（${p.verdictLine || "有条件通过"}），存在未处理的必须修复项：\n${p.fixSection}\n\n` +
              `二选一：① 逐条修复后重新标记全部完成——将自动触发第 ${s.reviewRounds + 1}/${MAX_REVIEW_ROUNDS} 轮审查；` +
              `② 确认接受残余风险则执行 echo "review-accepted: <原因>"（可审计）后重试。`
          );
        }
        if (codeEdits.length === 0) return; // 非代码编辑不受限
        if (hasRanVerify(s) || hasSkipMarker(s)) return;
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

        // ① 记录 bash 命令（脱敏后入证据池 + 验证判定）
        if (tool === "bash" || tool === "shell") {
          const cmd = typeof args === "string" ? args : String(args?.command ?? "");
          rememberCommand(s, cmd);
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

        // ② 记录编辑 + 静态检查回注
        if (tool === "edit" || tool === "write") {
          const file = String(args?.filePath ?? args?.path ?? "");
          if (file) {
            rememberEdit(s, file);
            if (isHighRiskFile(file)) s.highRisk.add(file);
            const diags = await staticDiagnose(file, projectRoot, s);
            if (diags && diags.length > 0) {
              appendToResult(
                output,
                `\n${TAG} 编辑后静态检查（仅本次编辑文件相关诊断，共 ${diags.length} 条，需修复后再交付）：\n` +
                  diags.slice(0, 20).join("\n")
              );
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
          }

          // 层 3 全自动执行 + 闭环：todo 全部 completed（交付节点）+ 高风险/复杂改动
          // + 本会话审查未通过/未做过 → 插件直调 runDualReview（正反审查+裁决）。
          // 闭环语义：裁决未通过 → 记录 must-fix 并阻断本次交付（before 钩子），
          // 修复后重新标记完成 → 此处自动再审；通过才置 dualReviewed。
          // 轮次上限（MAX_REVIEW_ROUNDS）后仍不过 → 放行并回注残余项（升级人工，防死循环）。
          // 无法解析的裁决（上游失败等）→ fail-open 不阻断（质量降质但不卡交付）。
          const allDone = todos.length > 0 && todos.every((t) => t?.status === "completed");
          // 与 before 钩子同一口径：高风险文件，或含代码改动且跨 ≥3 文件（纯文档不烧审查费）
          const complex = s.highRisk.size > 0 || (codeEdits.length > 0 && s.edited.size >= 3);
          if (allDone && complex && !s.dualReviewed && !hasAcceptMarker(s)) {
            const editedList = [...s.edited].slice(0, 30).join("\n");
            const subject = await reviewSubject(projectRoot, s, editedList);
            try {
              const verdict = await runDualReview(subject);
              const v = parseReviewVerdict(verdict);
              appendToResult(output, `\n${TAG} 层 3 双向审查（自动执行，正反异源模型+裁决）\n${verdict}`);
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
            } catch (e) {
              console.error(TAG, "auto dual review failed:", e?.message ?? e);
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
