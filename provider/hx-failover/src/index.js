// W3.6 模型失败自动降级（移植 legacy Virtual Quota Fallback 的语义）
//
// 契约（7.6.2 实测）：
//   - provider 工厂被调用时收到 { name, baseURL, apiKey, headers, fetch }
//   - 工厂须返回 provider 对象：可调用 + languageModel/chatModel/embeddingModel/... 方法
//   - languageModel(id) 返回 LanguageModelV2：{ specificationVersion:"v2", provider, modelId, supportedUrls, doStream, doGenerate }
//   - kilo.json 的 `provider.hx.options.failover` 原样透传到 options（schema 未封死 additionalProperties）
//
// legacy 五项语义：① 错误即触发（不限状态码）② 失败 profile 临时停用+冷却
//                  ③ 切换注入可见通知 ④ 禁止嵌套 ⑤ 全链失败抛原始最后一个错误
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES_PER_HOP = 2;
const BACKOFF_MS = [500, 1500];

// 内置默认降级链（plan.md §W3.6）：options.failover 缺失时回退到此
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

function isRetryable(err) {
  const status = err?.statusCode ?? err?.status ?? err?.response?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  // 无状态码（网络/超时/abort/无效 key 导致的解析失败）也触发降级——legacy 的「API 错误即触发」
  return true;
}

export function createHxFailover(options) {
  const { name = "hx", apiKey, headers, fetch: customFetch, failover: failoverOpts, ...rest } = options ?? {};

  if (failoverOpts?.nested === true || Array.isArray(failoverOpts?.nested)) {
    throw new Error("hx-failover: 禁止嵌套 failover 配置（legacy 语义，防循环依赖）");
  }

  // Kilo/自研扩展键不可透传给 @ai-sdk/openai-compatible（未知键会报错）
  const EXTENSION_KEYS = ["failover", "moa"];
  const sdkOptions = { ...rest, name, apiKey, headers, fetch: customFetch };
  for (const k of EXTENSION_KEYS) delete sdkOptions[k];

  const cooldownMs = Number(failoverOpts?.cooldownMs) > 0 ? Number(failoverOpts.cooldownMs) : DEFAULT_COOLDOWN_MS;

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

  function wrap(modelId) {
    const inner = provider.chatModel(modelId);
    return {
      specificationVersion: "v2",
      provider: inner.provider ?? name,
      modelId,
      supportedUrls: inner.supportedUrls ?? {},
      async doGenerate(callOptions) {
        return withFailover(modelId, (m) => m.doGenerate(callOptions));
      },
      async doStream(callOptions) {
        return withFailover(modelId, async (m, id, hop) => {
          const result = await m.doStream(callOptions);
          if (hop === 0) return result;

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
          return { ...result, stream: result.stream.pipeThrough(prepend) };
        });
      },
      // 供诊断读取（非官方字段，Kilo 忽略）
      hxFailoverChain: chainOf(options, modelId),
    };
  }

  const wrapped = (id) => wrap(id);
  wrapped.provider = name;
  wrapped.specificationVersion = "v2";
  wrapped.languageModel = (id) => wrap(id);
  wrapped.chatModel = (id) => wrap(id);
  wrapped.embeddingModel = (id) => provider.embeddingModel(id);
  wrapped.textEmbeddingModel = (id) => provider.textEmbeddingModel(id);
  wrapped.imageModel = (id) => provider.imageModel(id);
  return wrapped;
}

export default createHxFailover;
