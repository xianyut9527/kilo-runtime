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
  const { askWithDeadline, aggReserveOf } = hxMod;

  // ── aggReserveOf：聚合硬预留解析（缺省 120s；上限 180s；不超过本次总预算）──
  t("aggReserveOf 缺省 120s（total 480s）", () => aggReserveOf(undefined, 480_000) === 120_000);
  t("aggReserveOf 配置 180s 生效", () => aggReserveOf({ aggregator_reserve_ms: 180_000 }, 480_000) === 180_000);
  t("aggReserveOf 配置超上限 180s 截断", () => aggReserveOf({ aggregator_reserve_ms: 999_999 }, 480_000) === 180_000);
  t("aggReserveOf 不超过本次总预算（total 2s → 2s）",
    () => aggReserveOf({ aggregator_reserve_ms: 120_000 }, 2_000) === 2_000);
  t("aggReserveOf 非法/0 回退缺省并按总预算截断",
    () => aggReserveOf({ aggregator_reserve_ms: 0 }, 100_000) === 100_000 &&
      aggReserveOf({ aggregator_reserve_ms: "nope" }, 480_000) === 120_000);
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

  // ── moa 视角分工（2026-11-23 多模型视角互补增强）：≥2 参考席各领不同指定视角 lens，
  //    聚合保留分歧；diversify:false / 单席 / perspectives 缺省回退内置三条（图纸必修①）。──
  const moaLensMod = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const { lensesOf, DEFAULT_LENSES } = moaLensMod._export ?? {};
  t("lensesOf：缺省（无 perspectives）→ 内置三条", () => Array.isArray(lensesOf({}, 2)) && lensesOf({}, 2).length === 3);
  t("lensesOf：空数组回退内置三条（图纸必修①：i%0=NaN 不得发生）",
    () => lensesOf({ perspectives: [] }, 2).length === 3 && lensesOf({ perspectives: [] }, 2) === DEFAULT_LENSES);
  t("lensesOf：diversify:false → null（一键禁用=旧行为）", () => lensesOf({ diversify: false }, 3) === null);
  t("lensesOf：单参考席 → null（旧行为）", () => lensesOf({}, 1) === null && lensesOf({}, 0) === null);
  t("lensesOf：自定义 lens 去重+滤空+非字符串剔除", () => {
    const l = lensesOf({ perspectives: ["甲", "甲", " ", "乙", 42] }, 2);
    return l.length === 2 && l[0] === "甲" && l[1] === "乙";
  });
  t("lensesOf：超长 lens 限长（截断标注可见）", () => {
    const l = lensesOf({ perspectives: ["x".repeat(500)] }, 2);
    return l.length === 1 && l[0].startsWith("x".repeat(300)) && l[0].includes("截断");
  });

  const lensSeen = [];
  const lensServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      const content = parsed?.messages?.[0]?.content;
      lensSeen.push({ model: parsed?.model ?? "", prompt: typeof content === "string" ? content : JSON.stringify(content ?? "") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parsed?.model === "agg-x" ? "## 最终结论\n综合结论" : "参考观点" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => lensServer.listen(0, "127.0.0.1", resolve));
  const lensPort = lensServer.address().port;
  const lensCfgDir = path.join(tmpData, "cfg-lens");
  fs.mkdirSync(lensCfgDir, { recursive: true });
  const writeLensCfg = (moa) => fs.writeFileSync(path.join(lensCfgDir, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${lensPort}`, timeout: 20000, chunkTimeout: 5000, moa,
    } } },
  }));
  const lensTask = "视角分工回归任务：评估一个方案的可行性与风险";
  const runLens = async (moa) => {
    lensSeen.length = 0;
    writeLensCfg(moa);
    process.env.KILO_CONFIG_DIR = lensCfgDir;
    const mod = await bundle(path.join(ROOT, "plugin", "moa.ts")); // CONFIG_DIR import 期求值 + loadCfg TTL → 每场景新 bundle
    return { out: await (await mod.Moa({}))?.tool?.moa.execute({ task: lensTask }), seen: [...lensSeen] };
  };

  const lensDefault = await runLens({ references: ["ref-a", "ref-b"], aggregator: "agg-x" });
  const lensRefs = lensDefault.seen.filter((r) => r.model !== "agg-x");
  t("moa 视角分工：≥2 席各席 prompt 互异且各含内置 lens",
    () => lensRefs.length === 2 && lensRefs[0].prompt !== lensRefs[1].prompt &&
      lensRefs[0].prompt.includes(DEFAULT_LENSES[0]) && lensRefs[1].prompt.includes(DEFAULT_LENSES[1]) &&
      lensRefs.every((r) => r.prompt.includes(lensTask)));
  t("moa 视角分工：聚合 prompt 含分歧保留结构与视角标注", () => {
    const agg = lensDefault.seen.find((r) => r.model === "agg-x");
    return !!agg && agg.prompt.includes("## 分歧") && agg.prompt.includes("## 视角独有发现") &&
      agg.prompt.includes(DEFAULT_LENSES[0]) && agg.prompt.includes(DEFAULT_LENSES[1]);
  });
  t("moa 视角分工：输出含视角分工标注", () => /视角分工：ref-a→/.test(lensDefault.out));

  const lensOff = await runLens({ references: ["ref-a", "ref-b"], aggregator: "agg-x", diversify: false });
  t("moa diversify:false → 各席 prompt=task 逐字节同旧版",
    () => lensOff.seen.filter((r) => r.model !== "agg-x").every((r) => r.prompt === lensTask) &&
      !lensOff.out.includes("视角分工"));

  const lensCustom = await runLens({ references: ["ref-a", "ref-b"], aggregator: "agg-x", perspectives: ["自定义视角甲", "自定义视角乙"] });
  t("moa perspectives 自定义覆盖内置 lens", () => {
    const rs = lensCustom.seen.filter((r) => r.model !== "agg-x");
    return rs[0].prompt.includes("自定义视角甲") && rs[1].prompt.includes("自定义视角乙") &&
      !rs[0].prompt.includes(DEFAULT_LENSES[0]);
  });

  const lensSingle = await runLens({ references: ["ref-a"], aggregator: "agg-x" });
  t("moa 单参考席 → prompt=task 旧行为（无视角分工）",
    () => lensSingle.seen.filter((r) => r.model !== "agg-x").every((r) => r.prompt === lensTask) &&
      !lensSingle.out.includes("视角分工"));

  const lensReuse = await runLens({ references: ["ref-a", "ref-b"], aggregator: "agg-x", perspectives: ["仅一条视角"] });
  t("moa lens 数<席数 → 循环复用且输出显式标注（图纸必修①）",
    () => lensReuse.seen.filter((r) => r.model !== "agg-x").every((r) => r.prompt.includes("仅一条视角")) &&
      /视角复用：2 席\/1 视角/.test(lensReuse.out));
  lensServer.closeAllConnections?.();
  await new Promise((resolve) => lensServer.close(resolve));

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

  // ── 可选 boundary 第三视角席（dr-2026-11-23.1 多模型视角互补）：默认空=零变化（3 次调用）；
  //    启用+1 路并行、失败/超时不短路正反、独立短死线、single 强制关闭、视觉盲席过滤。──
  const bndSeen = [];
  const bndServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      const model = parsed?.model ?? "";
      const rawContent = parsed?.messages?.[0]?.content;
      const prompt = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
      bndSeen.push({ model, prompt });
      if (model === "b-fail") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NO_ROUTE_CANDIDATE", message: "no active channel" } }));
        return;
      }
      if (model === "b-hang") return; // 挂死：由 boundary 独立短死线 abort 收口
      const content = prompt.includes("你是审查裁决者") ? "## 裁决\n通过\n\n## 必须修复项\n无"
        : prompt.includes("边界视角审查者") ? (model === "b2" ? "边界兜底结论" : "边界未发现实质问题")
          : prompt.includes("正向审查者") ? "正向无遗漏"
            : prompt.includes("反向审查者") ? "反向无错误" : "结论";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => bndServer.listen(0, "127.0.0.1", resolve));
  const bndPort = bndServer.address().port;
  const bndCfgDir = path.join(tmpData, "cfg-bnd");
  fs.mkdirSync(bndCfgDir, { recursive: true });
  const bndSubject = "boundary 视角席回归 subject：可选第三席启用/失败/超时/钉扎/视觉各路径的调用数与裁决完整性校验（满足最小长度）。";
  const runBnd = async (dr, overrides = null, models = undefined) => {
    bndSeen.length = 0;
    fs.writeFileSync(path.join(bndCfgDir, "kilo.json"), JSON.stringify({
      provider: { openllamas: { options: {
        baseURL: `http://127.0.0.1:${bndPort}`, timeout: 20000, chunkTimeout: 5000, dual_review: dr,
      }, ...(models ? { models } : {}) } },
    }));
    process.env.KILO_CONFIG_DIR = bndCfgDir;
    const mod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
    const start = Date.now();
    const out = await mod._export.runDualReview(bndSubject, overrides);
    return { out, seen: [...bndSeen], elapsed: Date.now() - start, mod };
  };
  const bndBase = { positive: "p1", negative: "n1", aggregator: "agg-x" };

  const bndOff = await runBnd({ ...bndBase });
  t("boundary 缺省关闭：上游调用数=3（与旧版一致），输出无边界席标记",
    () => bndOff.seen.length === 3 && !bndOff.out.includes("边界") &&
      /## 双向审查裁决（p1 正向 × n1 反向 → agg-x 裁决）/.test(bndOff.out));

  const bndOn = await runBnd({ ...bndBase, boundary: "b-ok" });
  t("boundary 启用：4 次调用，裁决席 prompt 收到边界报告（独立围栏）",
    () => bndOn.seen.length === 4 && bndOn.seen.some((r) => r.model === "b-ok") &&
      bndOn.seen.find((r) => r.model === "agg-x")?.prompt.includes("边界视角审查结论") &&
      bndOn.seen.find((r) => r.model === "agg-x")?.prompt.includes("边界未发现实质问题"));
  t("boundary 启用：输出头含边界席与原始结论段",
    () => /× b-ok 边界 → agg-x 裁决/.test(bndOn.out) && bndOn.out.includes("### 边界\n边界未发现实质问题"));

  const bndFail = await runBnd({ ...bndBase, boundary: "b-fail" });
  t("boundary 失败不短路正反：裁决仍落地 + 缺席显式标注（图纸必修③⑤）",
    () => bndFail.seen.length === 4 && /## 裁决\n通过/.test(bndFail.out) &&
      /边界席缺席：/.test(bndFail.out) && !/一路审查失败/.test(bndFail.out));

  const bndFb = await runBnd({ ...bndBase, boundary: "b-fail", boundary_fallbacks: ["b2"] });
  t("boundary fallback：最坏调用数=Σ(1+len(fallbacks))=5 + 降级复核标注（图纸必修④）",
    () => bndFb.seen.length === 5 && /降级复核：.*边界 b-fail→b2/.test(bndFb.out) &&
      /## 裁决\n通过/.test(bndFb.out) && bndFb.out.includes("边界兜底结论"));

  const bndHang = await runBnd({ ...bndBase, boundary: "b-hang", boundary_timeout_ms: 1000 });
  t("boundary 独立短死线：挂死 1s abort，不拖延正反裁决（总耗时 <8s，图纸必修⑤）",
    () => bndHang.elapsed < 8000 && /## 裁决\n通过/.test(bndHang.out) && /边界席缺席：/.test(bndHang.out));

  const bndPin = await runBnd({ ...bndBase, boundary: "b-ok" }, { single_model: "pin-m" });
  t("single 钉扎强制关闭 boundary：3 次调用全为 pin-m + 显式标注（可观测）",
    () => bndPin.seen.length === 3 && bndPin.seen.every((r) => r.model === "pin-m") &&
      /边界席未在 single 模式启用/.test(bndPin.out) && /同源复核：正\/反\/裁决均为 pin-m/.test(bndPin.out));

  const bndVision = await runBnd({ ...bndBase, boundary: "b-ok" },
    { images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="] },
    { "b-ok": { attachment: false, modalities: { input: ["text"], output: ["text"] } } });
  t("boundary 视觉盲席过滤：text-only 边界席跳过（不发图），正反裁决照常",
    () => bndVision.seen.length === 3 && !bndVision.seen.some((r) => r.model === "b-ok") &&
      /视觉路由：边界 b-ok: 注册表为纯文本，带图审查跳过/.test(bndVision.out) && /## 裁决\n通过/.test(bndVision.out));

  // 指纹与 prompt 协议（纯函数，无需上游）
  const fpOff = await bndOff.mod._export.reviewerFingerprint({ options: { dual_review: { ...bndBase } } }, "");
  const fpOn = await bndOff.mod._export.reviewerFingerprint({ options: { dual_review: { ...bndBase, boundary: "b1", boundary_fallbacks: ["b2"], boundary_effort: "high", boundary_timeout_ms: 60000 } } }, "");
  t("指纹：boundary 空 → 无 b 段（向后兼容，存量缓存键格式不变）", () => !fpOff.includes("|b="));
  t("指纹：boundary 配置 → b/bf/be/bt 段齐全且与关闭态不同",
    () => fpOn.includes("|b=b1") && fpOn.includes("|bf=b2") && fpOn.includes("|be=high") && fpOn.includes("|bt=60000") && fpOn !== fpOff);
  const { POSITIVE_PROMPT, NEGATIVE_PROMPT, AGGREGATE_PROMPT, BOUNDARY_PROMPT } = bndOff.mod._export;
  const tagX = { s: "s1", p: "p1", n: "n1", b: "b1" };
  t("POSITIVE 含覆盖对照 + 不可判定保底（图纸必修②：不得静默漏项）", () => {
    const p = POSITIVE_PROMPT("素材", "t");
    return p.includes("覆盖对照") && p.includes("不可判定") && p.includes("不得静默漏项");
  });
  t("NEGATIVE 证据锚定 + 素材截断标不可判定", () => NEGATIVE_PROMPT("素材", "t").includes("不可判定（素材截断）"));
  t("AGGREGATE 段序固定：裁决/必须修复项 前两位，对质与覆盖在建议改进项之后（图纸必修⑥）", () => {
    const p = AGGREGATE_PROMPT("素材", "正", "反", tagX);
    const i = (h) => p.indexOf(h);
    return i("## 裁决") >= 0 && i("## 裁决") < i("## 必须修复项") &&
      i("## 必须修复项") < i("## 建议改进项") && i("## 建议改进项") < i("## 对质与覆盖") &&
      i("## 对质与覆盖") < i("## 依据");
  });
  t("AGGREGATE 必须修复项证据锚定 + 覆盖缺席按不可判定", () => {
    const p = AGGREGATE_PROMPT("素材", "正", "反", tagX);
    return p.includes("无证据支撑的指控剔除") && p.includes("不得因缺席而推定覆盖");
  });
  t("AGGREGATE boundary 报告独立围栏注入（null → 无边界段）", () => {
    const off = AGGREGATE_PROMPT("素材", "正", "反", tagX);
    const on = AGGREGATE_PROMPT("素材", "正", "反", tagX, "边界报告文本");
    return !off.includes("边界视角审查结论") && on.includes("边界视角审查结论") &&
      on.includes("<b1>") && on.includes("边界报告文本");
  });
  t("BOUNDARY lens 覆盖边界/安全/回归三域", () => {
    const p = BOUNDARY_PROMPT("素材", "t");
    return p.includes("边界条件") && p.includes("安全") && p.includes("回归");
  });
  bndServer.closeAllConnections?.();
  await new Promise((resolve) => bndServer.close(resolve));

  // ── 聚合硬预留（2026-11-23）：扇出烧完全部预算后，主聚合席仍拿到独立的
  //    aggregator_reserve_ms（不依赖 90s 保底）。KILO_AGG_FLOOR_MS=500 + timeout=2000 +
  //    reserve=1500 秒级复现：moa 参考席挂死到 2.0s、dual 反向拖到 1.8s（单路失败会短路，
  //    不能永久挂死），聚合 1.0s 后返回；旧 500ms floor 会在 2.5s/2.3s abort，输出无结论。──
  process.env.KILO_AGG_FLOOR_MS = "500"; // 必须在 bundle 新 moa 模块前设置
  const moaReserveTimers = new Set();
  const moaReserveServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(body)?.model ?? ""; } catch { /* 忽略 */ }
      if (model === "ref-b") return; // 挂死：由扇出墙钟 abort 收口
      if (model === "agg-reserve") {
        const timer = setTimeout(() => {
          moaReserveTimers.delete(timer);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "聚合结论" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 1000);
        moaReserveTimers.add(timer);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "参考观点" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => moaReserveServer.listen(0, "127.0.0.1", resolve));
  const moaReservePort = moaReserveServer.address().port;
  const tmpCfgDir5 = path.join(tmpData, "cfg-moa-reserve");
  fs.mkdirSync(tmpCfgDir5, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir5, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${moaReservePort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      moa: {
        references: ["ref-a", "ref-b"],
        aggregator: "agg-reserve",
        aggregator_reserve_ms: 1500,
      },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir5;
  const moaReserveMod = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const moaReserveTool = (await moaReserveMod.Moa({}))?.tool?.moa;
  const moaReserveStart = Date.now();
  const moaReserveOut = await moaReserveTool.execute({ task: "聚合硬预留回归：参考席挂死，聚合席应在独立预留窗口内完成" });
  const moaReserveElapsed = Date.now() - moaReserveStart;
  t("moa 聚合硬预留：扇出耗尽后聚合仍获 1500ms（旧 500ms floor 会在 2.5s abort）",
    () => /## MoA 结论/.test(moaReserveOut) && /聚合结论/.test(moaReserveOut) && moaReserveElapsed < 4500);

  // 反向对照：同一时序下 reserve=500 必须在聚合 1.0s 返回前 abort——证明配置值确实被读取
  //（若误读根 options，default 120s 会 clamp 到 total 2000ms，此对照会假绿），同时复现旧 floor 行为。
  const tmpCfgDir5b = path.join(tmpData, "cfg-moa-reserve-low");
  fs.mkdirSync(tmpCfgDir5b, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir5b, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${moaReservePort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      moa: {
        references: ["ref-a", "ref-b"],
        aggregator: "agg-reserve",
        aggregator_reserve_ms: 500,
      },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir5b;
  const moaLowMod = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const moaLowTool = (await moaLowMod.Moa({}))?.tool?.moa;
  const moaLowStart = Date.now();
  const moaLowOut = await moaLowTool.execute({ task: "聚合硬预留反向对照：reserve=500ms 时聚合必须超时" });
  const moaLowElapsed = Date.now() - moaLowStart;
  t("moa 500ms 预留反向对照：聚合返回前被 abort，无「## MoA 结论」",
    () => !/## MoA 结论/.test(moaLowOut) && /聚合失败/.test(moaLowOut) && moaLowElapsed < 4500);
  for (const tmr of moaReserveTimers) clearTimeout(tmr);
  moaReserveTimers.clear();
  moaReserveServer.closeAllConnections?.();
  await new Promise((resolve) => moaReserveServer.close(resolve));

  // dual_review 同口径：正向秒回、反向耗到扇出墙钟（1.8s/2s）后返回，裁决席 1.0s 后返回。
  // 注：dual_review 单路失败会短路（不做单路裁决），负向不能永久挂死——须在扇出墙钟内返回，
  // 审查才会进入裁决阶段；旧 500ms floor 会在 ~2.3s abort（聚合 1.0s 返回前）。
  const drReserveTimers = new Set();
  const drReserveServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(body)?.model ?? ""; } catch { /* 忽略 */ }
      if (model === "n1") {
        const timer = setTimeout(() => {
          drReserveTimers.delete(timer);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "反向无错误" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 1800);
        drReserveTimers.add(timer);
        return;
      }
      if (model === "agg-reserve") {
        const timer = setTimeout(() => {
          drReserveTimers.delete(timer);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "## 裁决\n通过\n\n## 必须修复项\n无" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 1000);
        drReserveTimers.add(timer);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: model === "p1" ? "正向无遗漏" : "反向无错误" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => drReserveServer.listen(0, "127.0.0.1", resolve));
  const drReservePort = drReserveServer.address().port;
  const tmpCfgDir6 = path.join(tmpData, "cfg-dr-reserve");
  fs.mkdirSync(tmpCfgDir6, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir6, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${drReservePort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      dual_review: {
        positive: "p1",
        negative: "n1",
        aggregator: "agg-reserve",
        aggregator_reserve_ms: 1500,
      },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir6;
  const drReserveMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const drReserveStart = Date.now();
  const drReserveOut = await drReserveMod._export.runDualReview(
    "聚合硬预留回归 subject：正向秒回、反向拖到扇出墙钟附近，扇出耗尽后裁决席必须获得独立预留窗口并在其中产出结论（含关键改动摘要与场景描述以满足最小长度）。",
  );
  const drReserveElapsed = Date.now() - drReserveStart;
  t("dual_review 聚合硬预留：扇出近耗尽后裁决仍获 1500ms（旧 500ms floor 提前 abort）",
    () => /## 双向审查裁决/.test(drReserveOut) && /## 裁决\n通过/.test(drReserveOut) && drReserveElapsed < 4500);

  // 反向对照：reserve=500 → 裁决 1.0s 返回前被 abort（旧 500ms floor 复现；同时证明配置值被读取）。
  const tmpCfgDir6b = path.join(tmpData, "cfg-dr-reserve-low");
  fs.mkdirSync(tmpCfgDir6b, { recursive: true });
  fs.writeFileSync(path.join(tmpCfgDir6b, "kilo.json"), JSON.stringify({
    provider: { openllamas: { options: {
      baseURL: `http://127.0.0.1:${drReservePort}`,
      timeout: 2000,
      chunkTimeout: 5000,
      dual_review: {
        positive: "p1",
        negative: "n1",
        aggregator: "agg-reserve",
        aggregator_reserve_ms: 500,
      },
    } } },
  }));
  process.env.KILO_CONFIG_DIR = tmpCfgDir6b;
  const drLowMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const drLowStart = Date.now();
  const drLowOut = await drLowMod._export.runDualReview(
    "聚合硬预留反向对照 subject：reserve=500ms 时裁决席必须在返回前被墙钟中止（含关键改动摘要与场景描述以满足最小长度）。",
  );
  const drLowElapsed = Date.now() - drLowStart;
  t("dual_review 500ms 预留反向对照：裁决返回前被 abort，无「## 双向审查裁决」",
    () => !/## 双向审查裁决/.test(drLowOut) && /裁决失败/.test(drLowOut) && drLowElapsed < 4500);
  for (const tmr of drReserveTimers) clearTimeout(tmr);
  drReserveTimers.clear();
  drReserveServer.closeAllConnections?.();
  await new Promise((resolve) => drReserveServer.close(resolve));
} finally {
  for (const f of bundles) fs.rmSync(f, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error(`失败：${failed.join("\n")}`);
  process.exit(1);
}
