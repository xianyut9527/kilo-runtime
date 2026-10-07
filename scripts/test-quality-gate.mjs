#!/usr/bin/env node
// quality-gate 纯函数离线回归：不联网、不起 Kilo。
// 用法：node scripts/test-quality-gate.mjs
// 原理：用 esbuild（provider 的既有依赖）把 plugin/quality-gate.ts 打包到临时文件再 import——
// 直接 import 会死在「./dual-review 无扩展名」的 Node ESM 解析上。
// 覆盖：parseReviewVerdict 裁决解析 / VERIFY_CMD_RE 验证命令识别 / HIGH_RISK_RE 高风险路径
// / reviewSubject 无 git 降级 / exitCodeOf 退出码三段契约 / exitMasked 遮蔽形态
// / hasVerified·verifyFailureOf 结果实证判定 / reviewerFingerprint 审查缓存指纹
// / providerEditsOf·distStaleOf 层 2 dist 新鲜度（内容指纹口径：mismatch 必拦、
// match 免疫 mtime 抖动、无指纹回落 mtime；src 改未重建 → 交付拦截）。
// 正则、门禁逻辑与进度通道的任何回归（含 CJK 腐化）都会让本测试变红。
// 注意：本文件必须在 scripts/ 下（不进 install.manifest）——放 plugin/ 会随整目录部署进生产配置。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const esbuildBin = path.join(ROOT, "provider/hx-failover/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuildBin)) {
  console.error("[test] esbuild 未安装：先在 provider/hx-failover 跑 npm install");
  process.exit(2);
}
const bundle = path.join(os.tmpdir(), `qg-test-${process.pid}.mjs`);
execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "quality-gate.ts"),
  "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle}`], { stdio: "inherit" });
// try…finally 兜底（层 3 必修项①）：import 抛错时临时 bundle 不得残留
let mod;
try {
  mod = await import(pathToFileURL(bundle).href);
} finally {
  fs.rmSync(bundle, { force: true });
}

// 工具函数经 _export 命名空间暴露（非顶层导出——Kilo vE2 会把每个导出函数当工厂调用）
const { parseReviewVerdict, VERIFY_CMD_RE, HIGH_RISK_RE, reviewSubject, exitCodeOf, exitMasked, hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker, isComplexDelivery, diagCoversLastEdit, providerEditsOf, distStaleOf, residualFixupLine, insertUnderHeading, degradationSummary, staleDeployOf, moduleBasenamesOf, hasTestRefFor, eslintConfigIn, reviewRetryAllowed, todoAnchorLines, unreviewedMarkerLine, driftCheckDue, diagRunFailureOf, isDelegateCall, reviewFailPrefix, todosIncomplete, asksUser, errorSettleDue, exitNudgeFingerprint, exitGateVerdict, exitNudgeText,
    pendingChildrenOf, childUnsettledText, registerChildUnsettled, removeChildUnsettled, childAgeLabel,
    setFileCheck, addHighRisk, rememberCommand, MAX_FILE_CHECKS, MAX_HIGH_RISK, SLEEP_CMD_RE } = mod._export ?? mod;
let pass = 0, fail = 0;
const failed = [];
// t 双模（层 3 必修项②）：cond 传函数则在其内部捕获异常记为 fail（含错误信息），
// 单个用例抛错不再中断后续全部断言；传值则维持旧语义（存量调用不强制改造）。
// 新增断言一律传 () => 表达式 获得韧性保护。
// 假绿防线（层 3 r2 必修项②）：Promise/async 函数返回值恒 truthy，!! 判定会静默通过——
// 检出即抛错计 fail，强制调用点 await 后传值（本套件为同步回归，无合法异步用例）。
const t = (name, cond) => {
  let ok = false;
  try {
    const v = typeof cond === "function" ? cond() : cond;
    if (v instanceof Promise) throw new Error("t() 拒绝 Promise（恒 truthy = 假绿）——await 后传值，或改为同步断言");
    ok = !!v;
  } catch (e) {
    failed.push(`${name}（抛错：${String(e?.message ?? e).slice(0, 120)}）`);
    console.error(`  FAIL(throw): ${name}\n    ${String(e?.message ?? e).split("\n")[0]}`);
    fail++;
    return;
  }
  if (ok) { pass++; }
  else { fail++; failed.push(name); console.error(`  FAIL: ${name}`); }
};

// ── parseReviewVerdict ──
t("通过+必须修复项为空 → fail=false", (() => {
  const v = parseReviewVerdict("## 裁决\n通过 ✅\n\n## 必须修复项\n无");
  return v.fail === false && v.inconclusive === false;
})());
t("裁决不通过 → fail=true", parseReviewVerdict("## 裁决\n不通过 ❌\n\n## 必须修复项\n无").fail === true);
t("必须修复项非空 → fail=true（即便裁决写通过）", parseReviewVerdict("## 裁决\n通过\n\n## 必须修复项\n- 修复空指针").fail === true);
t("无裁决段 → inconclusive（上游失败 fail-open）", parseReviewVerdict("dual_review: 正向模型失败").inconclusive === true);
t("裁决回显选项（三选一）时只看必须修复项段", parseReviewVerdict("## 裁决\n三选一：① 通过 ② 不通过\n\n## 必须修复项\n无").fail === false);
t("必须修复项段在 <details> 前截止", parseReviewVerdict("## 裁决\n通过\n\n## 必须修复项\n- 修 A\n<details><summary>细节</summary>").fixSection.includes("修 A"));

// ── VERIFY_CMD_RE ──
t("npm test 命中", VERIFY_CMD_RE.test("npm test"));
t("npm run build 命中", VERIFY_CMD_RE.test("npm run build"));
t("npx tsc --noEmit 命中", VERIFY_CMD_RE.test("npx tsc --noEmit"));
t("node scripts/test-x.mjs 命中", VERIFY_CMD_RE.test("node scripts/test-x.mjs"));
t("git tag v1.0-test 不命中", !VERIFY_CMD_RE.test("git tag v1.0-test"));
t("echo verify-skipped 不算验证", !VERIFY_CMD_RE.test('echo "verify-skipped: 理由"'));
t("管道后半段 pytest 命中", VERIFY_CMD_RE.test("cd x && pytest tests/"));

// ── HIGH_RISK_RE ──
t("文件名开头命中 auth.ts", HIGH_RISK_RE.test("auth.ts"));
t("目录段命中 src/auth/utils.ts", HIGH_RISK_RE.test("src/auth/utils.ts"));
t("目录段命中 src/order/query.ts", HIGH_RISK_RE.test("src/order/query.ts"));
t("仅前缀相似目录不命中 reorder", !HIGH_RISK_RE.test("src/reorder/utils.ts"));
t("仅前缀相似目录不命中 order-system", !HIGH_RISK_RE.test("src/order-system/utils.ts"));
t("普通文件不命中", !HIGH_RISK_RE.test("src/components/button.vue"));
t("README.md 不命中", !HIGH_RISK_RE.test("README.md"));

// ── exitCodeOf：退出码三段契约防御 ──
t("exitCodeOf：output.exitCode 显式字段", exitCodeOf({ exitCode: 1 }) === 1);
t("exitCodeOf：output.exit 显式字段", exitCodeOf({ exit: 0 }) === 0);
t("exitCodeOf：metadata 降级", exitCodeOf({ metadata: { exit: 2 } }) === 2);
t("exitCodeOf：结果文本解析（失败形态，独占一行）", exitCodeOf({ output: "oops\nExit code: 1" }) === 1);
t("exitCodeOf：描述性文本不误采（Expected exit code: 0）", exitCodeOf({ output: "Expected exit code: 0\n" }) === undefined);
t("exitCodeOf：纯字符串 output 也解析", exitCodeOf("Exit code: 2") === 2);
t("exitCodeOf：成功无退出信息 → undefined（降级旧口径）", exitCodeOf({ output: "all tests passed" }) === undefined);
t("exitCodeOf：output 缺失 → undefined", exitCodeOf(null) === undefined);

// ── exitMasked：退出码遮蔽形态 ──
t("exitMasked：|| true 遮蔽", exitMasked("npm test || true") === true);
t("exitMasked：|| exit 0 遮蔽", exitMasked("npm test || exit 0") === true);
t("exitMasked：|| exit 1 传播失败不遮蔽", exitMasked("npm test || exit 1") === false);
t("exitMasked：|| echo ok 遮蔽", exitMasked('npm test || echo "ok"') === true);
t("exitMasked：|| false 不遮蔽（false 保留失败退出码）", exitMasked("npm test || false") === false);
t("exitMasked：; echo ok 遮蔽（分号尾段以成功命令开头）", exitMasked("npm test; echo done") === true);
t("exitMasked：; true && deploy 不遮蔽（尾段 && 接非成功命令）", exitMasked("npm test; true && deploy") === false);
t("exitMasked：; true && echo ok 遮蔽（尾段 && 接成功命令）", exitMasked("npm test; true && echo ok") === true);
t("exitMasked：中间分号段成功但尾段非成功不遮蔽", exitMasked("echo start; true; npm test") === false);
t("exitMasked：非透传管道遮蔽（cat/tee 类已豁免）", exitMasked("npm test | node check.js") === true);
t("exitMasked：grep 会改写退出码（匹配与否）→ 不豁免", exitMasked("npm test | grep pattern") === true);
t("exitMasked：pipefail 字样出现在 echo 文本不豁免", exitMasked('echo "no pipefail"; npm test | node x.js') === true);
t("exitMasked：tee 透传管道豁免（留档无遮蔽意图）", exitMasked("npm test | tee out.log") === false);
t("exitMasked：head 截断管道豁免", exitMasked("npm test 2>&1 | head -50") === false);
t("exitMasked：多段全透传管道豁免", exitMasked("npm test | head -50 | sort") === false);
t("exitMasked：非透传后段仍遮蔽", exitMasked("npm test | weird-cmd") === true);
t("exitMasked：透传后跟非透传段仍遮蔽", exitMasked("npm test | tee a.log | weird-cmd") === true);
t("exitMasked：pipefail 管道不遮蔽", exitMasked("set -o pipefail && npm test | cat") === false);
t("exitMasked：&& 不吞码（不得误标）", exitMasked("cd x && npm test && echo done") === false);
t("exitMasked：普通验证命令不遮蔽", exitMasked("npm test") === false);
t("exitMasked：行尾悬挂 ||", exitMasked("npm test ||") === true);

