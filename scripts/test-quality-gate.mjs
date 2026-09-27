#!/usr/bin/env node
// quality-gate 纯函数离线回归：不联网、不起 Kilo。
// 用法：node scripts/test-quality-gate.mjs
// 原理：用 esbuild（provider 的既有依赖）把 plugin/quality-gate.ts 打包到临时文件再 import——
// 直接 import 会死在「./dual-review 无扩展名」的 Node ESM 解析上。
// 覆盖：parseReviewVerdict 裁决解析 / VERIFY_CMD_RE 验证命令识别 / HIGH_RISK_RE 高风险路径
// / reviewSubject 无 git 降级 / exitCodeOf 退出码三段契约 / exitMasked 遮蔽形态
// / hasVerified·verifyFailureOf 结果实证判定 / reviewerFingerprint 审查缓存指纹
// / providerEditsOf·distStaleOf 层 2 dist 新鲜度（src 改未重建 → 交付拦截）。
// 正则、门禁逻辑与进度通道的任何回归（含 CJK 腐化）都会让本测试变红。
// 注意：本文件必须在 scripts/ 下（不进 install.manifest）——放 plugin/ 会随整目录部署进生产配置。
import { execFileSync } from "node:child_process";
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
const mod = await import(pathToFileURL(bundle).href);
fs.rmSync(bundle, { force: true });

// 工具函数经 _export 命名空间暴露（非顶层导出——Kilo vE2 会把每个导出函数当工厂调用）
const { parseReviewVerdict, VERIFY_CMD_RE, HIGH_RISK_RE, reviewSubject, exitCodeOf, exitMasked, hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker, isComplexDelivery, diagCoversLastEdit, providerEditsOf, distStaleOf, residualFixupLine, insertUnderHeading, degradationSummary, staleDeployOf, moduleBasenamesOf, hasTestRefFor, eslintConfigIn, reviewRetryAllowed, todoAnchorLines, unreviewedMarkerLine, driftCheckDue, diagRunFailureOf, isDelegateCall, reviewFailPrefix } = mod._export ?? mod;
let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  if (cond) { pass++; }
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
// 高风险命中与文件数无关；普通改动须含代码且跨 ≥3 文件（2026-09-22 两调：≥3→≥5→回调 ≥3）
t("isComplexDelivery：高风险文件命中（1 个编辑也触发）", (() => {
  const s = { highRisk: new Set(["src/auth/x.ts"]), edited: new Set(["src/auth/x.ts"]) };
  return isComplexDelivery(s, ["src/auth/x.ts"]) === true;
})());
t("isComplexDelivery：2 文件改动不触发（阈值以下）", (() => {
  const edited = new Set(["a.ts", "b.ts"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, ["a.ts", "b.ts"]) === false;
})());
t("isComplexDelivery：3 文件改动触发（2026-09-22 回调口径）", (() => {
  const files = ["a.ts", "b.ts", "c.ts"];
  return isComplexDelivery({ highRisk: new Set(), edited: new Set(files) }, files) === true;
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
    const fresh = mkPkg("fresh");
    fs.writeFileSync(path.join(fresh, "src", "index.js"), "src");
    fs.writeFileSync(path.join(fresh, "dist", "index.js"), "dist");
    fs.utimesSync(path.join(fresh, "dist", "index.js"), new Date(), new Date(Date.now() + 60_000));
    t("distStaleOf：dist 比会话编辑文件新 → 不过期",
      distStaleOf(tmp, "fresh", ["index.js"]).stale === false);
    const stale = mkPkg("stale");
    fs.writeFileSync(path.join(stale, "dist", "index.js"), "dist");
    fs.writeFileSync(path.join(stale, "src", "late.js"), "newer");
    fs.utimesSync(path.join(stale, "src", "late.js"), new Date(), new Date(Date.now() + 60_000));
    t("distStaleOf：会话编辑文件比 dist 新 → 过期（>= 口径）",
      distStaleOf(tmp, "stale", ["late.js"]).stale === true);
    const noDist = mkPkg("nodist");
    fs.writeFileSync(path.join(noDist, "src", "index.js"), "src");
    fs.rmSync(path.join(noDist, "dist"), { recursive: true, force: true });
    t("distStaleOf：编辑过 src 但 dist 缺失（从未构建）→ 拦截", distStaleOf(tmp, "nodist", ["index.js"]).stale === true);
    t("distStaleOf：编辑文件已删除 → 跳过不抛", distStaleOf(tmp, "stale", ["gone.js"]).stale === false);
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

console.log(`\n${fail === 0 ? "✅" : "❌"} quality-gate 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
