// 推理门控（reasoningGate）回归：假 fetch 注入死亡/成功响应，驱动真实 dist 代码路径。
// 覆盖：死亡→重试→救活（SSE 与非流式）、重试耗尽原样透传、门控关闭零接触、
//       扣留超时转直通、tool_calls 可行动、reasoningEcho 组合、重试 body 修补正确性、
//       finish=stop 空正文（空摘要压缩事故形态）救援/透传/不误伤；
//       v2（2026-09-29 工具调用原子化+截断死亡重试）：工具参数中途断流原子重试、
//       完整工具流 held-to-completion 回放、finish=length 截断参数缺口 B 重试、
//       纯文本流式保留、toolHold 慢滴/超限弃流重试（必修项①）、toolHold 期取消
//       直通、空数组不锁死、签名跨 chunk 切分累积匹配（必修项②）。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

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

// 从流 parts 中提取首个 tool-call 的 input（SDK 形态：{type:"tool-call", input:{}}）；
// 测试用：断言工具参数完整到达、未被截断。
function toolInputOf(parts) {
  const tc = parts.find((p) => p.type === "tool-call");
  if (!tc) return null;
  if (tc.input && typeof tc.input === "object") return tc.input;
  try { return JSON.parse(tc.input ?? "{}"); } catch { return null; }
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

// ── 10.（T1）工具参数中途断流 → fetch 层整体 reject → withFailover 静默重试零重复 ──
// 原子化核心价值：toolHold 期断流发生在 fetch 层（半截参数从未交付调用方），
// 错误上抛被 withFailover 视为可重试 → 整条重跑。对照 v1 缺陷形态：tool_calls
// 一出现即放行，半截 tool-call part 已推给 SDK，流消费期断错只能重包装上抛
// （fetch 不重试、参数残缺）。断言 call===2 即证明 fetch 层 reject + 静默重试。
{
  let call = 0;
  const fullArgs = { path: "C:/repo/index.js", mode: "read" };
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先规划再动手" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"C:/rep" } }] } }] })}\n\n`));
          // 工具参数中途断（隧道掐流形态）：read 挂起期 error → gateConsume 上抛
          setTimeout(() => {
            controller.error(Object.assign(new Error("aborted prematurely"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
          }, 20);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先规划再动手" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 64 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "读文件" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const toolCalls = parts.filter((p) => p.type === "tool-call");
  const input = toolInputOf(toolCalls);
  check("midargs-break-retried :", call === 2);
  check("midargs-break-atomic  :", toolCalls.length === 1 && input !== null && input.path === fullArgs.path && input.mode === fullArgs.mode);
}

// ── 11.（T2）完整工具流 → held-to-completion 回放：缓冲与剩余字节零丢失 ──────
// toolHold 扣留到流尾后整包回放：reasoning（进入 toolHold 前的缓冲）、tool_calls
// 起始、参数增量、finish 全部到达；任一 chunk 丢失都会表现为 tool-call 残缺/缺失。
{
  let call = 0;
  const fullArgs = { cmd: "git", args: ["status", "--porcelain"] };
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "规划中" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t2", type: "function", function: { name: "run_cmd", arguments: "" } }] } }] })}\n\n`));
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 48 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }, 30);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "跑命令" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const input = toolInputOf(parts);
  const reasoningKept = parts.some((p) => String(p.type).includes("reasoning") && JSON.stringify(p).includes("规划中"));
  check("tool-hold-full-replay:", call === 1 && input !== null && input.cmd === "git" && Array.isArray(input.args) && input.args[0] === "status" && reasoningKept);
}

// ── 12.（T3）finish=length 截断工具参数 → 缺口 B 重试（reason=truncated_tool_args）──
// 首跳：tool_calls 签名在 + finish=length（参数半截、无 [DONE] 后续）→ mkRetry
// 扩预算+降档重发；重试响应完整 → 交付重试响应。遥测 reason 字段区分于缺口 A。
{
  const bodies = [];
  let call = 0;
  const fullArgs = { query: "SELECT 1", limit: 10 };
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call++;
    if (call === 1) {
      const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先查库" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t3", type: "function", function: { name: "sql", arguments: "{\"query\":\"SEL" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { completion_tokens: 2048 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t3", type: "function", function: { name: "sql", arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 32 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "查一下" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const input = toolInputOf(parts);
  check("trunc-toolargs-retry  :", call === 2 && input !== null && input.query === "SELECT 1" && input.limit === 10);
  // SDK 原始 body 不带 max_tokens/effort（harness 限制）→ 重试注入下限 32768 + effort=low
  check("trunc-toolargs-body    :", bodies[0].max_tokens === undefined && bodies[1].max_tokens === 32768 && bodies[1].reasoning_effort === "low");
  let reasonRec = null;
  try {
    const log = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
    reasonRec = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.action === "reasoning_gate_retry" && e.reason === "truncated_tool_args");
  } catch { /* 无日志文件视为未写入 */ }
  check("trunc-toolargs-logged  :", Boolean(reasonRec));
}

// ── 13.（T4）纯文本流 → 首个 content chunk 即放行（流式 UX 保留）────────────
// 上游在首 content chunk 后拖延 400ms 才收尾；门控必须在 content 出现时立刻返回
// （首个 text-delta 早于上游 EOF），且迟到的尾段字节经直通接管零丢失。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "FirstBytes" } }] })}\n\n`));
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "+Tail" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 9 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }, 400);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const t0 = Date.now();
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  let firstDeltaMs = null;
  let text = "";
  for await (const p of stream) {
    if (p.type === "text-delta") {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
      text += p.delta ?? p.textDelta ?? "";
    }
  }
  check("text-stream-kept       :", call === 1 && firstDeltaMs !== null && firstDeltaMs < 250 && text === "FirstBytes+Tail");
}

// ── 14.（T5）慢滴工具流（chunk 间隔 > toolHoldMs）→ 弃流抛可重试错误 → 整体重试 ──
// 2026-09-29 dual-review 必修项①语义：toolHold 期缓冲含半截工具参数，直通=交付
// 残缺件（正是 abort 根因）。inter-chunk 超时改弃流——chunk2 迟到 150ms 到达时
// 判超时 → rejectToolHold 抛 2xx 可重试错 → withFailover 静默整体重试（零交付，
// 零重复）→ 第二跳完整参数到达。
{
  let call = 0;
  const fullArgs = { file: "a.txt", enc: "utf8" };
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t5", type: "function", function: { name: "read", arguments: "" } }] } }] })}\n\n`));
          // 慢滴：第二 chunk 150ms 才到（toolHoldMs=40），到达时 inter-chunk 超时
          setTimeout(() => {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`));
          }, 150);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "重试后完整生成" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t5", type: "function", function: { name: "read", arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 20 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: { toolHoldMs: 40 },
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "读配置" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const toolCalls = parts.filter((p) => p.type === "tool-call");
  const input = toolInputOf(parts);
  check("toolhold-drip-retry   :", call === 2 && toolCalls.length === 1 && input !== null && input.file === "a.txt" && input.enc === "utf8");
}

// ── 15.（T6）toolHold 期取消（AbortError）→ 原样直通抛出，上游只调 1 次 ─────
// 取消不容错不变式：调用方取消绝不是上游故障，不重试、不降级（isCancellation 直通）。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t6", type: "function", function: { name: "x", arguments: "" } }] } }] })}\n\n`));
        setTimeout(() => controller.error(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })), 20);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  let err = null;
  try {
    await provider.languageModel("glm-5.2").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      includeRawChunks: false,
    });
  } catch (e) { err = e; }
  check("toolhold-abort-direct  :", err?.name === "AbortError" && call === 1);
}

