#!/usr/bin/env node
// dual_review 审查预算/取消 + 模型异源配置离线回归（不联网上游，仅本地 mock server）。
// 用法：node scripts/test-dual-review-budget.mjs
// 原理：用 provider 既有 esbuild 打包 TS 后 import；直接 import 会死在无扩展名相对导入。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "dr-budget-data-"));
process.env.XDG_DATA_HOME = tmpData; // ask 失败遥测写入临时目录，不碰真实数据

const bundles = [];
async function bundle(entry) {
  const out = path.join(os.tmpdir(), `dr-budget-${process.pid}-${bundles.length}.mjs`);
  bundles.push(out);
  execFileSync(process.execPath, [esbuildBin, entry,
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${out}`], { stdio: "inherit" });
  return import(pathToFileURL(out).href);
}

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  try {
    const v = typeof cond === "function" ? cond() : cond;
    if (v instanceof Promise) throw new Error("t() 拒绝 Promise（恒 truthy = 假绿）——await 后传值");
    if (v) pass++;
    else { fail++; failed.push(name); console.error(`  FAIL: ${name}`); }
  } catch (e) {
    fail++; failed.push(name); console.error(`  FAIL(throw): ${name}（${String(e?.message ?? e)}）`);
  }
};

try {
  // ── 审查素材：8K 二次截断已移除，20K 尾部必须可见 ──
  const drMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const { reviewSubjectForPrompt, AGG_SUBJECT_LIMIT, fallbackSeats, degradedReviewLine } = drMod._export ?? {};
  t("双审 subject 上限为 24K（与 quality-gate 总预算对齐）", () => AGG_SUBJECT_LIMIT === 24_000);
  const tail = "TAIL-" + "y".repeat(9000);
  const mid = "x".repeat(9000) + tail;
  const midOut = reviewSubjectForPrompt(mid);
  t("20K 内 subject 尾部不被二次截断（旧 8K 上限回归）",
    () => midOut.includes(tail) && midOut.length === mid.length);
  const over = "z".repeat(AGG_SUBJECT_LIMIT + 1);
  const overOut = reviewSubjectForPrompt(over);
  t("超 24K subject 明确标注截断（审查者知道在看残件）",
    () => overOut.includes(`（截断：原始 ${over.length} 字符）`) && overOut.length < over.length + 80);
  const seat = (model) => ({ model });
  t("fallbackSeats 识别降级席位并输出「降级复核」", () => {
    const seats = fallbackSeats(
      seat("kimi-k3.1-pro"), seat("glm-5.3-flash"), seat("glm-5.3-flash"),
      ["minimax-m3.1-flash"], ["glm-5.3-flash"], ["kimi-k3.1-pro"],
    );
    return seats.length === 2 && /降级复核/.test(degradedReviewLine(seats));
  });
  t("fallbackSeats 首选全成功不标降级", () => {
    const seats = fallbackSeats(
      seat("minimax-m3.1-flash"), seat("glm-5.3-flash"), seat("kimi-k3.1-pro"),
      ["minimax-m3.1-flash"], ["glm-5.3-flash"], ["kimi-k3.1-pro"],
    );
    return seats.length === 0 && degradedReviewLine(seats) === "";
  });

  // ── askWithDeadline：到点 abort 底层请求，不留下迟到重试 ──
  const hxMod = await bundle(path.join(ROOT, "lib", "hx-client.ts"));
  const { askWithDeadline } = hxMod;
  let requests = 0;
  const server = http.createServer((_req, _res) => {
    requests++;
    // 刻意不写响应：模拟「上游挂死」，由 askWithDeadline 的 abort 收口。
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const started = Date.now();
  let err = null;
  try {
    await askWithDeadline(
      {
        baseURL: `http://127.0.0.1:${port}`,
        key: "test-key",
        model: "mock-model",
        prompt: "x",
        timeoutMs: 60_000,
        idleMs: 60_000,
        attempts: 5,
      },
      Date.now() + 300,
      "deadline-test",
    );
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - started;
  t("askWithDeadline 到点 abort 并快速返回（<3s）",
    () => !!err && /墙钟预算/.test(err.message) && elapsed < 3000);
  t("askWithDeadline 确实发出了请求（mock server 观测）", () => requests >= 1);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  // ── 配置异源：三席不得同族，聚合席为 kimi，fallback 1017 须标注降级 ──
  const raw = fs.readFileSync(path.join(ROOT, "kilo.json.tmpl"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  const cfg = JSON.parse(raw);
  const opts = cfg.provider.openllamas.options;
  t("dual_review 三席异源：positive/negative/aggregator 两两不同",
    () => new Set([opts.dual_review.positive, opts.dual_review.negative, opts.dual_review.aggregator]).size === 3);
  t("dual_review 聚合席为 kimi-k3.1-pro（qwen3.8-max 实测无路由）",
    () => opts.dual_review.aggregator === "kimi-k3.1-pro");
  t("moa 聚合席不与任一参考席同族",
    () => opts.moa.aggregator === "kimi-k3.1-pro" && !opts.moa.references.includes(opts.moa.aggregator));
  t("聚合 fallback 保留 1017 降级路径",
    () => opts.dual_review.aggregator_fallbacks.includes("deepseek-v4.1-flash-1017") &&
      opts.moa.aggregator_fallbacks.includes("deepseek-v4.1-flash-1017"));
  t("三席 fallback 首选跨族轮换，不全部落到 1017",
    () => {
      const first = [
        opts.dual_review.positive_fallbacks[0],
        opts.dual_review.negative_fallbacks[0],
        opts.dual_review.aggregator_fallbacks[0],
      ];
      return new Set(first).size === 3 && !first.includes("deepseek-v4.1-flash-1017");
    });
} finally {
  for (const f of bundles) fs.rmSync(f, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error(`失败：${failed.join("\n")}`);
  process.exit(1);
}
