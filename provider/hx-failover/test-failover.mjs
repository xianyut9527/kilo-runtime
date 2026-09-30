// 用注入的假 fetch 驱动真实降级代码路径（不打真实网络）。
// 目标：证明 doStream 在 hop0 失败时确实切到链上后继模型，并注入可见通知。
// 用 import.meta.url 定位 dist：仓库可克隆到任意路径，不得写死绝对路径。
// 引擎守卫：dist 内嵌 SDK 需要 TransformStream（node>=18）；本机 PATH 默认 node 若为
// v14（无 TransformStream）会在 import dist 时炸 ReferenceError——提前给出可行动提示
// 而不是裸堆栈（2026-09-28 实证：PATH node v14.17，套件必须用 nvm v22 跑）。
if (typeof TransformStream === "undefined") {
  console.error(
    `hx-failover test: node ${process.version} 缺少 TransformStream（dist 内嵌 SDK 需要 node>=18）。` +
      ` 请用 node>=18 运行本套件（本机可用 %APPDATA%\\nvm\\v22.14.0\\node.exe）。`,
  );
  process.exit(70); // EX_SOFTWARE：引擎不满足，非测试失败
}
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

// 全部测试的 failover 遥测写入临时目录，不污染真实 failover-events.jsonl
// （failoverLogPath 在调用时读 env，import 后设置即生效）
process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "hx-failover-test-"));

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
  // 显式传链：降级链唯一真源是配置（kilo.json failover.chain.models），代码已无内置默认链
  failover: { chain: { models: ["kimi-k2.6", "deepseek-v4.1-flash", "glm-5.2"] } },
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

// ── 回归 1b：未配置 failover → 链 = 仅当前模型（代码无内置默认链，缺配置不猜）────────
const bare = createHxFailover({ name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch });
console.log("");
console.log("PASS no-config-single-model :", bare.languageModel("glm-5.3-flash").hxFailoverChain.length === 1);

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

// ── 回归 4：流中断重包装（2026-09-15 断流专项）────────────────────────────
// 生产事故形态：200 OK + SSE 中途断开 → provider-utils 把 body 读取错误包成
// APICallError{statusCode:200, isRetryable:false}（消费期从流上抛，不进 withFailover
// 的 catch）→ Kilo 自动重试门只认 isRetryable:true → 错误直达用户。
// 修复后：消费期断流错误必须被重包装为 isRetryable:true，且不触发 provider 内部重试
// （流已交给调用方，重放会重复输出；重试由 Kilo 会话级整条消息重跑接管）。
const APICALL_MARKER = Symbol.for("vercel.ai.error.AI_APICallError");

// 4a：模拟 socket 断开 —— body 流产出 2 个 chunk 后以 undici「terminated」形态报错。
// 注意必须异步 error：start() 里同步 error 会按规范丢弃已入队 chunk，模拟不出「部分输出后断流」
let fetchCount4 = 0;
const fakeFetch4 = async (url, init) => {
  fetchCount4++;
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] })}\n\n`));
      setTimeout(() => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] })}\n\n`));
        // undici 断流形态：TypeError "terminated"（cause ECONNRESET）
        controller.error(Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } }));
      }, 20);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p4 = createHxFailover({
  name: "hx",
  baseURL: "https://stub.local/v1",
  apiKey: "stub",
  fetch: fakeFetch4,
  // 链上只有主模型（explicit 空链），确保任何内部重试/换模型都无处可去，fetch 计数才可信
  failover: { chain: { models: [] } },
});
let breakError = null, breakText = "";
const keepAlive4 = setInterval(() => {}, 100);
try {
  const { stream } = await p4.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const part of stream) {
    if (part.type === "text-delta") breakText += part.delta ?? part.textDelta ?? "";
  }
} catch (e) { breakError = e; }
clearInterval(keepAlive4);
console.log("");
console.log("4a partial text before break:", JSON.stringify(breakText), "| fetch calls:", fetchCount4);
console.log("  error:", breakError?.name, "|", String(breakError?.message).slice(0, 90));
console.log("PASS break-marked-retryable :", Boolean(breakError) && breakError[APICALL_MARKER] === true && breakError.isRetryable === true);
console.log("PASS break-status-kept-200  :", breakError?.statusCode === 200);
console.log("PASS break-cause-preserved  :", String(breakError?.cause?.message ?? "").includes("Failed to process successful response") || String(breakError?.cause?.message ?? "").includes("terminated"));
console.log("PASS break-no-inner-retry   :", fetchCount4 === 1);
console.log("PASS break-after-partial    :", breakText === "Hello");

