#!/usr/bin/env node
// 缓存口径探针（只读，不回显 key）：同前缀双请求裁决 prompt cache 是否生效。
// 背景（2026-11-17 P1-3）：docs/HISTORY.md 曾以 cache.write=0 断言「缓存不生效、
// 每步全量 prefill」，scripts/kilo-metrics.mjs 又以 cache.read/(input+cache.read)
// 计得约 89% 命中——两处口径冲突。本探针发两次**完全相同**的非流式请求（随机 nonce
// 长前缀约 3-4k token 量级，间隔默认 2.5s），看第二请求 usage 的 cached_tokens /
// cache_read_input_tokens 是否 >0，或延迟是否显著下降。
// 判定：第二请求 cached_tokens>0，或延迟 < 首请求 70% 且绝对下降 >500ms → 缓存生效；
//       usage 不暴露任何 cache 字段 → 未裁决；字段为 0 且延迟无显著下降 → 未观测到生效。
// 用法：node scripts/probe-cache.mjs [--model NAME] [--gap MS] [--words N]
//   默认模型 = 部署配置 agent.code.model（代码模型）；--words 控制前缀长度。
// 退出码：0 实验完成（无论裁决）；1 参数/配置/请求错误。
import crypto from "node:crypto";
import { loadProbeConfig, probeHeaders } from "./lib/probe-config.mjs";

function usage() {
  return [
    "用法: node scripts/probe-cache.mjs [选项]",
    "  --model NAME  被测模型（默认部署配置 agent.code.model）",
    "  --gap MS      两次请求间隔毫秒（默认 2500）",
    "  --words N     长前缀词数（默认 3000，约 3-4k token 量级）",
    "  --help        显示本帮助",
  ].join("\n");
}

function fail(msg) {
  console.error(`probe-cache: ${msg}`);
  process.exit(1);
}

