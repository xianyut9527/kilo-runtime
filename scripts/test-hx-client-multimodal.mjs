#!/usr/bin/env node
// 多模态与 per-seat effort 离线回归（不联网上游，仅本地 mock SSE server）。
// 覆盖：
//   ① buildUserContent 纯函数：文本+图片顺序、空数组回退字符串、非法项过滤；
//   ② ask/askWithDeadline 请求体：reasoning_effort 配置生效/缺省不发送、images 形状；
//   ③ dual_review：配置 positive/negative/aggregator_effort、per-call 覆盖优先、
//      single 钉扎模型仍保留各席 effort、images 三路同发（data URI + 本地路径 + 8MB 限额）；
//   ④ moa：reference_effort / aggregator_effort 分别落到扇出与聚合请求。
// 用法：node scripts/test-hx-client-multimodal.mjs
// 原理：用 provider 既有 esbuild 打包 TS 后 import（直接 import 会死在无扩展名相对导入）。
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

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "hx-multimodal-"));
process.env.XDG_DATA_HOME = tmpData; // 遥测写临时目录，不碰真实数据
fs.mkdirSync(path.join(tmpData, "kilo"), { recursive: true });
fs.writeFileSync(path.join(tmpData, "kilo", "auth.json"), JSON.stringify({ openllamas: { key: "test-key" } }));

const bundles = [];
const servers = [];
async function bundle(entry) {
  const out = path.join(os.tmpdir(), `hx-multimodal-${process.pid}-${bundles.length}.mjs`);
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

const sse = (res, text) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

async function startServer(onChat) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略非 JSON */ }
      onChat(parsed, res);
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

const writeConfig = (dir, baseURL, options, models) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kilo.json"), JSON.stringify({
    provider: {
      openllamas: {
        options: { baseURL, timeout: 20000, chunkTimeout: 5000, ...options },
        ...(models ? { models } : {}),
      },
    },
  }));
};