// 4b：消费期取消（用户停止）必须直通，绝不能被标记成可重试
let fetchCount4b = 0;
const fakeFetch4b = async (url, init) => {
  fetchCount4b++;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] })}\n\n`));
      controller.error(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p4b = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch4b,
  failover: { chain: { models: [] } },
});
let cancelErr = null;
try {
  const { stream } = await p4b.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const _ of stream) { /* 收到 1 chunk 后流报取消错 */ }
} catch (e) { cancelErr = e; }
console.log("");
console.log("PASS cancel-midstream-passthrough :", cancelErr?.name === "AbortError" && cancelErr?.isRetryable !== true);

// 4c：回归 3 的看门狗错误现在必须是可重试形态（挂死 → Kilo 自动重试接管，而非用户面前报错）
console.log("PASS watchdog-retryable     :", Boolean(wdError) && wdError[APICALL_MARKER] === true && wdError.isRetryable === true);

// ── 回归 5：thinking 模式 reasoning_content 回传兜底（2026-09-21 400 专项）───
// 背景：DeepSeek V4/Kimi K2.6/GLM-5.x/MiniMax thinking 模式要求历史 assistant 消息
// 回传 reasoning_content；Kilo 历史重放丢失该字段 → 工具循环续跑 400 直达用户
//（实证：kilo.db message.error 全部命中 deepseek-v4.1-flash，400 不重试不降级）。
// 修复：出站请求体给缺失该字段的 assistant 消息补空串；已有真实值不覆盖。
const capturedBodies = [];
const fakeFetch5 = async (url, init) => {
  capturedBodies.push(JSON.parse(init.body));
  const sse = [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

// 模拟 Kilo 历史重放形状：assistant 只有 tool-call（无 reasoning 块）→ 转换层不输出该字段
const replayPrompt = (withReasoning) => [
  { role: "user", content: [{ type: "text", text: "读文件" }] },
  { role: "assistant", content: withReasoning
    ? [{ type: "reasoning", text: "真实思考" }, { type: "tool-call", toolCallId: "c1", toolName: "t", input: {} }]
    : [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "text", value: "ok" } }] },
  { role: "user", content: [{ type: "text", text: "继续" }] },
];
const runCapture = async (provider, prompt) => {
  capturedBodies.length = 0;
  const { stream } = await provider.languageModel("glm-5.3-flash").doStream({
    prompt,
    includeRawChunks: false,
  });
  for await (const _ of stream) { /* 消费即弃 */ }
  return capturedBodies[0]?.messages ?? [];
};

// 5a：开启 → 缺失字段补空串（含 content:null + tool_calls 的真实故障形状）
const p5a = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch5,
  reasoningEcho: true, failover: { chain: { models: [] } },
});
const msgs5a = await runCapture(p5a, replayPrompt(false));
const asst5a = msgs5a.find((m) => m.role === "assistant");
console.log("");
console.log("PASS echo-on-fills-empty    :", asst5a?.reasoning_content === "");

// 5b：缺省（未配置）→ 不注入，行为零变化
const p5b = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch5,
  failover: { chain: { models: [] } },
});
const msgs5b = await runCapture(p5b, replayPrompt(false));
console.log("PASS echo-off-by-default    :", msgs5b.every((m) => !("reasoning_content" in m)));

// 5c：已有真实思考值不被覆盖（reasoning 块 → SDK 转换已有 reasoning_content）
const p5c = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch5,
  reasoningEcho: true, failover: { chain: { models: [] } },
});
const msgs5c = await runCapture(p5c, replayPrompt(true));
const asst5c = msgs5c.find((m) => m.role === "assistant");
console.log("PASS echo-preserves-real    :", asst5c?.reasoning_content === "真实思考");

// 5d：不可重试错误（reasoning_content 400 形态）原样直通但入遥测（此前完全无痕）
const fakeFetch5d = async () => new Response(
  JSON.stringify({ error: { message: "The `reasoning_content` in the thinking mode must be passed back to the API.", type: "invalid_request_error" } }),
  { status: 400, headers: { "content-type": "application/json" } },
);
const p5d = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch5d,
  failover: { chain: { models: [] } },
});
let err5d = null;
try {
  await p5d.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
} catch (e) { err5d = e; }
console.log("PASS fatal-passthrough      :", err5d?.statusCode === 400 && err5d?.isRetryable === false);
let fatalLine = null;
try {
  const log5d = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
  fatalLine = log5d.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.action === "fatal");
} catch { /* 无日志文件视为未写入 */ }
console.log("PASS fatal-logged           :", Boolean(fatalLine) && fatalLine.status === 400 && String(fatalLine.error ?? "").includes("reasoning_content"));

// 5e：扩展键剥除完整性（timeout/dual_review 不得流入 SDK settings —— createOpenAICompatible 只读已知键，
// 但留在 settings 里易被误当 SDK 能力排查；SDK 源码实证 createOpenAICompatible 仅解构已知键）
const p5e = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub",
  timeout: 120000, dual_review: { positive: "x", negative: "y", aggregator: "z" },
  reasoningEcho: true, failover: { chain: { models: [] } },
});
console.log("PASS strip-ext-keys         :", p5e !== null && typeof p5e.chatModel === "function");

// ── 回归 6：网关排队回执拦截（2026-09-24 queued-ack 专项）────────────────
// 生产形态（07:05 实证 ses_f2dc6e20affe）：上游过载时返回 200 + JSON
// {"request_id":"...","seq":1,"position":0,"phase":"queued"} 而非 SSE 流 →
// AI_TypeValidationError 绕过 withFailover catch 且 Kilo 重试门不认 → 直达用户。
// 修复：fetch 层拦截转 503（isRetryable → hop 内 retry + 降级链）。
const QUEUED_ACK = JSON.stringify({ request_id: "req-queued-1", seq: 1, position: 0, phase: "queued" });
const sseOk = (model) => [
  `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: `[ok ${model}]` }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
].join("");

