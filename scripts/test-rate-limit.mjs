#!/usr/bin/env node
// 429 共享冷却离线回归（不联网上游，仅本地 mock server）。
// 覆盖：
//   ① 单个 ask 内 429 + Retry-After:1 → 冷却后同模型重试成功（约 1s，非 400ms 普通退避）；
//   ② 共享窗口：首 ask 无重试预算抛 429 后，紧接的第二个 ask 等剩余冷却再发并成功；
//   ③ 连续 3 次 429 不触发 503 断路器 open（429 是限流不是网关过载）；
//   ④ 冷却等待支持 abort；⑤ 冷却超过本次 ask 剩余预算 → 明确错误快速失败。
// 用法：node scripts/test-rate-limit.mjs（秒级完成）
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

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "hx-rate-limit-"));
process.env.XDG_DATA_HOME = tmpData; // ask 遥测写临时目录

const bundles = [];
async function bundle(entry) {
  const out = path.join(os.tmpdir(), `hx-rate-limit-${process.pid}-${bundles.length}.mjs`);
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

// mock 网关：前 N 次 429（带 Retry-After:1），之后 200 SSE。
let mode = "one429"; // "one429" | "always429"
let requestCount = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requestCount++;
    if (mode === "always429" || requestCount === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "rate limited", code: "rate_limit_exceeded" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const resetServer = (m) => { mode = m; requestCount = 0; };
const askArgs = (extra = {}) => ({
  baseURL, key: "test-key", model: "m1", prompt: "x", timeoutMs: 10000, idleMs: 5000, ...extra,
});

try {
  // ── ① + ② 单 ask 内部重试与跨 ask 共享窗口 ──
  const hx1 = await bundle(path.join(ROOT, "lib", "hx-client.ts"));
  const { ask, circuitState, _test } = hx1;

  resetServer("one429");
  const a0 = Date.now();
  let aOut = null, aErr = null;
  try { aOut = await ask(askArgs({ attempts: 2 })); } catch (e) { aErr = e; }
  const aMs = Date.now() - a0;
  t("ask 内 429 → 冷却 ~1s 后同模型重试成功（Retry-After 生效）",
    () => !aErr && aOut === "hello" && requestCount === 2 && aMs >= 600 && aMs < 3000);
  t("429 冷却遥测写入 failover-events.jsonl（status=429）", () => {
    const rows = fs.readFileSync(path.join(tmpData, "kilo", "failover-events.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((x) => x.action === "rate_limit_cooldown");
    return rows.length >= 1 && rows.every((x) => x.status === 429 && x.elapsedMs >= 800 && x.elapsedMs <= 1200);
  });
  t("429 不触发 503 断路器（保持 closed）", () => circuitState() === "closed");

  resetServer("one429");
  let bErr = null;
  try { await ask(askArgs({ attempts: 1 })); } catch (e) { bErr = e; }
  const sharedSet = _test.rateLimitUntil() > Date.now();
  const b1Count = requestCount;
  const b0 = Date.now();
  let bOut = null, bErr2 = null;
  try { bOut = await ask(askArgs({ attempts: 1 })); } catch (e) { bErr2 = e; }
  const bMs = Date.now() - b0;
  t("首个 ask 429 抛出并设置共享冷却窗口",
    () => bErr?.statusCode === 429 && sharedSet && b1Count === 1);
  t("第二个 ask 等剩余冷却后成功（跨 ask 共享，~1s）",
    () => !bErr2 && bOut === "hello" && requestCount === 2 && bMs >= 600 && bMs < 3000);

  // ── ③ + ④ + ⑤ 全新模块：429 不 trip / abort / 预算不足 ──
  const hx2 = await bundle(path.join(ROOT, "lib", "hx-client.ts"));
  resetServer("always429");
  const starts = Date.now();
  const results = await Promise.allSettled([
    hx2.ask(askArgs({ attempts: 1 })),
    hx2.ask(askArgs({ attempts: 1 })),
    hx2.ask(askArgs({ attempts: 1 })),
  ]);
  t("连续 3 次 429 全部拒绝且 statusCode=429",
    () => results.every((r) => r.status === "rejected" && r.reason?.statusCode === 429));
  t("3 次 429 不触发 503 断路器 open（closed）", () => hx2.circuitState() === "closed");
  t("3 次 429 并发快速失败（不在 429 上叠加 2s/6s 过载退避）", () => Date.now() - starts < 3000);
  t("429 设置共享冷却（窗口 > now）", () => hx2._test.rateLimitUntil() > Date.now());

  // ④ abort：冷却等待可中断
  const ctl = new AbortController();
  const abortStart = Date.now();
  const abortP = hx2.ask(askArgs({ attempts: 1, signal: ctl.signal })).catch((e) => e);
  setTimeout(() => ctl.abort(), 100);
  const abortErr = await abortP;
  t("冷却等待支持 abort（~100ms 返回，不等满窗口）",
    () => /aborted|取消|abort/i.test(String(abortErr?.message ?? "")) && Date.now() - abortStart < 800);

  // ⑤ 冷却超过本次剩余预算 → 明确错误、不发请求
  const budgetStart = Date.now();
  let budgetErr = null;
  try { await hx2.ask(askArgs({ attempts: 1, timeoutMs: 250 })); } catch (e) { budgetErr = e; }
  t("冷却超出本次 ask 剩余预算 → 明确错误快速失败",
    () => /冷却剩余/.test(String(budgetErr?.message ?? "")) && /超出本次请求剩余预算/.test(String(budgetErr?.message ?? "")) && Date.now() - budgetStart < 600);
  t("预算不足失败后断路器仍 closed", () => hx2.circuitState() === "closed");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  for (const f of bundles) fs.rmSync(f, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error(`失败：${failed.join("\n")}`);
  process.exit(1);
}
