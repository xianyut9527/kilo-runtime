// 用注入的假 fetch 驱动真实降级代码路径（不打真实网络）。
// 目标：证明 doStream 在 hop0 失败时确实切到链上后继模型，并注入可见通知。
// 用 import.meta.url 定位 dist：仓库可克隆到任意路径，不得写死绝对路径。
const { createHxFailover } = await import(new URL("./dist/index.js", import.meta.url).href);

const calls = [];
// 假 fetch：对指定失败模型返回 500，其余返回合法 SSE
const failing = new Set(["glm-5.3-flash"]);
const fakeFetch = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls.push(model);
  if (failing.has(model)) {
    return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const sse = [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: `[served-by ${model}]` }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const provider = createHxFailover({
  name: "hx",
  baseURL: "https://stub.local/v1",
  apiKey: "stub",
  fetch: fakeFetch,
});

const model = provider.languageModel("glm-5.3-flash");
console.log("chain:", model.hxFailoverChain.join(" -> "));

const { stream } = await model.doStream({
  prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  includeRawChunks: false,
});

let text = "";
for await (const part of stream) {
  if (part.type === "text-delta") text += part.delta ?? part.textDelta ?? "";
}

console.log("attempted models (in order):", calls.join(", "));
console.log("emitted text:", JSON.stringify(text));
console.log("");
console.log("PASS failover-switched      :", calls.length > 1 && calls[0] === "glm-5.3-flash");
console.log("PASS notice-injected        :", text.includes("[failover]"));
console.log("PASS served-by-fallback     :", /\[served-by (kimi-k2\.6|deepseek-v4\.1-flash|glm-5\.2)\]/.test(text));

// ── 回归 2：调用方取消（AbortError）必须直通 ────────────────────────────────
// 缺陷复现：旧 isRetryable 把 AbortError 也当可重试 → 在已 aborted 的 signal 上把整条链各试 3 次
// （实测 8s 卡顿），并给每个模型打冷却标记 → 冷却期内备用被 skip_cooldown 跳过 → 真故障时无备用、直接停止。
const mode = new Map(); // model -> "abort" | "fail500" | "ok"
const calls2 = [];
const fakeFetch2 = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls2.push(model);
  const m = mode.get(model) ?? "ok";
  if (m === "abort") {
    // 与 Node undici 用户取消一致：DOMException AbortError，message "The operation was aborted."
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  }
  if (m === "fail500") {
    return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
  const sse = [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: `[served-by ${model}]` }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

// cooldownMs 拉长到 20s：任何“被误标冷却”都会在下面的 B 步暴露（备用被跳过）
const p2 = createHxFailover({
  name: "hx",
  baseURL: "https://stub.local/v1",
  apiKey: "stub",
  fetch: fakeFetch2,
  failover: { chain: { models: ["minimax-m3", "deepseek-v4-flash"] }, cooldownMs: 20000 },
});
// 用 doStream（与真实主链路一致；doGenerate 走非流式 JSON schema，不能喂 SSE 假体）
const gen = async (model) => {
  const { stream } = await p2.languageModel(model).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  let out = "";
  for await (const part of stream) {
    if (part.type === "text-delta") out += part.delta ?? part.textDelta ?? "";
  }
  return out;
};

// A 步：hop0 被取消 → 必须立即抛 AbortError，且只尝试过 1 次（不重试、不换模型）
mode.set("deepseek-v4-flash", "abort");
let cancelName = null;
try { await gen("deepseek-v4-flash"); } catch (e) { cancelName = e?.name; }
const cancelCalls = calls2.slice();
console.log("");
console.log("cancel attempts (A):", cancelCalls.join(", "));
console.log("PASS cancel-no-retry        :", cancelCalls.length === 1 && cancelCalls[0] === "deepseek-v4-flash");
console.log("PASS cancel-passthrough     :", cancelName === "AbortError");

// B 步：上一步被取消的模型现在作为备用出现 → 若被误标冷却会被 skip_cooldown 跳过
mode.set("deepseek-v4-flash", "ok");
mode.set("minimax-m3", "fail500");
calls2.length = 0;
let bText = "";
try { bText = await gen("minimax-m3"); } catch (e) { bText = `ERROR: ${e?.message}`; }
console.log("attempts (B):", calls2.join(", "));
console.log("text (B):", JSON.stringify(bText));
console.log("PASS no-cooldown-pollution  :", calls2.includes("deepseek-v4-flash") && bText.includes("[served-by deepseek-v4-flash]"));

// ── 回归 3：chunkTimeout 看门狗 —— 流建立后长时间无数据必须被主动中断 ──────
// 背景：chunkTimeout 曾是「无消费者的无效配置」，注释承诺的防挂死并不存在（2026-09-15 补实现）。
const stalled = () => new ReadableStream({ start() { /* 永不 enqueue、永不 close */ } });
const fakeFetch3 = async () =>
  new Response(stalled(), { status: 200, headers: { "content-type": "text/event-stream" } });
const p3 = createHxFailover({
  name: "hx",
  baseURL: "https://stub.local/v1",
  apiKey: "stub",
  fetch: fakeFetch3,
  chunkTimeout: 300,
});
let wdError = null;
const wdT0 = Date.now();
// 看门狗 timer 是 unref 的（不阻止宿主进程退出），测试进程需保活防事件循环排空
const keepAlive = setInterval(() => {}, 100);
try {
  const { stream } = await p3.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const _ of stream) { /* 不应收到任何数据 */ }
} catch (e) { wdError = e; }
clearInterval(keepAlive);
const wdElapsed = Date.now() - wdT0;
console.log("");
console.log("watchdog elapsed(ms):", wdElapsed);
console.log("PASS watchdog-fires         :", Boolean(wdError) && /chunkTimeout/.test(String(wdError?.message)) && wdElapsed < 5000);