// 6a：主模型连续排队 → 拦截转 503 → hop 内重试后仍排队 → 降级链切换到备用模型成功
let queuedCalls6a = [];
const queuedModels = new Set(["glm-5.3-flash", "glm-5.2"]);
const fakeFetch6a = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  queuedCalls6a.push(model);
  if (queuedModels.has(model)) {
    return new Response(QUEUED_ACK, { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p6a = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch6a,
  // 排队回执转 503 后走过载退避档（生产 2s/6s），注入小值保测试速度
  failover: { chain: { models: ["kimi-k2.6"] }, overloadBackoffMs: [50, 60] },
});
let out6a = "", err6a = null;
try {
  const { stream } = await p6a.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const part of stream) {
    if (part.type === "text-delta") out6a += part.delta ?? part.textDelta ?? "";
  }
} catch (e) { err6a = e; }
console.log("");
console.log("6a output:", JSON.stringify(out6a), "| fetch calls:", JSON.stringify(queuedCalls6a));
console.log("  error:", err6a?.name ?? "(none)");
console.log("PASS queued-ack-fallback    :", err6a === null && out6a.includes("[ok kimi-k2.6]"));
console.log("PASS queued-ack-retried     :", queuedCalls6a.filter((m) => m === "glm-5.3-flash").length === 3 && queuedCalls6a.includes("kimi-k2.6"));

// 6b：全链排队 → 耗尽后抛 APICallError{isRetryable:true}（Kilo 会话级重试兜底）
const p6b = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub",
  fetch: async () => new Response(QUEUED_ACK, { status: 200, headers: { "content-type": "application/json" } }),
  failover: { chain: { models: [] }, overloadBackoffMs: [50, 60] },
});
let err6b = null;
try {
  await p6b.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
} catch (e) { err6b = e; }
console.log("PASS queued-ack-exhausted   :", err6b?.statusCode === 503 && err6b?.isRetryable === true);

// 6c：正常补全 JSON（有 choices）与 SSE 不被误伤——只有 queued/pending 空回执才拦
let fetchCount6c = 0;
const fakeFetch6c = async (url, init) => {
  fetchCount6c++;
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p6c = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch6c,
  failover: { chain: { models: [] } },
});
let out6c = "", err6c = null;
try {
  const { stream } = await p6c.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const part of stream) {
    if (part.type === "text-delta") out6c += part.delta ?? part.textDelta ?? "";
  }
} catch (e) { err6c = e; }
console.log("PASS sse-unaffected         :", err6c === null && out6c.includes("[ok glm-5.3-flash]") && fetchCount6c === 1);

// 6d：拦截器对「choices 齐全的正常 JSON 响应」（doGenerate 路径）不误伤
const p6d = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub",
  fetch: async () => new Response(JSON.stringify({ id: "1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }),
  failover: { chain: { models: [] } },
});
let gen6d = null, err6d = null;
try {
  gen6d = await p6d.languageModel("glm-5.3-flash").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  });
} catch (e) { err6d = e; }
console.log("PASS completion-json-unaffected :", err6d === null && String(gen6d?.content?.[0]?.text ?? gen6d?.text ?? "").includes("hi"));

