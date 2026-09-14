// 用注入的假 fetch 驱动真实降级代码路径（不打真实网络）。
// 目标：证明 doStream 在 hop0 失败时确实切到链上后继模型，并注入可见通知。
import { createHxFailover } from "file:///E:/AI/agent/kilo_config/provider/hx-failover/dist/index.js";

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