// ── hasVerified / verifyFailureOf：结果实证判定 ──
const mk = (commands, codeEditV) => ({ commands, codeEditV });
t("跑赢：末次代码编辑后 exit 0", hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 1 }], 1)) === true);
t("未验证：验证命令 exit 非 0", hasVerified(mk([{ cmd: "npm test", exit: 1, editV: 1 }], 1)) === false);
t("失败可查：exit 非 0 → verifyFailureOf 命中", (() => {
  const f = verifyFailureOf(mk([{ cmd: "npm test", exit: 1, editV: 1 }], 1));
  return f && f.exit === 1 && f.cmd === "npm test";
})());
t("旧版本失败不回注：失败后又改代码（未重跑）→ verifyFailureOf 为 null", verifyFailureOf(mk([{ cmd: "npm test", exit: 1, editV: 1 }], 2)) === null);
t("过时验证：测试通过后又改代码 → 不算跑赢", hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 1 }], 2)) === false);
t("先失败后修好：最后一次是 exit 0 → 跑赢", hasVerified(mk([{ cmd: "npm test", exit: 1, editV: 1 }, { cmd: "npm test", exit: 0, editV: 2 }], 2)) === true);
t("先通过后修坏（可信失败在通过之后）→ 不算跑赢", hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 1 }, { cmd: "npm test", exit: 1, editV: 1 }], 1)) === false);
t("成功验证在后、遮蔽命令更后 → 仍算跑赢（遮蔽非可信负证据）", hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 1 }, { cmd: "npm test || true", exit: 0, editV: 1 }], 1)) === true);
t("遮蔽成功不算跑赢：npm test || true", hasVerified(mk([{ cmd: "npm test || true", exit: 0, editV: 1 }], 1)) === false);
t("exit 未知：不算跑赢（降级旧口径由 hasRanVerify 兜底）", hasVerified(mk([{ cmd: "npm test", exit: undefined, editV: 1 }], 1)) === false);
t("exit 未知：不算失败（不误杀）", verifyFailureOf(mk([{ cmd: "npm test", exit: undefined, editV: 1 }], 1)) === null);
t("旧形态纯字符串（升级前记录）：不算跑赢不算失败", (() => {
  const s = mk(["npm test"], 1);
  return hasVerified(s) === false && verifyFailureOf(s) === null;
})());
t("无代码编辑（codeEditV=0）：验证不判跑赢", hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 0 }], 0)) === false);
t("编辑后只改文档不作废验证", (() => {
  // editV 只数代码文件：验证后 model 改了 README（editVersion+1 但 codeEditV 不变）
  return hasVerified(mk([{ cmd: "npm test", exit: 0, editV: 1 }], 1)) === true;
})());

// ── 逃生门标记（commands 已对象化，标记必须从 cmd 文本里找——曾整体失效的真 bug） ──
t("hasSkipMarker：对象形态命令命中 verify-skipped", hasSkipMarker(mk([{ cmd: 'echo "verify-skipped: 无测试环境"' }])) === true);
t("hasSkipMarker：旧形态纯字符串仍兼容", hasSkipMarker(mk(["echo verify-skipped: x"])) === true);
t("hasSkipMarker：无关命令不误报", hasSkipMarker(mk([{ cmd: "npm test" }])) === false);
t("hasAcceptMarker：对象形态命令命中 review-accepted", hasAcceptMarker(mk([{ cmd: 'echo "review-accepted: 残余风险可接受"' }])) === true);
t("hasAcceptMarker：旧形态纯字符串仍兼容", hasAcceptMarker(mk(["echo review-accepted: x"])) === true);
t("hasAcceptMarker：无关命令不误报", hasAcceptMarker(mk([{ cmd: "npm test" }])) === false);

// ── reviewSubject（无 git 目录 → 降级路径） ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-rsj-"));
  const f = path.join(tmp, "a.ts");
  fs.writeFileSync(f, "const a = 1;\n");
  const s = { commands: ["npm test"], edited: new Set([f]) };
  const subject = await reviewSubject(tmp, s, f);
  t("审查素材包含编辑文件清单", subject.includes("编辑了以下文件"));
  t("无 git 时未跟踪新文件全文仍入素材", subject.includes("const a = 1;"));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── reviewSubject：验收清单意图锚点（2026-09-25 多模型审查采纳项） ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-rsj-todo-"));
  const f = path.join(tmp, "a.ts");
  fs.writeFileSync(f, "const a = 1;\n");
  const s = {
    commands: ["npm test"], edited: new Set([f]),
    lastTodos: [
      { content: "验收清单：①npm test exit 0 ②failover 链序为 flash→glm-5.2→kimi→deepseek", status: "completed" },
      { content: "部署后 install.ps1 -Check 渲染一致", status: "in_progress" },
    ],
  };
  const subject = await reviewSubject(tmp, s, f);
  t("验收清单并入审查素材（含清单标题与条目）", subject.includes("验收清单") && subject.includes("failover 链序"));
  t("验收清单逐条保留（多 todo 均出现）", subject.includes("部署后 install.ps1 -Check 渲染一致"));
  const plain = await reviewSubject(tmp, { commands: [], edited: new Set([f]) }, f);
  t("无验收清单会话（lastTodos 空）→ 无清单段（不误增噪音）", !plain.includes("验收清单"));
  const longSubject = await reviewSubject(tmp, { commands: [], edited: new Set([f]), lastTodos: [{ content: "x".repeat(500), status: "completed" }] }, f);
  t("超长清单条目截断 160 封顶（素材预算保护）", longSubject.includes("x".repeat(160) + "…") && !longSubject.includes("x".repeat(200)));
  const statusSubject = await reviewSubject(tmp, { commands: [], edited: new Set([f]), lastTodos: [
    { content: "已完成项", status: "completed" },
    { content: "进行中项", status: "in_progress" },
  ] }, f);
  t("未完成项带待办标记（不误导审查者当成应达成）", statusSubject.includes("[待办 in_progress]") && statusSubject.includes("- 已完成项"));
  const emojiSubject = await reviewSubject(tmp, { commands: [], edited: new Set([f]), lastTodos: [{ content: "🎉".repeat(200), status: "completed" }] }, f);
  t("代理对安全截断（截断点不劈 emoji）", !emojiSubject.includes("🎉".repeat(200)) && !/[�]/.test(emojiSubject));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── reviewSubject（git 仓库 → diff 范围限定本会话编辑文件） ──
