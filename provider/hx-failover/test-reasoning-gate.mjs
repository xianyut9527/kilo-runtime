// 推理门控（reasoningGate）回归：假 fetch 注入死亡/成功响应，驱动真实 dist 代码路径。
// 覆盖：死亡→重试→救活（SSE 与非流式）、重试耗尽原样透传、门控关闭零接触、
//       扣留超时转直通、tool_calls 可行动、reasoningEcho 组合、重试 body 修补正确性、
//       finish=stop 空正文（空摘要压缩事故形态）救援/透传/不误伤；
//       v2（2026-09-29 工具调用原子化+截断死亡重试）：工具参数中途断流原子重试、
//       完整工具流 held-to-completion 回放、finish=length 截断参数缺口 B 重试、
//       纯文本流式保留、toolHold 慢滴/超限弃流重试（必修项①）、toolHold 期取消
//       直通、空数组不锁死、签名跨 chunk 切分累积匹配（必修项②）。
//       v3 审计加固（2026-10-08）：取消后零多余上游请求（cancel 护栏）、正文已透传
//       时缺口 B 禁用（正文零重复）、toolHold reject 终态可重试形态锁定（P1）。
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

// ── 19.（T10）死亡重试 fetch 期间用户取消 → AbortError 直通，不得吞掉后回放死亡流 ──
// 2026-09-29 查漏补缺：旧 catch { next = null } 无差别吞掉 mkRetry 的一切错误——
// 用户取消（AbortError）也被当网络错，转而回放原始死亡流（空正文响应），
// 违反取消不容错不变式。修复后取消必须原样上抛。
// 形态：首跳死亡流（finish=length 无正文）→ 门控进死亡重试 → 第二跳 fetch 抛
// name=AbortError →（修复）gateConsume 直抛 → withFailover isCancellation 直通。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      return new Response(sseDeath(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    // 第二跳 = 门控死亡重试：模拟用户此刻取消（undici 同形态 AbortError）
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  let err = null;
  try {
    const { stream } = await provider.languageModel("kimi-k2.6").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      includeRawChunks: false,
    });
    await consume(stream); // 旧行为在此拿到空正文流不报错——修复后到不了这里
  } catch (e) { err = e; }
  check("gate-retry-abort-throw :", call === 2 && err !== null && err?.name === "AbortError");
}

// ── 20.（2026-10-01 查漏补缺）gate_release 终局遥测：每个终端出口必须留痕 ──
// 事故取证缺口：本次 180s 幽灵中止链路上门控出口无任何遥测（Aborted 无 gate_release），
// 事后无法从 failover-events.jsonl 判定流是被哪条路径放掉的。断言：
//   20a 正常文本流 → reason=text_released；
//   20b 死亡流 retries 耗尽回放 → reason=stream_end_release + finishReason=length。
{
  const fakeFetch20 = async () =>
    new Response(sseOk("[tele-ok]"), { status: 200, headers: { "content-type": "text/event-stream" } });
  const provider20a = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch20,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream: s20a } = await provider20a.languageModel("gate-tele-text").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  const t20a = await consume(s20a);

  const fakeFetch20b = async () =>
    new Response(sseDeath(), { status: 200, headers: { "content-type": "text/event-stream" } });
  const provider20b = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "stub", fetch: fakeFetch20b,
    failover: { chain: { models: [] } }, reasoningGate: { retries: 0 },
  });
  const { stream: s20b } = await provider20b.languageModel("gate-tele-dead").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  await consume(s20b);

  // logFailover 是链式异步落盘，等队列排空再读（同文件 5d/7b 的既有节奏）
  await new Promise((r) => setTimeout(r, 250));
  const ev20 = (await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.action === "gate_release");
  check("gate-tele-text-released  :", t20a.includes("[tele-ok]")
    && ev20.some((r) => r.from === "gate-tele-text" && r.reason === "text_released"));
  check("gate-tele-stream-end     :", ev20.some((r) => r.from === "gate-tele-dead"
    && r.reason === "stream_end_release" && r.finishReason === "length"));
}