// ── 回归 7：过载感知退避（2026-09-24 Tool execution aborted 专项）────────────
// 生产形态（17:01:45 实证）：网关 CPU 99%+ 对所有模型回 503 system cpu overloaded；
// 旧固定 500/1500ms 快退避 = 对过载网关连环补刀（3 会话 × 4 模型 × 2 重试，~2.3s/轮）。
// 修复：过载类错误（503 / cpu overloaded / Retry-After）换长退避（生产 2000/6000，
// 对齐 lib/hx-client OVERLOAD_BACKOFF_MS），普通可重试错误维持快退避不变。
// 验证：注入 overloadBackoffMs [300,700] —— ① 950ms ≤ elapsed < 5000ms（过载档生效
// 且注入生效：回落生产值会 ~8000ms，未走慢档则遥测无标记）；② retry 遥测带 overload:true；
// ③ 调用次数仍为 3（1+2 重试，档位不改重试次数）。
let calls7 = [];
const fakeFetch7 = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls7.push(model);
  return new Response(
    JSON.stringify({ error: { message: "system cpu overloaded (current: 99.9%, threshold: 90%)" } }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
};
const p7 = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch7,
  failover: { chain: { models: [] }, overloadBackoffMs: [300, 700] },
});
let err7 = null;
const t7 = Date.now();
try {
  await p7.languageModel("overload-probe").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
} catch (e) { err7 = e; }
const elapsed7 = Date.now() - t7;
let retry7Overload = [];
try {
  const log7 = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
  retry7Overload = log7.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.action === "retry" && e.at === "overload-probe");
} catch { /* 无日志文件视为未写入 */ }
console.log("");
console.log("7 overload elapsed(ms):", elapsed7, "| calls:", calls7.join(", "), "| flagged retries:", retry7Overload.filter((e) => e.overload === true).length);
console.log("PASS overload-backoff-used  :", calls7.length === 3 && err7?.statusCode === 503 && elapsed7 >= 950 && elapsed7 < 5000);
console.log("PASS overload-flag-logged    :", retry7Overload.length === 2 && retry7Overload.every((e) => e.overload === true));

// 7b：普通 500 错误不走慢档——退避仍为 BACKOFF_MS（500/1500），遥测无 overload 标记。
// 用 500 而非 503：同链同重试次数，唯一差异就是档位与标记；耗时下界 500+1500=2000ms
// 不作断言（过慢），只断言遥测干净 + 重试次数不变。
let calls7b = [];
const fakeFetch7b = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls7b.push(model);
  return new Response(
    JSON.stringify({ error: { message: "simulated upstream 500" } }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
};
const p7b = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch7b,
  failover: { chain: { models: [] } },
});
let err7b = null;
try {
  await p7b.languageModel("nonoverload-probe").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
} catch (e) { err7b = e; }
let retry7bLines = [];
try {
  const log7b = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
  retry7bLines = log7b.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.action === "retry" && e.at === "nonoverload-probe");
} catch { /* 无日志文件视为未写入 */ }
console.log("PASS normal-backoff-kept     :", calls7b.length === 3 && err7b?.statusCode === 500 && retry7bLines.length === 2 && retry7bLines.every((e) => e.overload !== true));

// ── 回归 8：干净断连「无 finish_reason」形态（2026-09-26 专项）────────────────
// 生产形态（failover-events.jsonl 2026-09-25 16:30-18:32 实证）：429 限额风暴期
// 隧道/上游优雅关闭 SSE（FIN 非 RST）→ body 流正常 EOF，SDK flush 判定
// finishReason 未赋值 → 以 error part 入队 InvalidResponseDataError
// "Response stream ended without a finish reason."——不经 reader.read() 拒绝路径、
// 无 statusCode → 旧重包装拦不到、Kilo 重试门不认 → 直达用户。
// 修复：最外层重包装拦截该 error part → 重包装 isRetryable:true（Kilo 会话级重试接管）。
const NO_FINISH_MSG = "Response stream ended without a finish reason.";
// 8a：error part 形态 —— SSE 产出 1 个正文 chunk 后直接 EOF（无 finish_reason、无 [DONE]）
const fakeFetch8a = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  const sse = `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`;
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p8a = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch8a,
  failover: { chain: { models: [] } },
});
let err8a = null, text8a = "";
const keepAlive8 = setInterval(() => {}, 100);
try {
  const { stream } = await p8a.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const part of stream) {
    if (part.type === "text-delta") text8a += part.delta ?? part.textDelta ?? "";
  }
} catch (e) { err8a = e; }
clearInterval(keepAlive8);
console.log("");
console.log("8a partial text:", JSON.stringify(text8a), "| error:", err8a?.name, "|", String(err8a?.message ?? "").slice(0, 90));
console.log("PASS nofinish-errorpart-retryable :", Boolean(err8a) && err8a[APICALL_MARKER] === true && err8a.isRetryable === true);
console.log("PASS nofinish-cause-preserved     :", String(err8a?.cause?.message ?? "").includes(NO_FINISH_MSG));
console.log("PASS nofinish-after-partial       :", text8a === "partial");

