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
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES_PER_HOP = 2;
const BACKOFF_MS = [500, 1500];
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// 内置默认降级链（kilo.json 的 options.failover 缺失时回退到此；与 kilo.json.tmpl 保持一致）
// 注意：首位永远是主模型（chainOf 会把 currentModelId 排到最前）。
const DEFAULT_CHAIN = ["glm-5.3-flash", "kimi-k2.6", "deepseek-v4.1-flash", "glm-5.2"];

// 降级记录：事件发生在 provider 内，Kilo 感知不到（不会触发 session.next.retried），
// 因此包自己写本地 JSONL 便于事后排查（纯追加，失败不影响模型调用）。
// 位置优先 XDG_DATA_HOME（与 auth.json 同根），保证跨项目汇总。
function failoverLogPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "kilo", "failover-events.jsonl");
}

let logDirReady = null;
async function logFailover(record) {
  try {
    const p = failoverLogPath();
    if (!logDirReady) logDirReady = mkdir(join(p, ".."), { recursive: true });
    await logDirReady;
    // 简单轮转：超 5MB 归档为 .1（只保一代；事件频率低，足够排查用）
    try {
      const st = await stat(p);
      if (st.size > LOG_ROTATE_BYTES) await rename(p, `${p}.1`);
    } catch { /* 文件不存在或轮转失败都不影响写日志 */ }
    await appendFile(p, JSON.stringify({ ts: new Date().toISOString(), kind: "failover", ...record }) + "\n", "utf8");
  } catch {
    // 写日志失败绝不影响模型调用
  }
}

const cooldown = new Map(); // modelId -> 失效截止时间戳

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

function chainOf(options, currentModelId) {
  const raw = options?.failover;
  const explicit = raw !== undefined && raw !== null && !(typeof raw === "object" && Object.keys(raw).length === 0);
  let list = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.profiles)) list = raw.profiles;
    else if (typeof raw.chain === "object" && Array.isArray(raw.chain?.models)) list = raw.chain.models;
    else if (Array.isArray(raw.models)) list = raw.models;
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  let models = list
    .map((p) => (typeof p === "string" ? p : p?.model ?? p?.id))
    .filter((m) => typeof m === "string" && m);

  // 未显式配置（或配置为空）时回退内置默认链
  if (models.length === 0 && !explicit) models = DEFAULT_CHAIN.slice();

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
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  // 无状态码（网络中断/无效 key 导致的解析失败）也触发降级——legacy 的「API 错误即触发」
  return true;
}

export function createHxFailover(options) {
  const { name = "hx", apiKey, headers, fetch: customFetch, failover: failoverOpts, ...rest } = options ?? {};

  if (failoverOpts?.nested === true || Array.isArray(failoverOpts?.nested)) {
    throw new Error("hx-failover: 禁止嵌套 failover 配置（legacy 语义，防循环依赖）");
  }

  // Kilo/自研扩展键不可透传给 @ai-sdk/openai-compatible（未知键会报错）
  const EXTENSION_KEYS = ["failover", "moa", "chunkTimeout"];
  const sdkOptions = { ...rest, name, apiKey, headers, fetch: customFetch };
  for (const k of EXTENSION_KEYS) delete sdkOptions[k];

  const cooldownMs = Number(failoverOpts?.cooldownMs) > 0 ? Number(failoverOpts.cooldownMs) : DEFAULT_COOLDOWN_MS;
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
          if (!isRetryable(err)) throw err;

          if (attempt < MAX_RETRIES_PER_HOP) {
            await logFailover({ from: modelId, at: id, action: "retry", attempt: attempt + 1 });
            await sleep(BACKOFF_MS[attempt] ?? 1500);
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

    // R8：全链失败必须抛原始最后一个错误（保留可诊断性），不得静默吞错
    throw lastError ?? new Error("hx-failover: 降级链全部失败");
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
          const stream = chunkTimeoutMs > 0 ? withChunkWatchdog(result.stream, chunkTimeoutMs, id) : result.stream;
          if (hop === 0) return { ...result, stream };

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
          return { ...result, stream: stream.pipeThrough(prepend) };
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
