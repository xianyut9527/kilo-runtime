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
const { parseReviewVerdict, VERIFY_CMD_RE, HIGH_RISK_RE, reviewSubject, exitCodeOf, exitMasked, hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker, isComplexDelivery, diagCoversLastEdit, providerEditsOf, distStaleOf, residualFixupLine, insertUnderHeading, degradationSummary, staleDeployOf, moduleBasenamesOf, hasTestRefFor } = mod._export ?? mod;
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

console.log(`\n${fail === 0 ? "✅" : "❌"} quality-gate 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