// 8b：裸抛形态 —— 同一文案错误直接从流上抛（不经 error part 的变体路径）
const fakeFetch8b = async () => {
  const err = new Error(NO_FINISH_MSG);
  err.name = "AI_InvalidResponseDataError";
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
      setTimeout(() => controller.error(err), 20);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p8b = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch8b,
  failover: { chain: { models: [] } },
});
let err8b = null;
const keepAlive8b = setInterval(() => {}, 100);
try {
  const { stream } = await p8b.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const _ of stream) { /* 收到首 chunk 后流报错 */ }
} catch (e) { err8b = e; }
clearInterval(keepAlive8b);
console.log("");
console.log("8b error:", err8b?.name, "|", String(err8b?.message ?? "").slice(0, 90));
console.log("PASS nofinish-thrown-retryable    :", Boolean(err8b) && err8b[APICALL_MARKER] === true && err8b.isRetryable === true);

// 8c：遥测留痕（stream_break_rewrap + noFinishReason 标记，事后可从 jsonl 区分形态）
// 8a（error part）必须带 noFinishReason:true + viaErrorPart:true；
// 8b 的裸抛错误经 SDK wrapResponseBodyStream 先包成「Failed to process successful
// response」2xx APICallError（cause 才是原错误）——isStreamBreakError 主路径接管，
// noFinishReason:false 属预期（文案在 cause 层，不重复标记）。
let rewrap8 = [];
try {
  const log8 = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
  const parsed8 = log8.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.action === "stream_break_rewrap");
  rewrap8 = parsed8;
} catch { /* 无日志文件视为未写入 */ }
console.log("PASS nofinish-logged              :", rewrap8.some((e) => e.viaErrorPart === true && e.noFinishReason === true));

// 8d：误伤面检查——带 finish_reason 的正常流绝不被拦截（对照：同文案但不带该签名的错误不重包装）
const fakeFetch8d = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p8d = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch8d,
  failover: { chain: { models: [] } },
});
let out8d = "", err8d = null;
try {
  const { stream } = await p8d.languageModel("glm-5.3-flash").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  for await (const part of stream) {
    if (part.type === "text-delta") out8d += part.delta ?? part.textDelta ?? "";
  }
} catch (e) { err8d = e; }
console.log("PASS nofinish-normal-untouched    :", err8d === null && out8d.includes("[ok glm-5.3-flash]"));

// ── 回归 9：主模型冷却跳过（2026-09-26 体验专项）──────────────────────────
// 生产形态（failover-events.jsonl 21:51-21:53 实证）：主模型 glm-5.2 持续 503 期间，
// 每次调用都对已知故障主模型走 3 连重试+退避（~8s）才切到备用，且每条回复流首
// 重复同一条 ⚠️ [failover] 提示——体验差（用户原话「一直输出模型失败」）。
// 修复：① 冷却对全链生效——主模型上一轮刚降级过，本轮直接从首个未冷却备用起跑；
//      ② 切换通知去重——同一「主模型→备用」在 noticeCooldownMs 窗口内只注入一次；
//      ③ 全链冷却 → fail-fast 确定性 503（isRetryable，Kilo 重试门接管，冷却到期恢复）。
const gen9 = async (provider, model) => {
  const { stream } = await provider.languageModel(model).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  let out = "";
  for await (const part of stream) {
    if (part.type === "text-delta") out += part.delta ?? part.textDelta ?? "";
  }
  return out;
};

// 9a：主模型持续故障 → 第 1 轮全链重试后降级成功；第 2 轮直接跳过主模型（零 fetch）走备用
let calls9a = [];
const fakeFetch9a = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9a.push(model);
  if (model === "glm-5.3-flash") {
    return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9a = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9a,
  failover: { chain: { models: ["kimi-k2.6"] }, cooldownMs: 2000, noticeCooldownMs: 2000 },
});
const out9a1 = await gen9(p9a, "glm-5.3-flash"); // 第 1 轮：主模型 3 连失败 → 降级 kimi 成功
const c1 = calls9a.length; // 预期 4（glm×3 + kimi×1）
const out9a2 = await gen9(p9a, "glm-5.3-flash"); // 第 2 轮（冷却窗口内）：主模型被跳过
const c2 = calls9a.length; // 预期 5（只多了 kimi×1）
console.log("");
console.log("9a round1:", c1, "calls | round2:", c2, "calls");
console.log("PASS cooldown-skip-main       :", c1 === 4 && c2 === 5 && out9a2.includes("[ok kimi-k2.6]"));

// 9b：通知去重——第 1 轮切换有提示，冷却窗口内第 2 轮切换静默（无重复提示）
console.log("PASS notice-first-only        :", out9a1.includes("[failover]") && !out9a2.includes("[failover]"));

// 9c：冷却到期后主模型恢复探测（非永久跳过）
await new Promise((r) => setTimeout(r, 2100));
calls9a.length = 0;
const out9a3 = await gen9(p9a, "glm-5.3-flash");
console.log("9c after cooldown:", calls9a.join(", "));
console.log("PASS cooldown-expiry-retry    :", calls9a[0] === "glm-5.3-flash" && out9a3.includes("[ok kimi-k2.6]"));