let modelOverride = null;
let gapMs = 2500;
let prefixWords = 3000;
const argv = process.argv.slice(2);
let i = 0;
while (i < argv.length) {
  const arg = argv[i++];
  if (arg === "--model" || arg === "--gap" || arg === "--words") {
    const val = argv[i++];
    if (val === undefined || val.startsWith("--")) fail(`${arg} 缺少参数值（--help 看用法）`);
    if (arg === "--model") {
      modelOverride = val;
    } else if (arg === "--gap") {
      gapMs = Number(val);
      if (!Number.isFinite(gapMs) || gapMs < 0) fail(`--gap 需为非负数：${val}`);
    } else {
      prefixWords = Number(val);
      if (!Number.isInteger(prefixWords) || prefixWords < 100) fail(`--words 需为 >=100 的整数：${val}`);
    }
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else {
    console.error(usage());
    fail(`未知参数：${arg}`);
  }
}

const { cfg, prov, baseURL, key, authPath } = loadProbeConfig();
if (!prov) fail(`部署 kilo.json 无 provider.openllamas（keys: ${Object.keys(cfg.provider || {}).join(",")}）`);
if (!baseURL || !key) fail(`上游配置不完整（baseURL=${Boolean(baseURL)}, keyFound=${Boolean(key)}, authPath=${authPath}）`);
const configuredCodeModel = String(cfg.agent?.code?.model ?? "").split("/").pop();
const model = modelOverride || configuredCodeModel || "deepseek-v4.1-flash-1017";
const H = probeHeaders(key);

// 常见英文词重复（tokenizer 友好，避免随机串把 token 数放大到不可控）。
const WORDS = (
  "the quick brown fox jumps over lazy dog cache probe reference material summary " +
  "context prompt token model request response latency upstream gateway conversation " +
  "history message system user assistant document section paragraph sentence word letter " +
  "number value result answer question detail example sample data table index column row"
).split(/\s+/);
const nonce = crypto.randomBytes(12).toString("hex");
const filler = Array.from({ length: prefixWords }, (_, n) => WORDS[n % WORDS.length]).join(" ");
const prefix = `CACHE-PROBE nonce ${nonce}\n\nReference material begins.\n${filler}\nReference material ends. nonce ${nonce}.`;
const prompt = `${prefix}\n\nQuestion: what is the nonce value printed at the start and end of the reference material? Reply with only the nonce.`;
const bodyText = JSON.stringify({
  model,
  messages: [
    { role: "system", content: "You are a prompt-cache probe. Answer with only the requested value." },
    { role: "user", content: prompt },
  ],
  max_tokens: 64,
  temperature: 0,
  stream: false,
});

async function ask(label) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("probe-timeout-120s")), 120_000);
  let res;
  try {
    res = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: H,
      body: bodyText,
      signal: ctl.signal,
    });
  } catch (e) {
    fail(`${label} 请求失败：${String(e?.message ?? e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - t0);
  const text = await res.text().catch(() => "");
  if (!res.ok) fail(`${label} HTTP ${res.status}：${text.replace(/\s+/g, " ").slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${label} 返回非 JSON：${text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const choice = json.choices?.[0];
  return {
    ms,
    usage: json.usage ?? {},
    finish: choice?.finish_reason ?? null,
    reply: String(choice?.message?.content ?? "").trim().slice(0, 80),
  };
}

const cacheFields = (u) => ({
  "prompt_tokens_details.cached_tokens": u?.prompt_tokens_details?.cached_tokens,
  "input_tokens_details.cached_tokens": u?.input_tokens_details?.cached_tokens,
  cached_tokens: u?.cached_tokens,
  cache_read_input_tokens: u?.cache_read_input_tokens,
  cache_creation_input_tokens: u?.cache_creation_input_tokens,
  prompt_cache_hit_tokens: u?.prompt_cache_hit_tokens,
  prompt_cache_miss_tokens: u?.prompt_cache_miss_tokens,
});
const cachedOf = (u) => {
  const f = cacheFields(u);
  const value = f["prompt_tokens_details.cached_tokens"]
    ?? f["input_tokens_details.cached_tokens"]
    ?? f.cached_tokens
    ?? f.cache_read_input_tokens
    ?? f.prompt_cache_hit_tokens;
  return typeof value === "number" ? value : null;
};
const shortUsage = (u) => JSON.stringify(u).slice(0, 1200);

console.log("=== CACHE PROBE（同前缀双请求，非流式）===");
console.log(`model     : ${model}`);
console.log(`baseURL   : ${baseURL} | keyFound: ${Boolean(key)} | authPath: ${authPath}`);
console.log(`prefix    : ${prefixWords} words / ${prompt.length} chars（nonce=${nonce}）`);
console.log(`gap       : ${gapMs}ms`);
console.log(`sameBody  : true（两次请求共用同一 JSON 字符串）`);

const req1 = await ask("req1");
console.log(`\nreq1: ${req1.ms}ms finish=${req1.finish} reply=${JSON.stringify(req1.reply)}`);
console.log(`  usage: ${shortUsage(req1.usage)}`);
if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
const req2 = await ask("req2");
console.log(`\nreq2: ${req2.ms}ms finish=${req2.finish} reply=${JSON.stringify(req2.reply)}`);
console.log(`  usage: ${shortUsage(req2.usage)}`);

const f1 = cacheFields(req1.usage);
const f2 = cacheFields(req2.usage);
console.log("\n[cache 字段]");
for (const k of Object.keys(f2)) {
  const a = f1[k];
  const b = f2[k];
  if (a === undefined && b === undefined) continue;
  console.log(`  ${k}: req1=${a ?? "(缺)"} req2=${b ?? "(缺)"}`);
}
const hasCacheField = Object.values(f2).some((v) => v !== undefined) || Object.values(f1).some((v) => v !== undefined);
const cached2 = cachedOf(req2.usage);
const latencyDrop = req1.ms - req2.ms;
const latencySignificant = req2.ms < req1.ms * 0.7 && latencyDrop > 500;

let verdict;
let basis;
if (cached2 != null && cached2 > 0) {
  verdict = "缓存生效";
  basis = `req2 cached_tokens=${cached2} > 0`;
} else if (latencySignificant) {
  verdict = "缓存生效";
  basis = `req2 延迟 ${req2.ms}ms < req1 ${req1.ms}ms × 70%（下降 ${latencyDrop}ms）`;
} else if (!hasCacheField) {
  verdict = "未裁决";
  basis = "两次 usage 均未暴露 cache 字段，且延迟无显著下降";
} else {
  verdict = "未观测到缓存生效";
  basis = `cache 字段为 0/缺失（req2=${cached2 ?? "null"}），延迟 ${req1.ms}ms → ${req2.ms}ms 无显著下降`;
}

console.log(`\n[裁决] ${verdict}`);
console.log(`  依据: ${basis}`);
console.log("  注意: 单次双请求只证明该前缀在该时刻的缓存行为；生产命中率仍以 kilo-metrics 的 cache.read 口径为准。");