// ── 16.（T7）"tool_calls": [] 空数组 → 不进 toolHold，按文本放行（正则防御）──
// GATE_TOOL 要求 [ 后跟 {：空数组不命中 → 不原子化锁死；后续 content 走 GATE_TEXT
// 立即放行（首个 delta 早于 400ms 后的上游 EOF）。若误入 toolHold，整条流要扣到
// 流尾才可见 → 首达时间 ≥400ms，本断言即失败。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [] } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "[after-empty]" } }] })}\n\n`));
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 5 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }, 400);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const t0 = Date.now();
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  let firstDeltaMs = null;
  let text = "";
  for await (const p of stream) {
    if (p.type === "text-delta") {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
      text += p.delta ?? p.textDelta ?? "";
    }
  }
  check("empty-tool-array-pass  :", call === 1 && firstDeltaMs !== null && firstDeltaMs < 250 && text.includes("[after-empty]"));
}

// ── 17.（T8）tool_calls 签名跨 chunk 切分 + 参数中途断流 → 累积匹配 + 原子重试 ──
// dual-review 必修项②（经核实实现已对累积 text 匹配，本用例锁死该不变式）：
// 签名劈在 "tool_calls": 与 [{ 之间——若退化为逐 chunk 匹配，第三片（参数 delta，
// 自带 "tool_calls":[ 键）会触发 v1 提前放行 → 断流落在流消费期 → 半截参数交付。
// 正确形态：累积匹配在第二片命中进入 toolHold → 断流在 fetch 层 reject → 静默重试。
{
  let call = 0;
  const fullArgs = { src: "lib/util.ts", line: 42 };
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const sig = JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t8", type: "function", function: { name: "read_line", arguments: "" } }] } }] });
          const key = '"tool_calls":';
          const cut = sig.indexOf(key) + key.length; // 第一片终于冒号，[{ 落第二片
          controller.enqueue(enc.encode(`data: ${sig.slice(0, cut)}\n\n`));
          controller.enqueue(enc.encode(`data: ${sig.slice(cut)}\n\n`));
          // 参数 delta（若 gate 退化成逐 chunk 匹配，此片会命中 v1 放行条件）
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"src":"lib/ut' } }] } }] })}\n\n`));
          // 参数中途断（隧道掐流形态）：toolHold 期 fetch 层 reject
          setTimeout(() => {
            controller.error(Object.assign(new Error("tunnel cut mid-args"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
          }, 20);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "重试后完整" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t8", type: "function", function: { name: "read_line", arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 28 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "读行" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const toolCalls = parts.filter((p) => p.type === "tool-call");
  const input = toolInputOf(parts);
  check("cross-chunk-atomic    :", call === 2 && toolCalls.length === 1 && input !== null && input.src === fullArgs.src && input.line === fullArgs.line);
}

// ── 18.（T9）toolHold 期缓冲字节超限 → 弃流重试（必修项①：直通=交付半截参数）──
// 签名命中进 toolHold 后灌超 bufferLimitBytes：弃流抛可重试错 → 第二跳完整到达；
// 第一跳半截参数零交付（toolCalls 仅 1 个且来自第二跳）。
{
  let call = 0;
  const fullArgs = { path: "src/big.ts", range: [1, 200] };
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "长思考" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t9", type: "function", function: { name: "read_file", arguments: "" } }] } }] })}\n\n`));
          // 超限巨参数（bufferLimitBytes=512）：toolHold 期字节上限触发弃流
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "x".repeat(800) } }] } }] })}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t9", type: "function", function: { name: "read_file", arguments: JSON.stringify(fullArgs) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 36 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: { bufferLimitBytes: 512 },
  });
  const { stream } = await provider.languageModel("glm-5.2").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "读大文件" }] }],
    includeRawChunks: false,
  });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const toolCalls = parts.filter((p) => p.type === "tool-call");
  const input = toolInputOf(parts);
  check("toolhold-limit-retry   :", call === 2 && toolCalls.length === 1 && input !== null && input.path === "src/big.ts");
}

const failed = results.filter(([, ok]) => !ok);
console.log("");
console.log(failed.length === 0 ? `ALL ${results.length} PASS` : `${failed.length} FAILED: ${failed.map(([n]) => n).join(", ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
