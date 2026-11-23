// 视觉文本识别探针（只读，不回显 key；仓库工具，非下发资产）
// 用法：node scripts/probe-vision-text.mjs [--model] [model[@effort]] [more...]
//   无模型参数时默认测 qwen4-max。零依赖程序化生成 800x220 白底黑字 "KILO-7391"
//   （5x7 点阵字模放大），要求模型「只回复图中代码」——判 VISION-TEXT-OK /
//   PARTIAL（看见了但 OCR 错 ≤1 位）/ FAIL（无代码或自述看不见）与 latency。
// 与 scripts/probe-models.mjs --vision（16x16 纯色）互补：颜色探针只能证明「能看到图」，
// 本探针要求真实 OCR 文本，能区分「200 但看不清/不读图」的渠道（2026-11-14 glm-5.3 类
// 200≠能看图的前科）。PNG 编码方式与 probe-models 的 solidPng 同源（node:zlib + CRC32），
// 但不修改该脚本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const cfgPath = path.join(os.homedir(), ".config", "kilo", "kilo.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
const prov = cfg.provider && (cfg.provider.openllamas || cfg.provider.hx);
if (!prov) {
  console.log("NO_PROVIDER, provider keys:", Object.keys(cfg.provider || {}));
  process.exit(1);
}
const opts = prov.options || {};
const baseURL = String(prov.baseURL || opts.baseURL || "").replace(/\/+$/, "");
const dataDirs = [
  process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, "kilo"),
  path.join(os.homedir(), ".local", "share", "kilo"),
  path.join(os.homedir(), ".config", "kilo"),
].filter(Boolean);
let key = "";
for (const d of dataDirs) {
  const p = path.join(d, "auth.json");
  if (!fs.existsSync(p)) continue;
  try {
    const auth = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    key = (auth && ((auth.openllamas && auth.openllamas.key) || (auth.hx && auth.hx.key))) || "";
    if (key) break;
  } catch { /* 下一个候选 */ }
}
console.log("baseURL:", baseURL, "| keyFound:", Boolean(key));
if (!baseURL || !key) process.exit(1);
const H = { Authorization: "Bearer " + key, "Content-Type": "application/json" };

// ── 5x7 点阵字模（只收录探针文本用到的字符）──
const FONT = {
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
};

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
// 白底黑字面板 PNG（RGB8，filter=0）：5x7 点阵按 scale 放大，字符间距 = scale。
function textPanelPng(text, scale = 12, margin = 60) {
  const glyphW = 5 * scale, glyphH = 7 * scale, gap = scale;
  const width = margin * 2 + text.length * glyphW + (text.length - 1) * gap;
  const height = margin * 2 + glyphH;
  const rgb = Buffer.alloc(width * height * 3, 0xff);
  const setPx = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 3;
    rgb[o] = 0; rgb[o + 1] = 0; rgb[o + 2] = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const glyph = FONT[text[i]];
    if (!glyph) continue;
    const ox = margin + i * (glyphW + gap);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) setPx(ox + col * scale + dx, margin + row * scale + dy);
        }
      }
    }
  }
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter type 0
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type 2 (RGB)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const CODE = "KILO-7391";
const png = textPanelPng(CODE);
const dataUri = "data:image/png;base64," + png.toString("base64");
console.log(`=== VISION TEXT PROBE (${png.length} bytes PNG, expect ${CODE}) ===`);

// ── 参数：--model 可选，位置参数同样接受；无参默认 qwen4-max ──
const argv = process.argv.slice(2);
const specs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model") {
    if (argv[i + 1]) specs.push(argv[++i]);
    continue;
  }
  if (a.startsWith("--model=")) { specs.push(a.slice("--model=".length)); continue; }
  if (!a.startsWith("--")) specs.push(a);
}
if (specs.length === 0) specs.push("qwen4-max");

for (const spec of specs) {
  const at = spec.indexOf("@");
  const model = at === -1 ? spec : spec.slice(0, at);
  const effort = at === -1 ? null : spec.slice(at + 1);
  const body = {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `只回复图片里显示的代码（大写字母、数字与连字符），不要解释。` },
        { type: "image_url", image_url: { url: dataUri } },
      ],
    }],
    max_tokens: 2048,
    stream: false,
  };
  if (effort) body.reasoning_effort = effort;
  const label = effort ? `${model}@${effort}` : model;
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
      const txt = String((c && c.message && c.message.content) || "").trim();
      // 判定必须区分「看不见图」与「看见了但 OCR 错一位」：后者是视觉可用，不能按盲模型处理。
      const normalized = txt.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      const m = normalized.match(/KILO-?(\d{4})/);
      const candidate = m ? `KILO-${m[1]}` : "";
      const exact = candidate === CODE;
      const mismatches = candidate ? [...candidate].filter((ch, i) => ch !== CODE[i]).length : 99;
      const verdict = exact ? "VISION-TEXT-OK     " : (mismatches <= 1 ? "VISION-TEXT-PARTIAL" : "VISION-TEXT-FAIL   ");
      console.log(`${verdict}  ${label}  ${ms}ms  finish=${c && c.finish_reason}  reply=${JSON.stringify(txt.slice(0, 80))}`);
    } else {
      const body2 = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      console.log(`VISION-TEXT-FAIL  ${label}  HTTP ${r.status}  ${ms}ms  ${body2}`);
    }
  } catch (e) {
    console.log(`ERR  ${label}  ${Date.now() - t0}ms  ${String((e && e.message) || e).slice(0, 140)}`);
  }
}
