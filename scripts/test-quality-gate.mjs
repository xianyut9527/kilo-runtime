#!/usr/bin/env node
// quality-gate 纯函数离线回归：不联网、不起 Kilo。
// 用法：node scripts/test-quality-gate.mjs
// 原理：用 esbuild（provider 的既有依赖）把 plugin/quality-gate.ts 打包到临时文件再 import——
// 直接 import 会死在「./dual-review 无扩展名」的 Node ESM 解析上。
// 覆盖：parseReviewVerdict 裁决解析 / VERIFY_CMD_RE 验证命令识别 / HIGH_RISK_RE 高风险路径
// / reviewSubject 无 git 降级 / exitCodeOf 退出码三段契约 / exitMasked 遮蔽形态
// / hasVerified·verifyFailureOf 结果实证判定 / makeTitle 进度通道选择与节流（含无 ctx 降级 stderr）。
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
const { parseReviewVerdict, VERIFY_CMD_RE, HIGH_RISK_RE, reviewSubject, exitCodeOf, exitMasked, hasVerified, verifyFailureOf, hasSkipMarker, hasAcceptMarker, isComplexDelivery, diagCoversLastEdit } = mod._export ?? mod;
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
// 高风险命中与文件数无关；普通改动须含代码且跨 ≥5 文件（2026-09-22 由 ≥3 上调）
t("isComplexDelivery：高风险文件命中（1 个编辑也触发）", (() => {
  const s = { highRisk: new Set(["src/auth/x.ts"]), edited: new Set(["src/auth/x.ts"]) };
  return isComplexDelivery(s, ["src/auth/x.ts"]) === true;
})());
t("isComplexDelivery：4 文件改动不触发（≥3 旧口径已上调）", (() => {
  const edited = new Set(["a.ts", "b.ts", "c.ts", "d.ts"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, ["a.ts", "b.ts", "c.ts", "d.ts"]) === false;
})());
t("isComplexDelivery：5 文件改动触发", (() => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  return isComplexDelivery({ highRisk: new Set(), edited: new Set(files) }, files) === true;
})());
t("isComplexDelivery：无代码编辑不触发（纯文档）", (() => {
  const edited = new Set(["README.md", "docs/a.md"]);
  return isComplexDelivery({ highRisk: new Set(), edited }, []) === false;
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

// ── makeTitle（plugin/dual-review.ts）：进度通道选择与节流 ──
// 2026-09-22 通道根因修复后签名 makeTitle(emit, label)：emit 函数（工具路径，
// bridgeProgress 注入）→ 转发流式进度；无 emit（quality-gate 钩子直调路径）→
// 降级 stderr（阶段首现立即输出、同阶段 10s 节流、正反交替不误判刷屏）。
{
  const drBundle = path.join(os.tmpdir(), `dr-test-${process.pid}.mjs`);
  execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "dual-review.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${drBundle}`], { stdio: "inherit" });
  const dr = await import(pathToFileURL(drBundle).href);
  fs.rmSync(drBundle, { force: true });
  const drT = dr._export ?? dr;

  const lines = [];
  const origErr = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    // 无 emit（自动审查路径）→ stderr；阶段首次出现立即输出，同阶段重复按 10s 节流
    const emit = drT.makeTitle(null, "双向审查两路并行");
    await emit("正向已收 1 字");
    await emit("正向已收 2 字");
    await emit("两路并行已收 9 字");
    await emit("两路并行已收 88 字");
    t("无 emit：进度降级 stderr，阶段首现不被节流吞掉、同阶段重复被抑制",
      lines.length === 2 && lines[0].includes("正向") && lines[1].includes("两路并行"));

    // 两路标题交替到达（正/反各一路）：不得因交替而每 chunk 都视为新阶段刷屏
    lines.length = 0;
    const emit2 = drT.makeTitle(null, "双向审查两路并行");
    for (let i = 1; i <= 5; i++) {
      await emit2(`正向已收 ${i * 10} 字`);
      await emit2(`两路并行已收 ${i * 10} 字`);
    }
    t("无 emit：正反交替标题不被误判为阶段切换（仅各输出一次）", lines.length === 2);

    // 有 emit（工具路径，preliminary 流式）→ 转发且不落 stderr；force 透传
    const titles = [];
    const emitFn = (text, force) => { titles.push(`${force ? "!" : ""}${text}`); };
    const emitStream = drT.makeTitle(emitFn, "X");
    const before = lines.length;
    await emitStream("裁决生成中 10 字");
    await emitStream("阶段切换", true);
    t("有 emit：转发流式进度且不写 stderr（force 透传）",
      titles.length === 2 && titles[0].includes("裁决生成中") && titles[1].startsWith("!") && lines.length === before);

    // ── reviewerFingerprint：审查缓存键成分（2026-09-22 三模型裁决必须项）──
    // 缓存键 = 指纹 + 素材 sha1：改 prompt（版本变）或换模型（三元组变）→ 指纹变 →
    // 缓存失效，绝不复用异构模型旧裁决。cfg 注入，不依赖真实配置。
    const fpCfg = (dual_review) => ({ options: { dual_review } });
    const fpA = await drT.reviewerFingerprint(fpCfg({ positive: "m-a", negative: "m-b", aggregator: "m-c" }));
    t("指纹含版本与模型三元组", /^v=\S+\|p=m-a\|n=m-b\|a=m-c$/.test(fpA));
    t("换任一模型 → 指纹变（缓存即失效）",
      fpA !== (await drT.reviewerFingerprint(fpCfg({ positive: "m-x", negative: "m-b", aggregator: "m-c" }))));
    t("配置缺 dual_review → 指纹稳定（空三元组，不抛错）",
      /^v=\S+\|p=\|n=\|a=$/.test(await drT.reviewerFingerprint(fpCfg(undefined))));

    // bridgeProgress（lib/hx-client.ts）：execute 契约桥（三修终版）——返回 Promise<string>，
    // emit 降级 stderr 节流（force 透传），run 抛错 → Promise 拒绝（kilo t$A 错误通道）
    const hxBundle = path.join(os.tmpdir(), `hx-test-${process.pid}.mjs`);
    execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "lib", "hx-client.ts"),
      "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${hxBundle}`], { stdio: "inherit" });
    const hx = await import(pathToFileURL(hxBundle).href);
    fs.rmSync(hxBundle, { force: true });
    const stream = hx.bridgeProgress(async (emit3) => {
      emit3("启动：模型 A + 模型 B", true);
      await new Promise((r) => setTimeout(r, 10)); // 越过短节流窗
      emit3("进度 1");
      emit3("进度 1"); // 节流窗内重复 → 被抑制
      emit3("阶段完成", true); // force 跳过节流
      await new Promise((r) => setTimeout(r, 30));
      return "最终结果";
    }, { throttleMs: 5 });
    const errLines = [];
    const origErr2 = console.error;
    console.error = (...a) => errLines.push(a.join(" "));
    let finalVal;
    try { finalVal = await stream; } finally { console.error = origErr2; }
    t("bridgeProgress：返回 Promise 且 resolve 为 string（ET 提升/f.split 渲染双契约）",
      typeof finalVal === "string" && finalVal === "最终结果");
    t("bridgeProgress：进度走 stderr 节流去重 + force 透传",
      errLines.length === 3 && errLines[0].includes("启动") && errLines[1] === "进度 1" && errLines[2] === "阶段完成");
    let rejected = false;
    try { await hx.bridgeProgress(async () => { throw new Error("boom"); }); }
    catch { rejected = true; }
    t("bridgeProgress：run 抛错 → Promise 拒绝（不吞错）", rejected === true);
  } finally {
    console.error = origErr;
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} quality-gate 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