// 9d：全链冷却 → fail-fast 确定性 503（不空转，fetch 零调用）
const fakeFetch9d = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
    status: 500, headers: { "content-type": "application/json" },
  });
};
const p9d2 = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9d,
  failover: { chain: { models: ["kimi-k2.6"] }, cooldownMs: 30000 },
});
let err9dWarm = null;
try { await gen9(p9d2, "glm-5.3-flash"); } catch (e) { err9dWarm = e; }
let err9d = null;
const t9d = Date.now();
try { await gen9(p9d2, "glm-5.3-flash"); } catch (e) { err9d = e; }
const elapsed9d = Date.now() - t9d;
console.log("");
console.log("9d warm-up error:", err9dWarm?.statusCode, "| fail-fast error:", err9d?.statusCode, "| elapsed:", elapsed9d, "ms");
console.log("PASS all-cooling-fail-fast    :", err9dWarm?.statusCode === 500 && err9d?.statusCode === 503 && err9d?.isRetryable === true && elapsed9d < 100);

// 9e：备用冷却跳过仍照常工作（既有语义），链上还有未冷却模型可达
const fakeFetch9e = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  if (model === "kimi-k2.6" || model === "glm-5.3-flash") {
    return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9e = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9e,
  failover: { chain: { models: ["glm-5.3-flash", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
await gen9(p9e, "kimi-k2.6"); // 第 1 轮：kimi×3 失败冷却 → glm×3 失败冷却 → deepseek 成功（此时 glm 未冷却所以被真试了 3 次）
const out9e = await gen9(p9e, "kimi-k2.6"); // 第 2 轮：kimi 失败×3 → glm 冷却被跳过 → deepseek 成功
console.log("");
console.log("9e output:", JSON.stringify(out9e));
console.log("PASS standby-cooldown-skip    :", out9e.includes("[ok deepseek-v4.1-flash]") && !out9e.includes("[failover]"));

// 9f：去重命中留遥测痕迹（notice_dedup）——静默切换不丢诊断
let dedup9f = [];
try {
  const log9f = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
  dedup9f = log9f.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.action === "notice_dedup" && e.from === "glm-5.3-flash" && e.to === "kimi-k2.6");
} catch { /* 无日志文件视为未写入 */ }
console.log("PASS notice-dedup-logged      :", dedup9f.length >= 1);

// 9g：单元素链豁免——主模型冷却时空链仍照常直连重试（唯一模型没有可跳去处，
// 跳过 = 零执行 = 误抛全冷却 503），与 Kilo 原生单模型行为一致
let calls9g = [];
const fakeFetch9g = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9g.push(model);
  return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
    status: 500, headers: { "content-type": "application/json" },
  });
};
const p9g = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9g,
  failover: { chain: { models: [] }, cooldownMs: 30000 },
});
await gen9(p9g, "solo-model").catch(() => {}); // 第 1 轮：3 连失败 → 冷却
calls9g.length = 0;
let err9g = null;
try { await gen9(p9g, "solo-model"); } catch (e) { err9g = e; }
console.log("");
console.log("9g attempts:", calls9g.join(", "), "| error:", err9g?.statusCode);
console.log("PASS single-model-exempt      :", calls9g.length === 3 && err9g?.statusCode === 500);

