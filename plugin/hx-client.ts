// hx 上游客户端共享层（W3.8）：moa.ts 与 dual-review.ts 的公共依赖。
// 集中：配置目录/数据目录定位、kilo.json options + auth.json hx.key 读取（60s 缓存）、
// OpenAI-compatible SSE 流式请求（首字节超时 + 空闲看门狗 + 总超时、指数退避重试、onDelta 进度回调）。
// ⚠️ 改动凭证布局或 baseURL 规则时只改这里；两处调用方不再各自维护副本。
//
// 2026-09-18 性能改造（原实现 stream:false 非流式，长任务整段等待 1-2 分钟无任何输出）：
//   - 改 SSE 流式（stream:true）：首 token 即到，总耗时不变但可观测，且规避 natapp 隧道对
//     长非流式请求的静默掐断（流式持续有数据，连接不会被中间设备回收）。
//   - 超时拆三层：首字节（chunkTimeout 同源 60s）、chunk 间空闲（idle，60s）、总时长（total，300s）。
//   - 网络类失败（非 HTTP 4xx）自动重试 2 次指数退避（400ms/1200ms）；HTTP 400/401/403/404/422
//     视为确定性失败不重试，避免对死配置空烧时间。
//   - onDelta(text) 回调：调用方（moa/dual-review）用它把生成进度实时写进 ctx.metadata
//     工具标题（无 ctx 的自动审查路径由调用方降级 stderr），UI 可见「正在生成…已收 N 字」。
//
// 2026-09-22 可靠性修复（双向审查裁决必须项）：
//   - 重试墙钟预算：总时长超时（上游滴流式拖满 timeoutMs）不再重试，且已耗时 ≥ timeoutMs
//     不再发起新尝试——单次 ask 最坏墙钟从 ~3×timeout 收敛到 ~2×timeout；
//   - 可选 signal 取消透传：调用方传入 AbortSignal 即可中止（预留，工具 ctx 尚无此通道）；
//   - 401 立即失效凭证缓存：换 key 后不再用旧 key 空烧 60s TTL；
//   - logDirReady 失败不再永久缓存 rejected Promise，遥测目录可重试。

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.KILO_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kilo");
// 数据目录：与 kilo.db / auth.json / failover-events.jsonl 同根。
// memory-bootstrap.ts 复用此常量（同目录部署）；provider/hx-failover 与 scripts/memory-enable.mjs
// 跨部署边界（独立打包/部署到别处），各自保留本地实现。
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kilo");
export const CFG_TTL_MS = 60_000;
// 超时兜底（总时长）：配置缺失/非法时回退。流式后总时长放宽到 300s（生成中持续有 chunk 证明活着）。
export const FALLBACK_TIMEOUT_MS = 300_000;
// 首字节/空闲兜底：kilo.json provider.hx.options.chunkTimeout 同源（当前 60s）。
export const FALLBACK_CHUNK_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3; // 1 次 + 2 次重试
const BACKOFF_MS = [400, 1200];
// 503 过载专用退避：对 99% CPU 的网关 400ms 重试=火上浇油；2s/6s 给上游喘息窗口
const OVERLOAD_BACKOFF_MS = [2000, 6000];
// 确定性 HTTP 失败：重试无意义（key 错、模型名错、请求体非法），直接抛
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

// ── 断路器（2026-09-22 网关过载专项）──────────────────────────
// 根因：单上游网关 CPU 过载时所有模型 503，provider 降级链与 moa 并行路全挂——
// 降级只是换模型名不换网关，过载时段怎么换都 503。断路器连续 CB_THRESHOLD 次
// 503-overload 后进入 open 态：cooldown 内 ask() 直接抛错不发请求（fail fast，
// 省掉每路 8-15s 空烧与对过载网关的持续施压）；cooldown 后 half-open 放 probe，
// 成功关断、失败重开。只对 503+overload 计数；4xx/超时/网络错不触发（单请求问题非网关问题）。
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 30_000;
let cbConsecutiveOverloads = 0;
let cbState = "closed"; // "closed" | "open" | "half-open"
let cbOpenedAt = 0;

export function circuitState() { return cbState; }

function isOverloadErr(err) {
  if (err?.statusCode === 503) return true;
  return /system cpu overloaded|overloaded/i.test(String(err?.message ?? ""));
}

function cbOnSuccess() {
  cbConsecutiveOverloads = 0;
  cbState = "closed";
}

function cbOnOverloadFail() {
  cbConsecutiveOverloads++;
  if (cbConsecutiveOverloads >= CB_THRESHOLD) {
    cbState = "open";
    cbOpenedAt = Date.now();
  }
}