try {
  // ── ① + ② lib/hx-client：纯函数与请求体形状 ──
  const hxSeen = [];
  const hxURL = await startServer((parsed, res) => {
    hxSeen.push({
      effort: parsed.reasoning_effort,
      hasEffort: Object.prototype.hasOwnProperty.call(parsed, "reasoning_effort"),
      content: parsed.messages?.[0]?.content,
    });
    sse(res, "hello");
  });
  const hxMod = await bundle(path.join(ROOT, "lib", "hx-client.ts"));
  const { ask, askWithDeadline } = hxMod;
  const { buildUserContent } = hxMod._test;

  t("buildUserContent: 无 images → 原字符串", () => buildUserContent("hello") === "hello");
  t("buildUserContent: 空数组 → 回退字符串", () => buildUserContent("hello", []) === "hello");
  t("buildUserContent: 文本在前、images 顺序保持（string 与 {dataUrl} 两种形态）", () => {
    const out = buildUserContent("hello", [
      "data:image/png;base64,AAA",
      { dataUrl: "data:image/jpeg;base64,BBB" },
    ]);
    return Array.isArray(out) && out.length === 3
      && out[0].type === "text" && out[0].text === "hello"
      && out[1].type === "image_url" && out[1].image_url.url === "data:image/png;base64,AAA"
      && out[2].type === "image_url" && out[2].image_url.url === "data:image/jpeg;base64,BBB";
  });
  t("buildUserContent: 非法/非 data:image 项被过滤（混合时仅保留合法图）", () => {
    const out = buildUserContent("hello", [
      "http://example.com/a.png",
      "data:text/plain;base64,CCC",
      null,
      42,
      "data:image/webp;base64,DDD",
    ]);
    return Array.isArray(out) && out.length === 2 && out[1].image_url.url === "data:image/webp;base64,DDD";
  });
  t("buildUserContent: 全部非法 → 回退字符串（纯文本请求形状不变）",
    () => buildUserContent("hello", ["http://x/a.png", "data:text/plain;base64,AAA"]) === "hello");

  const askBase = { baseURL: hxURL, key: "test-key", model: "m1", prompt: "hi", timeoutMs: 5000, idleMs: 2000, attempts: 1 };
  const askOnce = async (extra) => {
    try { return { text: await ask({ ...askBase, ...extra }) }; } catch (e) { return { err: e }; }
  };

  const aHigh = await askOnce({ reasoningEffort: "high" });
  t("ask: reasoningEffort 透传为请求体 reasoning_effort",
    () => aHigh.text === "hello" && hxSeen.at(-1)?.effort === "high" && hxSeen.at(-1)?.hasEffort === true);

  const aCustom = await askOnce({ reasoningEffort: "custom-x" });
  t("ask: 任意字符串原样透传", () => aCustom.text === "hello" && hxSeen.at(-1)?.effort === "custom-x");

  const aDefault = await askOnce({});
  t("ask: 缺省不发送 reasoning_effort", () => aDefault.text === "hello" && hxSeen.at(-1)?.hasEffort === false);

  const aBlank = await askOnce({ reasoningEffort: "   " });
  t("ask: 空白 effort 视同缺省（不发送）", () => aBlank.text === "hello" && hxSeen.at(-1)?.hasEffort === false);

  t("ask: 无 images 时 content 仍是字符串（旧形状逐字节兼容）",
    () => typeof hxSeen.at(-1)?.content === "string" && hxSeen.at(-1)?.hasEffort === false);

  let deadlineOut = "";
  let deadlineErr = null;
  try {
    deadlineOut = await askWithDeadline(
      { ...askBase, reasoningEffort: "low", images: ["data:image/png;base64,AAA"] },
      Date.now() + 5000,
      "multimodal",
    );
  } catch (e) { deadlineErr = e; }
  t("askWithDeadline: effort + images 经透传到请求体", () => {
    const last = hxSeen.at(-1);
    return !deadlineErr && deadlineOut === "hello" && last?.effort === "low" && Array.isArray(last?.content)
      && last.content[0]?.type === "text" && last.content[1]?.image_url?.url === "data:image/png;base64,AAA";
  });

  const aBadImg = await askOnce({ images: ["http://x/a.png"] });
  t("ask: 仅非法 images → 仍发字符串 content",
    () => aBadImg.text === "hello" && typeof hxSeen.at(-1)?.content === "string");

  // ── ③ dual_review：per-seat effort + images ──
  const drSeen = [];
  const drURL = await startServer((parsed, res) => {
    drSeen.push({
      model: parsed.model,
      effort: parsed.reasoning_effort,
      hasEffort: Object.prototype.hasOwnProperty.call(parsed, "reasoning_effort"),
      content: parsed.messages?.[0]?.content,
    });
    const prompt = JSON.stringify(parsed.messages ?? "");
    const content = prompt.includes("你是审查裁决者") ? "## 裁决\n通过\n\n## 必须修复项\n无"
      : prompt.includes("「正向审查者」") ? "正向无遗漏"
        : prompt.includes("反向审查者") ? "反向无错误" : "结论";
    sse(res, content);
  });
  const drCfgDir = path.join(tmpData, "cfg-dr");
  writeConfig(drCfgDir, drURL, {
    dual_review: {
      positive: "p1", negative: "n1", aggregator: "agg",
      positive_effort: "low", negative_effort: "medium", aggregator_effort: "high",
    },
  });
  process.env.KILO_CONFIG_DIR = drCfgDir;
  const drMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const subject = "多模态与 effort 回归 subject：验证配置档位、per-call 覆盖与图片三路同发（含关键改动摘要与场景描述以满足最小长度）。";

  drSeen.length = 0;
  const drOut = await drMod._export.runDualReview(subject);
  t("dual_review: 配置 effort 分别落到正/反/裁决", () => {
    const byModel = Object.fromEntries(drSeen.map((x) => [x.model, x.effort]));
    return /## 裁决\n通过/.test(drOut) && byModel.p1 === "low" && byModel.n1 === "medium" && byModel.agg === "high";
  });
  t("dual_review: 无 images 时三路 content 均为字符串", () => drSeen.every((x) => typeof x.content === "string"));

  drSeen.length = 0;
  await drMod._export.runDualReview(subject, {
    positive_effort: "max", negative_effort: "minimal", aggregator_effort: "custom",
  });
  t("dual_review: per-call effort 覆盖优先于配置", () => {
    const byModel = Object.fromEntries(drSeen.map((x) => [x.model, x.effort]));
    return byModel.p1 === "max" && byModel.n1 === "minimal" && byModel.agg === "custom";
  });

  const imgUri = "data:image/png;base64,QUJD";
  drSeen.length = 0;
  const drImgOut = await drMod._export.runDualReview(subject, { images: [imgUri] });
  t("dual_review: 三路 prompt 均携带同一 images（text 在前 + image_url）", () => {
    if (!/## 裁决/.test(drImgOut) || drSeen.length !== 3) return false;
    return drSeen.every((x) => Array.isArray(x.content)
      && x.content[0]?.type === "text"
      && x.content[1]?.type === "image_url"
      && x.content[1]?.image_url?.url === imgUri);
  });

  // 带图审查的盲席过滤：注册表 text-only 的主席跳过，改用该席视觉 fallback，且输出可审计。
  const blindSeen = [];
  const blindURL = await startServer((parsed, res) => {
    blindSeen.push({ model: parsed.model, content: parsed.messages?.[0]?.content });
    const prompt = JSON.stringify(parsed.messages ?? "");
    const content = prompt.includes("你是审查裁决者") ? "## 裁决\n通过\n\n## 必须修复项\n无"
      : prompt.includes("「正向审查者」") ? "正向无遗漏" : "反向无错误";
    sse(res, content);
  });
  const blindCfgDir = path.join(tmpData, "cfg-dr-blind");
  writeConfig(blindCfgDir, blindURL, {
    dual_review: {
      positive: "p1", negative: "nblind", negative_fallbacks: ["nvis"], aggregator: "agg",
    },
  }, {
    p1: { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
    nblind: { attachment: false, modalities: { input: ["text"], output: ["text"] } },
    nvis: { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
    agg: { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
  });
  process.env.KILO_CONFIG_DIR = blindCfgDir;
  const blindMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));
  const blindOut = await blindMod._export.runDualReview(subject, { images: [imgUri] });
  t("dual_review: 带图审查跳过 text-only 主席并改走视觉 fallback", () => {
    const models = blindSeen.map((x) => x.model);
    return /## 裁决/.test(blindOut)
      && !models.includes("nblind")
      && models.includes("p1") && models.includes("nvis") && models.includes("agg")
      && /视觉路由/.test(blindOut) && /nblind/.test(blindOut);
  });

  // execute：本地文件路径 → base64 data URI（MIME 取扩展名）
  const pngPath = path.join(tmpData, "panel.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  fs.writeFileSync(pngPath, pngBytes);
  const drTool = (await drMod.DualReview({}))?.tool?.dual_review;
  drSeen.length = 0;
  const drFileOut = await drTool.execute({ subject, images: [pngPath] }, {});
  const expectedUri = `data:image/png;base64,${pngBytes.toString("base64")}`;
  t("dual_review.execute: 本地 png 路径读成 data:image/png;base64 并随三路发送", () => {
    if (!/## 裁决/.test(drFileOut) || drSeen.length !== 3) return false;
    return drSeen.every((x) => Array.isArray(x.content) && x.content[1]?.image_url?.url === expectedUri);
  });

  const bigPath = path.join(tmpData, "big.png");
  fs.writeFileSync(bigPath, Buffer.alloc(8 * 1024 * 1024 + 1));
  const beforeBig = drSeen.length;
  const bigOut = await drTool.execute({ subject, images: [bigPath] }, {});
  t("dual_review.execute: 超 8MB 返回明确字符串错误且不发请求",
    () => /8MB/.test(bigOut) && drSeen.length === beforeBig);

  const badPath = path.join(tmpData, "note.gif");
  fs.writeFileSync(badPath, Buffer.from("GIF89a"));
  const badOut = await drTool.execute({ subject, images: [badPath] }, {});
  t("dual_review.execute: 不支持的扩展名返回明确错误（默认支持 png/jpg/jpeg/webp）",
    () => /不支持的图片类型/.test(badOut) && drSeen.length === beforeBig);

  const fakePng = path.join(tmpData, "fake.png");
  fs.writeFileSync(fakePng, Buffer.from("not an image"));
  const beforeFake = drSeen.length;
  const fakeOut = await drTool.execute({ subject, images: [fakePng] }, {});
  t("dual_review.execute: 扩展名伪造但魔数不符时拒绝读取且不发请求",
    () => /魔数/.test(fakeOut) && drSeen.length === beforeFake);

  const beforeMany = drSeen.length;
  const manyOut = await drTool.execute({ subject, images: Array(9).fill(imgUri) }, {});
  t("dual_review.execute: 图片张数超过 8 张时明确拒绝",
    () => /最多 8 张/.test(manyOut) && drSeen.length === beforeMany);

  // ── ④ 缺省 effort + single 钉扎仍保留 effort ──
  const pinSeen = [];
  const pinURL = await startServer((parsed, res) => {
    pinSeen.push({
      model: parsed.model,
      effort: parsed.reasoning_effort,
      hasEffort: Object.prototype.hasOwnProperty.call(parsed, "reasoning_effort"),
    });
    const prompt = JSON.stringify(parsed.messages ?? "");
    const content = prompt.includes("你是审查裁决者") ? "## 裁决\n通过\n\n## 必须修复项\n无"
      : prompt.includes("「正向审查者」") ? "正向无遗漏" : "反向无错误";
    sse(res, content);
  });
  const pinCfgDir = path.join(tmpData, "cfg-dr-pin");
  writeConfig(pinCfgDir, pinURL, { dual_review: { positive: "p1", negative: "n1", aggregator: "agg" } });
  process.env.KILO_CONFIG_DIR = pinCfgDir;
  const drPinMod = await bundle(path.join(ROOT, "plugin", "dual-review.ts"));

  pinSeen.length = 0;
  await drPinMod._export.runDualReview(subject);
  t("dual_review: 配置缺省 → 三路均不发送 reasoning_effort", () => pinSeen.length === 3 && pinSeen.every((x) => x.hasEffort === false));

  pinSeen.length = 0;
  await drPinMod._export.runDualReview(subject, {
    single_model: "chosen-model",
    positive_effort: "high", negative_effort: "low", aggregator_effort: "max",
  });
  t("dual_review: single 钉扎只用选定模型，仍保留各席 effort", () => {
    const effs = pinSeen.map((x) => x.effort);
    return pinSeen.length === 3 && pinSeen.every((x) => x.model === "chosen-model")
      && effs.includes("high") && effs.includes("low") && effs.includes("max");
  });

  // ── ⑤ moa：reference_effort / aggregator_effort ──
  const moaSeen = [];
  const moaURL = await startServer((parsed, res) => {
    moaSeen.push({ model: parsed.model, effort: parsed.reasoning_effort });
    sse(res, parsed.model === "agg" ? "聚合结论" : "参考观点");
  });
  const moaCfgDir = path.join(tmpData, "cfg-moa");
  writeConfig(moaCfgDir, moaURL, {
    moa: {
      references: ["ref-a", "ref-b"], aggregator: "agg",
      reference_effort: "low", aggregator_effort: "max",
    },
  });
  process.env.KILO_CONFIG_DIR = moaCfgDir;
  const moaMod = await bundle(path.join(ROOT, "plugin", "moa.ts"));
  const moaTool = (await moaMod.Moa({}))?.tool?.moa;
  moaSeen.length = 0;
  const moaOut = await moaTool.execute({ task: "多模态 effort 回归：给一个结论" });
  t("moa: reference_effort 落扇出、aggregator_effort 落聚合", () => {
    const byModel = Object.fromEntries(moaSeen.map((x) => [x.model, x.effort]));
    return /## MoA 结论/.test(moaOut)
      && byModel["ref-a"] === "low" && byModel["ref-b"] === "low" && byModel.agg === "max";
  });
} finally {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const f of bundles) fs.rmSync(f, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error(`失败：${failed.join("\n")}`);
  process.exit(1);
}
