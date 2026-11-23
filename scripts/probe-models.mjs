// 路由健康双验证探针（只读，不回显 key；仓库工具，非下发资产）
// 用法：node scripts/probe-models.mjs [--vision] <model[@effort]> [more...]
//   ① 无参打印 /v1/models 在册清单；② 逐个实弹探测参数里的模型。
// 在册 ≠ 可路由（2026-10-27 qwen3.8-max 在册仍 404 实证；2026-11-12 单日 404 亦可能只是
// 暂时性渠道故障，2026-11-13 复测全部恢复）——死跳/复活判定以本探针实弹结果为地面真值，
// 路由配置改动（kilo.json.tmpl 座席/failover 链）前后各跑一次对照。
// 支持 "model@effort" 语法：@后缀映射为请求体 reasoning_effort（变体可路由性验证）。
// --vision：改发 16x16 纯红 PNG data URI 并问颜色，判定 VISION-OK / VISION-FAIL
//（2026-11-14 视觉修复的地面真值来源：glm-5.3 在此模式下 HTTP 400 code 1210 = 网关渠道纯文本，
// 而 /v1/models 在册与文本探针 ALIVE 都掩盖不了它；modalities/attachment 声明必须以本模式实测为准）。
// --vision 无模型参数时默认遍历注册表全部模型。网关图像最小边须 >10px（1x1 会被尺寸校验拒）。
import zlib from "node:zlib";
import { loadProbeConfig, probeHeaders } from "./lib/probe-config.mjs";

// 配置/auth 加载与 probe-cache 共用 scripts/lib/probe-config.mjs（2026-11-17 抽取）；
// 输出行保持原口径，便于既有排障流程照旧读。
const { cfg, prov, baseURL, key, authPath } = loadProbeConfig();
if (!prov) {
  console.log("NO_PROVIDER, provider keys:", Object.keys(cfg.provider || {}));
  process.exit(1);
}
console.log("provider fields:", Object.keys(prov).join(","));
console.log("baseURL:", baseURL, "| keyFound:", Boolean(key), "| authPath:", authPath);
if (!baseURL || !key) process.exit(1);
const H = probeHeaders(key);

// ① 在册清单
try {
  const r = await fetch(baseURL + "/models", { headers: { Authorization: H.Authorization } });
  const j = await r.json();
  const ids = (j.data || []).map((x) => x.id).sort();
  console.log("=== /v1/models (" + ids.length + ") ===");
  console.log(ids.join("\n"));
} catch (e) {
  console.log("models list failed:", String((e && e.message) || e));
}

// ② 实弹探测（参数即待测模型，顺序执行防压网关）
const argv = process.argv.slice(2);
const vision = argv.includes("--vision");
let specs = argv.filter((a) => a !== "--vision");
if (vision && specs.length === 0) specs = Object.keys(prov.models || {});

// 视觉探针夹具：程序化生成纯色 PNG（零依赖，不入库二进制）
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array(size).fill(row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const redUri = "data:image/png;base64," + solidPng(16, [255, 0, 0]).toString("base64");
if (vision) console.log("=== VISION PROBE (16x16 solid red PNG) ===");

for (const spec of specs) {
  const at = spec.indexOf("@");
  const m = at === -1 ? spec : spec.slice(0, at);
  const effort = at === -1 ? null : spec.slice(at + 1);
  const body = {
    model: m,
    messages: [{ role: "user", content: vision
      ? [{ type: "text", text: "这张图片是什么颜色？只回答颜色名称，不要解释。" }, { type: "image_url", image_url: { url: redUri } }]
      : "只回复两个字母：OK" }],
    max_tokens: vision ? 2048 : 1024,
    stream: false,
  };
  if (effort) body.reasoning_effort = effort;
  const label = effort ? `${m}@${effort}` : m;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("probe-timeout-45s")), 45000);
    const r = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const c = j.choices && j.choices[0];
      const txt = String((c && c.message && c.message.content) || "").trim().slice(0, 40);
      const verdict = vision ? (/红|red/i.test(txt) ? "VISION-OK  " : "VISION-UNCLEAR") : "ALIVE  ";
      console.log(`${verdict}  ${label}  ${ms}ms  finish=${c && c.finish_reason}  reply=${JSON.stringify(txt)}`);
    } else {
      const body2 = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
      console.log(`${vision ? "VISION-FAIL" : "DEAD   "}  ${label}  HTTP ${r.status}  ${ms}ms  ${body2}`);
    }
  } catch (e) {
    console.log(`ERR    ${label}  ${Date.now() - t0}ms  ${String((e && e.message) || e).slice(0, 120)}`);
  }
}