function cbAllowRequest() {
  if (cbState === "closed") return true;
  if (cbState === "open") {
    if (Date.now() - cbOpenedAt >= CB_COOLDOWN_MS) {
      cbState = "half-open"; // 放一个 probe
      return true;
    }
    return false;
  }
  return true; // half-open：probe 放行
}

let cfgCache = null;
let cfgCacheAt = 0;

// ── 失败遥测（2026-09-22 glm-5.2 四连失败专项）──────────────────
// moa/dual-review 走本客户端直连，不经过 provider 降级链也不写 failover-events.jsonl——
// 「N 轮失败」曾完全无迹可循，只能事后人工实测复现定位。最终失败（重试耗尽/确定性 4xx）
// 追加一行 jsonl：只记模型/HTTP 状态/错误摘要（≤200 字）/耗时，绝不含 prompt 与生成内容。
// 与 provider 的遥测同文件同轮转口径（>5MB 归档 .1）；写失败绝不影响主流程。
const ASK_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

let logDirReady = null;

async function logAskFailure(e, model, elapsedMs) {
  try {
    const p = join(DATA_DIR, "failover-events.jsonl");
    if (!logDirReady) {
      // mkdir 失败时重置为 null：下次调用重试建目录，而不是永久复用 rejected Promise
      // 导致后续遥测全部静默丢弃（2026-09-22 审查必须项）
      logDirReady = mkdir(join(p, ".."), { recursive: true })
        .catch((e2) => { logDirReady = null; throw e2; });
    }
    await logDirReady;
    try {
      const st = await stat(p);
      if (st.size > ASK_LOG_ROTATE_BYTES) await rename(p, `${p}.1`);
    } catch { /* 文件不存在则跳过轮转 */ }
    await appendFile(p, JSON.stringify({
      ts: new Date().toISOString(),
      kind: "hx-client",
      action: "ask_fail",
      model,
      status: e?.statusCode ?? null,
      error: String(e?.message ?? e).slice(0, 200),
      elapsedMs,
    }) + "\n", "utf8");
  } catch { /* 遥测失败不影响主流程 */ }
}

export async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < CFG_TTL_MS) return cfgCache;
  const kilo = JSON.parse(await readFile(join(CONFIG_DIR, "kilo.json"), "utf8"));
  const opts = kilo?.provider?.hx?.options ?? {};
  const auth = JSON.parse(await readFile(join(DATA_DIR, "auth.json"), "utf8"));
  const key = auth?.hx?.key;
  if (!opts.baseURL) throw new Error("hx-client: provider.hx.options.baseURL 未配置");
  if (!key) throw new Error("hx-client: auth.json 缺少 hx.key（请先登录/配置 hx provider）");
  cfgCache = { baseURL: String(opts.baseURL).replace(/\/+$/, ""), key, options: opts };
  cfgCacheAt = Date.now();
  return cfgCache;
}

// 单次尝试：SSE 流式拉取，直到 done。返回完整文本。
// 超时三层：首字节（headers 后到第一个 data:）、chunk 间空闲、总时长。
// signal：可选外部取消信号（预留通道，当前调用方暂无来源）；触发即中止底层连接。
async function attemptOnce({ baseURL, key, model, prompt, timeoutMs, idleMs, onDelta, signal }) {
  const totalMs = timeoutMs ?? FALLBACK_TIMEOUT_MS;
  const idleTimeoutMs = idleMs ?? FALLBACK_CHUNK_TIMEOUT_MS;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(total);
    if (idle) clearTimeout(idle);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  };
  const t0 = Date.now();
  let total = setTimeout(() => controller.abort(new Error(`总时长超过 ${totalMs}ms`)), totalMs);
  let idle = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      controller.abort(new Error(`流式响应空闲超过 ${idleTimeoutMs}ms（chunkTimeout 看门狗）`));
    }, idleTimeoutMs);
    idle.unref?.();
  };

  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    cleanup();
    throw e;
  }

  if (!res.ok) {
    cleanup();
    const body = await res.text().catch(() => "");
    const err = new Error(`${model} HTTP ${res.status}: ${body.slice(0, 300)}`);
    err.statusCode = res.status;
    // 401 属凭证失效（key 轮换/过期）：立即失效缓存，下次 loadCfg 重读 auth.json（2026-09-22 审查必须项）
    if (res.status === 401) cfgCache = null;
    throw err;
  }
  if (!res.body) {
    cleanup();
    throw new Error(`${model}: 响应无 body（流式不可用）`);
  }

  // SSE 解析：按行拆，取 data: 载荷；[DONE] 结束；content 增量回调
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usageTokens = null;
  try {
    armIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (Date.now() - t0 > totalMs) throw new Error(`总时长超过 ${totalMs}ms`);
      armIdle();
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { buf = ""; continue; }
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json?.usage && typeof json.usage === "object") {
          usageTokens = json.usage.completion_tokens ?? usageTokens;
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
          try { onDelta?.(delta, text.length); } catch { /* 进度回调失败不影响主流程 */ }
        }
      }
    }
    // 流结束 flush：最后一块可能不带换行（规范上 SSE 事件以 \n 结尾，但防御非规范上游丢尾包）
    if (buf.trim().startsWith("data:")) {
      const payload = buf.trim().slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const json = JSON.parse(payload);
          if (json?.usage && typeof json.usage === "object") {
            usageTokens = json.usage.completion_tokens ?? usageTokens;
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            text += delta;
            try { onDelta?.(delta, text.length); } catch {}
          }
        } catch { /* 尾包非法 JSON 则放弃 */ }
      }
    }
  } finally {
    cleanup();
    try { await reader.cancel(); } catch { /* 已结束则忽略 */ }
  }

  if (!text) throw new Error(`${model}: 空响应（流结束无 content）`);
  return { text, tokens: usageTokens, elapsedMs: Date.now() - t0 };
}

