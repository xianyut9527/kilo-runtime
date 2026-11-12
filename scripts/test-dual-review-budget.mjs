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
  const mainId = String(cfg.model || "").replace(/^[^/]+\//, "");
  t("审查三席均不与主编码模型同模（防自审；锁结构不锁型号，换型只改模板）",
    () => {
      if (!mainId) return false;
      const seats = [opts.dual_review.positive, opts.dual_review.negative, opts.dual_review.aggregator];
      return !seats.includes(mainId) && opts.moa.aggregator !== mainId;
    });
  t("moa 聚合席不与任一参考席同族",
    () => !opts.moa.references.includes(opts.moa.aggregator));
  t("聚合 fallback 终极保底锚定主模型（末位策略，非具体型号）",
    () => {
      const a = opts.dual_review.aggregator_fallbacks || [];
      const m = opts.moa.aggregator_fallbacks || [];
      return a.length > 0 && m.length > 0 && a[a.length - 1] === mainId && m[m.length - 1] === mainId;
    });
  t("三席 fallback 首选跨族轮换，不全部落到 1017",
    () => {
      const first = [
        opts.dual_review.positive_fallbacks[0],
        opts.dual_review.negative_fallbacks[0],
        opts.dual_review.aggregator_fallbacks[0],
      ];
      return new Set(first).size === 3 && !first.includes(mainId);
    });

  t("引用模型合计 ≤5（模板 82-83 行用户约束，防手改静默破约；注册表条目不计入）",
    () => {
      const reg = cfg.provider.openllamas.models;
      const regIds = Array.isArray(reg)
        ? reg.map((m) => m?.id ?? m?.model ?? m)
        : reg && typeof reg === "object" ? Object.keys(reg) : [];
      const rest = JSON.stringify({ ...cfg.provider.openllamas, models: undefined });
      // 边界匹配防前缀误报：kimi-k3 ⊂ kimi-k3.1-pro、glm-5.3 ⊂ glm-5.3-flash
      const used = regIds.filter(
        (id) => typeof id === "string" &&
          new RegExp(`(?<![\\w.\\-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.\\-])`).test(rest),
      );
      return used.length <= 5;
    });

  t("agent 路由 variant 均在注册表声明（防换型静默失配；锁结构不锁型号）",
    () => {
      const reg = cfg.provider.openllamas.models || {};
      return Object.values(cfg.agent).every((a) => {
        if (!a.model || !a.variant) return true;
        const id = String(a.model).replace(/^[^/]+\//, "");
        const vs = reg[id] && reg[id].variants ? Object.keys(reg[id].variants) : [];
        return vs.includes(a.variant);
      });
    });

  // ── moa 降级复核标注：聚合席落到 fallback → 输出必须带「降级复核」（对齐 kilo.json.tmpl 注释）──
  const moaServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(body)?.model ?? ""; } catch { /* 忽略 */ }
      if (model === "agg-primary") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NO_ROUTE_CANDIDATE", message: "no active channel" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: model === "agg-fallback" ? "聚合结论" : "参考观点" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => moaServer.listen(0, "127.0.0.1", resolve));
  const moaPort = moaServer.address().port;
  const tmpCfgDir = path.join(tmpData, "cfg");
  fs.mkdirSync(tmpCfgDir, { recursive: true });
  fs.mkdirSync(path.join(tmpData, "kilo"), { recursive: true });
  process.env.KILO_CONFIG_DIR = tmpCfgDir; // bundle 内 CONFIG_DIR 常量在 import 时求值，须先设
  fs.writeFileSync(path.join(tmpCfgDir, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${moaPort}`,
      timeout: 20000,
      chunkTimeout: 5000,
      moa: { references: ["ref-a", "ref-b"], aggregator: "agg-primary", aggregator_fallbacks: ["agg-fallback"] },
    } } },
  }));
  fs.writeFileSync(path.join(tmpData, "kilo", "auth.json"), JSON.stringify({ openllamas: { key: "test-key" } }));
  const moaMod = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const moaTool = (await moaMod.Moa({}))?.tool?.moa;
  const moaOut = await moaTool.execute({ task: "测试任务：给一个结论" });
  t("moa 聚合席 fallback → 输出「降级复核：聚合 agg-primary→agg-fallback」标注",
    () => /降级复核：聚合 agg-primary→agg-fallback/.test(moaOut) && /## MoA 结论/.test(moaOut));
  t("moa 路由兜底明细同时保留（诊断用）", () => /路由兜底：.*agg-primary/.test(moaOut));
  moaServer.closeAllConnections?.();
  await new Promise((resolve) => moaServer.close(resolve));

  // ── 裁决/聚合席 fallback 饿死修复（dr-2026-10-27.3 armFloor）：首选吃光共享墙钟后，
  //    fallback 须拿到一次保底窗（实证：kimi 裁决 283s 超时 → glm 兜底「已试 1 个模型」饿死）。
  //    KILO_AGG_FLOOR_MS=1000 + timeout=2000 秒级复现：agg-primary 挂死 2s 到点 → armFloor 补 1s → agg-fallback 出结论。──
  process.env.KILO_AGG_FLOOR_MS = "1000";
  const moaHangServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(body)?.model ?? ""; } catch { /* 忽略 */ }
      if (model === "agg-primary") return; // 挂死：不写任何响应，由墙钟 abort 收口
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: model === "agg-fallback" ? "聚合结论" : "参考观点" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => moaHangServer.listen(0, "127.0.0.1", resolve));
  const moaHangPort = moaHangServer.address().port;
  const tmpCfgDir2 = path.join(tmpData, "cfg-hang");
  fs.mkdirSync(tmpCfgDir2, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir2, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${moaHangPort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      moa: { references: ["ref-a", "ref-b"], aggregator: "agg-primary", aggregator_fallbacks: ["agg-fallback"] },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir2;
  const moaMod2 = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const moaHangTool = (await moaMod2.Moa({}))?.tool?.moa;
  const moaHangStart = Date.now();
  const moaHangOut = await moaHangTool.execute({ task: "测试任务：给一个结论" });
  t("moa 首选聚合吃光墙钟 → armFloor 补保底 → fallback 仍出结论（饿死回归）",
    () => /## MoA 结论/.test(moaHangOut) &&
      /降级复核：聚合 agg-primary→agg-fallback/.test(moaHangOut) &&
      /路由兜底：.*agg-primary/.test(moaHangOut) && /墙钟预算/.test(moaHangOut));
  t("moa armFloor 路径墙钟有界（2s 墙耗尽 + fallback 秒回，总耗时 <10s 不等保底窗）",
    () => Date.now() - moaHangStart < 10_000);
  moaHangServer.closeAllConnections?.();
  await new Promise((resolve) => moaHangServer.close(resolve));

  // dual_review 同口径：裁决席首选挂死 → 墙钟耗尽 → armFloor → agg-fallback 出裁决
  const drServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(body)?.model ?? ""; } catch { /* 忽略 */ }
      if (model === "agg-primary") return; // 挂死
      const content = model === "agg-fallback" ? "## 裁决\n通过\n\n## 必须修复项\n无"
        : model === "p1" ? "正向无遗漏" : "反向无错误";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => drServer.listen(0, "127.0.0.1", resolve));
  const drPort = drServer.address().port;
  const tmpCfgDir3 = path.join(tmpData, "cfg-dr");
  fs.mkdirSync(tmpCfgDir3, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir3, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${drPort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      dual_review: { positive: "p1", negative: "n1", aggregator: "agg-primary", aggregator_fallbacks: ["agg-fallback"] },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir3;
  const drMod2 = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const drStart = Date.now();
  const drOut = await drMod2._export.runDualReview("回归 subject：裁决席 fallback 饿死修复——首选聚合模型耗尽共享墙钟后，fallback 候选必须获得保底窗口并产出裁决（含关键改动摘要与场景描述以满足最小长度）。");
  t("dual_review 裁决席首选超时 → armFloor 补保底 → fallback 裁决落地（饿死回归）",
    () => /## 双向审查裁决（p1 正向 × n1 反向 → agg-fallback 裁决）/.test(drOut) &&
      /降级复核：.*裁决 agg-primary→agg-fallback/.test(drOut) &&
      /## 裁决\n通过/.test(drOut) && /路由兜底：.*agg-primary/.test(drOut));
  t("dual_review armFloor 路径墙钟有界（2s 墙耗尽 + fallback 秒回，总耗时 <10s）",
    () => Date.now() - drStart < 10_000);
  drServer.closeAllConnections?.();
  await new Promise((resolve) => drServer.close(resolve));

  // ── single_model 全席钉扎（2026-11-11 单模型质量闭环）：正/反/裁决三席全部只用指定模型，
  //    不套配置 fallback；输出必须标注「同源复核」，杜绝 single 会话混入其他模型。──
  const drPinSeen = [];
  const drPinServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      drPinSeen.push(parsed?.model ?? "");
      const prompt = JSON.stringify(parsed?.messages ?? "");
      const content = prompt.includes("你是审查裁决者") ? "## 裁决\n通过\n\n## 必须修复项\n无"
        : prompt.includes("你是代码/方案审查中的「正向审查者」") ? "正向无遗漏"
          : prompt.includes("反向审查者") ? "反向无错误" : "结论";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => drPinServer.listen(0, "127.0.0.1", resolve));
  const drPinPort = drPinServer.address().port;
  const tmpCfgDir4 = path.join(tmpData, "cfg-dr-pin");
  fs.mkdirSync(tmpCfgDir4, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir4, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${drPinPort}`,
      timeout: 20000,
      chunkTimeout: 5000,
      singleModel: "strict-model",
      dual_review: {
        positive: "p1", negative: "n1", aggregator: "agg-primary",
        positive_fallbacks: ["p-fb"], negative_fallbacks: ["n-fb"], aggregator_fallbacks: ["agg-fallback"],
      },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir4;
  const drPinMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const drPinOut = await drPinMod._export.runDualReview(
    "单模型钉扎回归 subject：调用方指定 single_model 后，正向、反向与裁决三席必须全部使用该模型，且不得套用配置 fallback（含关键改动摘要与场景描述以满足最小长度）。",
    { single_model: "chosen-model" },
  );
  t("single_model 全席钉扎：三次上游调用全部为 chosen-model（配置 fallback 不生效）",
    () => drPinSeen.length === 3 && drPinSeen.every((m) => m === "chosen-model"));
  const drCfgOut = await drPinMod._export.runDualReview(
    "config fallback pin regression: without single_model override, all three seats must use cfg.singleModel (strict-model) and never fall back to configured positive/negative/aggregator or their fallbacks. This subject is intentionally long enough for the review minimum length guard.",
    null,
  );
  t("single_model 配置兜底：overrides 缺失时三席全部为 cfg.singleModel（strict-model）",
    () => drPinSeen.length === 6 && drPinSeen.slice(3).every((m) => m === "strict-model"));
  t("single_model 配置兜底：输出同源复核模型为 strict-model",
    () => /同源复核：正\/反\/裁决均为 strict-model/.test(drCfgOut) && /## 裁决\n通过/.test(drCfgOut));
  t("single_model 全席钉扎：输出标注同源复核并通过裁决",
    () => /同源复核：正\/反\/裁决均为 chosen-model/.test(drPinOut) && /## 裁决\n通过/.test(drPinOut));
  drPinServer.closeAllConnections?.();
  await new Promise((resolve) => drPinServer.close(resolve));
} finally {
  for (const f of bundles) fs.rmSync(f, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error(`失败：${failed.join("\n")}`);
  process.exit(1);
}
