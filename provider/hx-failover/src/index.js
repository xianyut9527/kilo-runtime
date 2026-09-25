// W3.6 模型失败自动降级（移植 legacy Virtual Quota Fallback 的语义）
//
// 契约（7.6.2 实测）：
//   - provider 工厂被调用时收到 { name, baseURL, apiKey, headers, fetch }
//   - 工厂须返回 provider 对象：可调用 + languageModel/chatModel/embeddingModel/... 方法
//   - languageModel(id) 返回 LanguageModelV3：{ specificationVersion:"v3", provider, modelId, supportedUrls, doStream, doGenerate }
//   - kilo.json 的 `provider.hx.options.failover` 原样透传到 options（schema 未封死 additionalProperties）
//
// ⚠️ spec 版本必须是 v3（Kilo 7.6.2 运行时 spec）：
// 声明 v2 会让 Kilo 走兼容桥（日志 "Using v2 specification compatibility mode"），
// 该桥把 finishReason 归一化后整轮丢失，落库为 step-finish.reason="unknown"、
// tokens 全 0，UI 报「回合已结束，模型未提供结束原因」。2026-09-15 用受控实验确认：
// 同一包装声明 v3 时 reason=stop，声明 v2 时 reason=unknown。
// 因此依赖锁 @ai-sdk/openai-compatible ^2（其 specificationVersion 为 "v3"），
// 不可退回 ^1（"v2"）。
//
// legacy 五项语义：① 错误即触发（不限状态码，唯一例外见 isCancellation：调用方取消直通）
//                  ② 失败 profile 临时停用+冷却
//                  ③ 切换注入可见通知 ④ 禁止嵌套 ⑤ 全链失败抛原始最后一个错误
//
// thinking 协议兜底（2026-09-21 reasoning_content 400 专项）：
// DeepSeek V4 / Kimi K2.6 / GLM-5.x / MiniMax 在 thinking 模式下要求历史 assistant 消息
// 回传 reasoning_content（工具循环续跑必查）；Kilo 从存储重放历史不保留该字段，
// @ai-sdk/openai-compatible 只在 assistant 带 reasoning 块时才输出它 → 上游 400
// 「must be passed back」直达用户（kilo.db 实证全部命中 deepseek-v4.1-flash，variant=max）。
// 真实思考文本在更上层已丢失，本层唯一能做的是协议兜底：给缺失该字段的 assistant 消息
// 补空串（四家上游直连实测均接受）。开关 reasoningEcho，缺省关，kilo.json 显式开。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "@ai-sdk/provider";
import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES_PER_HOP = 2;
const BACKOFF_MS = [500, 1500];
// 过载专用退避（2026-09-24 Tool execution aborted 专项）：网关 CPU 过载期对全模型回
// 503 system cpu overloaded，固定 500/1500ms 快退避 = 对 99% CPU 网关的连环补刀
// （17:01:43-50 实测：3 并发会话 × 4 模型链 × 每 hop 2 重试，每 ~2.3s 一轮全链冲击）。
// 口径对齐 lib/hx-client.ts OVERLOAD_BACKOFF_MS（2s/6s 给上游喘息窗口）。
const OVERLOAD_BACKOFF_MS = [2000, 6000];
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// 降级链唯一真源 = kilo.json 的 provider.hx.options.failover.chain.models（改模型只改配置文件）。
// 代码不内置默认链：未配置时链 = 仅当前模型（等于无降级，与 Kilo 原生单模型行为一致），
// 工厂初始化时打一条 stderr 告警提示补配置。

// 降级记录：事件发生在 provider 内，Kilo 感知不到（不会触发 session.next.retried），
// 因此包自己写本地 JSONL 便于事后排查（纯追加，失败不影响模型调用）。
// 位置优先 XDG_DATA_HOME（与 auth.json 同根），保证跨项目汇总。
function failoverLogPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "kilo", "failover-events.jsonl");
}

let logDirReady = null;
// 遥测写队列：appendFile+轮转都是读-判-写多步异步，无锁并发会交错/重复轮转/
// 乱序（dual_review 正反两路并行审查 + moa 并行参考 = 天然并发调用方）。
// 链式 catch 保底：单条失败不阻断后续条目，也不让队列 Promise 永久 rejected。
let logQueue = Promise.resolve();
async function logFailover(record) {
  // then 回调体内整体 try/catch 已兜住所有 IO 异常（含 mkdir 重抛/appendFile/stat），
  // 回调必以 fulfilled 结束——但防御性再加链尾 .catch：即便未来改动在 try 外引入
  // 抛点（如 record 序列化前访问 undefined），队列仍恢复 fulfilled，绝不永久 rejected
  // 静默吞掉后续遥测（二轮审查必须项）。
  logQueue = logQueue
    .then(async () => {
      try {
        const p = failoverLogPath();
        if (!logDirReady) {
          // mkdir 失败时重置为 null：下次调用重试建目录，而不是永久复用 rejected Promise
          // 导致后续遥测全部静默丢弃（与 lib/hx-client 同日审查必须项，同步移植）
          logDirReady = mkdir(dirname(p), { recursive: true })
            .catch((e2) => { logDirReady = null; throw e2; });
        }
        await logDirReady;
        // 简单轮转：超 5MB 归档为 .1（只保一代；事件频率低，足够排查用）。
        // rename 原子覆盖（libuv Windows 走 MoveFileExW+REPLACE_EXISTING，本机实测；
        // 常规本地路径成立，SMB/持锁等异常由下方降级兜底）。
        const st = await stat(p).catch(() => null);
        if (st && st.size > LOG_ROTATE_BYTES) {
          try {
            await rename(p, `${p}.1`);
          } catch (e3) {
            // 轮转失败降级（Windows 归档被占用 rename 必败）：清空主文件阻断无限膨胀，
            // 保住「日志可继续追加」这条底线；归档丢了只丢一代历史（低频事件可接受）
            await writeFile(p, "", "utf8");
            console.error(`hx-failover: telemetry rotate failed（已清空主文件继续记录）: ${e3?.message ?? e3}`);
          }
        }
        await appendFile(p, JSON.stringify({ ts: new Date().toISOString(), kind: "failover", ...record }) + "\n", "utf8");
      } catch (e) {
        // 写日志失败绝不影响模型调用，但必留 stderr 诊断——静默丢弃会让排障无迹可循
        console.error(`hx-failover: telemetry write failed: ${e?.message ?? e}`);
      }
    })
    .catch((e) => { console.error(`hx-failover: telemetry queue guard: ${e?.message ?? e}`); });
  return logQueue;
}

