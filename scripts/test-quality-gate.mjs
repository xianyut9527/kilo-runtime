#!/usr/bin/env node
// quality-gate 纯函数离线回归：不联网、不起 Kilo。
// 用法：node scripts/test-quality-gate.mjs
// 原理：用 esbuild（provider 的既有依赖）把 plugin/quality-gate.ts 打包到临时文件再 import——
// 直接 import 会死在「./dual-review 无扩展名」的 Node ESM 解析上。
// 覆盖：parseReviewVerdict 裁决解析 / VERIFY_CMD_RE 验证命令识别 / HIGH_RISK_RE 高风险路径
// / reviewSubject 无 git 降级。正则与门禁逻辑的任何回归（含 CJK 腐化）都会让本测试变红。
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

const { parseReviewVerdict, VERIFY_CMD_RE, HIGH_RISK_RE, reviewSubject } = mod;
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); } };

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

console.log(`\n${fail === 0 ? "✅" : "❌"} quality-gate 回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