// 多会话共享工作区场景：HEAD 不动，工作区堆着多个会话的改动 + tmp 脚本。
// reviewSubject 必须只取本会话编辑过的文件，不能把别会话的改动/tmp 脚本算进审查素材。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-rsj-git-"));
  const git = (args) => execFileSync("git", args, { cwd: tmp, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git(["init", "-q"]);
  // 基线：两个已提交文件
  const mine = path.join(tmp, "mine.ts");
  const other = path.join(tmp, "other.ts");
  fs.writeFileSync(mine, "export const m = 0;\n");
  fs.writeFileSync(other, "export const o = 0;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  // 本会话只改 mine.ts；别会话改 other.ts + 加一个 tmp 脚本
  fs.writeFileSync(mine, "export const m = 1;\n");
  fs.writeFileSync(other, "export const o = 99;\n");
  fs.writeFileSync(path.join(tmp, "tmp-debug.cjs"), "debug\n");
  const s = { commands: [], edited: new Set([mine]) };
  const subject = await reviewSubject(tmp, s, "mine.ts");
  t("git 仓库：本会话编辑文件的 diff 入素材", subject.includes("export const m = 1;"));
  t("git 仓库：别会话改动不进审查素材（other.ts 的改动不出现）", !subject.includes("const o = 99"));
  t("git 仓库：未编辑的 tmp 脚本不进审查素材", !subject.includes("tmp-debug.cjs"));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── isComplexDelivery：层 3 触发口径 ──
// 高风险命中与文件数无关；普通改动须 ≥3 个代码文件
// （口径沿革：≥3 全文件 →≥5 全文件 →回调 ≥3 全文件 →2026-10-07 改 codeEdits 计数）
t("isComplexDelivery：高风险文件命中（1 个编辑也触发）", (() => {
  const s = { highRisk: new Set(["src/auth/x.ts"]), edited: new Set(["src/auth/x.ts"]) };
  return isComplexDelivery(s, ["src/auth/x.ts"]) === true;
})());
t("isComplexDelivery：2 个代码文件不触发（阈值以下）", (() => {
  const edited = new Set(["a.ts", "b.ts"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, ["a.ts", "b.ts"]) === false;
})());
t("isComplexDelivery：3 个代码文件触发", (() => {
  const files = ["a.ts", "b.ts", "c.ts"];
  return isComplexDelivery({ highRisk: new Set(), edited: new Set(files) }, files) === true;
})());
t("isComplexDelivery：1 代码 + 2 文档不触发（2026-10-07 codeEdits 口径，文档不计数）", (() => {
  const edited = new Set(["a.ts", "docs/a.md", "docs/b.md"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, ["a.ts"]) === false;
})());
t("isComplexDelivery：2 代码 + 5 文档不触发（代码未满 3，编辑再多文档也不触发）", (() => {
  const edited = new Set(["a.ts", "b.ts", "d1.md", "d2.md", "d3.md", "d4.md", "d5.md"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, ["a.ts", "b.ts"]) === false;
})());
t("isComplexDelivery：无代码编辑不触发（纯文档 ≥3 文件压边界）", (() => {
  const edited = new Set(["README.md", "docs/a.md", "docs/b.md"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, []) === false;
})());
t("isComplexDelivery：高风险命中 + codeEdits 为空 → 仍触发（与代码编辑解耦）", (() => {
  const s = { highRisk: new Set(["src/auth/x.md"]), edited: new Set(["src/auth/x.md"]) };
  return isComplexDelivery(s, []) === true;
})());
t("isComplexDelivery：0 文件编辑 + 高风险空 → false", isComplexDelivery({ highRisk: new Set(), edited: new Set() }, []) === false);

// ── diagCoversLastEdit：交付冲刷新鲜度判定（2026-09-22 三模型裁决必须项）──
// 与层 2 hasVerified「末次编辑后」语义同构：冲刷等待期间又编辑 → 诊断不覆盖末次编辑
const dcls = (over) => diagCoversLastEdit({ codeEditV: 2, pendingDiags: new Set(), diagBusy: false, ...over }, 2);
t("diagCovers：无新编辑无积压后台空闲 → 覆盖", dcls({}) === true);
t("diagCovers：冲刷期间又编辑代码（codeEditV 前进）→ 不覆盖（触发补跑轮）", dcls({ codeEditV: 3 }) === false);
t("diagCovers：新积压未跑 → 不覆盖", dcls({ pendingDiags: new Set(["a.ts"]) }) === false);
t("diagCovers：后台仍在跑 → 不覆盖", dcls({ diagBusy: true }) === false);
t("diagCovers：文档编辑不数（editVersion 变但 codeEditV 不变）→ 仍覆盖",
  diagCoversLastEdit({ codeEditV: 2, editVersion: 9, pendingDiags: new Set(), diagBusy: false }, 2) === true);

// ── reviewerFingerprint（plugin/dual-review.ts）：审查缓存键成分 ──
{
  const drBundle = path.join(os.tmpdir(), `dr-test-${process.pid}.mjs`);
  execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "dual-review.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${drBundle}`], { stdio: "inherit" });
  const dr = await import(pathToFileURL(drBundle).href);
  fs.rmSync(drBundle, { force: true });
  const drT = dr._export ?? dr;

  // 缓存键 = 指纹 + 素材 sha1：改 prompt（版本变）或换模型（三元组变）→ 指纹变 →
  // 缓存失效，绝不复用异构模型旧裁决。cfg 注入，不依赖真实配置。
  const fpCfg = (dual_review) => ({ options: { dual_review } });
  const fpA = await drT.reviewerFingerprint(fpCfg({ positive: "m-a", negative: "m-b", aggregator: "m-c" }));
  t("指纹含版本与模型三元组", /^v=\S+\|p=m-a\|n=m-b\|a=m-c$/.test(fpA));
  t("换任一模型 → 指纹变（缓存即失效）",
    fpA !== (await drT.reviewerFingerprint(fpCfg({ positive: "m-x", negative: "m-b", aggregator: "m-c" }))));
  t("配置缺 dual_review → 指纹稳定（空三元组，不抛错）",
    /^v=\S+\|p=\|n=\|a=$/.test(await drT.reviewerFingerprint(fpCfg(undefined))));
}

// ── providerEditsOf / distStaleOf（层 2 dist 新鲜度）──
{
  const m1 = providerEditsOf(["provider/hx-failover/src/index.js", "plugin\\moa.ts",
    "provider\\hx-failover\\src\\util.js", "provider/../src/escape.js", "lib/hx-client.ts"]);
  t("providerEditsOf：正反斜杠提取 + 点段逃逸防护 + 非 src 忽略",
    m1.size === 1 && m1.get("hx-failover").length === 2 && m1.get("hx-failover").includes("index.js") && m1.get("hx-failover").includes("util.js"));
  const m2 = providerEditsOf(["a/Provider/Pkg/Src/x.js"]);
  t("providerEditsOf：大小写不敏感（Windows 形态）命中", m2.size === 1 && m2.get("Pkg")?.[0] === "x.js");
  const m3 = providerEditsOf(["provider/pkg/dist/index.js", "src/a.ts", null]);
  t("providerEditsOf：dist 路径与普通文件不误报", m3.size === 0);
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-dist-"));
  try {
    const mkPkg = (name) => {
      const pkgDir = path.join(tmp, "provider", name);
      fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      return pkgDir;
    };
    const sha = (t) => createHash("sha256").update(t).digest("hex");
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    // 指纹 MATCH：src mtime 事后变新（git checkout/还原同步）不得误报过期
    const fpFresh = mkPkg("fpfresh");
    fs.writeFileSync(path.join(fpFresh, "src", "index.js"), "src");
    fs.writeFileSync(path.join(fpFresh, "dist", "index.js"), `// kilo-build: src-sha256=${sha("src")}\ndist`);
    fs.utimesSync(path.join(fpFresh, "src", "index.js"), future, future);
    const r1 = distStaleOf(tmp, "fpfresh", ["index.js"]);
    t("distStaleOf：指纹 MATCH + src mtime 更新（模拟 git 同步）→ 不过期（mtime 抖动免疫）",
      () => r1.stale === false && r1.fingerprint === "match");
    // 指纹 MISMATCH：src 已改未重建——即使 src mtime 比 dist 旧（dab55da 漏拦形态）也必须拦
    const fpStale = mkPkg("fpstale");
    fs.writeFileSync(path.join(fpStale, "dist", "index.js"), `// kilo-build: src-sha256=${sha("old-src")}\ndist`);
    fs.writeFileSync(path.join(fpStale, "src", "index.js"), "new-src");
    fs.utimesSync(path.join(fpStale, "src", "index.js"), past, past);
    fs.utimesSync(path.join(fpStale, "dist", "index.js"), future, future);
    const r2 = distStaleOf(tmp, "fpstale", ["index.js"]);
    t("distStaleOf：指纹 MISMATCH + src mtime 比 dist 旧（dab55da 漏拦形态）→ 过期（指纹口径拦截）",
      () => r2.stale === true && r2.fingerprint === "mismatch");
    // 指纹 MATCH 但非 index.js 的 src 编辑比 dist 新 → mtime 兜底拦
    const fpExtra = mkPkg("fpextra");
    fs.writeFileSync(path.join(fpExtra, "src", "index.js"), "src");
    fs.writeFileSync(path.join(fpExtra, "dist", "index.js"), `// kilo-build: src-sha256=${sha("src")}\ndist`);
    fs.writeFileSync(path.join(fpExtra, "src", "util.js"), "u");
    fs.utimesSync(path.join(fpExtra, "src", "util.js"), future, future);
    t("distStaleOf：指纹 MATCH + 非 index src 编辑比 dist 新 → mtime 兜底拦截",
      () => distStaleOf(tmp, "fpextra", ["index.js", "util.js"]).stale === true);
    // 无指纹（旧版产物）→ 整体回落 mtime 口径（与旧行为一致）
    const fresh = mkPkg("fresh");
    fs.writeFileSync(path.join(fresh, "src", "index.js"), "src");
    fs.writeFileSync(path.join(fresh, "dist", "index.js"), "dist");
    fs.utimesSync(path.join(fresh, "dist", "index.js"), new Date(), new Date(Date.now() + 60_000));
    const r4 = distStaleOf(tmp, "fresh", ["index.js"]);
    t("distStaleOf：无指纹 + dist 比编辑文件新 → 回落 mtime 口径不过期",
      () => r4.stale === false && r4.fingerprint === "absent");
    const stale = mkPkg("stale");
    fs.writeFileSync(path.join(stale, "dist", "index.js"), "dist");
    fs.writeFileSync(path.join(stale, "src", "late.js"), "newer");
    fs.utimesSync(path.join(stale, "src", "late.js"), new Date(), new Date(Date.now() + 60_000));
    t("distStaleOf：无指纹 + 会话编辑文件比 dist 新 → 过期（>= 口径）",
      () => distStaleOf(tmp, "stale", ["late.js"]).stale === true);
    const noDist = mkPkg("nodist");
    fs.writeFileSync(path.join(noDist, "src", "index.js"), "src");
    fs.rmSync(path.join(noDist, "dist"), { recursive: true, force: true });
    const r5 = distStaleOf(tmp, "nodist", ["index.js"]);
    t("distStaleOf：编辑过 src 但 dist 缺失（从未构建）→ 拦截", () => r5.stale === true && r5.missing === true);
    t("distStaleOf：编辑文件已删除 → 跳过不抛", () => distStaleOf(tmp, "stale", ["gone.js"]).stale === false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── ⑤ residualFixupLine / insertUnderHeading：残余必须修复项沉淀（纯函数）──
t("residualFixupLine：格式 = review_residual_<date>_<sha8> :: 摘要（列表符号剥除）", (() => {
  const line = residualFixupLine("- 修复 A\n- 修复 B", "salt");
  return line !== null && /^- review_residual_\d{4}-\d{2}-\d{2}_[0-9a-f]{8} :: .+修复 A；修复 B/.test(line);
})());
t("residualFixupLine：空残余项 → null（不沉淀）", residualFixupLine("", "salt") === null);
t("residualFixupLine：纯空白残余项 → null", residualFixupLine("  \n \t ", "salt") === null);
t("residualFixupLine：内容相同盐不同 → key 不同（不同轮次各留一行）",
  residualFixupLine("修 A", "s1") !== residualFixupLine("修 A", "s2"));
t("residualFixupLine：超长残余截断 600（与 reviewPending 同口径）",
  residualFixupLine("x".repeat(2000), "salt").length < 800);
t("insertUnderHeading：Open Questions 段末追加（不进下一段）", (() => {
  const md = "# Project Memory\n\n## Facts\n\n## Open Questions\n\n## Constraints\n";
  const next = insertUnderHeading(md, "## Open Questions", "- review_residual_x :: 待跟进");
  const qi = next.indexOf("## Open Questions");
  const ci = next.indexOf("## Constraints");
  return qi >= 0 && ci > qi && next.indexOf("- review_residual_x :: 待跟进") > qi && next.indexOf("- review_residual_x :: 待跟进") < ci;
})());
t("insertUnderHeading：段在文件尾（无下一段）→ 追加不丢内容", (() => {
  const md = "## Open Questions\n";
  const next = insertUnderHeading(md, "## Open Questions", "- r :: x");
  return next.includes("## Open Questions") && next.includes("- r :: x");
})());
t("insertUnderHeading：幂等（同 key 已存在 → 原文不变）", (() => {
  const md = "## Open Questions\n- review_residual_2026-09-24_deadbeef :: 待跟进\n";
  return insertUnderHeading(md, "## Open Questions", "- review_residual_2026-09-24_deadbeef :: 待跟进") === md;
})());
t("insertUnderHeading：段缺失 → 补段落（防御性兜底）", (() => {
  const next = insertUnderHeading("# Project Memory\n", "## Open Questions", "- r :: x");
  return next.includes("## Open Questions") && next.includes("- r :: x");
})());
t("insertUnderHeading：CRLF 文件 → 追加不破坏结构（\\r\\n 归一化处理）", (() => {
  const md = "# P\r\n\r\n## Open Questions\r\n\r\n## Constraints\r\n";
  const next = insertUnderHeading(md, "## Open Questions", "- r :: x");
  return next.includes("## Open Questions") && next.includes("- r :: x") && next.includes("## Constraints");
})());

// ── ⑦ degradationSummary：降级/放行审计账本汇总（纯函数）──
t("degradationSummary：无降级 → null（零噪音）", degradationSummary({ degradations: [] }) === null);
t("degradationSummary：无账本字段 → null", degradationSummary({}) === null);
t("degradationSummary：有降级 → 汇总成清单文本", (() => {
  const out = degradationSummary({ degradations: ["a: x", "b: y"] });
  return out !== null && out.includes("a: x") && out.includes("b: y") && out.includes("降级/放行");
})());
t("degradationSummary：重复事件去重", (() => {
  const out = degradationSummary({ degradations: ["a: x", "a: x"] });
  return out !== null && out.indexOf("a: x") === out.lastIndexOf("a: x");
})());
t("degradationSummary：溢出裁剪保留最新（splice 批量）", (() => {
  // recordDegradation 是桶内函数，此处经打包产物间接验证行为不现实；
  // 直接验证账本上限语义：summary 不因长账本崩溃且保序输出
  const many = Array.from({ length: 60 }, (_, i) => `k${i}: d`);
  const out = degradationSummary({ degradations: many });
  return out !== null && out.includes("k59: d") && out.includes("k0: d");
})());

// ── ⑥ staleDeployOf：部署≠生效检测（纯函数）──
t("staleDeployOf：磁盘指纹与加载期一致 → 不过期", staleDeployOf("abc123", "abc123") === false);
t("staleDeployOf：磁盘指纹变化（部署新版）→ 过期", staleDeployOf("abc123", "def456") === true);
t("staleDeployOf：任一侧指纹不可得 → 恒 false（fail-open，检测关闭）",
  staleDeployOf(null, "abc123") === false && staleDeployOf("abc123", null) === false && staleDeployOf(null, null) === false);

// ── diff→test 关联断言（2026-09-25 多模型审查采纳项 + 层 3 审查修复回归）──
{
  // moduleBasenamesOf：basename 提取（测试中段/尾部后缀剥离、去重、限 8 个、dropped 可见）
  t("moduleBasenamesOf：路径取 basename 去后缀",
    (() => {
      const r = moduleBasenamesOf(["src/auth/login.ts", "plugin\\quality-gate.ts"]);
      return r.names.includes("login") && r.names.includes("quality-gate") && r.dropped === 0;
    })());
  t("moduleBasenamesOf：测试中段剥离 login.test.ts → login（自测试文件反查不 miss）",
    moduleBasenamesOf(["src/login.test.ts"]).names[0] === "login");
  t("moduleBasenamesOf：多段后缀 foo.spec.ts → foo", moduleBasenamesOf(["x/foo.spec.ts"]).names[0] === "foo");
  t("moduleBasenamesOf：声明文件 foo.d.ts → foo（不残留 foo.d 误报）", moduleBasenamesOf(["x/foo.d.ts"]).names[0] === "foo");
  t("moduleBasenamesOf：去重 + 超 limit 计入 dropped（层 3 必须修复项：截断可见）", (() => {
    const r = moduleBasenamesOf(["a.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts", "k.ts"]);
    return r.names.length === 8 && r.dropped === 3; // 11 个唯一模块，前 8 入核对，3 个计入 dropped
  })());
  t("moduleBasenamesOf：空输入 → 空数组零 dropped", (() => {
    const r = moduleBasenamesOf([]);
    return r.names.length === 0 && r.dropped === 0;
  })());

  // hasTestRefFor 三态（git repo 环境；git grep -e + pathspec 限定测试目录）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-tref-"));
  const git = (args) => execFileSync("git", args, { cwd: tmp, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git(["init", "-q"]);
  fs.writeFileSync(path.join(tmp, "login.ts"), "export const login = 1;\n");
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tests", "login.test.ts"), 'import { login } from "../login";\n');
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  // 态1：有 tests 目录 + login 有引用 → missing 为空
  {
    const r = await hasTestRefFor(tmp, ["login"]);
    t("hasTestRefFor：有测试目录且被引用 → missing 空（不警告）", r.skip === false && r.missing.length === 0);
  }
  // 态2：新增无引用模块 → missing 命中
  {
    fs.writeFileSync(path.join(tmp, "wallet.ts"), "export const wallet = 1;\n");
    git(["add", "wallet.ts"]);
    git(["commit", "-q", "-m", "add wallet"]);
    const r = await hasTestRefFor(tmp, ["login", "wallet"]);
    t("hasTestRefFor：编辑模块在测试目录无引用 → missing 命中（警告）", r.skip === false && r.missing.length === 1 && r.missing[0] === "wallet");
  }
  // 假阳性收窄回归（第 2 轮审查必须项）：词边界匹配——util 不被 utility 前缀命中
  {
    fs.writeFileSync(path.join(tmp, "util.ts"), "export const util = 1;\n");
    git(["add", "util.ts"]);
    git(["commit", "-q", "-m", "add util"]);
    fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "tests", "utility.test.ts"), "import { utility } from 'x'; // utility helper\n");
    git(["add", "tests/utility.test.ts"]);
    git(["commit", "-q", "-m", "utility word"]);
    const r = await hasTestRefFor(tmp, ["util"]);
    t("hasTestRefFor：词边界防前缀假阳性（util ≠ utility）", r.skip === false && r.missing.length === 1 && r.missing[0] === "util");
  }
  // colocate 形态（第 2 轮审查必须项）：无独立测试目录但 src/foo.test.ts 紧邻源码 → 不静默跳过
  {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "qg-tref-col-"));
    const g3 = (args) => execFileSync("git", args, { cwd: tmp3, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
    g3(["init", "-q"]);
    fs.mkdirSync(path.join(tmp3, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp3, "src", "login.ts"), "export const login = 1;\n");
    fs.writeFileSync(path.join(tmp3, "src", "wallet.ts"), "export const wallet = 1;\n");
    fs.writeFileSync(path.join(tmp3, "src", "login.test.ts"), 'import { login } from "./login";\n');
    g3(["add", "."]);
    g3(["commit", "-q", "-m", "colocate"]);
    const r = await hasTestRefFor(tmp3, ["login", "wallet"]);
    t("hasTestRefFor：colocate 仓库不静默跳过（有 src/*.test.ts 即触发核对）", r.skip === false);
    t("hasTestRefFor：colocate 无引用模块仍命中 missing", r.missing.length === 1 && r.missing[0] === "wallet");
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
  // 态3：无测试目录 → skip 静默
  {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "qg-tref-nt-"));
    const g2 = (args) => execFileSync("git", args, { cwd: tmp2, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
    g2(["init", "-q"]);
    fs.writeFileSync(path.join(tmp2, "x.ts"), "export const x = 1;\n");
    g2(["add", "."]);
    g2(["commit", "-q", "-m", "b"]);
    const r = await hasTestRefFor(tmp2, ["x"]);
    t("hasTestRefFor：无测试目录 → skip（无测试仓库不产生义务）", r.skip === true);
    t("hasTestRefFor：空名单 → skip（无可核对项）", (await hasTestRefFor(tmp2, [])).skip === true);
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── ⑧ persistResidualFixup 触达路径的纯函数前提（fixSection 形态不变，回归保护）──
t("parseReviewVerdict：fixSection 截断 600（沉淀素材同口径）", (() => {
  const v = parseReviewVerdict(`## 裁决\n不通过\n\n## 必须修复项\n- ${"x".repeat(2000)}`);
  return v.fixSection.length <= 600;
})());
t("insertUnderHeading：段前无空行（文件头紧贴）→ 追加不劈段", (() => {
  const md = "# P\n## Open Questions\n";
  const next = insertUnderHeading(md, "## Open Questions", "- r :: x");
  return next.includes("- r :: x") && next.includes("# P");
})());

// ── 修复 G：eslintConfigIn（目录配置探测，进程级只缓存 true）──
{
  t("eslintConfigIn：空/null 目录 → false（不跑诊断）", eslintConfigIn("") === false && eslintConfigIn(null) === false);
  for (const cfg of ["eslint.config.mjs", ".eslintrc.json", "eslint.config.js", ".eslintrc"]) {
    // 进程级缓存 → 每个配置形态必须用独立目录（同目录首探测结果永久复用）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-esl-"));
    t(`eslintConfigIn：有 ${cfg} → true`, (() => { fs.writeFileSync(path.join(tmp, cfg), "x\n"); return eslintConfigIn(tmp) === true; })());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-esl-"));
    t("eslintConfigIn：无配置目录 → false", eslintConfigIn(tmp) === false);
    // 审查建议项修复：false 不缓存——中途新增 eslint 配置本会话即生效（装依赖带配置进来是常见流）
    fs.writeFileSync(path.join(tmp, "eslint.config.mjs"), "x\n");
    t("eslintConfigIn：false 后中途加配置 → true（false 不缓存，热生效）", eslintConfigIn(tmp) === true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-esl-"));
    fs.writeFileSync(path.join(tmp, "eslint.config.mjs"), "x\n");
    t("eslintConfigIn：true 后删配置仍 true（true 缓存命中）", eslintConfigIn(tmp) === true);
    fs.rmSync(path.join(tmp, "eslint.config.mjs"), { force: true });
    t("eslintConfigIn：同目录第二次调用走缓存", eslintConfigIn(tmp) === true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 修复 F：reviewRetryAllowed（fail-open 后重审判定，纯函数）──
const rrs = (over) => ({ dualReviewed: true, codeEditV: 5, reviewFailedAtCodeEditV: 4, reviewFailedCount: 1, ...over });
t("reviewRetryAllowed：从未失败（起点 0）→ false（常规口径覆盖）", reviewRetryAllowed({ dualReviewed: false, codeEditV: 3, reviewFailedAtCodeEditV: 0, reviewFailedCount: 0 }) === false);
t("reviewRetryAllowed：失败后有新代码编辑 → true（交付节点重审一次）", reviewRetryAllowed(rrs({})) === true);
t("reviewRetryAllowed：失败后无新编辑（同一素材）→ false（不重烧）", reviewRetryAllowed(rrs({ codeEditV: 4, reviewFailedAtCodeEditV: 4 })) === false);
t("reviewRetryAllowed：连续两败（count≥2）→ false（永久放行 + unreviewed 留痕）", reviewRetryAllowed(rrs({ reviewFailedCount: 2 })) === false);
t("reviewRetryAllowed：count 超上限更不重审", reviewRetryAllowed(rrs({ reviewFailedCount: 5 })) === false);
t("reviewRetryAllowed：桶字段缺失 → false（fail-open 不误触发）", reviewRetryAllowed(null) === false && reviewRetryAllowed({}) === false);

// ── 修复 F：unreviewedMarkerLine（永久放行持久留痕格式）──
t("unreviewedMarkerLine：review_unreviewed_<date> 前缀 + 补审指引", (() => {
  const line = unreviewedMarkerLine();
  return /^- review_unreviewed_\d{4}-\d{2}-\d{2} :: .+层 3 fail-open 放行.+补审/.test(line);
})());
t("unreviewedMarkerLine：同毫秒内两次调用相同（幂等沉淀前提）", unreviewedMarkerLine() === unreviewedMarkerLine());

// ── 修复 B：todoAnchorLines（验收清单压缩锚点，纯函数）──
{
  const todos = [
    { content: "验收清单：①test 全绿 ②插件契约", status: "completed" },
    { content: "实现 F 修复", status: "in_progress" },
    { content: "实现 B 修复", status: "pending" },
    { content: "跑全量回归", status: "in_progress" },
  ];
  const lines = todoAnchorLines(todos);
  t("todoAnchorLines：含注入标记与进度（1/4）", lines[0].includes("验收清单（quality-gate 注入）") && lines[0].includes("1/4"));
  t("todoAnchorLines：未完成项以 [ ] 列出", lines.some((l) => l.includes("- [ ] 实现 F 修复")) && lines.some((l) => l.includes("- [ ] 实现 B 修复")));
  t("todoAnchorLines：已完成项不进清单", !lines.join("\n").includes("①test 全绿"));
  t("todoAnchorLines：全完成 → []（零噪音）", todoAnchorLines([{ content: "x", status: "completed" }]).length === 0);
  t("todoAnchorLines：空/非数组 → []", todoAnchorLines([]).length === 0 && todoAnchorLines(null).length === 0 && todoAnchorLines(undefined).length === 0);
  t("todoAnchorLines：单条目超 120 按码点截断", (() => {
    const out = todoAnchorLines([{ content: "x".repeat(300), status: "in_progress" }]);
    return out.some((l) => l.includes("x".repeat(120) + "…") && !l.includes("x".repeat(121)));
  })());
  t("todoAnchorLines：代理对安全截断（不劈 emoji）", (() => {
    const out = todoAnchorLines([{ content: "🎉".repeat(100), status: "in_progress" }]);
    return !out.join("\n").includes("\uFFFD");
  })());
  t("todoAnchorLines：超 15 条未完成 → 溢出行可见", (() => {
    const many = Array.from({ length: 20 }, (_, i) => ({ content: `task-${i}`, status: "pending" }));
    const out = todoAnchorLines(many);
    return out.some((l) => l.includes("另有 5 条未完成项"));
  })());
}

// ── 修复 C：driftCheckDue（过半漂移自检判定，纯函数）──
const dcs = (over) => ({ driftChecked: false, lastTodos: [
  { content: "验收清单", status: "completed" }, { content: "a", status: "completed" },
  { content: "b", status: "in_progress" }, { content: "c", status: "pending" },
], ...over });
t("driftCheckDue：完成过半（2/4）→ true", driftCheckDue(dcs({})) === true);
t("driftCheckDue：未过半（1/4）→ false（太早，纯噪音）", driftCheckDue(dcs({ lastTodos: [
  { content: "验收清单", status: "completed" }, { content: "a", status: "in_progress" },
  { content: "b", status: "pending" }, { content: "c", status: "pending" },
] })) === false);
t("driftCheckDue：已提醒过（driftChecked）→ false（一次性）", driftCheckDue(dcs({ driftChecked: true })) === false);
t("driftCheckDue：单条清单 → false（无从漂移）", driftCheckDue(dcs({ lastTodos: [{ content: "x", status: "completed" }] })) === false);
t("driftCheckDue：空 todos / null 桶 → false", driftCheckDue({ driftChecked: false, lastTodos: [] }) === false && driftCheckDue(null) === false);
t("driftCheckDue：无 completed → false", driftCheckDue(dcs({ lastTodos: [
  { content: "a", status: "in_progress" }, { content: "b", status: "pending" },
] })) === false);
t("driftCheckDue：全完成（done==total）→ false（内聚 guard，不依赖调用点）", driftCheckDue(dcs({ lastTodos: [
  { content: "a", status: "completed" }, { content: "b", status: "completed" },
], driftChecked: false })) === false);

// ── 查漏补缺（2026-09-26 复审）：诊断退出码语义（tsc/ruff 与 eslint 同口径）──
// 审查必须修复项只点了 eslint，tsc/ruff 同类假降级（检出诊断 = exit 1 被误记为「运行失败」）
// 一并修掉：exit 1 = 正常诊断产出；exit≥2 / 非数字 code（超时被杀/ENOENT）= 真失败。
t("diagRunFailureOf：null（无 err）→ false", diagRunFailureOf(null) === false && diagRunFailureOf(undefined) === false);
t("diagRunFailureOf：exit 0 → false", diagRunFailureOf({ code: 0 }) === false);
t("diagRunFailureOf：exit 1（tsc 类型错误 / ruff·eslint 违规 = 正常产出）→ false", diagRunFailureOf({ code: 1 }) === false);
t("diagRunFailureOf：exit 2（配置/内部错误）→ true", diagRunFailureOf({ code: 2 }) === true);
t("diagRunFailureOf：非数字 code（超时被杀/ENOENT/信号）→ true",
  diagRunFailureOf({ code: null }) === true && diagRunFailureOf({ code: "ENOENT" }) === true && diagRunFailureOf({ killed: true }) === true);
t("diagRunFailureOf：信号终止（code=null 且 signal 非空）→ true（勿优化成 code>1，null>1 为 false 会漏判）",
  diagRunFailureOf({ code: null, signal: "SIGTERM" }) === true);
// 策略锚定断言（审查必须修复项）：exit 1 一律视为诊断产出——含 eslint --max-warnings 超阈值
// 触发的 exit 1。此断言防「语义漂移」（有人日后改成 warn 计数则本测试变红）。
t("策略锚定：exit 1 恒为诊断产出（含 --max-warnings 超阈值）→ 不记降级", diagRunFailureOf({ code: 1 }) === false);
t("策略锚定：只有 exit≥2 与非退出码形态才判工具失败（反例：exit 3 亦失败）", diagRunFailureOf({ code: 3 }) === true);

// ── 查漏补缺：委派调用识别（白名单 + 大小写归一；复审必须修复项：不得以参数存在判委派）──
t("isDelegateCall：task → true", isDelegateCall("task") === true);
t("isDelegateCall：大小写变体 Task/AGENT_MANAGER → true", isDelegateCall("Task") === true && isDelegateCall("AGENT_MANAGER") === true);
t("isDelegateCall：agent_manager → true", isDelegateCall("agent_manager") === true);
t("isDelegateCall：未知工具名即使带 subagent_type → false（参数存在不得判委派，误判会吞提醒）",
  isDelegateCall("spawn_subagent") === false && isDelegateCall("edit") === false);
t("isDelegateCall：空/空白/非字符串 tool → false", isDelegateCall("") === false && isDelegateCall(undefined) === false && isDelegateCall(null) === false);
t("isDelegateCall：首尾空白 trim 归一（' task ' → true）", isDelegateCall(" task ") === true && isDelegateCall("\tAGENT_MANAGER\n") === true);
t("isDelegateCall：非字符串对象/数字 → false（不抛异常）", isDelegateCall({}) === false && isDelegateCall(5) === false);

// ── 查漏补缺：reviewFailPrefix 显式判空（复审建议项：不得把『无记录』强转为『第 0 轮』）──
t("reviewFailPrefix：round=undefined → 不输出轮次括号（显式判空）",
  reviewFailPrefix({ reviewFailedCount: 4 }) === "连续 4 次失败；");
t("reviewFailPrefix：round=0 → 1-based 显示第 1 轮", reviewFailPrefix({ reviewFailedCount: 2, reviewFailedAtRound: 0 }) === "连续 2 次失败（最近一次在第 1 轮）；");
t("reviewFailPrefix：round=1 → 第 2 轮；count 非法 → 0 防御", reviewFailPrefix({ reviewFailedCount: 2, reviewFailedAtRound: 1 }) === "连续 2 次失败（最近一次在第 2 轮）；" && reviewFailPrefix({}) === "连续 0 次失败；");
t("reviewFailPrefix：字符串数字容忍（'2'/'1' → 正常输出，复审建议项）", reviewFailPrefix({ reviewFailedCount: "2", reviewFailedAtRound: "1" }) === "连续 2 次失败（最近一次在第 2 轮）；");
t("reviewFailPrefix：负数/NaN 非法值走判空分支", reviewFailPrefix({ reviewFailedCount: -1, reviewFailedAtRound: -1 }) === "连续 0 次失败；" && reviewFailPrefix({ reviewFailedCount: NaN, reviewFailedAtRound: NaN }) === "连续 0 次失败；");

// ── 修复 B：双插件 compacting 钩子合并语义（compaction-anchor + quality-gate 共存）──
// 层 3 审查必须修复项 B：两插件同注册 experimental.session.compacting，钩子顺序不可知——
// 无论谁先跑，两份锚点都必须存活（追加合并、按各自标记幂等、绝不互相覆盖）。
{
  const caBundle = path.join(os.tmpdir(), `ca-test-${process.pid}.mjs`);
  execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "compaction-anchor.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${caBundle}`], { stdio: "inherit" });
  const ca = await import(pathToFileURL(caBundle).href);
  fs.rmSync(caBundle, { force: true });
  const caFactory = Object.values(ca).find((v) => typeof v === "function");
  const qgFactory = mod.QualityGate ?? mod.default;

  // 双插件钩子实例化（最小桩 ctx：client.messages 抛错 → compaction-anchor 走退化路径仍注入锚点）
  const stubCtx = { directory: ROOT, client: { session: { messages: async () => { throw new Error("stub"); } } }, $: null };
  const caHooks = await caFactory(stubCtx);
  const qgHooks = await qgFactory({ directory: ROOT });
  const runHook = async (hooks, out, sessionID) => {
    await hooks["experimental.session.compacting"]({ sessionID }, out);
  };

  // 场景 1：quality-gate 先注入（有未完成 todo）→ compaction-anchor 后跑 → 追加共存
  {
    const out = { context: [] };
    // 先喂 quality-gate 桶（经 todowrite after 钩子记录 lastTodos——直接调 compacting 前置状态）
    // compacting 钩子读 bucketOf(sessionID)，此处经 qgHooks["tool.execute.after"] 注入 todo 痕迹
    await qgHooks["tool.execute.after"](
      { tool: "todowrite", sessionID: "t-merge", args: { todos: [{ content: "验收清单：①npm test 全绿", status: "completed" }, { content: "实现 B 修复", status: "in_progress" }] } },
      {},
    );
    await runHook(qgHooks, out, "t-merge"); // quality-gate 先
    await runHook(caHooks, out, "t-merge"); // compaction-anchor 后（client 抛错 → 退化注入锚点行）
    const joined = out.context.join("\n");
    t("合并：quality-gate 先注入清单锚点存活", joined.includes("验收清单（quality-gate 注入）"));
    t("合并：compaction-anchor 后跑锚点共存（追加不覆盖）", joined.includes("压缩锚点（必须保留）"));
    t("合并：两份锚点都在（顺序无关共存）", out.context.some((l) => String(l).includes("验收清单（quality-gate 注入）")) && out.context.some((l) => String(l).includes("压缩锚点（必须保留）")));
  }
  // 场景 2：compaction-anchor 先注入 → quality-gate 后跑 → 追加共存
  {
    const out = { context: [] };
    await qgHooks["tool.execute.after"](
      { tool: "todowrite", sessionID: "t-merge2", args: { todos: [{ content: "验收清单：①npm test 全绿", status: "completed" }, { content: "实现 B 修复", status: "in_progress" }] } },
      {},
    );
    await runHook(caHooks, out, "t-merge2"); // compaction-anchor 先
    await runHook(qgHooks, out, "t-merge2"); // quality-gate 后
    const joined = out.context.join("\n");
    t("合并：compaction-anchor 先注入锚点存活", joined.includes("压缩锚点（必须保留）"));
    t("合并：quality-gate 后跑清单共存（追加不覆盖）", joined.includes("验收清单（quality-gate 注入）"));
  }
  // 场景 3：重复调用幂等（各插件第二次跑不重复注入）
  {
    const out = { context: [] };
    await qgHooks["tool.execute.after"](
      { tool: "todowrite", sessionID: "t-merge3", args: { todos: [{ content: "验收清单：①x", status: "completed" }, { content: "实现 B 修复", status: "in_progress" }] } },
      {},
    );
    await runHook(caHooks, out, "t-merge3");
    await runHook(qgHooks, out, "t-merge3");
    await runHook(caHooks, out, "t-merge3"); // 第二次
    await runHook(qgHooks, out, "t-merge3"); // 第二次
    const tagCount = out.context.filter((l) => String(l).includes("验收清单（quality-gate 注入）")).length;
    const anchorCount = out.context.filter((l) => String(l).includes("压缩锚点（必须保留）")).length;
    t("合并：quality-gate 钩子重复调用只注入一次（标记幂等）", tagCount === 1);
    t("合并：compaction-anchor 重复调用只注入一次（标记幂等）", anchorCount === 1);
  }
  // 场景 4：全完成 todo → quality-gate 零注入（compaction-anchor 独占正常）
  {
    const out = { context: [] };
    await qgHooks["tool.execute.after"](
      { tool: "todowrite", sessionID: "t-merge4", args: { todos: [{ content: "验收清单：全绿", status: "completed" }] } },
      {},
    );
    await runHook(qgHooks, out, "t-merge4");
    await runHook(caHooks, out, "t-merge4");
    t("合并：全完成清单零注入（不产生噪音锚点）", !out.context.some((l) => String(l).includes("验收清单（quality-gate 注入）")));
  }
}

// ── 查漏补缺（2026-09-26 复审）：钩子副作用回归 ──
// ① 高风险登记（曾误删 s.highRisk.add → isComplexDelivery 高风险分支死掉）；
// ② C 修复提醒的委派痕迹：task/agent_manager 调用必须入池，否则「已委派」不可见，
//    提醒对已委派会话误报（提醒失灵即噪音）。
{
  const qgFactory2 = mod.QualityGate ?? mod.default;
  const hooks = await qgFactory2({ directory: ROOT });

  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "t-hr", args: { filePath: "src/auth/login.ts" } }, { output: "" });
  const sHr = mod._export.bucketOf({ sessionID: "t-hr" });
  t("高风险编辑 → s.highRisk 登记（isComplexDelivery 高风险命中即触发不失效）",
    (sHr?.highRisk?.size ?? 0) > 0 && isComplexDelivery(sHr, ["src/auth/login.ts"]) === true);

  const out1 = { output: "" };
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "t-remind", args: { filePath: "src/payment/pay.ts" } }, out1);
  t("高风险直接编辑（无委派痕迹）→ 越级提醒出现", String(out1.output).includes("高风险文件提醒"));
  const out2 = { output: "" };
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "t-remind", args: { filePath: "src/payment/refund.ts" } }, out2);
  t("越级提醒一次封顶：同会话第二次高风险编辑不重复提醒", !String(out2.output).includes("高风险文件提醒"));

  const out3 = { output: "" };
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "t-deleg", args: { subagent_type: "general", description: "实现支付高风险改动" } }, { output: "" });
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "t-deleg", args: { filePath: "src/payment/pay.ts" } }, out3);
  t("已委派（task general 痕迹入池）→ 高风险编辑不误提醒",
    !String(out3.output).includes("高风险文件提醒") &&
    (mod._export.bucketOf({ sessionID: "t-deleg" })?.delegated ?? []).some((r) => String(r).startsWith("task ")));

  // 大小写变体（审查必须修复项）：Task 工具名归一后同样登记
  const out3b = { output: "" };
  await hooks["tool.execute.after"](
    { tool: "Task", sessionID: "t-deleg2", args: { subagent_type: "general" } }, { output: "" });
  t("大小写变体：Task 登记进 s.delegated（归一化小写）",
    (mod._export.bucketOf({ sessionID: "t-deleg2" })?.delegated ?? []).some((r) => String(r).startsWith("task ")));

  // 委派登记不早退（审查必须修复项）：task 调用后同会话 edit 仍正常入 edited
  const out3c = { output: "" };
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "t-deleg3", args: { subagent_type: "general" } }, { output: "" });
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "t-deleg3", args: { filePath: "src/util/helper.ts" } }, out3c);
  const sD3 = mod._export.bucketOf({ sessionID: "t-deleg3" });
  t("委派登记不阻断通用路径：后续 edit 正常入 edited（无 early-return）",
    (sD3?.edited?.size ?? 0) > 0 && (sD3?.delegated ?? []).length > 0);

  // 委派工具本身不产生 edited/highRisk 副作用（审查建议项）：task 调用只登记 delegated
  const sD4 = mod._export.bucketOf({ sessionID: "t-deleg4" });
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "t-deleg4", args: { subagent_type: "general", description: "auth 高风险实现" } }, { output: "" });
  t("委派工具自身不误记 edited/highRisk（只入 delegated）",
    (sD4?.delegated ?? []).length === 1 && (sD4?.edited?.size ?? 0) === 0 && (sD4?.highRisk?.size ?? 0) === 0);
}

// ── vE2 插件契约（quality-gate.ts 自身）：唯一函数导出 = 工厂 ──
t("vE2 契约：quality-gate 恰好 1 个函数导出（QualityGate/default 同引用）+ _export 无 server", (() => {
  const fnByRef = new Map();
  let hasServerInExport = false;
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v !== "function") {
      if (v && typeof v === "object" && typeof v.server === "function") hasServerInExport = true;
      continue;
    }
    if (!fnByRef.has(v)) fnByRef.set(v, k);
  }
  return fnByRef.size === 1 && !hasServerInExport;
})());
t("vE2 契约：_export 含 staleDeployOf / degradationSummary / residualFixupLine（⑤⑥⑦⑧ 全在位）",
  typeof mod._export?.staleDeployOf === "function" &&
  typeof mod._export?.degradationSummary === "function" &&
  typeof mod._export?.residualFixupLine === "function" &&
  typeof mod._export?.insertUnderHeading === "function");