const cooldown = new Map(); // modelId -> 失效截止时间戳

// ── thinking 模式 reasoning_content 回传兜底（2026-09-21 400 专项）─────────────
// 只补缺失、绝不覆盖已有值（真实思考文本由 SDK 转换层写入时保持原样）；
// 解析失败/非聊天请求（无 messages）一律原样放行，兜底永不阻断请求。
function patchReasoningContent(bodyText) {
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return bodyText; }
  const messages = parsed?.messages;
  if (!Array.isArray(messages)) return bodyText;
  let changed = false;
  for (const m of messages) {
    if (m && m.role === "assistant" && typeof m.reasoning_content !== "string") {
      m.reasoning_content = "";
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : bodyText;
}

// ── 网关排队回执拦截（2026-09-24 queued-ack 专项）────────────────────
// 生产形态：上游网关过载时对 chat/completions 返回 200 + JSON
// {"request_id":"...","seq":1,"position":0,"phase":"queued"} 而非 SSE 流。
// SDK 校验失败抛 AI_TypeValidationError（无 statusCode，body 是该回执），
// 它在建流/流消费期从 SDK 内部抛出，绕过 withFailover 的 catch，且
// Kilo 自动重试门不认 → 错误直达用户（07:05 实证，failover 遥测零记录）。
// 解法：fetch 层识别该形态，转成 503 + Retry-After 的 Response——
// status>=500 命中 isRetryable → 正常走 hop 内 retry + 降级链；
// 保留原始 request_id/phase 于 body，可诊断性不丢。
// 严格限定：仅拦 content-type 含 json 且 body 顶层含 "phase":"queued" 的
// 200 响应；正常 SSE（text/event-stream）与真实补全 JSON（有 choices）不受影响。
function looksLikeQueuedAck(response) {
  if (!response || response.status !== 200) return false;
  const ct = String(response.headers?.get?.("content-type") ?? "");
  if (!/json/i.test(ct)) return false;
  return response
    .clone()
    .text()
    .then((text) => {
      if (text.length > 4096) return false;
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) return false;
      try {
        const parsed = JSON.parse(trimmed);
        // 只认网关排队回执的签名字段：choices/error 都不该有，phase 必须是 queued/pending 类
        if (parsed.choices !== undefined || parsed.error !== undefined) return false;
        const phase = String(parsed.phase ?? "");
        return phase === "queued" || phase === "pending";
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

function queuedAckResponse(original) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("retry-after", "2");
  return new Response(
    JSON.stringify({
      error: {
        message: "hx-failover: 上游网关返回排队回执（phase=queued，未开始推理），已转义为可重试 503 —— 原始回执见 error.cause_fields",
        type: "upstream_queued",
        cause_fields: { intercepted_from_status: 200, content_type: original.headers?.get?.("content-type") },
      },
    }),
    { status: 503, headers },
  );
}

function withQueuedAckGuard(baseFetch) {
  const call = baseFetch ?? globalThis.fetch;
  return async function queuedAckFetch(input, init) {
    const response = await call(input, init);
    try {
      if (await looksLikeQueuedAck(response)) return queuedAckResponse(response);
    } catch { /* 拦截器永不阻断正常响应 */ }
    return response;
  };
}

function withReasoningEcho(baseFetch) {
  const call = baseFetch ?? globalThis.fetch;
  return async function reasoningEchoFetch(input, init) {
    try {
      // SDK 的 postJsonToApi 固定 fetch(url, {method:"POST", body:<JSON 字符串>})
      if (init && typeof init.body === "string" && init.body.length > 0) {
        const patched = patchReasoningContent(init.body);
        if (patched !== init.body) init = { ...init, body: patched };
      }
    } catch { /* 兜底永不阻断请求 */ }
    return call(input, init);
  };
}

// ── 推理门控（2026-09-24「推理吃光输出预算」专项，2026-09-26 自 dangling blob 恢复）──
// 死因（kilo.db 全库 95 条 finish=length 地面真值 + 网关直连探针复现）：thinking
// 模型推理与正文共享输出预算（kilo.exe 发 max_tokens = min(32000, max(1024,
// 200000−input−2048))），推理 token ≥ 预算时正文为空、finish_reason=length——
// Kilo 报「The model hit its output limit while reasoning, produced no actionable
// output」。该失败是「正常流结束」：不抛错、不触发降级/重试（降级层只拦错误不检
// 流内容），每次都要人工重发；长会话按条件猝死率累计，百次调用 ≥1 死概率 ~40%。
// 线上 9527 网关是无源码的 new-api 二进制，改不了服务端 → 本层在 fetch 出口做客户端门控：
//   - 扣留 2xx 响应 body 直到出现「可行动输出」（非空 content / tool_calls）才回放直通；
//     正常响应唯一变化是思考段不再逐 chunk 实时到达（content 出现时一次性补放）；
//   - 流结束仍无任何可行动输出且 finish=length 或 stop → 判定死亡，用「扩预算 + 降推理档」
//     的 body 原地重发（默认 1 次）；重试响应走同一门控；
//     ① finish=length：推理吃光输出预算，正文为空（2026-09-24 专项）；
//     ② finish=stop：流「正常」结束但正文/tool_calls 全空——思考型模型把全部产出
//       写进 reasoning_content 后自行停止（2026-09-24 19:34 空摘要压缩事故实证：
//       配额 429 令压缩降级到 kimi，7219 字摘要全在 reasoning、content 空、
//       finish=stop，Kilo 报「Compaction did not run: empty summary」只能手动 /compact）；
//   - 重试仍死 / 重试失败（非 2xx/网络错）→ 原样回放死亡流，字节与不启用门控时一致，绝不劣化；
//   - 扣留超过 holdMs 仍未出现可行动输出 → 放弃门控转直通（不再重试），防超长思考被误杀；
//   - 非 POST / 非字符串 body / 非 JSON 聊天体 / URL 不含 /chat/completions → 零接触透传。
// 判定用文本特征而非 JSON.parse 整包（SSE 分帧边界鲁棒，且只扫增量累计文本）：
//   - "reasoning_content" 不命中 content 锚（content 前是 '_' 不是 '"'）；
//   - 空 content（""）不算可行动；正文 JSON 字符串内转义形态 \"content\" 不命中。
// 代价说明：死亡→重试使该请求最坏墙钟 ×2（思考期重跑），Kilo 侧整体超时/中止语义不变。
const GATE_ACTIONABLE = /"(?:content|tool_calls)"\s*:\s*(?:"[^"]+"|\[)/;
// 死亡 finish 形态：length=推理吃光预算（经典）；stop=正常收尾但正文全空（空摘要事故形态）。
// stop 必须与 !GATE_ACTIONABLE 联合判定（在 gateConsume 调用点保证）：出现正文时早已
// 提前放行，流尾仍无正文的 stop 才是死亡；不匹配 finish（缺字段/其他值）不重试，
// 原样回放——宁可不救也不误伤合法流。
const GATE_LENGTH_FINISH = /"finish_reason"\s*:\s*"(?:length|stop)"/;
const GATE_EFFORT_DOWN = { max: "high", high: "medium", medium: "low", low: "low" };

// 构造死亡重试 body（基于原请求字符串重新序列化的副本；非聊天体返回 null 不重试）：
// max_tokens/max_completion_tokens 扩至 clamp(原值×2, minTokens, maxTokens)
// （都缺省时注入 minTokens——上游默认小预算也是死因）；reasoning_effort 降一档，
// 未设置视为最高档起步降（部分上游对 effort 不敏感，如 kimi 实测降档不缩短推理，
// 此时仅靠扩预算起效；两者都不奏效则重试仍死，由调用方原样回放）。
function gatePatchRetryBody(bodyText, minTokens, maxTokens) {
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return null;
  const cur = Number(parsed.max_tokens ?? parsed.max_completion_tokens ?? Number.NaN);
  const boosted = Math.max(
    minTokens,
    Math.min(maxTokens, Number.isFinite(cur) && cur > 0 ? cur * 2 : minTokens),
  );
  if (parsed.max_tokens !== undefined || parsed.max_completion_tokens !== undefined) {
    if (parsed.max_tokens !== undefined) parsed.max_tokens = boosted;
    if (parsed.max_completion_tokens !== undefined) parsed.max_completion_tokens = boosted;
  } else {
    parsed.max_tokens = boosted;
  }
  parsed.reasoning_effort = GATE_EFFORT_DOWN[String(parsed.reasoning_effort ?? "")] ?? "low";
  return JSON.stringify(parsed);
}

// 用已缓冲 chunk + 仍持有的 reader 构造回放流（release/hold 超时后的直通接管）。
function gateReplayStream(reader, chunks) {
  return new ReadableStream({
    async start(controller) { for (const c of chunks) controller.enqueue(c); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel(reason) { return reader.cancel(reason).catch(() => {}); },
  });
}

// 纯缓冲回放流（流已结束：死亡/非死亡整包原样透传）。
function gateBufferedStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

// 扣留观察一个 2xx 响应 body 并裁决（递归有界：每 hop retryLeft-1、独立 holdDeadline）。
// 返回 Response：
//   - 出现可行动输出 → 回放缓冲 + 剩余直通；
//   - hold 超时（在 chunk 到达时评估）/ 缓冲超字节上限 → 放弃门控转直通
//     （回放缓冲 + 接管剩余，字节零丢失）。完全静默的流由外层兜底：Kilo 的
//     chunkTimeout 看门狗/abort signal 会让 reader.read() 以 AbortError 拒绝并
//     原样上抛——不在本层用读超时竞争：race 输掉的一方仍占着 read 队列，
//     会把后续 chunk 吞给已被放弃的读取（实测数据丢失）。
//   - 流结束：死亡且可重试 → mkRetry() 下一跳同样门控；其余 → 原始字节原样回放。
async function gateConsume(res, mkRetry, retryLeft, holdMs, bufferLimitBytes) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const chunks = [];
  let text = "";
  let bufferedBytes = 0;
  const deadline = Date.now() + holdMs;

  // 放弃门控：回放已缓冲 + 接管剩余（真正的直通，不丢后续字节）
  const passthrough = () => new Response(gateReplayStream(reader, chunks), {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bufferedBytes += value.byteLength ?? value.length ?? 0;
    text += dec.decode(value, { stream: true });
    if (GATE_ACTIONABLE.test(text)) {
      return new Response(gateReplayStream(reader, chunks), {
        status: res.status, statusText: res.statusText, headers: res.headers,
      });
    }
    if (Date.now() > deadline) return passthrough(); // 扣留超时：放弃门控转直通
    // 缓冲字节上限：快速上游可在时限内灌爆内存（并发放大）——超限放弃门控转直通
    if (bufferedBytes > bufferLimitBytes) return passthrough();
  }
  // 流结束仍无可行动输出 → 死亡判定
  if (retryLeft > 0 && GATE_LENGTH_FINISH.test(text) && !GATE_ACTIONABLE.test(text)) {
    let next = null;
    try { next = await mkRetry(); } catch { next = null; } // 重试网络错 → 回退原样回放
    if (next && next.ok && next.body) {
      try { reader.cancel().catch(() => {}); } catch { /* 已结束则忽略 */ }
      return gateConsume(next, mkRetry, retryLeft - 1, holdMs, bufferLimitBytes);
    }
    try { next?.body?.cancel?.()?.catch?.(() => {}); } catch { /* 忽略 */ }
  }
  return new Response(gateBufferedStream(chunks), {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
}

// 推理门控 fetch 包装：options.reasoningGate = true | {holdMs, retries, minTokens, maxTokens}
function withReasoningGate(baseFetch, cfg) {
  const call = baseFetch ?? globalThis.fetch;
  const retries = Math.max(0, Math.floor(Number(cfg?.retries ?? 1)));
  const minTokens = Number(cfg?.minTokens) > 0 ? Number(cfg.minTokens) : 32_768;
  const maxTokens = Math.max(minTokens, Number(cfg?.maxTokens) > 0 ? Number(cfg.maxTokens) : 65_536);
  const holdMs = Number(cfg?.holdMs) > 0 ? Number(cfg.holdMs) : 180_000;
  // 扣留缓冲字节上限（默认 16MB，超限放弃门控转直通）：思考段常态 ~百 KB 量级，
  // 上限只防「快速异常上游在时限内灌爆内存」的资源风险，正常流量永远达不到。
  const bufferLimitBytes = Number(cfg?.bufferLimitBytes) > 0 ? Number(cfg.bufferLimitBytes) : 16 * 1024 * 1024;

  return async function reasoningGateFetch(input, init) {
    const method = init?.method ?? "POST";
    const url = String(typeof input === "object" && input !== null && "url" in input ? input.url : input);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    if (method !== "POST" || bodyText === null || !/\/(chat\/)?completions(\?|$)/.test(url)) {
      return call(input, init);
    }
    let model = null;
    try { model = JSON.parse(bodyText)?.model ?? null; } catch { return call(input, init); }

    let attempt = 0;
    const mkRetry = async () => {
      const patched = gatePatchRetryBody(bodyText, minTokens, maxTokens);
      if (patched === null) throw new Error("hx-failover: reasoning-gate retry body patch failed");
      attempt++;
      await logFailover({ action: "reasoning_gate_retry", from: model, attempt });
      console.error(`hx-failover: reasoning-gate ${model} 推理吃光输出预算/正文为空（finish=length|stop 无可行动输出），第 ${attempt} 次重试（扩预算+降推理档）`);
      return call(input, { ...init, body: patched });
    };

    const res = await call(input, init);
    if (!res.ok || !res.body) return res;
    // 扣留期读断/取消会从 gateConsume 原样上抛：取消直通、断流按可重试错误走降级链
    // ——与无门控时 body 读取断裂的错误语义一致，只是发生点从流消费期提前到 fetch 期。
    const gated = await gateConsume(res, mkRetry, retries, holdMs, bufferLimitBytes);
    if (attempt > 0) {
      await logFailover({ action: "reasoning_gate_applied", from: model, attempt });
    }
    return gated;
  };
}

function isCooling(id, cooldownMs) {
  const until = cooldown.get(id);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    cooldown.delete(id);
    return false;
  }
  return true;
}

function markFailed(id, cooldownMs) {
  cooldown.set(id, Date.now() + cooldownMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 从 failover 配置提取模型名列表（供 chainOf 与「缺配置告警」共用）
function configuredModelsOf(options) {
  const raw = options?.failover;
  let list = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.profiles)) list = raw.profiles;
    else if (typeof raw.chain === "object" && Array.isArray(raw.chain?.models)) list = raw.chain.models;
    else if (Array.isArray(raw.models)) list = raw.models;
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  return list
    .map((p) => (typeof p === "string" ? p : p?.model ?? p?.id))
    .filter((m) => typeof m === "string" && m);
}

function chainOf(options, currentModelId) {
  const models = configuredModelsOf(options);

  // 主模型永远排第一；去掉重复与嵌套（禁止嵌套：链内不得再含 failover 配置）
  const seen = new Set();
  const ordered = [currentModelId, ...models].filter((m) => {
    if (!m || seen.has(m)) return false;
    seen.add(m);
    return true;
  });

  return ordered;
}

// 调用方主动取消（用户按停止 / 会话被取消 / 客户端断连）绝不是上游故障：
// 必须原样直通抛出，否则会在已 aborted 的 signal 上把整条降级链各试 3 次（实测 4 模型 × 3 次 ≈ 8s），
// 并给每个模型打上冷却标记，导致冷却期内的备用模型被 skip_cooldown 跳过 → 真故障时无备用可用、直接停止。
// 判据优先用 name：跨包/跨 realm 的 AbortError 实例 instanceof Error 不成立；旧运行时无 Error.isError。
// 注意：TimeoutError/ResponseAborted 是 AI SDK 归一化后的真实超时/上游断流，仍按下文重试+降级处理。
function isCancellation(err) {
  const name = err?.name;
  if (name === "AbortError") return true;
  const code = err?.code ?? err?.cause?.code;
  return code === "ABORT_ERR";
}

function isRetryable(err) {
  if (isCancellation(err)) return false;
  const status = err?.statusCode ?? err?.status ?? err?.response?.status;
  if (typeof status === "number") {
    // 2xx 状态的 API 错误只可能是「成功响应 body 处理失败」（真实 API 错误必带 4xx/5xx），
    // 此错误从 doStream() 调用内抛出时尚无内容交付给调用方 → 可安全走内部重试/降级
    if (status >= 200 && status < 300) return true;
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  // 无状态码（网络中断/无效 key 导致的解析失败）也触发降级——legacy 的「API 错误即触发」
  return true;
}

// 过载判定（退避档位选择用，与 isRetryable 正交）：503 / cpu overloaded 报文 / 响应带
// Retry-After（含排队回执拦截器转出的 503+retry-after）任一命中即走 OVERLOAD_BACKOFF_MS。
// 已知取舍：503 也覆盖「无可用渠道」类确定性错误（hx-client 同口径）——慢退避只是
// 让死配置的失败暴露慢 ~6s，而把真过载期的快重试误放过的代价是全链连环冲击。
function isOverloadErr(err) {
  const status = err?.statusCode ?? err?.status;
  if (status === 503) return true;
  const h = err?.responseHeaders;
  const ra = typeof h?.get === "function" ? h.get("retry-after") : h?.["retry-after"];
  if (ra !== undefined && ra !== null) return true;
  return /cpu overloaded|system overloaded/i.test(String(err?.message ?? ""));
}

// ── 流中断错误重包装（2026-09-15 断流专项）────────────────────────────
// 背景：natapp 隧道偶发「200 OK + SSE 流中途断开」。AI SDK 在成功响应 body
// 读取阶段出错时（provider-utils wrapResponseBodyStream.pull，消费期抛出，
// 不经过 withFailover 的 catch）包装为 APICallError{statusCode:200,
// isRetryable:false, message:"Failed to process successful response"}；
// Kilo 的自动重试门（exe 反编译实证）只放行 APIError.isInstance &&
// (data.isRetryable || statusCode>=500)，于是错误直达用户，只能手动重发。
//
// 解法：doStream 返回的流外层再包一层，消费期读到流中断类错误时重包装为
// APICallError{isRetryable:true} 上抛，让 Kilo 会话级重试接管（整条消息重跑）。
// provider 侧绝不在流中途重放——流已交给调用方，重放必然重复输出（与
// chunkTimeout 看门狗注释同理）；chunkTimeout 主动中断也走同一重包装，
// 「挂死 30s」从用户面前报错变为自动重试。
//
// 取消类（用户停止/客户端断连）绝不重包装：原样上抛，避免已中止 signal 上空转。
function isStreamBreakError(err) {
  if (isCancellation(err)) return false;
  // 2xx 状态的 APICallError 即「成功响应 body 处理失败」的规范形态（版本鲁棒，
  // 不依赖 message 文案）；message 兜底覆盖老版本包装文案
  if (APICallError.isInstance(err)) {
    const s = err.statusCode;
    if (typeof s === "number" && s >= 200 && s < 300) return true;
    if (String(err.message ?? "").includes("Failed to process successful response")) return true;
  }
  // chunkTimeout 看门狗主动中断（流静默挂死）
  if (String(err?.message ?? "").includes("chunkTimeout 看门狗")) return true;
  // 网关排队回执穿透形态（2026-09-24）：AI_TypeValidationError 的 body 是
  // {"phase":"queued"} 排队回执而非补全/错误——fetch 层拦截是主防线，此为
  // 兜底（拦截器被绕过/新变体时仍标记可重试，让 Kilo 会话级重试接管）
  const qMsg = `${String(err?.name ?? "")} ${String(err?.message ?? "")}`;
  if (err?.name === "AI_TypeValidationError" && /phase[":\s]+(?:queued|pending)/.test(qMsg)) return true;
  // 裸 body 读取断裂（socket 层错误直接从底层流抛出的变体）
  const msg = `${String(err?.message ?? err)} ${String(err?.cause?.message ?? err?.cause?.code ?? "")}`;
  return /terminated|socket hang up|ECONNRESET|ECONNABORTED|ERR_STREAM_PREMATURE_CLOSE|premature close|underlying socket/i.test(msg);
}

// 干净断连形态（2026-09-26「Response stream ended without a finish reason」专项）：
// 隧道/上游把 SSE 连接半途掐断但 TCP 侧走优雅关闭（FIN 而非 RST）时，body 流
// 正常 EOF，SDK 兼容层 flush 判定 finishReason 未赋值 → 以「error part」入队
// InvalidResponseDataError("Response stream ended without a finish reason.")，
// 不经 reader.read() 拒绝路径（withStreamBreakRewrap 的 catch 拦不到），
// 也无 statusCode（Kilo 重试门不认）→ 错误直达用户。
// 识别两路：① error part 携带的 InvalidResponseDataError 且带该文案；
// ② 该形态从流上抛时的兜底（错误名 AI_InvalidResponseDataError，跨 bundle marker 不可靠，
//   以 message 文案为准——SDK 固定文案，无用户数据注入，无误伤面）。
function isNoFinishReasonError(err) {
  if (isCancellation(err)) return false;
  const name = String(err?.name ?? "");
  if (name !== "AI_InvalidResponseDataError" && name !== "InvalidResponseDataError") return false;
  return String(err?.message ?? "").includes("Response stream ended without a finish reason");
}

function rewrapStreamBreak(err) {
  if (APICallError.isInstance(err) && err.isRetryable === true) return err;
  return new APICallError({
    message: `hx-failover: 上游流中断（流已开始后断开），已标记可自动重试 —— ${String(err?.message ?? err).slice(0, 300)}`,
    url: err?.url,
    requestBodyValues: err?.requestBodyValues,
    statusCode: err?.statusCode,
    responseHeaders: err?.responseHeaders,
    cause: err,
    // 关键：statusCode 可能是 200（「成功响应处理失败」），必须显式覆盖默认判定
    isRetryable: true,
  });
}

export function createHxFailover(options) {
  const { name = "hx", apiKey, headers, fetch: customFetch, failover: failoverOpts, ...rest } = options ?? {};

  // 降级链缺失告警（每工厂一次）：真源在 kilo.json provider.hx.options.failover.chain.models。
  // 显式配置空链（failover:{chain:{models:[]}}，测试隔离用）是刻意行为，不告警。
  const rawF = options?.failover;
  const explicitF = rawF !== undefined && rawF !== null && !(typeof rawF === "object" && Object.keys(rawF).length === 0);
  if (!explicitF) {
    console.error("hx-failover: 未配置降级链（kilo.json provider.hx.options.failover.chain.models）——仅用当前模型，无自动降级");
  }

  if (failoverOpts?.nested === true || Array.isArray(failoverOpts?.nested)) {
    throw new Error("hx-failover: 禁止嵌套 failover 配置（legacy 语义，防循环依赖）");
  }

  // Kilo/自研扩展键不可透传给 @ai-sdk/openai-compatible（SDK 只读已知键，未知键静默丢弃——
  // 但留在 settings 里易被误当 SDK 能力排查，统一剥除；timeout/dual_review 由 plugin 侧直读 kilo.json）
  const EXTENSION_KEYS = ["failover", "moa", "chunkTimeout", "reasoningEcho", "reasoningGate", "timeout", "dual_review"];
  // thinking 模式 reasoning_content 回传兜底（kilo.json options.reasoningEcho；缺省 = 关闭）
  const reasoningEcho = options?.reasoningEcho === true;
  // 推理门控（kilo.json options.reasoningGate = true | {holdMs,retries,minTokens,maxTokens}；缺省 = 关闭）。
  // 组装顺序（内→外）：queuedAckGuard 恒开 → echo → gate——gate 的重发体先经 echo 补丁
  // （幂等，已带 reasoning_content 则无变化），排队回执先在源头被拦。
  const gateCfg = options?.reasoningGate === true ? {} : (options?.reasoningGate && typeof options.reasoningGate === "object" ? options.reasoningGate : null);
  let fetchFn = withQueuedAckGuard(customFetch);
  if (reasoningEcho) fetchFn = withReasoningEcho(fetchFn);
  if (gateCfg !== null) fetchFn = withReasoningGate(fetchFn, gateCfg);
  const sdkOptions = {
    ...rest,
    name,
    apiKey,
    headers,
    // 未启用任何包装时仅 queuedAckGuard 生效（恒开防线），行为与既往一致
    fetch: fetchFn,
  };
  for (const k of EXTENSION_KEYS) delete sdkOptions[k];

  const cooldownMs = Number(failoverOpts?.cooldownMs) > 0 ? Number(failoverOpts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  // 过载退避可注入（failover.overloadBackoffMs，正数组）：生产用默认 2s/6s，测试注入小值
  // 验证路径命中而不真等 8s；非法值（非数组/含非有限正数）静默回落默认，不炸调用链。
  const overloadBackoffMs = Array.isArray(failoverOpts?.overloadBackoffMs)
    && failoverOpts.overloadBackoffMs.every((n) => Number.isFinite(n) && n >= 0)
    ? failoverOpts.overloadBackoffMs
    : OVERLOAD_BACKOFF_MS;
  // 流式空闲看门狗（kilo.json options.chunkTimeout；0/缺省 = 关闭）
  const chunkTimeoutMs = Number(options?.chunkTimeout) > 0 ? Number(options.chunkTimeout) : 0;

  const provider = createOpenAICompatible(sdkOptions);

  async function withFailover(modelId, run) {
    const chain = chainOf(options, modelId);
    let lastError;

    for (let hop = 0; hop < chain.length; hop++) {
      const id = chain[hop];
      if (hop > 0 && isCooling(id, cooldownMs)) {
        await logFailover({ from: modelId, to: id, action: "skip_cooldown", hop });
        continue;
      }

      const model = provider.chatModel(id);

      for (let attempt = 0; attempt <= MAX_RETRIES_PER_HOP; attempt++) {
        try {
          return await run(model, id, hop);
        } catch (err) {
          lastError = err;
          // 取消类错误：只记一条诊断日志，立即原样抛出（不进冷却，不换模型）
          if (isCancellation(err)) {
            await logFailover({ from: modelId, at: id, action: "cancelled" });
            throw err;
          }
          if (!isRetryable(err)) {
            // 不可重试错误（400 类协议/参数错误）原样直通，但必须入遥测：
            // 此前这类错误完全绕过降级链与日志（reasoning_content 400 排查时无迹可循）
            await logFailover({
              from: modelId,
              at: id,
              action: "fatal",
              status: err?.statusCode ?? err?.status,
              error: String(err?.message ?? err).slice(0, 200),
            });
            throw err;
          }

          if (attempt < MAX_RETRIES_PER_HOP) {
            // 过载感知退避（2026-09-24）：503/过载类换 2s/6s 慢退避给上游喘息，其余维持快退避；
            // 遥测带 overload 标记，事后可从 failover-events.jsonl 区分两档路径
            const overload = isOverloadErr(err);
            await logFailover({ from: modelId, at: id, action: "retry", attempt: attempt + 1, ...(overload ? { overload: true } : {}) });
            const backoff = (overload ? overloadBackoffMs : BACKOFF_MS)[attempt] ?? (overload ? 6000 : 1500);
            await sleep(backoff);
            continue;
          }
          markFailed(id, cooldownMs);
          await logFailover({
            from: modelId,
            at: id,
            action: hop + 1 < chain.length ? "fallback" : "exhausted",
            to: chain[hop + 1],
            status: err?.statusCode ?? err?.status,
            error: String(err?.message ?? err).slice(0, 200),
          });
          break; // 换链上下一模型
        }
      }
    }

    // R8：全链失败必须抛原始最后一个错误（保留可诊断性），不得静默吞错。
    // 例外：若最后一个错误是流中断类（含「无 finish_reason」干净断连形态），
    // 重包装为 isRetryable=true —— 内部重试/降级已尽力，Kilo 会话级重试是
    // 最后兜底；cause 保留原始错误，可诊断性不丢。
    if (isStreamBreakError(lastError) || isNoFinishReasonError(lastError)) {
      await logFailover({ from: modelId, action: "stream_break_rewrap", error: String(lastError?.message ?? lastError).slice(0, 200) });
      throw rewrapStreamBreak(lastError);
    }
    throw lastError ?? new Error("hx-failover: 降级链全部失败");
  }

  // 流消费期错误重包装：doStream 建流成功后，body 读取/解析阶段的错误由读取方
  // 在 pull 时收到（不经过 withFailover 的 catch）——这正是生产断流（200 OK +
  // SSE 中途断开）的路径。此层在最外拦截：流中断类 → 重包装 isRetryable=true
  // 交给 Kilo 自动重试；取消类与其他错误原样直通。
  function withStreamBreakRewrap(stream, modelId) {
    const reader = stream.getReader();
    let emittedAny = false; // 断流前是否已产出内容（诊断用：Kilo 重试整条消息重跑）
    // 断流阶段诊断（2026-09-22）：elapsed/chunks 区分「流早期断」（建流即断，疑似隧道
    // 连接老化）与「流晚期断」（长思考/长生成中断，疑似隧道空闲回收或上游重启），
    // 下次断流时遥测直接给出流的存活时长与吞吐量
    const streamT0 = Date.now();
    let chunks = 0;
    return new ReadableStream({
      async pull(controller) {
        let next;
        try {
          next = await reader.read();
        } catch (error) {
          if (isStreamBreakError(error) || isNoFinishReasonError(error)) {
            const wrapped = rewrapStreamBreak(error);
            logFailover({
              from: modelId,
              action: "stream_break_rewrap",
              noFinishReason: isNoFinishReasonError(error),
              emittedAny,
              chunks,
              elapsedMs: Date.now() - streamT0,
              status: wrapped.statusCode,
              error: String(error?.message ?? error).slice(0, 200),
            });
            controller.error(wrapped);
          } else {
            controller.error(error);
          }
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        // 干净断连的 error part 形态（2026-09-26 专项）：SDK flush 层把
        // 「流结束仍无 finish_reason」以 {type:"error", error:<InvalidResponseDataError>}
        // 入队而非从流上抛——catch 拦不到。转发给消费方前拦截：
        // 转为可重试 APICallError 经 controller.error 上抛（流终止语义不变，
        // 但 Kilo 重试门此时能认），与 RST 断流路径殊途同归。
        const part = next.value;
        const errPart = part && typeof part === "object" && part.type === "error" ? part.error : null;
        if (errPart && isNoFinishReasonError(errPart)) {
          const wrapped = rewrapStreamBreak(errPart);
          logFailover({
            from: modelId,
            action: "stream_break_rewrap",
            noFinishReason: true,
            viaErrorPart: true,
            emittedAny,
            chunks,
            elapsedMs: Date.now() - streamT0,
            status: wrapped.statusCode,
            error: String(errPart?.message ?? errPart).slice(0, 200),
          });
          controller.error(wrapped);
          return;
        }
        emittedAny = true;
        chunks++;
        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => {});
      },
    });
  }

  // 流式空闲看门狗：chunkTimeout 期内没有任何新 chunk 则主动 error 流。
  // 背景：fetch timeout 只覆盖到响应头，body 阶段挂死会无限等待且上层无感知
  // （chunkTimeout 曾是「无消费者的无效配置」，2026-09-15 补实现）。
  // 看门狗把「静默挂死」转成「显式报错」，由上层（Kilo 重试/用户重发）接管；
  // 不触发本包的模型降级 —— 流已交给调用方，重放语义不安全。
  function withChunkWatchdog(stream, ms, modelId) {
    let timer = null;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = (controller) => {
      clear();
      timer = setTimeout(() => {
        try {
          controller.error(new Error(`hx-failover: ${modelId} 流式响应超过 ${ms}ms 无新数据（chunkTimeout 看门狗），主动中断`));
        } catch { /* controller 已关闭则忽略 */ }
      }, ms);
      timer.unref?.(); // 看门狗不阻止进程退出
    };
    const watch = new TransformStream({
      start(controller) { arm(controller); },
      transform(chunk, controller) { arm(controller); controller.enqueue(chunk); },
      flush() { clear(); },
      cancel() { clear(); },
    });
    return stream.pipeThrough(watch);
  }

  function wrap(modelId) {
    const inner = provider.chatModel(modelId);
    return {
      specificationVersion: "v3",
      provider: inner.provider ?? name,
      modelId,
      supportedUrls: inner.supportedUrls ?? {},
      async doGenerate(callOptions) {
        return withFailover(modelId, (m) => m.doGenerate(callOptions));
      },
      async doStream(callOptions) {
        return withFailover(modelId, async (m, id, hop) => {
          const result = await m.doStream(callOptions);
          let stream = result.stream;
          if (hop > 0) {
            // 切换通知（legacy 语义③）：在流首插入一行可见提示。
            // 必须保持 ReadableStream 语义（Kilo 会对 stream 调 pipeThrough），
            // 且 text-delta 必须配套 text-start/text-end（否则 Kilo 报 "text part ... not found"）。
            //
            // 注意：此处的 hop>0 意味着「切换在 doStream 建流之前完成」（上游在返回 stream 前就失败了），
            // 因此插入通知不会与已输出内容冲突。若失败发生在流读取过程中，异常由读取方抛出，
            // 不会回到本函数的重试逻辑 —— 即不存在「流中途换模型导致重复输出」的路径。
            const noticeId = "hx-failover-notice";
            const prepend = new TransformStream({
              start(controller) {
                controller.enqueue({ type: "text-start", id: noticeId });
                controller.enqueue({
                  type: "text-delta",
                  id: noticeId,
                  delta: `⚠️ [failover] ${modelId} 失败，已自动降级到 ${id}\n\n`,
                });
                controller.enqueue({ type: "text-end", id: noticeId });
              },
              transform(chunk, controller) {
                controller.enqueue(chunk);
              },
            });
            stream = stream.pipeThrough(prepend);
          }
          if (chunkTimeoutMs > 0) stream = withChunkWatchdog(stream, chunkTimeoutMs, id);
          // 最外层：消费期流中断 → 重包装 isRetryable=true，Kilo 会话级重试接管
          stream = withStreamBreakRewrap(stream, modelId);
          return { ...result, stream };
        });
      },
      // 供诊断读取（非官方字段，Kilo 忽略）
      hxFailoverChain: chainOf(options, modelId),
    };
  }

  const wrapped = (id) => wrap(id);
  wrapped.provider = name;
  wrapped.specificationVersion = "v3";
  wrapped.languageModel = (id) => wrap(id);
  wrapped.chatModel = (id) => wrap(id);
  wrapped.embeddingModel = (id) => provider.embeddingModel(id);
  wrapped.textEmbeddingModel = (id) => provider.textEmbeddingModel(id);
  wrapped.imageModel = (id) => provider.imageModel(id);
  return wrapped;
}

export default createHxFailover;