// 对外接口（兼容旧签名：直接 await 返回字符串）。onDelta 可选注入进度回调；signal 可选取消透传。
// 重试墙钟预算（2026-09-22 审查必须项）：
//   - 「总时长超时」类失败不重试——剩余预算已装不下一次完整尝试，重试只是再烧 timeoutMs；
//   - 已耗时 ≥ timeoutMs 不再发起新尝试。
//   单次 ask 最坏墙钟从 ~3×timeout 收敛到 ~2×timeout（快速失败类仍有重试保护）。
export async function ask({ baseURL, key, model, prompt, timeoutMs, idleMs, onDelta, attempts, signal }) {
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : MAX_ATTEMPTS;
  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : FALLBACK_TIMEOUT_MS;
  const t0 = Date.now();
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    // 断路器 open：fail fast 不发请求（省掉每路 8-15s 空烧 + 不继续锤过载网关）
    if (!cbAllowRequest()) {
      const cooldownLeft = Math.ceil((cbOpenedAt + CB_COOLDOWN_MS - Date.now()) / 1000);
      const e = new Error(`${model}: 断路器 open（上游网关过载），${cooldownLeft}s 后探测恢复。跳过请求。`);
      e.circuitOpen = true;
      await logAskFailure(e, model, Date.now() - t0);
      throw e;
    }
    try {
      const r = await attemptOnce({ baseURL, key, model, prompt, timeoutMs, idleMs, onDelta, signal });
      cbOnSuccess();
      return r.text;
    } catch (e) {
      lastErr = e;
      const status = e?.statusCode;
      // 确定性失败（HTTP 4xx 已知状态码）不重试；中断（AbortError 由我们主动 abort 触发）按超时算可重试
      if (NON_RETRYABLE_STATUS.has(status)) {
        await logAskFailure(e, model, Date.now() - t0);
        throw e;
      }
      // 墙钟预算耗尽（总时长超时或已耗时过半途预算）：不再重试
      const totalTimeout = typeof e?.message === "string" && e.message.includes("总时长超过");
      if (totalTimeout || Date.now() - t0 >= budgetMs) {
        if (isOverloadErr(e)) cbOnOverloadFail();
        await logAskFailure(e, model, Date.now() - t0);
        throw e;
      }
      // 503 过载：断路器计数 + 专用退避（2s/6s 给上游喘息，而非 400ms 火上浇油）
      if (isOverloadErr(e)) {
        cbOnOverloadFail();
        if (cbConsecutiveOverloads >= CB_THRESHOLD && i < maxAttempts - 1) {
          continue; // 下一轮 cbAllowRequest() 判定，open 时直接 fail fast
        }
        if (i < maxAttempts - 1) {
          await new Promise((r2) => setTimeout(r2, OVERLOAD_BACKOFF_MS[i] ?? 6000));
        }
      } else if (i < maxAttempts - 1) {
        await new Promise((r2) => setTimeout(r2, BACKOFF_MS[i] ?? 1200));
      }
    }
  }
  await logAskFailure(lastErr, model, Date.now() - t0);
  throw lastErr;
}