t("vE2 契约：_export 含 F/B/C/G 修复新纯函数（reviewRetryAllowed/todoAnchorLines/unreviewedMarkerLine/driftCheckDue/eslintConfigIn）",
  typeof mod._export?.reviewRetryAllowed === "function" &&
  typeof mod._export?.todoAnchorLines === "function" &&
  typeof mod._export?.unreviewedMarkerLine === "function" &&
  typeof mod._export?.driftCheckDue === "function" &&
  typeof mod._export?.eslintConfigIn === "function");

// ── C1 修复回归（2026-09-27 查漏补缺）：手动 dual_review 豁免绑定 dualReviewedAtCodeEditV ──
// 漏洞：手动补审置 dualReviewed=true 后继续编辑代码，交付节点 !s.dualReviewed 已为 false →
// 新改动永久跳审（旧裁决 subject 窄于全量 diff，不覆盖新编辑）。修复后豁免要求版本对齐。
{
  const qgFactory3 = mod.QualityGate ?? mod.default;
  const hooks3 = await qgFactory3({ directory: ROOT });
  const sessC1 = "t-c1";
  // 前置：一次代码编辑（codeEditV: 0 → 1）
  await hooks3["tool.execute.after"](
    { tool: "edit", sessionID: sessC1, args: { filePath: "src/auth/login.ts" } }, { output: "" });
  const sC1a = mod._export.bucketOf({ sessionID: sessC1 });
  t("C1 前置：代码编辑推进 codeEditV（=1）",
    (sC1a?.codeEditV ?? 0) === 1);
  // 手动补审（codeEditV>0 → 置 dualReviewed + 绑定版本）
  await hooks3["tool.execute.after"](
    { tool: "dual_review", sessionID: sessC1, args: { subject: "交付审查" } }, { output: "" });
  const sC1b = mod._export.bucketOf({ sessionID: sessC1 });
  t("C1：手动补审置 dualReviewed 并绑定 dualReviewedAtCodeEditV（=1）",
    sC1a?.dualReviewed === true && (sC1b?.dualReviewedAtCodeEditV ?? 0) === 1);
  // 补审后再编辑代码（codeEditV: 1 → 2）→ 版本不对齐 → 豁免失效
  await hooks3["tool.execute.after"](
    { tool: "edit", sessionID: sessC1, args: { filePath: "src/auth/session.ts" } }, { output: "" });
  const sC1d = mod._export.bucketOf({ sessionID: sessC1 });
  const staleC1 = (sC1d?.codeEditV ?? 0) !== (sC1d?.dualReviewedAtCodeEditV ?? 0);
  t("C1：补审后新代码编辑 → 版本不对齐（豁免失效，交付节点须重审）",
    (sC1d?.codeEditV ?? 0) === 2 && staleC1 === true);
  // 补审后仅编辑文档（codeEditV 不推进）→ 版本仍对齐 → 豁免维持
  const sessC1b = "t-c1-doc";
  await hooks3["tool.execute.after"](
    { tool: "edit", sessionID: sessC1b, args: { filePath: "src/auth/login.ts" } }, { output: "" });
  await hooks3["tool.execute.after"](
    { tool: "dual_review", sessionID: sessC1b, args: { subject: "交付审查" } }, { output: "" });
  await hooks3["tool.execute.after"](
    { tool: "edit", sessionID: sessC1b, args: { filePath: "README.md" } }, { output: "" });
  const sC1c = mod._export.bucketOf({ sessionID: sessC1b });
  t("C1：补审后纯文档编辑不触发重审（codeEditV 不前进，豁免维持）",
    (sC1c?.codeEditV ?? 0) === 1 && (sC1c?.dualReviewedAtCodeEditV ?? 0) === 1);
}