// ── 21.（v3 死寂专项）reasoning 首 delta 提前可见：全工具回合不再扣留到流尾 ──
// 病灶形态（48h 遥测 67% 步骤）：reasoning 慢滴 → tool_calls → finish；v2 把整条流
// 扣到源尾，UI 首反馈 p50=19s/p90=103s。断言：首个 reasoning 相关 part（reasoning-
// start/delta 或 raw）在 tool_calls 帧（+150ms）与 [DONE]（+650ms）之前到达。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一步" } }] })}\n\n`));
        }, 30);
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t21", type: "function", function: { name: "run", arguments: "" } }] } }] })}\n\n`));
          setTimeout(() => {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ cmd: "dir" }) } }] } }] })}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          }, 150);
        }, 60);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "x", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const t0 = Date.now();
  const { stream } = await provider.languageModel("relay-latency").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: true,
  });
  let reasoningMs = null;
  let firstToolMs = null;
  let doneMs = null;
  let toolInput = null;
  const parts = [];
  for await (const p of stream) {
    parts.push(p);
    const ms = Date.now() - t0;
    const s = JSON.stringify(p);
    if (reasoningMs === null && (s.includes("reasoning") || s.includes("想一步"))) reasoningMs = ms;
    if (firstToolMs === null && (p.type === "tool-input-start" || p.type === "tool-call" || s.includes('"run"'))) firstToolMs = ms;
    if (p.type === "tool-call" && toolInput === null) toolInput = toolInputOf([p]);
    if (p.type.startsWith("finish") || p.type === "finish") doneMs = ms;
  }
  check("relay-reasoning-early   :", call === 1 && reasoningMs !== null && reasoningMs < 200 && (firstToolMs === null || firstToolMs > (reasoningMs ?? 1e9)));
  check("relay-tool-atomic       :", toolInput !== null && toolInput.cmd === "dir");
  check("relay-finish-after-tool :", firstToolMs !== null && doneMs !== null && doneMs >= firstToolMs);
  check("relay-reasoning-before-tool :", reasoningMs !== null && firstToolMs !== null && reasoningMs < firstToolMs);
  // 21b. 首个 part 时间：reasoning 可见时间必须显著早于流 EOF（650ms）——死寂消灭的直接断言
  check("relay-no-dead-silence   :", reasoningMs < 650);
}

// ── 22. relay 断流续试（原体重发）：reasoning 透传期 break → mkRetryRaw → 零重复 ──
// 与 T1（toolHold 期断流）对照：relay 观察态断流时 reasoning 字节已交付调用方，
// 无法整流重放——但重试只走原体（不补丁：补丁体会改变输出预算，两跳拼不出连续
// 流）。断言第二跳帧接在同一 stream 上且 SDK 正常收尾。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一半" } }] })}\n\n`));
          setTimeout(() => controller.error(Object.assign(new Error("tunnel cut mid-reasoning"), { code: "ERR_STREAM_PREMATURE_CLOSE" })), 20);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "续上" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "[raw-resumed]" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 8 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "x", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("relay-raw-retry").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: true,
  });
  const reasoningParts = [];
  let text = "";
  for await (const p of stream) {
    const s = JSON.stringify(p);
    if (s.includes("reasoning")) reasoningParts.push(s);
    if (p.type === "text-delta") text += p.delta ?? p.textDelta ?? "";
  }
  check("raw-retry-reasoning-kept:", call === 2 && reasoningMsHas(reasoningParts, "想一半") && reasoningMsHas(reasoningParts, "续上") && text.includes("[raw-resumed]"));
  let rawRec = null;
  try {
    const log = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
    rawRec = log.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .find((e) => e.action === "reasoning_gate_retry" && String(e.reason ?? "").startsWith("raw_"));
  } catch { /* 无日志文件视为未写入 */ }
  check("raw-retry-logged        :", rawRec !== null);
}
function reasoningMsHas(parts, s) {
  return parts.some((p) => p.includes(s));
}

