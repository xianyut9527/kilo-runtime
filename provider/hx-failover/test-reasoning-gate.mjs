// 推理门控（reasoningGate）回归：假 fetch 注入死亡/成功响应，驱动真实 dist 代码路径。
// 覆盖：死亡→重试→救活（SSE 与非流式）、重试耗尽原样透传、门控关闭零接触、
//       扣留超时转直通、tool_calls 可行动、reasoningEcho 组合、重试 body 修补正确性、
//       finish=stop 空正文（空摘要压缩事故形态）救援/透传/不误伤。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "hx-gate-test-"));

const { createHxFailover } = await import(new URL("./dist/index.js", import.meta.url).href);

const results = [];
function check(name, ok) {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

function sseDeath() {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考很长但没写答案" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { completion_tokens: 2048 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
function sseOk(marker) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: marker } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 9 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

async function consume(stream) {
  let text = "";
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.delta ?? part.textDelta ?? "";
  }
  return text;
}

// ── 1. SSE 死亡 → 自动重试（扩预算+降档）→ 第二次成功 ─────────────────────
// 假 fetch 先给首跳 body 补上 kilo 真实形态的 max_tokens/reasoning_effort
// （测试 harness 的 callOptions 不带这些字段，SDK 不会发送）
{
  const bodies = [];
  let call = 0;
  const fakeFetch = async (url, init) => {
    let b = JSON.parse(init.body);
    if (call === 0) b = { ...b, max_tokens: 2048, reasoning_effort: "max" };
    bodies.push(b);
    call++;
    const body = call === 1 ? sseDeath() : sseOk("[rescued]");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("sse-death-rescued      :", text.includes("[rescued]"));
  check("retry-count-2          :", call === 2);
  check("retry-boosted-tokens   :", bodies[1].max_tokens === 32768 && bodies[0].max_tokens === 2048);
  // 注：fake fetch 给首跳 body 补的字段只影响「上游可见」，门控修补的是 SDK 原始 body
  // （不含 effort）→ 重试 effort 走缺省梯级 'low'；max→high 梯级由 llamas-api 侧
  // 同源实现的单测覆盖（test/reasoning-gate.spec.ts patchBodyForDeathRetry 用例）。
  check("retry-effort-defaulted  :", bodies[1].reasoning_effort === "low" && bodies[0].reasoning_effort === "max");
}

// ── 2. 重试后仍死 → 原样透传死亡流（无正文、无错误，与不启用门控一致）────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    return new Response(sseDeath(), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("exhausted-passthrough   :", call === 2 && text === "");
}

// ── 3. 门控关闭 → 单次调用零接触 ─────────────────────────────────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    return new Response(sseDeath(), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } },
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("gate-off-single-call    :", call === 1 && text === "");
}

// ── 4. 扣留超时 → 放弃门控转直通（迟到的 content 照常到达，不重试）──────────
// chunk 时间线：思考#1@0ms（未超时）→ 思考#2@120ms（已过 holdMs=50 → 触发直通）
// → content@240ms 必须经直通接管到达（修复前该路径只回放缓冲后 close，丢剩余流）
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考开始" } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, 120));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "还在思考" } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, 120));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "[late-content]" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: { holdMs: 50 },
  });
  const { stream } = await provider.languageModel("glm-5.3").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("hold-timeout-passthrough:", call === 1 && text.includes("[late-content]"));
}

// ── 4b. 缓冲字节上限 → 超限放弃门控转直通（内存防护，字节零丢失）────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        // 三个 2KB 思考 chunk（bufferLimitBytes=2048 → 第 2 个 chunk 后即超限）
        for (let i = 0; i < 3; i++) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "x".repeat(2000) } }] })}\n\n`));
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "[after-cap]" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: { bufferLimitBytes: 2048 },
  });
  const { stream } = await provider.languageModel("glm-5.3").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("buffer-cap-passthrough  :", call === 1 && text.includes("[after-cap]"));
}

// ── 5. tool_calls 是可行动输出：直接放行，不扣留到流尾 ────────────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "规划中" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t1", function: { name: "run" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.3").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  check("tool-calls-released     :", call === 1 && parts.some((p) => p.type === "tool-input-start" || p.type === "tool-call" || p.type === "tool-call-delta" || JSON.stringify(p).includes("run")));
}

// ── 6. reasoningEcho + gate 组合：重发体保留 assistant reasoning_content 补丁──
{
  const bodies = [];
  let call = 0;
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call++;
    return new Response(call === 1 ? sseDeath() : sseOk("[echo-rescued]"), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningEcho: true, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "c" }] },
    ],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  const echoOk = bodies.every((b) => b.messages.every((m) => m.role !== "assistant" || typeof m.reasoning_content === "string"));
  check("echo-composition        :", text.includes("[echo-rescued]") && echoOk && call === 2);
}

// ── 7. 非流式（doGenerate）死亡 → 重试 → 成功 ────────────────────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const payload = call === 1
      ? { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "想满预算" } }], usage: { completion_tokens: 2048 } }
      : { choices: [{ finish_reason: "stop", message: { content: "[json-rescued]" } }], usage: { completion_tokens: 5 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const result = await provider.languageModel("deepseek-v4.1-flash").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  });
  check("nostream-death-rescued  :", call === 2 && result.content.some((c) => c.type === "text" && c.text.includes("[json-rescued]")));
}

// ── 8. 请求体未带 max_tokens/effort（SDK 省字段形态）→ 重试注入预算下限 + effort=low ──
{
  const bodies = [];
  let call = 0;
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call++;
    return new Response(call === 1 ? sseDeath() : sseOk("[injected]"), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("absent-fields-injected   :", text.includes("[injected]") && bodies[1].max_tokens === 32768 && bodies[1].reasoning_effort === "low" && bodies[0].max_tokens === undefined);
}

// ── 9. finish=stop + 正文全空（2026-09-24 空摘要压缩事故形态）→ 同样触发重试──
// 复刻生产死亡形态：摘要全文写进 reasoning_content、content 空、finish_reason=stop。
// 修复前 GATE_LENGTH_FINISH 只认 length，此形态直通成空回复（Kilo 报 empty summary）。
function sseStopDeath() {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "## Objective - 全部摘要都写进了思考通道" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1743 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
{
  let call = 0;
  const bodies = [];
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call++;
    const body = call === 1 ? sseStopDeath() : sseOk("[stop-rescued]");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("stop-death-rescued     :", text.includes("[stop-rescued]") && call === 2 && bodies[1].max_tokens === 32768);
}

// ── 9b. stop 死亡重试后仍死 → 原样回放（两次都空，不无限重试）────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    return new Response(sseStopDeath(), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("kimi-k2.6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("stop-exhausted-passthru :", call === 2 && text === "");
}

// ── 9c. stop + 有正文 → 正常流，绝不重试（防误伤回归锚）───────────────────
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    return new Response(sseOk("[normal-stop]"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.3").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const text = await consume(stream);
  check("normal-stop-no-retry     :", call === 1 && text.includes("[normal-stop]"));
}

const failed = results.filter(([, ok]) => !ok);
console.log("");
console.log(failed.length === 0 ? `ALL ${results.length} PASS` : `${failed.length} FAILED: ${failed.map(([n]) => n).join(", ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
