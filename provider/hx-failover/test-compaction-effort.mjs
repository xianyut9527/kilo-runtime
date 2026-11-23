#!/usr/bin/env node
// 压缩 effort clamp 独立回归（provider/hx-failover，裸 node；先 npm run build）。
// 与 test-failover.mjs 分离：本文件只覆盖 options.compactionEffort 的判定边界与遥测，
// 不改动巨型测试的 PASS 计数门槛。
// 用 createHxFailover + 假 fetch 走真实 doGenerate，捕获 SDK 实际出站 body。
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "hx-compaction-effort-"));
const { createHxFailover } = await import(new URL("./dist/index.js", import.meta.url).href);

const MODEL = "deepseek-v4.1-flash-1017";
let pass = 0;
let fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};

function completionResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// 返回 SDK 实际出站 body（JSON 解析后）。compactionEffort=null 表示不配该 options 键。
async function outbound({
  maxOutputTokens,
  text,
  tools,
  reasoningEffort = "high",
  compactionEffort = "low",
}) {
  const bodies = [];
  const options = {
    name: "hx",
    baseURL: "https://stub.local/v1",
    apiKey: "stub",
    failover: { chain: { models: [] } },
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(init.body));
      return completionResponse();
    },
  };
  if (compactionEffort !== null) options.compactionEffort = compactionEffort;
  const provider = createHxFailover(options);
  const model = provider.languageModel(MODEL);
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    maxOutputTokens,
    ...(tools ? { tools } : {}),
    providerOptions: { openaiCompatible: { reasoningEffort } },
  });
  if (bodies.length !== 1) throw new Error(`expected 1 outbound request, got ${bodies.length}`);
  return bodies[0];
}

// ── 命中：summary 关键词 + 小 max_tokens + 无 tools ─────────────────────
const hit = await outbound({ maxOutputTokens: 1024, text: "Please summarize this conversation." });
t("summary+small → reasoning_effort=low", hit.reasoning_effort === "low", JSON.stringify(hit.reasoning_effort));

// ── 大 max_tokens 普通请求不 clamp ──────────────────────────────────────
const big = await outbound({ maxOutputTokens: 16384, text: "Please summarize this conversation." });
t("max_tokens>8192 → untouched", big.reasoning_effort === "high", JSON.stringify(big.reasoning_effort));

// ── 带 tools 不 clamp（压缩请求无工具面）────────────────────────────────
const withTools = await outbound({
  maxOutputTokens: 1024,
  text: "Please summarize this conversation.",
  tools: [{
    type: "function",
    name: "read_file",
    description: "read a file",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }],
});
t("tools present → untouched", withTools.reasoning_effort === "high", JSON.stringify(withTools.reasoning_effort));

// ── 边界：8192 命中 / 8193 不命中 ───────────────────────────────────────
const atLimit = await outbound({ maxOutputTokens: 8192, text: "summary" });
t("max_tokens=8192 → clamped", atLimit.reasoning_effort === "low", JSON.stringify(atLimit.reasoning_effort));
const overLimit = await outbound({ maxOutputTokens: 8193, text: "summary" });
t("max_tokens=8193 → untouched", overLimit.reasoning_effort === "high", JSON.stringify(overLimit.reasoning_effort));

// ── 缺省关闭：不配 options.compactionEffort 时零接触 ───────────────────
const off = await outbound({ maxOutputTokens: 1024, text: "summary", compactionEffort: null });
t("option absent → untouched", off.reasoning_effort === "high", JSON.stringify(off.reasoning_effort));

// ── 可配置：非 low 档位原样执行 ────────────────────────────────────────
const medium = await outbound({ maxOutputTokens: 1024, text: "summary", compactionEffort: "medium" });
t("configurable effort=medium", medium.reasoning_effort === "medium", JSON.stringify(medium.reasoning_effort));

// ── 无关键词兜底：短请求零接触 / 大负载按压缩处理 ─────────────────────
const shortNoKeyword = await outbound({ maxOutputTokens: 1024, text: "Say OK" });
t("short no-keyword → untouched", shortNoKeyword.reasoning_effort === "high", JSON.stringify(shortNoKeyword.reasoning_effort));
const largeNoKeyword = await outbound({ maxOutputTokens: 1024, text: "x".repeat(5000) });
t("large no-keyword → clamped", largeNoKeyword.reasoning_effort === "low", JSON.stringify(largeNoKeyword.reasoning_effort));

// ── 遥测：compaction_effort_clamped 至少一条，含 from/to/model ─────────
const logText = await readFile(join(process.env.XDG_DATA_HOME, "kilo", "failover-events.jsonl"), "utf8");
const events = logText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const clamps = events.filter((e) => e.action === "compaction_effort_clamped");
t("telemetry compaction_effort_clamped present", clamps.length >= 1, `${clamps.length} events`);
t(
  "telemetry from/to/model recorded",
  clamps.some((e) => e.from === "high" && e.to === "low" && e.model === MODEL),
  JSON.stringify(clamps[0] ?? null),
);

console.log(`\n[test-compaction-effort] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