// ── 回归 9h：503 渠道/模型不可用（2026-09-27 查漏补缺）───────────────────────
// 生产实证（2026-09-27）：glm-5.2 渠道下线期上游统一报 503 model_not_found——
// 旧行为按可重试处理：每 hop 3 连重试空转 ~8s 才换链（且 trip 冷却 60s 连累健康渠道）。
// 新行为：isRetryable=false + isChannelUnavailable → 不重试立即换下一 hop（channel_fallback）；
// 全链渠道不可用 → 抛最后一个原始错误（不伪造全冷却 503）。
let calls9h = [];
const fakeFetch9h = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9h.push(model);
  if (model === "glm-5.2") {
    return new Response(JSON.stringify({ error: { code: "model_not_found", message: "No available channel for model glm-5.2 under group svip (distributor)" } }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9h = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9h,
  failover: { chain: { models: ["glm-5.3-flash", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
const t9h = Date.now();
const out9h = await gen9(p9h, "glm-5.2"); // 主模型渠道不可用 → 零重试直接换链（链 = 请求模型 + chain.models）
const elapsed9h = Date.now() - t9h;
console.log("");
console.log("9h attempts:", calls9h.join(", "), "| elapsed:", elapsed9h, "ms");
console.log("PASS channel-unavail-no-retry:", JSON.stringify(calls9h) === JSON.stringify(["glm-5.2", "glm-5.3-flash"]) && out9h.includes("[ok glm-5.3-flash]") && elapsed9h < 500);

// 9i：全链渠道不可用 → 快速失败抛最后原始错误（不空转、不触发全冷却 503 分支）
let calls9i = [];
const fakeFetch9i = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9h.push(model); calls9i.push(model);
  return new Response(JSON.stringify({ error: { code: "model_not_found", message: `No available channel for model ${model} under group svip (distributor)` } }), {
    status: 503, headers: { "content-type": "application/json" },
  });
};
const p9i = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9i,
  failover: { chain: { models: ["kimi-k2.6", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
const t9i = Date.now();
let err9i = null;
try { await gen9(p9i, "glm-5.3-flash"); } catch (e) { err9i = e; }
const elapsed9i = Date.now() - t9i;
console.log("9i attempts:", calls9i.join(", "), "| elapsed:", elapsed9i, "ms | err:", err9i?.statusCode);
console.log("PASS all-channel-unavail-fast :", calls9i.length === 3 && err9i?.statusCode === 503 && /No available channel/.test(String(err9i?.message ?? err9i)) && elapsed9i < 500);

// ── 回归 9j：404 NO_ROUTE_CANDIDATE 渠道不可用（2026-09-28 查漏补缺）──────────
// 生产实证（2026-09-28 07:29）：glm-5.3-flash 渠道下线期网关回
// 404 {"code":"NO_ROUTE_CANDIDATE","msg":"no active channel candidate for model (protocol=openai)"}
// ——旧行为：isChannelUnavailable 只认 503 → 404 走 fatal 直通，用户看到裸报错且
// 放弃整条链（本会话 07:29 实证 action=fatal 直接抛出）。
// 新行为：与 503 兄弟报文同语义——不重试立即换下一 hop（channel_fallback），全链不可用快速失败。
let calls9j = [];
const fakeFetch9j = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9j.push(model);
  if (model === "glm-5.3-flash") {
    return new Response(JSON.stringify({ error: { code: "NO_ROUTE_CANDIDATE", message: "no active channel candidate for model (protocol=openai)" } }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9j = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9j,
  failover: { chain: { models: ["kimi-k2.6", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
const t9j = Date.now();
const out9j = await gen9(p9j, "glm-5.3-flash"); // 主模型 404 渠道不可用 → 零重试直接换链
const elapsed9j = Date.now() - t9j;
console.log("");
console.log("9j attempts:", calls9j.join(", "), "| elapsed:", elapsed9j, "ms");
console.log("PASS route404-fallback-no-retry:", JSON.stringify(calls9j) === JSON.stringify(["glm-5.3-flash", "kimi-k2.6"]) && out9j.includes("[ok kimi-k2.6]") && elapsed9j < 500);

// 9k：404 但非渠道类报文（普通 Not Found）仍 fatal 直通——渠道不可用判定不得扩大化
let calls9k = [];
const fakeFetch9k = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9k.push(model);
  return new Response(JSON.stringify({ error: { message: "Not Found" } }), {
    status: 404, headers: { "content-type": "application/json" },
  });
};
const p9k = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9k,
  failover: { chain: { models: ["kimi-k2.6", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
let err9k = null;
const t9k = Date.now();
try { await gen9(p9k, "glm-5.3"); } catch (e) { err9k = e; }
const elapsed9k = Date.now() - t9k;
console.log("9k attempts:", calls9k.join(", "), "| elapsed:", elapsed9k, "ms | err:", err9k?.statusCode);
console.log("PASS plain404-still-fatal      :", calls9k.length === 1 && err9k?.statusCode === 404 && elapsed9k < 500);

// 9l：404 渠道不可用但 code 只在 body.code（message 为空）——共享提取必须从 data.code 命中
// （dual-review 必修项：code 不进 message 的形态不能漏判 → 仍应零重试换链）
let calls9l = [];
const fakeFetch9l = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9l.push(model);
  if (model === "glm-5.3-flash") {
    return new Response(JSON.stringify({ code: "NO_ROUTE_CANDIDATE", msg: "no active channel candidate for model (protocol=openai)", data: null }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9l = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9l,
  failover: { chain: { models: ["kimi-k2.6", "deepseek-v4.1-flash"] }, cooldownMs: 30000 },
});
const out9l = await gen9(p9l, "glm-5.3-flash");
console.log("9l attempts:", calls9l.join(", "));
console.log("PASS bodycode404-fallback     :", JSON.stringify(calls9l) === JSON.stringify(["glm-5.3-flash", "kimi-k2.6"]) && out9l.includes("[ok kimi-k2.6]"));

// 9m：404 渠道不可用会标记当前模型冷却（避免反复请求已知下线渠道），但只影响本模型、
// 不污染链上其他模型——第 2 轮应直接跳过冷却的主模型走备用（cooldown-skip 行为正确）。
let calls9m = [];
const fakeFetch9m = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9m.push(model);
  if (model === "glm-5.3-flash") {
    return new Response(JSON.stringify({ code: "NO_ROUTE_CANDIDATE", message: "no active channel candidate for model (protocol=openai)" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return new Response(sseOk(model), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const p9m = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9m,
  failover: { chain: { models: ["kimi-k2.6"] }, cooldownMs: 30000, noticeCooldownMs: 30000 },
});
await gen9(p9m, "glm-5.3-flash"); // 第 1 轮：404 → 标记冷却 → 换 kimi 成功
const callsAfterRound1 = calls9m.length;
const out9m = await gen9(p9m, "glm-5.3-flash"); // 第 2 轮：主模型冷却中 → skip_cooldown 直跳备用
console.log("9m round1 calls:", callsAfterRound1, "| round2:", calls9m.slice(callsAfterRound1).join(", "));
console.log("PASS route404-cools-self-only  :", callsAfterRound1 === 2 && out9m.includes("[ok kimi-k2.6]") && calls9m.slice(callsAfterRound1)[0] === "kimi-k2.6");

// 9n：全链冷却 fail-fast 503 附 retry-after（2026-09-29 dual_review 必修项⑥）——
// 生产遥测实证：冷却期 Kilo 会话级重试每 4-20s 重撞 fail-fast（exhausted_cooldown
// 一日 54 条）。修法：503 带 responseHeaders.retry-after=剩余秒数，守约下游按节奏退避。
// 断言：APICallError.responseHeaders 是 Record 且值 = 剩余冷却秒（1..30，fail-fast 立即返回远早于 30s 冷却到期）。
const fakeFetch9n = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
    status: 500, headers: { "content-type": "application/json" },
  });
};
const p9n = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9n,
  failover: { chain: { models: ["kimi-k2.6"] }, cooldownMs: 30000 },
});
await gen9(p9n, "glm-5.3-flash").catch(() => {}); // 预热：3 连失败 → 全链冷却
let err9n = null;
try { await gen9(p9n, "glm-5.3-flash"); } catch (e) { err9n = e; }
const raVal = err9n?.responseHeaders?.["retry-after"]; // SDK 契约：responseHeaders 是 Record（Object.fromEntries），非 Headers 实例
console.log("");
console.log("9n fail-fast:", err9n?.statusCode, "| retry-after:", raVal);
console.log("PASS cooldown503-retry-after  :", err9n?.statusCode === 503 && Number(raVal) >= 1 && Number(raVal) <= 30 && err9n?.isRetryable === true);

// 9o：退避期可被 abortSignal 立即打断（2026-09-29 dual_review 必修项⑤）——
// 旧行为：sleep(500/1500ms) 不感知 signal，用户取消后仍睡满全程才返回（迟滞+浪费）。
// 断言：失败模型每次调用后进入退避，主流程中途 abort；elapsed < 400ms（远小于
// 完整 500+1500 退避），错误为取消类（AbortError 直通不换模型）。
let calls9o = [];
const ctl9o = new AbortController();
const fakeFetch9o = async (url, init) => {
  let model = "?";
  try { model = JSON.parse(init.body).model; } catch {}
  calls9o.push(model);
  // 确定性触发（dual_review r2 必修项：固定 200ms setTimeout 依赖事件循环时序，
  // 首 fetch 未在窗内完成会 flaky）：abort 定时器在 fetch 已 resolve 后才注册——
  // 「第 1 次调用已失败 + 已进入 500ms 退避」必然成立，50ms << 退避 500ms。
  if (calls9o.length === 1) setTimeout(() => ctl9o.abort(), 50);
  return new Response(JSON.stringify({ error: { message: "simulated upstream 500" } }), {
    status: 500, headers: { "content-type": "application/json" },
  });
};
const p9o = createHxFailover({
  name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch9o,
  failover: { chain: { models: [] }, cooldownMs: 30000 },
});
const t9o = Date.now();
let err9o = null;
try {
  await p9o.languageModel("solo-model").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
    abortSignal: ctl9o.signal,
  });
} catch (e) { err9o = e; }
const elapsed9o = Date.now() - t9o;
console.log("9o attempts:", calls9o.join(", "), "| elapsed:", elapsed9o, "ms | err:", err9o?.name ?? err9o?.message);
// 期望：1 次调用后进入 500ms 退避，50ms（自 fetch resolve 起）时 abort 打断；
// 取消类错误直通（isCancellation），不再重试/换模型 → attempts 恒 1、
// elapsed < 400ms 证立即性（无修复时睡满 500+1500 退避 ≥2s）。
console.log("PASS backoff-abort-immediate   :", calls9o.length === 1 && elapsed9o < 400 && (err9o?.name === "AbortError" || err9o?.code === "ABORT_ERR"));