// ── 23.（v3 审计加固）relay 取消护栏：cancel 后不再发起多余上游请求 ─────────
// 病灶（审计发现）：cancel() 后 pending read 以 done 返回，泵仍进流尾死亡判定 →
// 缺口 A splice 在已取消的流上再发一次上游请求（换源后无人 cancel 泄漏连接）。
// 断言：消费首 part 后取消，上游只调 1 次、fixture 侧 cancel 级联到达。
{
  let call = 0;
  let cancelled = false;
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一半" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          // 不 close：模拟挂尾流，等调用方取消
        },
        cancel() { cancelled = true; },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(sseOk("[should-not-refetch]"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "x", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("relay-cancel").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: true,
  });
  const reader = stream.getReader();
  const first = await reader.read();
  await new Promise((r) => setTimeout(r, 120));
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 200));
  check("relay-cancel-no-refetch :", !first.done && call === 1 && cancelled === true);
}

// ── 24.（v3 审计加固）relay 正文粘滞：content 已透传时缺口 B 禁用（零重复）────
// 病灶（审计发现）：reasoning 透传后正文也已观察放行，随后 tool_calls 截断 +
// finish=length → 旧缺口 B 补丁重试 → 第二跳 content 拼接成可见重复正文。
// 断言：正文只出现一次、上游只调 1 次（缺口 B 被 contentDelivered 粘滞禁用，
// 终局回退 publishHoldBag 原样回放）。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    if (call === 1) {
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一半" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "[dup-marker]" } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t24", type: "function", function: { name: "run", arguments: "{\"cmd\":\"di" } }] } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(sseOk("[dup-marker]"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "x", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: true,
  });
  const { stream } = await provider.languageModel("relay-content").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  });
  let text = "";
  try {
    for await (const p of stream) {
      if (p.type === "text-delta") text += p.delta ?? p.textDelta ?? "";
    }
  } catch { /* 回放半截工具帧的 SDK 侧错误不影响文本断言 */ }
  const dup = text.split("[dup-marker]").length - 1;
  check("relay-content-no-dup    :", call === 1 && dup === 1);
}

// ── 25.（P1 锁定）relay toolHold reject 终态：经 SDK 包装仍为可重试 APICallError ──
// 审计判读（2026-10-08）：泵内 fail(e)（plain Error + statusCode=200 +
// gateToolHoldReject）→ SDK wrapResponseBodyStream 包装为 APICallError{200,
// "Failed to process successful response"} → isStreamBreakError 2xx 分支命中 →
// rewrapStreamBreak 显式 isRetryable:true → Kilo 会话级重试门放行。本用例把该
// 链路锁死（旧 dist 同路径，非红绿对照；retries:0 直接走 reject 终态）。
{
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一半" } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t25", type: "function", function: { name: "run", arguments: "" } }] } }] })}\n\n`));
        setTimeout(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"cmd\":\"di" } }] } }] })}\n\n`));
        }, 150);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createHxFailover({
    name: "hx", baseURL: "https://stub.local/v1", apiKey: "x", fetch: fakeFetch,
    failover: { chain: { models: [] } }, reasoningGate: { toolHoldMs: 40, retries: 0 },
  });
  let err = null;
  try {
    const { stream } = await provider.languageModel("relay-reject").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      includeRawChunks: false,
    });
    for await (const p of stream) { /* 排空到错误 */ }
  } catch (e) { err = e; }
  let gate = false;
  for (let c = err, i = 0; c && i < 6; c = c.cause, i++) if (c.gateToolHoldReject) { gate = true; break; }
  check("relay-reject-retryable :", err !== null && err.isRetryable === true && call === 1 && gate);
}

const failed = results.filter(([, ok]) => !ok);
console.log("");
console.log(failed.length === 0 ? `ALL ${results.length} PASS` : `${failed.length} FAILED: ${failed.map(([n]) => n).join(", ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