// ── 回合出口门禁（2026-10-03 收口审计专项）：纯函数矩阵 + 假 client 集成 ──
{
  t("todosIncomplete：空/全完成/全cancel → null",
    todosIncomplete([]) === null && todosIncomplete([{ status: "completed" }, { status: "cancelled" }]) === null && todosIncomplete(null) === null);
  t("todosIncomplete：单 pending → null（纯问答噪音防护）", todosIncomplete([{ status: "pending", content: "答" }]) === null);
  t("todosIncomplete：单 in_progress → 纳入（干到一半最典型）", (todosIncomplete([{ status: "in_progress", content: "改" }]) ?? []).length === 1);
  t("todosIncomplete：≥2 混未完成 → 未落定项数组", (todosIncomplete([{ status: "completed", content: "a" }, { status: "pending", content: "b" }]) ?? []).length === 1);
  t("asksUser：行尾问号命中", asksUser("需要我先 commit 吗？") === true);
  t("asksUser：请示短语命中", asksUser("请选 A 或 B。") === true);
  t("asksUser：报告收尾不命中（中段问号不误豁免）", asksUser("是否达标见上。\n全部验证通过，交付完成。") === false);
  t("asksUser：代码块尾巴剥离后行尾问号仍命中", asksUser("跑 `npm test` 吗？\n```") === true);
  t("asksUser：等待用户显式停点命中（INSTRUCTIONS 规定标记，可无问号）", asksUser("等待用户：是否保留双币种文档。") === true);
  t("asksUser：英文请示命中", asksUser("I'll wait for your decision. Let me know.") === true);
  t("errorSettleDue：busy/retry 放弃复检，idle/未知放行", errorSettleDue("busy") === false && errorSettleDue("retry") === false && errorSettleDue("idle") === true && errorSettleDue("") === true);
  t("fingerprint：状态变 → 指纹变", exitNudgeFingerprint([{ status: "pending", content: "a" }]) !== exitNudgeFingerprint([{ status: "in_progress", content: "a" }]));
  const base = { now: 10 ** 12, hasWork: true, isChild: false, aborted: false, errored: false, askingUser: false, undone: [{ status: "pending", content: "a" }], fingerprint: "fp-new" };
  const mkS = (o) => ({ exitNudges: 0, exitNudgeAt: 0, exitNudgeFp: "", ...o });
  const sReset = mkS({ exitNudges: 2, exitNudgeFp: "fp-old" });
  t("verdict：快照变更 → 计数先重置再放行（cap 不再拦死长会话）", exitGateVerdict(sReset, base).act === true && sReset.exitNudges === 0 && sReset.exitNudgeFp === "fp-new");
  t("verdict：快照变更 → capped 标记同步复位（修复 A：第二份清单可再升级人工）", (() => {
    const y = mkS({ exitNudges: 2, exitNudgeFp: "fp-old", exitGateCapped: true });
    return exitGateVerdict(y, base).act === true && y.exitGateCapped === false;
  })());
  t("verdict：undone=null → all-settled", exitGateVerdict(mkS({}), { ...base, undone: null }).reason === "all-settled");
  t("verdict：同快照 cap=2 → nudge-cap", exitGateVerdict(mkS({ exitNudges: 2, exitNudgeFp: base.fingerprint }), base).reason === "nudge-cap");
  t("verdict：15s 内 → cooldown", exitGateVerdict(mkS({ exitNudgeAt: 10 ** 12 - 1, exitNudgeFp: base.fingerprint }), base).reason === "cooldown");
  t("verdict：无工作痕迹 → no-work", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), { ...base, hasWork: false }).reason === "no-work");
  t("verdict：子代理 → child-session", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), { ...base, isChild: true }).reason === "child-session");
  t("verdict：中止 → user-aborted", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), { ...base, aborted: true }).reason === "user-aborted");
  t("verdict：请示 → awaiting-user", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), { ...base, askingUser: true }).reason === "awaiting-user");
  t("verdict：APIError → auto-resume-error", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), { ...base, errored: true }).reason === "auto-resume-error");
  t("verdict：常规提前收口 → todos-pending", exitGateVerdict(mkS({ exitNudgeFp: base.fingerprint }), base).reason === "todos-pending");
  t("nudgeText：常规变体含计数/条目/等待用户收口", (() => {
    const x = exitNudgeText([{ status: "pending", content: "验证" }], 1, "todos-pending", 3);
    return /#1\/2/.test(x) && x.includes("验证") && x.includes("等待用户") && !x.includes("API 错误");
  })());
  t("nudgeText：error 变体走 auto-resume 文案", exitNudgeText([{ status: "pending", content: "x" }], 2, "auto-resume-error", 2).includes("API 错误"));
  t("verdict v2：自身落定+子聚合项 → child-unsettled", (() => {
    const y = mkS({ exitNudgeFp: "fp-k" });
    const r = exitGateVerdict(y, { ...base, undone: null, fingerprint: "fp-k", children: [{ id: "ses_k", items: ["pending:x"] }] });
    return r.act === true && r.reason === "child-unsettled";
  })());
  t("verdict v2：undone 与 children 均空 → all-settled", exitGateVerdict(mkS({}), { ...base, undone: null, children: [] }).reason === "all-settled");
  t("fingerprint v2：子聚合项内容变 → 指纹变（新子终局重新计额度）",
    exitNudgeFingerprint([], [{ id: "a", items: ["p:1"] }]) !== exitNudgeFingerprint([], [{ id: "a", items: ["p:2"] }]));
  t("nudgeText v2：child-unsettled 变体含子会话与续派指引", (() => {
    const x = exitNudgeText(null, 1, "child-unsettled", 0, [{ id: "ses_kid", items: ["in_progress:接线"], at: 1 }]);
    return x.includes("ses_kid") && x.includes("报告=完成") && x.includes("同会话续跑") && !x.includes("API 错误");
  })());
  t("nudgeText v2：自身+子聚合混合场景两段都在", (() => {
    const x = exitNudgeText([{ status: "pending", content: "验证" }], 1, "todos-pending", 3, [{ id: "ses_k", items: ["pending:x"], at: 1 }]);
    return x.includes("验证") && x.includes("ses_k");
  })());
  t("nudgeText v2：>5 子会话时含补报提示", exitNudgeText(null, 1, "child-unsettled", 0,
    Array.from({ length: 7 }, (_, i) => ({ id: "k" + i, items: ["x"], at: 1 }))).includes("另有 2 个子会话未列出"));
  t("v2 修复：容量满优先淘汰已上报项腾位", (() => {
    const p = mod._export.bucketOf({ sessionID: "t-v2-cap" });
    p.childUnsettled.clear();
    for (let i = 0; i < 10; i++) p.childUnsettled.set("c" + i, { items: ["x"], at: 1, reported: i === 0 });
    const ok = registerChildUnsettled("c-new", "t-v2-cap", [{ status: "pending", content: "任务" }]);
    return ok === true && p.childUnsettled.has("c-new") && !p.childUnsettled.has("c0") && p.childUnsettled.size === 10;
  })());
  t("v2 修复：容量满且全未上报 → 拒登记并入降级账本", (() => {
    const p = mod._export.bucketOf({ sessionID: "t-v2-cap2" });
    p.childUnsettled.clear();
    for (let i = 0; i < 10; i++) p.childUnsettled.set("d" + i, { items: ["x"], at: 1, reported: false });
    const ok = registerChildUnsettled("d-new", "t-v2-cap2", [{ status: "pending", content: "任务" }]);
    return ok === false && !p.childUnsettled.has("d-new") && p.degradations.some((d) => d.includes("聚合上限"));
  })());
  t("v2 修复：items 截断可见 + 换行折叠", (() => {
    const p = mod._export.bucketOf({ sessionID: "t-v2-items" });
    p.childUnsettled.clear();
    const many = Array.from({ length: 7 }, (_, i) => ({ status: "pending", content: `任\n务${i}` }));
    registerChildUnsettled("e1", "t-v2-items", many);
    const e = p.childUnsettled.get("e1");
    return e.items.length === 6 && e.items[5].includes("+2 项未列出") && !e.items.some((i) => i.includes("\n"));
  })());
  t("v2 修复：childUnsettledText 含补报条数", childUnsettledText(Array.from({ length: 7 }, (_, i) => ({ id: "c" + i, items: ["x"] }))).includes("另有 2 条"));
  t("v2：childAgeLabel 四档时效 + 未来 at 归零", (() => {
    const M = 60000, H = 3600000, D = 86400000;
    return childAgeLabel(0, 30 * 1000) === "刚刚" && childAgeLabel(0, 5 * M) === "5 分钟前"
      && childAgeLabel(0, 3 * H) === "3 小时前" && childAgeLabel(0, 2 * D) === "2 天前"
      && childAgeLabel(1000, 100) === "刚刚";
  })());
  t("v2：removeChildUnsettled 撤销往返（父桶缺失/未知子安全）", (() => {
    if (!registerChildUnsettled("r1", "t-v2-rm", [{ status: "in_progress", content: "接线" }])) return false;
    const p = mod._export.bucketOf({ sessionID: "t-v2-rm" });
    if (p.childUnsettled.size !== 1 || pendingChildrenOf(p).length !== 1) return false;
    removeChildUnsettled("t-v2-rm", "r1");
    removeChildUnsettled("no-such-parent", "x");
    removeChildUnsettled("t-v2-rm", "ghost");
    return p.childUnsettled.size === 0 && pendingChildrenOf(p).length === 0;
  })());
  t("v2：聚合文本两通道均含终局时效", (() => {
    const kids = [{ id: "k1", items: ["pending:x"], at: 0 }];
    return childUnsettledText(kids, 2 * 3600000).includes("2 小时前") && exitNudgeText(null, 1, "child-unsettled", 0, kids, 370000).includes("6 分钟前");
  })());
}
{
  // 假 client 集成：messages/get/promptAsync 三方法即门禁全部依赖面（{path:{id}} 嵌套参数为插件侧生产形状）
  const injected = [];
  const msgs = new Map();
  const parents = new Map();
  const fakeClient = {
    session: {
      messages: async ({ path }) => ({ data: msgs.get(path.id) ?? [] }),
      get: async ({ path }) => ({ data: { parentID: parents.get(path.id) ?? null } }),
      promptAsync: async (H) => { injected.push(H); },
    },
  };
  const qgExit = mod.QualityGate ?? mod.default;
  const hooksX = await qgExit({ directory: ROOT, client: fakeClient });
  const idle = (id) => hooksX.event({ event: { type: "session.idle", properties: { sessionID: id } } });
  const plainAssistant = (text) => [{ info: { role: "user" }, parts: [] }, { info: { role: "assistant" }, parts: [{ type: "text", text }] }];

  const sidA = "t-exit-a";
  const sA = mod._export.bucketOf({ sessionID: sidA });
  sA.lastTodos = [
    { content: "模块甲实现", status: "completed" },
    { content: "模块乙接线", status: "in_progress" },
    { content: "交付验证", status: "pending" },
  ];
  sA.edited.add("src/b.ts");
  msgs.set(sidA, plainAssistant("先做到这里"));
  await idle(sidA);
  t("出口门禁：idle+未落定+有工作痕迹 → 注入 #1（含未完成项与来源标注）",
    injected.length === 1 && sA.exitNudges === 1 && /回合出口门禁 #1\/2/.test(injected[0].body.parts[0].text) && injected[0].body.parts[0].text.includes("模块乙接线"));
  await idle(sidA);
  t("出口门禁：15s 冷却拒注入", injected.length === 1);
  sA.exitNudgeAt = Date.now() - 20_000;
  await idle(sidA);
  t("出口门禁：冷却后同快照注入 #2", injected.length === 2 && sA.exitNudges === 2);
  await idle(sidA);
  t("出口门禁：同快照达上限不再注入并入降级账本", injected.length === 2 && sA.degradations.some((d) => d.includes("上限")));
  sA.lastTodos[1].status = "completed";
  sA.lastTodos[2].status = "in_progress";
  sA.exitNudgeAt = Date.now() - 20_000;
  await idle(sidA);
  t("出口门禁：清单变更（指纹变）→ 计数重置重新注入 #1/2", injected.length === 3 && /#1\/2/.test(injected[2].body.parts[0].text) && injected[2].body.parts[0].text.includes("交付验证"));
  sA.lastTodos = sA.lastTodos.map((x) => ({ ...x, status: "completed" }));
  sA.exitNudgeAt = Date.now() - 20_000;
  await idle(sidA);
  t("出口门禁：全落定不注入", injected.length === 3);
  await hooksX.event({ event: { type: "session.status", properties: { sessionID: sidA, status: { type: "busy" } } } });
  t("出口门禁：session.status 记录 lastStatus（error 延迟复检依据）", sA.lastStatus === "busy");

  const mkSkip = (id, messages, parent) => {
    const s = mod._export.bucketOf({ sessionID: id });
    s.lastTodos = [{ content: "甲", status: "completed" }, { content: "乙", status: "pending" }];
    s.edited.add("src/x.ts");
    msgs.set(id, messages);
    if (parent) parents.set(id, parent);
    return s;
  };
  const sidB = mkSkip("t-exit-abort", [{ info: { role: "assistant", error: { name: "MessageAbortedError", message: "aborted" } }, parts: [] }]);
  await idle(sidB ? "t-exit-abort" : "");
  t("出口门禁：用户中止豁免", injected.length === 3 && sidB.exitNudges === 0);
  const sidC = mkSkip("t-exit-question", plainAssistant("两条路线：A 保测试，B 快落地。请选 A 或 B。"));
  await idle("t-exit-question");
  t("出口门禁：请示收尾豁免（等待用户是合法停点）", injected.length === 3 && sidC.exitNudges === 0);
  const sidD = mkSkip("t-exit-child", plainAssistant("报告如上"), "ses_parent-x");
  await idle("t-exit-child");
  t("出口门禁：子代理豁免（防与父会话文件竞争）", injected.length === 3 && sidD.exitNudges === 0);
  const sidE = mkSkip("t-exit-nowork", plainAssistant("状态同步"));
  sidE.edited.clear();
  await idle("t-exit-nowork");
  t("出口门禁：无工作痕迹豁免（纯问答不炸）", injected.length === 3 && sidE.exitNudges === 0);
  mkSkip("t-exit-err", [{ info: { role: "assistant", error: { name: "APIError", message: "503 overloaded" } }, parts: [] }]);
  await idle("t-exit-err");
  t("出口门禁：APIError 终止 → auto-resume 注入（断流病自动续）", injected.length === 4 && injected[3].body.parts[0].text.includes("API 错误"));

  const sidG = mkSkip("t-exit-getthrow", plainAssistant("报告"));
  const origGet = fakeClient.session.get;
  fakeClient.session.get = async (H) => { if (H?.path?.id === "t-exit-getthrow") throw new Error("boom"); return origGet(H); };
  await idle("t-exit-getthrow");
  fakeClient.session.get = origGet;
  t("出口门禁：session.get 失败 → 保守按子代理豁免（宁漏提醒不误注入）", sidG.exitNudges === 0 && injected.length === 4);

  const sidH = mkSkip("t-exit-sendfail", plainAssistant("半截报告"));
  const origPrompt = fakeClient.session.promptAsync;
  fakeClient.session.promptAsync = async () => { throw new Error("network down"); };
  await idle("t-exit-sendfail");
  fakeClient.session.promptAsync = origPrompt;
  t("出口门禁：注入发送失败不抛错且不烧额度（成功才计数）", sidH.exitNudges === 0 && injected.length === 4);

  const sidI = mkSkip("t-exit-errtimer", plainAssistant("中断"));
  await hooksX.event({ event: { type: "session.error", properties: { sessionID: "t-exit-errtimer" } } });
  t("出口门禁：session.error 挂延迟复检定时器（busy/retry 时放弃）", !!sidI.exitCheckTimer);
  clearTimeout(sidI.exitCheckTimer); sidI.exitCheckTimer = null;

  // 查漏修复 A（2026-10-03 二轮）：capped 标记随快照复位——第二份清单烧 cap 仍能升级人工
  const sidK = mkSkip("t-exit-recap", plainAssistant("第一轮"));
  for (let i = 0; i < 2; i++) { sidK.exitNudgeAt = Date.now() - 20_000; await idle("t-exit-recap"); }
  await idle("t-exit-recap");
  const caps1 = sidK.degradations.filter((d) => d.includes("上限")).length;
  sidK.lastTodos = [{ content: "丙", status: "in_progress" }]; // 快照变更 → 计数与 capped 一并重置（detail 与前轮区分，防去重）
  for (let i = 0; i < 2; i++) { sidK.exitNudgeAt = Date.now() - 20_000; await idle("t-exit-recap"); }
  await idle("t-exit-recap");
  t("出口门禁（修复 A）：快照变更后二次烧 cap 仍入账升级人工",
    caps1 === 1 && sidK.degradations.filter((d) => d.includes("上限")).length === 2 &&
    sidK.exitNudges === 2 && injected.length === 8 && sidK.exitGateCapped === true);

  // 查漏修复 B：同窗并发事件去重——in-flight 期间第二路直接跳过（error 复检与 idle 可同窗）
  const sidJ = mkSkip("t-exit-race", plainAssistant("并发"));
  let release;
  const gateP = new Promise((r) => { release = r; });
  const origMsgs = fakeClient.session.messages;
  fakeClient.session.messages = async (H) => { const res = await origMsgs(H); await gateP; return res; };
  const p1 = idle("t-exit-race");
  const p2 = idle("t-exit-race");
  await new Promise((r) => setTimeout(r, 0));
  release();
  await Promise.all([p1, p2]);
  fakeClient.session.messages = origMsgs;
  t("出口门禁（修复 B）：并发第二路不注入且锁释放",
    injected.length === 9 && sidJ.exitNudges === 1 && sidJ.exitGateInFlight === false);
  await idle("t-exit-race");
  t("出口门禁（修复 B）：锁释放后后续事件判定照常（冷却豁免不回归）", injected.length === 9);

  // v2 子代理终局聚合：登记 → 父 todowrite 回注 → 子补完撤销 → 父出口聚合 → 中止不登记
  const sidKid1 = mkSkip("t-exit-kid1", plainAssistant("半截"), "ses-agg-parent");
  await idle("t-exit-kid1");
  const par = mod._export.bucketOf({ sessionID: "ses-agg-parent" });
  t("v2：子代理终局登记父桶（子本身不注入）",
    injected.length === 9 && par.childUnsettled.has("t-exit-kid1"));
  msgs.set("ses-agg-parent", plainAssistant("派发完成"));
  par.edited.add("src/p.ts");
  const outP = { output: "ok" };
  await hooksX["tool.execute.after"](
    { tool: "todowrite", sessionID: "ses-agg-parent", args: { todos: [{ content: "父任务", status: "completed" }] } },
    outP);
  t("v2：父 todowrite 回注聚合项并标 reported",
    /报告=完成/.test(outP.output) && [...par.childUnsettled.values()].every((e) => e.reported));
  par.exitNudgeAt = 0;
  await idle("ses-agg-parent");
  t("v2：已 reported 子项出口不重复注入", injected.length === 9);
  sidKid1.lastTodos = sidKid1.lastTodos.map((x) => ({ ...x, status: "completed" }));
  await idle("t-exit-kid1");
  t("v2：子代理补完终局 → 父侧登记撤销", !par.childUnsettled.has("t-exit-kid1") && sidKid1.childReg === "");
  mkSkip("t-exit-kid2", plainAssistant("半截"), "ses-agg-parent");
  await idle("t-exit-kid2");
  await idle("ses-agg-parent");
  t("v2：父 idle 出口聚合注入（child-unsettled 文本含子会话）",
    injected.length === 10 && injected[9].path.id === "ses-agg-parent" && /子会话 t-exit-kid2/.test(injected[9].body.parts[0].text));
  par.exitNudges = 2;
  par.exitNudgeFp = mod._export.exitNudgeFingerprint(par.lastTodos, mod._export.pendingChildrenOf(par));
  par.exitNudgeAt = 0;
  let aggFetchCnt = 0;
  const wrapMsgs2 = fakeClient.session.messages;
  const wrapGet2 = fakeClient.session.get;
  fakeClient.session.messages = async (H) => { aggFetchCnt++; return wrapMsgs2(H); };
  fakeClient.session.get = async (H) => { aggFetchCnt++; return wrapGet2(H); };
  await idle("ses-agg-parent");
  fakeClient.session.messages = wrapMsgs2;
  fakeClient.session.get = wrapGet2;
  t("v2 优化：已知父会话本地定案（cap）→ 零 HTTP 取数", aggFetchCnt === 0 && injected.length === 10);
  par.exitNudges = 0;
  mkSkip("t-exit-kid3", [{ info: { role: "assistant", error: { name: "MessageAbortedError", message: "aborted" } }, parts: [] }], "ses-agg-parent");
  await idle("t-exit-kid3");
  t("v2：中止的子代理不登记（父侧已有 runtime 中止通知）", !par.childUnsettled.has("t-exit-kid3"));
  const sidKid4 = mkSkip("t-exit-kid4", plainAssistant("半截"), "ses-agg-parent");
  await idle("t-exit-kid4");
  msgs.set("t-exit-kid4", [{ info: { role: "assistant", error: { name: "MessageAbortedError", message: "aborted" } }, parts: [] }]);
  await idle("t-exit-kid4");
  t("v2 修复：先登记后中止 → 撤销父侧登记", !par.childUnsettled.has("t-exit-kid4") && sidKid4.childReg === "");
  mkSkip("t-exit-kid5", plainAssistant("半截"), "ses-agg-parent");
  await idle("t-exit-kid5");
  const kid5 = mod._export.bucketOf({ sessionID: "t-exit-kid5" });
  par.exitNudgeAt = 0; // 排除冷却干扰：竞态测试必须走到发送前重查路径
  const gateMsgs = fakeClient.session.messages;
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  fakeClient.session.messages = async (H) => { const res = await gateMsgs(H); if (H?.path?.id === "ses-agg-parent") await gate2; return res; };
  const pIdle = idle("ses-agg-parent");
  await new Promise((r) => setTimeout(r, 0));
  kid5.lastTodos = kid5.lastTodos.map((x) => ({ ...x, status: "completed" }));
  await idle("t-exit-kid5");
  release2();
  await pIdle;
  fakeClient.session.messages = gateMsgs;
  t("v2 修复：等待窗内子补完撤销 → 父不注入陈旧清单", injected.length === 10);

  const hooksY = await qgExit({ directory: ROOT });
  let threw = false;
  try { await hooksY.event({ event: { type: "session.idle", properties: { sessionID: "t-exit-no-client" } } }); } catch { threw = true; }
  t("出口门禁：ctx 无 client → event 静默降级不抛错（never-throw 契约）", threw === false);
}

// ── 体检 2026-10-07 闭环：次级有界化 + Start-Sleep 行为纪律记账 ──
{
  console.log("== 有界化（fileChecks/highRisk 上限驱逐）==");
  const sb = mod._export.bucketOf({ sessionID: "t-bounded" });
  for (let i = 0; i < MAX_FILE_CHECKS + 5; i++) setFileCheck(sb, `f${i}.ts`, { kind: "ts", mtimeMs: i, diags: [] });
  t("fileChecks 封顶 MAX_FILE_CHECKS", sb.fileChecks.size === MAX_FILE_CHECKS);
  t("fileChecks 最早键被驱逐、最新保留", !sb.fileChecks.has("f0.ts") && sb.fileChecks.has(`f${MAX_FILE_CHECKS + 4}.ts`));
  const sLru = mod._export.bucketOf({ sessionID: "t-bounded-lru" });
  setFileCheck(sLru, "A.ts", { kind: "ts", mtimeMs: 1, diags: [] });
  setFileCheck(sLru, "B.ts", { kind: "ts", mtimeMs: 2, diags: [] });
  setFileCheck(sLru, "A.ts", { kind: "ts", mtimeMs: 3, diags: [] }); // 重复 set → delete+set 提升为新近项
  for (let i = 0; i < MAX_FILE_CHECKS - 1; i++) setFileCheck(sLru, `x${i}.ts`, { kind: "ts", mtimeMs: i, diags: [] });
  t("LRU 提升：热文件 A 保留、最早的 B 被驱逐", sLru.fileChecks.has("A.ts") && !sLru.fileChecks.has("B.ts") && sLru.fileChecks.size === MAX_FILE_CHECKS);
  const sRisk = mod._export.bucketOf({ sessionID: "t-bounded-risk" });
  for (let i = 0; i < MAX_HIGH_RISK + 3; i++) addHighRisk(sRisk, `r${i}.ts`);
  t("highRisk 封顶 MAX_HIGH_RISK", sRisk.highRisk.size === MAX_HIGH_RISK);
  t("highRisk 最早项被驱逐、最新保留", !sRisk.highRisk.has("r0.ts") && sRisk.highRisk.has(`r${MAX_HIGH_RISK + 2}.ts`));

  console.log("== Start-Sleep 行为纪律记账（命令动词位锚定）==");
  t("命中：行首", SLEEP_CMD_RE.test("Start-Sleep -Seconds 5"));
  t("命中：分号后命令位", SLEEP_CMD_RE.test("Write-Host x; Start-Sleep -Seconds 180"));
  t("命中：&& 后命令位", SLEEP_CMD_RE.test("npm test && Start-Sleep -s 30"));
  t("命中：位置参数秒数", SLEEP_CMD_RE.test("Start-Sleep 180"));
  t("不误报：引号内文本", !SLEEP_CMD_RE.test('echo "Start-Sleep -Seconds 5"'));
  t("不误报：行中裸词无分隔符", !SLEEP_CMD_RE.test("Write-Host Start-Sleep -Seconds"));
  t("不误报：Start-Sleeping 词边界外", !SLEEP_CMD_RE.test("Start-Sleeping 5"));
  const sSlp = mod._export.bucketOf({ sessionID: "t-sleep-ledger" });
  rememberCommand(sSlp, "Start-Sleep -Seconds 180", 0, 1);
  t("记账触发：sleepWarned 置位 + 降级账本入账", sSlp.sleepWarned === true && (sSlp.degradations ?? []).some((d) => d.includes("Start-Sleep")));
  const cnt = (sSlp.degradations ?? []).length;
  rememberCommand(sSlp, "Start-Sleep -Seconds 60", 0, 2);
  rememberCommand(sSlp, 'echo "Start-Sleep -Seconds 5"', 0, 3);
  t("幂等：重复与文本形态不再追加账本", sSlp.degradations.length === cnt);
  t("命令本体仍入证据池", sSlp.commands.length === 3);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} quality-gate 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
