// hx 上游客户端共享层（W3.8）：moa.ts 与 dual-review.ts 的公共依赖。
// 集中：配置目录/数据目录定位、kilo.json options + auth.json openllamas.key 读取（60s 缓存，
// 兼容迁移窗口内的旧 hx 结构）、
// OpenAI-compatible SSE 流式请求（首字节超时 + 空闲看门狗 + 总超时、指数退避重试）。
// ⚠️ 改动凭证布局或 baseURL 规则时只改这里；两处调用方不再各自维护副本。
//
// 2026-09-18 性能改造（原实现 stream:false 非流式，长任务整段等待 1-2 分钟无任何输出）：
//   - 改 SSE 流式（stream:true）：流式持续有数据，规避 natapp 隧道对长非流式请求的
//     静默掐断（中间设备不回收活跃连接）——这是流式保留的真实理由（进度可视已证伪，见下）。
//   - 超时拆三层：首字节（chunkTimeout 同源 60s）、chunk 间空闲（idle，60s）、总时长（total，300s）。
//   - 网络类失败（非 HTTP 4xx）自动重试 2 次指数退避（400ms/1200ms）；HTTP 400/401/403/404/422
//     视为确定性失败不重试，避免对死配置空烧时间。
//   - 2026-09-22 终裁：onDelta 进度回调已随进度机制整体拆除（插件工具无 UI 进度通道，
//     三次证伪，详见文件末尾契约墓碑注释）——调用方只消费最终完整文本。
//
// 2026-09-22 可靠性修复（双向审查裁决必须项）：
//   - 重试墙钟预算：总时长超时（上游滴流式拖满 timeoutMs）不再重试，且已耗时 ≥ timeoutMs
//     不再发起新尝试——单次 ask 最坏墙钟从 ~3×timeout 收敛到 ~2×timeout；
//   - 可选 signal 取消透传：调用方传入 AbortSignal 即可中止（预留，工具 ctx 尚无此通道）；
//   - 401 立即失效凭证缓存：换 key 后不再用旧 key 空烧 60s TTL；
//   - logDirReady 失败不再永久缓存 rejected Promise，遥测目录可重试。
//
// 2026-09-22 二轮审查修复：
//   - half-open 单探测名额：由断路器维护者以 cbProbeInFlight 锁实现（probe 在途其余请求
//     fail fast、probe 失败回退 open、finally 兜底释放），见 4cfa939/5fa8dbf；
//   - 遥测错误字段改固定分类枚举（不再落上游报文文本）：网关 4xx/内容策略类报文可能回显
//     请求体片段，直写 message 有 prompt 泄漏面；
//   - 轮转用 rename 原子覆盖（libuv 在 Windows 走 MoveFileExW+REPLACE_EXISTING，
//     2026-09-22 本机 Node 22 实测覆盖成功；常规本地路径成立，SMB/持锁等异常由
//     rotate catch 诊断兜底）：无需先删旧归档；先 rm 反而引入「rm 成功、rename 失败」
//     的丢归档窗口。轮转失败留 stderr 诊断不静默。
//
// 2026-09-22 三轮审查修复（重载后实测）：
//   - half-open 跨代隔离：cbOnSuccess/cbOnOverloadFail/cbOnProbeFail 按请求身份（isProbe）
//     裁决——trip 前发出的旧请求迟到成功/失败均无权迁移状态，关断/回退专属当代 probe
//     （旧成功不得提前释放 probe 锁放进并发 fanout；旧失败不得丢弃其后的 probe 恢复证据）；
//   - open 态迟到过载不再刷新 openedAt：冷却自 trip 时刻起算，防拖尾失败无限顺延停摆。

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.KILO_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kilo");
// 数据目录：与 kilo.db / auth.json / failover-events.jsonl 同根。
// memory-bootstrap.ts 复用此常量（同目录部署）；provider/hx-failover 与 scripts/memory-enable.mjs
// 跨部署边界（独立打包/部署到别处），各自保留本地实现。
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kilo");
const CFG_TTL_MS = 60_000; // 配置缓存 TTL（模块私有，无外部消费方）
// 超时兜底（总时长）：配置缺失/非法时回退。流式后总时长放宽到 300s（生成中持续有 chunk 证明活着）。
export const FALLBACK_TIMEOUT_MS = 300_000;
// 首字节/空闲兜底：仅在 kilo.json provider.openllamas.options.chunkTimeout 缺失/非法时兜底
// （缺省 60s；配置侧现为 180s，故两者不等值——配置生效时本常量不参与）。
export const FALLBACK_CHUNK_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3; // 1 次 + 2 次重试
const BACKOFF_MS = [400, 1200];
// 503 过载专用退避：对 99% CPU 的网关 400ms 重试=火上浇油；2s/6s 给上游喘息窗口
const OVERLOAD_BACKOFF_MS = [2000, 6000];
// 确定性 HTTP 失败：重试无意义（key 错、模型名错、请求体非法），直接抛
// 410 Gone（2026-09-27 补）：资源已永久移除——重试同一 URL 必然再 410；此前不在集合里，
// 对已下线端点会白跑 2 次重试（400ms+1200ms）。语义上与 404 同类，归入确定性失败。
// 402（2026-10-24 补）：余额/配额类失败，重试同一 key 不会恢复（普通 Payment required 与
// 已实证的 "insufficient personal balance" 均快速失败，交上层换模型）。
const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 410, 422]);

// ── 断路器（2026-09-22 网关过载专项）──────────────────────────
// 根因：单上游网关 CPU 过载时所有模型 503，provider 降级链与 moa 并行路全挂——
// 降级只是换模型名不换网关，过载时段怎么换都 503。断路器连续 CB_THRESHOLD 次
// 503-overload 后进入 open 态：cooldown 内 ask() 直接抛错不发请求（fail fast，
// 省掉每路 8-15s 空烧与对过载网关的持续施压）；cooldown 后 half-open 放单个 probe
// （probeInFlight 锁防 moa 并发 fanout 多路同时穿透），成功关断、任何失败重开。
// 只对 503+overload 计数；4xx/超时/网络错不触发 open（单请求问题非网关问题）。
// half-open 态：仅 5xx/超时/网络错等网关级失败回退 open；4xx/模型级错误
// （400 区域策略、402 余额、413 体积、404 渠道不存在等）证明网关可达，
// 中性释放 probe 并关断，避免把单模型约束误算成网关故障、连累健康渠道。
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 30_000;
let cbConsecutiveOverloads = 0;
let cbState = "closed"; // "closed" | "open" | "half-open"
let cbOpenedAt = 0;
let cbProbeInFlight = false; // half-open 单 probe 锁：防并发 fanout 集体穿透
let cbGeneration = 0; // 每次进入 half-open 递增；旧代 probe 的迟到结果无权迁移状态
let cbProbeGeneration = 0; // 当前获准 probe 的代次
let cbEpoch = 0; // 每次状态迁移递增；closed 态迟到 503 不得污染过载计数

export function circuitState() { return cbState; }

// 预检门（2026-09-25 断路器永久 open 死锁专项）：
// open → half-open 的状态迁移只发生在 ask() 内部的 cbAllowRequest()。而 moa.ts /
// dual-review.ts 的预检在 circuitState()==="open" 时直接 return、不发任何请求——
// 若冷却到期后仍暴露 "open"，预检将永远拦住下一次 ask()，状态机永远失去迁移机会，
// 断路器永久 open（线上实证：2026-09-25 18:28 真实过载 trip 后，网关早已恢复，
// moa/dual_review 仍连续数小时秒回「断路器开启，稍后重试」，hx-client 遥测零条——
// 请求根本没发出）。预检必须与 ask() 同口径：冷却已过即视为 half-open 可探测，
// 预检放行 → ask() 内 cbAllowRequest() 正式迁移状态并放单 probe。
// 时钟回拨防护（2026-09-26 补审必须项，二次修正）：审查建议的 Math.max(0,…) 归一
// 是错的——负差值归一成 0 后仍 < 冷却值，依旧拦截（0 < 30000 恒真）。正确语义：
// 差值为严格负说明墙钟回拨、cbOpenedAt 已不可信，唯一安全的解释是「冷却已过」——放行，
// 让 ask() 的 cbAllowRequest 用同口径决断（最坏代价一次多余 probe，由网关真实验证；
// 绝不允许在边界条件下退回永久拦截死锁）。差值 ==0（同毫秒刚 trip）属正常流逝
// 边界，保守拦截。
export function cbShouldFailFast() {
  const sinceOpen = Date.now() - cbOpenedAt;
  return cbState === "open" && sinceOpen >= 0 && sinceOpen < CB_COOLDOWN_MS;
}

// ── 工具 execute 契约（2026-09-22 三修实证 + 同日终裁：无进度通道）──
// kilo.exe（Bun/JSC）插件工具管线对 execute 返回值有两道硬消费，由两次真实崩溃钉死：
//   ① 提升层（Effect tryPromise 族适配器）对返回值直接调 .then —— 裸 generator/非 thenable
//      → "ET(...).then is not a function"；
//   ② 渲染层对 resolve 值调 .split —— resolve 值非 string → "evaluating 'f.split'"。
//   ⇒ execute 必须返回 Promise 且 resolve 值为 string——async 函数原生满足，无需任何包装。
// 进度通道已三次证伪，勿再尝试：ctx.metadata 不存在于 server 7.7.6；asyncIterator/preliminary
// 流式卡不适用插件工具；stderr 落 server 进程调试日志、对话视图不可见（2026-09-22 用户实测
// 2.5min 工具卡无任何输出确认）。可观测性靠最终结果字符串自带（耗时/字数/参与模型）。
// 历史：bridgeProgress（stderr 节流进度桥）已于同日删除——UI 不可达的死代码。

// probe 锁兜底释放：ask() 的 finally 调用（仅持锁时），防异常/取消路径泄漏
// cbProbeInFlight 导致 half-open 永久卡死。guard 双条件确保已正常释放时无操作。
function cbReleaseProbeIfStuck(probeGen) {
  if (cbState === "half-open" && cbProbeInFlight && probeGen === cbGeneration) {
    // probe 异常退出（未走 cbOnSuccess/cbOnProbeFail/cbOnOverloadFail）→ 回退 open 重试
    cbState = "open";
    cbOpenedAt = Date.now();
    cbProbeInFlight = false;
    cbEpoch++;
  }
}

// HTTP 状态归一化：直连错误自带 statusCode；包装型上游/SDK 可能只给 status 或
// response.status。三处判型（过载/413/模型级 4xx）必须同源，防网关包装错误漏判。
function statusOf(err) {
  const s = err?.statusCode ?? err?.status ?? err?.response?.status;
  return typeof s === "number" ? s : undefined;
}

function isOverloadErr(err) {
  // 503 + 渠道/模型不可用报文（model_not_found/no available channel）：确定性故障——
  // 渠道没配/下线，退避重试与断路器冷却都救不了（渠道不会因 30s 等待恢复）。
  // 按非过载处理：不 trip 断路器（网关本身健康）、不进 2s/6s 退避，快速失败换路。
  // 2026-09-28 查漏补缺：正则与 provider/hx-failover 对齐补 "no active channel candidate"
  // （NO_ROUTE_CANDIDATE 的 503 变体）——缺失时该形态会被误判为过载：白退避 ~8s 且
  // trip 断路器，与「快速失败换路」语义相悖（口径漂移修复）。
  // 2026-10-01 根治对齐（同 provider 侧 CHANNEL_UNAVAILABLE_RE）：补 "model not exist"
  // （404/503 同措辞变体，生产实证 2026-10-01 21:50 glm-5.3-flash）与 NO_ROUTE_CANDIDATE
  // 本体；404 渠道签名形态在 ask() 侧经 NON_RETRYABLE_STATUS 早退（不 trip 不退避），
  // 本正则只守 503 入口——两文件签名集必须同源维护，改一处必改另一处。
  // 2026-10-07 同源补漏（与 provider 侧 CHANNEL_UNAVAILABLE_RE 必须一致）：网关「全链
  // 熔断」的两套措辞（503 ALL_CHANNELS_DEGRADED / 502 UPSTREAM_UNAVAILABLE all
  // candidates failed）此前未进签名集，被当网关节流过载 → 白付 2s/6s 退避并 trip 断路器。
  // 状态码家族同步纳入 502（同样由网关主动发出，非模型侧错误）。
  const cuStatus = statusOf(err);
  if ((cuStatus === 503 || cuStatus === 502) && /model_not_found|no[_-]?route[_-]?candidate|no available channel|model.?not.?available|no active channel candidate|model not exist|all channels? circuit[- ]open|ALL_CHANNELS_DEGRADED|all candidates failed/i.test(String(err?.message ?? "") + String(err?.responseHeaders?.get?.("x-error") ?? ""))) {
    return false;
  }
  if (cuStatus === 503) return true;
  // 2026-10-24 查漏补缺：过载兜底正则仅对网关主动发出的 502/503 生效——
  // 4xx（模型级策略/参数错误）与无状态码的本地网络错不得凭消息文本里的
  // "overloaded" 字样误判过载、误开断路器（与 ask() 内「4xx/网络错走中性
  // 释放或 probe fail、不进过载计数」的注释口径对齐）。
  if (cuStatus === 502) return /system cpu overloaded|overloaded/i.test(String(err?.message ?? ""));
  return false;
}

// 模型级策略/配额签名（与 provider/hx-failover 的 MODEL_POLICY_UNAVAILABLE_RE /
// MODEL_QUOTA_UNAVAILABLE_RE 必须同源维护，改一处必改另一处）：
// 400 "requires global regions" 与 402 "insufficient personal balance" 都是单模型渠道
// 约束，换 hop/换模型可绕开；直连路径由 askRoute 捕获后试下一模型，不能在同一 body 上
// 空转 3 次。普通 400/402 仍由 NON_RETRYABLE_STATUS 原样快速失败。
const MODEL_POLICY_UNAVAILABLE_RE = /requires global regions/i;
const MODEL_QUOTA_UNAVAILABLE_RE = /insufficient personal balance/i;
// 413 体积超限签名（与 provider 同源）：状态码 413 直接判定；网关偶尔把同一错误包成
// 400/500，报文签名兜底。直连路径 prompt 为单字符串，命中后逐级半长裁剪，最多 3 级
// （原始 + 3 次裁剪 = 4 次请求），与 provider 的 MAX_BODY_SHRINK_LEVEL 口径一致。
const BODY_TOO_LARGE_RE = /request body (?:is )?too large|payload too large|request entity too large|entity too large|body exceeds/i;
const BODY_SHRINK_MIN_CHARS = 1_000;
const MAX_BODY_SHRINK_LEVELS = 3;

function errorText(err) {
  const text = (v) => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v).slice(0, 500); } catch { return String(v); }
  };
  return [
    err?.message,
    err?.data?.error?.message,
    err?.data?.error?.code,
    err?.data?.code,
    err?.responseBody,
    err?.response?.data?.error?.message,
    err?.response?.data?.error?.code,
    err?.response?.data?.code,
    err?.response?.data?.message,
    err?.response?.body,
    err?.cause?.message,
    err?.cause?.response?.data,
    err?.responseHeaders?.get?.("x-error"),
  ].map(text).filter((p) => p != null).join(" | ");
}

function isModelUnavailable(err) {
  const status = statusOf(err);
  if (status === 400) return MODEL_POLICY_UNAVAILABLE_RE.test(errorText(err));
  if (status === 402) return MODEL_QUOTA_UNAVAILABLE_RE.test(errorText(err));
  return false;
}

function isBodyTooLarge(err) {
  if (statusOf(err) === 413) return true;
  return BODY_TOO_LARGE_RE.test(errorText(err));
}

function cbOnSuccess(isProbe, probeGen, requestEpoch) {
  // open 态的迟到成功不关断：在途旧请求（open 前发出）成功不代表网关已恢复，
  // 冷却窗口必须走完——只有 half-open probe 成功才允许关断（防绕过冷却直砸过载网关）
  if (cbState === "open") return;
  // 跨代隔离：half-open 态只有当代 probe 的成功有权关断并释放 probe 锁；
  // trip 前/上一代发出的旧请求迟到成功不得提前关断（否则真 probe 在途时锁被释放、
  // 并发 fanout 涌入刚过载过的网关）
  if (cbState === "half-open") {
    if (!isProbe || probeGen !== cbGeneration) return;
  } else if (requestEpoch !== cbEpoch) {
    // closed 态旧 epoch 的迟到成功不得清空新一代过载计数（否则 2 次新 503 被旧成功清零）
    return;
  }
  cbConsecutiveOverloads = 0;
  cbProbeInFlight = false;
  cbState = "closed";
  cbEpoch++;
}

function cbOnOverloadFail(isProbe, probeGen, requestEpoch) {
  if (cbState === "half-open") {
    // 跨代隔离：half-open 态只有当代 probe 的过载失败有权计数并回退 open；
    // 旧请求迟到过载不计数、不裁决（先验代次，再改计数/状态）。
    if (isProbe && probeGen === cbGeneration) {
      cbConsecutiveOverloads++;
      cbState = "open";
      cbOpenedAt = Date.now();
      cbProbeInFlight = false;
      cbEpoch++;
    }
    return;
  }
  // open 态的迟到过载不计数、不刷新 openedAt：冷却自 trip 时刻起算，防拖尾失败无限顺延停摆
  if (cbState === "open") return;
  // closed 态只接受同一 epoch 的请求计数；trip 前发出的迟到 503 不得污染新一代阈值。
  if (requestEpoch !== cbEpoch) return;
  cbConsecutiveOverloads++;
  if (cbConsecutiveOverloads >= CB_THRESHOLD) {
    cbState = "open";
    cbOpenedAt = Date.now();
    cbProbeInFlight = false;
    cbEpoch++;
  }
}

// half-open probe 遭遇网关级失败（5xx/超时/网络错）：网关仍不可信，回退 open。
// 跨代隔离：仅当代 probe 的失败有裁决权——旧请求迟到失败不得凭空延长冷却（其后的真
// probe 成功会被 open 态忽略规则丢弃，等于白扔一次有效恢复证据、多 30s 全局停摆）
function cbOnProbeFail(isProbe, probeGen) {
  if (cbState === "half-open" && isProbe && probeGen === cbGeneration) {
    cbState = "open";
    cbOpenedAt = Date.now();
    cbProbeInFlight = false;
    cbEpoch++;
  }
}

// half-open probe 遭遇模型级 4xx（区域策略/余额/体积/渠道不存在等）：网关已经
// 返回确定响应，说明可达且未过载——中性释放 probe 并关断，不重开熔断。
// 若继续 open，一个模型的策略错误会让所有健康模型陪跑 30s 冷却。
// 跨代隔离：旧代 probe 的 4xx 无权关断新一代 half-open（否则持续过载会被旧结果掩盖）。
function cbOnProbeNeutral(isProbe, probeGen) {
  if (cbState === "half-open" && isProbe && probeGen === cbGeneration) {
    cbConsecutiveOverloads = 0;
    cbProbeInFlight = false;
    cbState = "closed";
    cbEpoch++;
  }
}

function cbAllowRequest() {
  if (cbState === "closed") return "closed";
  if (cbState === "open") {
    // 时钟回拨防护（2026-09-26 补审必须项，二次修正）：差值 <0 视为已过冷却（与
    // cbShouldFailFast 同口径）——Math.max(0,…) 归一是错方（0 仍 < 冷却值恒拦截）。
    // 差值 ==0（同毫秒刚 trip）保守拦截，走 else 分支。
    const sinceOpen = Date.now() - cbOpenedAt;
    if (sinceOpen < 0 || sinceOpen >= CB_COOLDOWN_MS) {
      cbState = "half-open"; // 转 half-open，下面走单 probe 锁
      cbGeneration++; // 新代次：上一代 probe 的迟到结果不得裁决本次 half-open
      cbEpoch++;
    } else {
      return false;
    }
  }
  // half-open：单 probe 锁——已有 probe 在途时其余请求 fail fast（防并发穿透）
  if (cbProbeInFlight) return false;
  cbProbeInFlight = true;
  cbProbeGeneration = cbGeneration;
  return "probe"; // 调用方凭此在 finally 兜底释放（防异常路径锁泄漏）
}

let cfgCache = null;
let cfgCacheAt = 0;

// ── 失败遥测（2026-09-22 glm-5.2 四连失败专项）──────────────────
// moa/dual-review 走本客户端直连，不经过 provider 降级链也不写 failover-events.jsonl——
// 「N 轮失败」曾完全无迹可循，只能事后人工实测复现定位。最终失败（重试耗尽/确定性 4xx）
// 追加一行 jsonl：只记模型/HTTP 状态/错误分类（固定枚举，不含上游报文文本）/耗时，
// 绝不含 prompt 与生成内容。
// 与 provider 的遥测同文件同轮转口径（>5MB 归档 .1）；写失败绝不影响主流程。
const ASK_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

let logDirReady = null;

const ASK_LOG_ACTIONS = new Set(["ask_fail", "body_shrink_retry"]);
const ASK_LOG_FIELDS = new Set(["action", "model", "status", "error", "elapsedMs", "beforeChars", "afterChars", "bytesBefore", "bytesAfter"]);
const ASK_LOG_ERRORS = new Set([
  "circuit_open", "request_body_too_large", "model_unavailable",
  "timeout_total", "timeout_idle", "empty_response", "no_body", "network_error",
]);

function isAskLogError(value) {
  return typeof value === "string" && (ASK_LOG_ERRORS.has(value) || /^http_[1-5]\d\d$/.test(value));
}

async function logAskEvent(fields) {
  try {
    // 安全边界：只落固定字段 + 固定 error 枚举。通用展开曾把 responseBody/x-error 原文
    // 一类上游文本带进遥测的通道重新打开（二轮必修项回归，2026-10-24 审查）。
    // 未知键/非法 error 不整条丢弃：剥离后保留合法字段并计数上报，避免防泄漏反而灭掉
    // 413 的 bytesBefore/bytesAfter 审计证据。
    if (!fields || !ASK_LOG_ACTIONS.has(fields.action)) return;
    const unknownKeys = Object.keys(fields).filter((k) => !ASK_LOG_FIELDS.has(k));
    if (unknownKeys.length > 0) {
      console.error(`hx-client: telemetry stripped ${unknownKeys.length} unexpected field(s): ${unknownKeys.join(",")}`);
    }
    const safeError = fields.error !== undefined && isAskLogError(fields.error) ? fields.error : undefined;
    if (fields.error !== undefined && safeError === undefined) {
      console.error("hx-client: telemetry stripped non-enum error");
    }
    if (typeof fields.model !== "string" || fields.model.length === 0) return;
    const safeStatus = fields.status != null && Number.isFinite(fields.status) ? fields.status : undefined;
    if (fields.status != null && safeStatus === undefined) {
      console.error("hx-client: telemetry stripped non-numeric status");
    }
    const record = {
      ts: new Date().toISOString(),
      kind: "hx-client",
      action: fields.action,
      model: fields.model,
      status: safeStatus,
      error: safeError,
      elapsedMs: Number.isFinite(fields.elapsedMs) ? fields.elapsedMs : undefined,
      beforeChars: Number.isInteger(fields.beforeChars) ? fields.beforeChars : undefined,
      afterChars: Number.isInteger(fields.afterChars) ? fields.afterChars : undefined,
      bytesBefore: Number.isInteger(fields.bytesBefore) ? fields.bytesBefore : undefined,
      bytesAfter: Number.isInteger(fields.bytesAfter) ? fields.bytesAfter : undefined,
    };
    const p = join(DATA_DIR, "failover-events.jsonl");
    if (!logDirReady) {
      // mkdir 失败时重置为 null：下次调用重试建目录，而不是永久复用 rejected Promise
      // 导致后续遥测全部静默丢弃（2026-09-22 审查必须项）
      logDirReady = mkdir(join(p, ".."), { recursive: true })
        .catch((e2) => { logDirReady = null; throw e2; });
    }
    await logDirReady;
    // 轮转：rename 原子覆盖（见文件头注）；stat 任何失败（含不存在）都只是跳过轮转；
    // 轮转失败留诊断线索不阻断写入（权限类 stat 失败时随后的 append 同样失败并由外层
    // 诊断；AV 扫描/瞬时锁类失败自愈无害）。
    const st = await stat(p).catch(() => null);
    if (st && st.size > ASK_LOG_ROTATE_BYTES) {
      try {
        await rename(p, `${p}.1`);
      } catch (e3) {
        console.error(`hx-client: telemetry rotate failed（日志将继续追加原文件）: ${e3?.message ?? e3}`);
      }
    }
    await appendFile(p, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    // 遥测失败不影响主流程，但必留 stderr 诊断——静默丢弃会让排障无迹可循
    console.error(`hx-client: telemetry write failed: ${e?.message ?? e}`);
  }
}

async function logAskFailure(e, model, elapsedMs) {
  // 错误字段只落固定分类枚举，不落 e.message 原文：OpenAI 兼容网关在 400/422/内容策略类
  // 错误中常回显请求体片段，直写 message 有 prompt 泄漏面（二轮审查必须项）。
  // 电路 open 的提示文案是我们自己构造的、无上游文本，属安全例外。
  const cls = e?.circuitOpen ? "circuit_open"
    : isBodyTooLarge(e) ? "request_body_too_large"
    : isModelUnavailable(e) ? "model_unavailable"
    : statusOf(e) != null ? `http_${statusOf(e)}`
    : /总时长超过/.test(String(e?.message ?? "")) ? "timeout_total"
    : /空闲超过/.test(String(e?.message ?? "")) ? "timeout_idle"
    : /空响应/.test(String(e?.message ?? "")) ? "empty_response"
    : /响应无 body/.test(String(e?.message ?? "")) ? "no_body"
    : "network_error";
  await logAskEvent({
    action: "ask_fail",
    model,
    status: statusOf(e) ?? null,
    error: cls,
    elapsedMs,
  });
}

async function logAskShrink(model, beforeChars, afterChars, bytesBefore, bytesAfter, status, elapsedMs) {
  // 413 裁剪不是静默行为：留下裁剪前后字符数与 UTF-8 字节数，便于确认残缺请求
  // 确实被缩小后再重试（与 provider 的 bytesBefore/After 口径对齐）。
  await logAskEvent({
    action: "body_shrink_retry",
    model,
    status: status ?? null,
    beforeChars,
    afterChars,
    bytesBefore,
    bytesAfter,
    elapsedMs,
  });
}

// 部署副本 kilo.json 允许尾随逗号（installer 只剥行首 // 注释，Kilo 主程序 JSONC 宽松解析
// 接受尾随逗号），但严格 JSON.parse 在 JSC/Bun 下报 "Unexpected comma at the end of array
// expression"、V8 下报 "Unexpected token ]"——moa/dual_review 的 loadCfg 因此全挂（2026-09-24
// 实证：模板 commit ad2e312 加尾随逗号后 6 次工具调用全部立即报错）。这里先按严格解析，
// 失败再剥尾随逗号重试。剥离走字符级状态机而非正则：正则 /,(\s*[}\]])/g 会误伤字符串
// 字面量内的 ",}"（如 commit_message prompt 文本，单测实证），状态机跟踪引号/转义，
// 只在「逗号后紧跟空白+}或]」且不在字符串内时删除逗号。
function parseJsonTolerant(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripTrailingCommas(text));
  }
}

function stripTrailingCommas(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) continue; // 剥掉尾随逗号
    }
    out += c;
  }
  return out;
}

export async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < CFG_TTL_MS) return cfgCache;
  const kilo = parseJsonTolerant(await readFile(join(CONFIG_DIR, "kilo.json"), "utf8"));
  // 2026-10-16 provider 改名 hx → openllamas：优先读新结构，旧结构兜底（迁移窗口内两者并存）
  const opts = kilo?.provider?.openllamas?.options ?? kilo?.provider?.hx?.options ?? {};
  const auth = JSON.parse(await readFile(join(DATA_DIR, "auth.json"), "utf8"));
  const key = auth?.openllamas?.key ?? auth?.hx?.key;
  if (!opts.baseURL) throw new Error("hx-client: provider.openllamas.options.baseURL 未配置");
  if (!key) throw new Error("hx-client: auth.json 缺少 openllamas.key（请先登录/配置 openllamas provider）");
  cfgCache = { baseURL: String(opts.baseURL).replace(/\/+$/, ""), key, options: opts };
  cfgCacheAt = Date.now();
  return cfgCache;
}

// 聚合/裁决阶段保底墙钟（moa/dual_review 共用口径）：扇出烧完全局预算后仍给聚合一次
// 出结论的机会；两个工具此前各留一份同名常量，改一处漏一处会导致预算口径漂移。
export const AGG_MIN_BUDGET_MS = 90_000;

// 模型路由列表（moa/dual_review 共用）：首选 + 配置 fallback，去空、trim、去重保序。
// fallback 只在首选失败时启用；调用方显式覆盖模型时传空 fallback 表示精确指定。
// 保持无类型注解的 JS 语法：test-plugin-contract 用 Node 原生 strip-types 直接加载本文件，
// 新增 TS 专有语法会绕过该回归入口（实测 Node 22 在此处报 Unexpected token ':'）。
export function modelRoutes(primary, fallbacks) {
  const list = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((m) => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim());
  return [...new Set(list)];
}

// 超时解析单点（moa/dual-review 共用口径）：配置值先显式 Number 转换（"1000" 字符串
// 也接受），须为有限正数且 ≤ 2^31-1（setTimeout 超过该值会溢出立即触发），否则回退
// 共享兜底常量（回退不抛错——病态配置最多损失长超时，绝不让调用路径崩溃）。
// 收敛原因：该习语曾在 dual-review 漂移成 60_000 字面量。
export function timeoutsOf(options) {
  const t = Number(options?.timeout);
  const c = Number(options?.chunkTimeout);
  const ok = (n) => Number.isFinite(n) && n > 0 && n <= 2_147_483_647;
  return {
    timeoutMs: ok(t) ? t : FALLBACK_TIMEOUT_MS,
    idleMs: ok(c) ? c : FALLBACK_CHUNK_TIMEOUT_MS,
  };
}

// 截断并内联标注单点（prompt 组装共用，原 4 处重复习语）：截断事实随文本可见，
// 消费方（审查者/聚合模型）明确知道自己在看残件，不在残缺输入上假装全量结论。
// 软预算口径：截断后总长 = limit + 标注文本（下游均为 prompt 组装，无硬上限消费）；
// 末位防切断 UTF-16 代理对（emoji/生僻字产出孤立代理项）。
export function clipText(text, limit) {
  const t = String(text ?? "");
  if (t.length <= limit) return t;
  let cut = t.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + `\n（截断：原始 ${t.length} 字符）`;
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

// 单次尝试：SSE 流式拉取，直到 done。返回完整文本。
// 超时三层：首字节（headers 后到第一个 data:）、chunk 间空闲、总时长。
// signal：可选外部取消信号（预留通道，当前调用方暂无来源）；触发即中止底层连接。
async function attemptOnce({ baseURL, key, model, prompt, timeoutMs, idleMs, signal }) {
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
    const err = Object.assign(new Error(`${model} HTTP ${res.status}: ${body.slice(0, 300)}`), { statusCode: res.status });
    // 401 属凭证失效（key 轮换/过期）：立即失效缓存，下次 loadCfg 重读 auth.json（2026-09-22 审查必须项）
    if (res.status === 401) cfgCache = null;
    throw err;
  }
  if (!res.body) {
    cleanup();
    throw new Error(`${model}: 响应无 body（流式不可用）`);
  }

  // 排队回执拦截（2026-09-24 专项，与 provider/hx-failover withQueuedAckGuard 同口径）：
  // 网关过载时 stream 请求也可能收到 200 + JSON {"phase":"queued"} 而非 SSE——
  // 旧路径把它当普通流解析，无 data: 前缀的 JSON 行被丢弃 → 「空响应」通用错误，
  // 不过载分类、不进断路器计数、退避走普通档。此处识别同签名（content-type json +
  // ≤4KB + 顶层无 choices/error + phase queued/pending）→ 抛带 overloaded 措辞的
  // 503 语义错误，命中 isOverloadErr → CB 计数 + 2s/6s 过载退避（与主链路行为对齐）。
  const ctMeta = String(res.headers?.get?.("content-type") ?? "");
  if (/json/i.test(ctMeta)) {
    const raw = await res.text().catch(() => "");
    const trimmed = raw.trim();
    let parsedJson;
    if (trimmed.length <= 4096 && trimmed.startsWith("{")) {
      try { parsedJson = JSON.parse(trimmed); } catch { /* 非 JSON 忽略 */ }
    }
    if (parsedJson && parsedJson.choices === undefined && parsedJson.error === undefined) {
      const phaseQ = String(parsedJson.phase ?? "");
      if (phaseQ === "queued" || phaseQ === "pending") {
        cleanup();
        const err = Object.assign(
          new Error(
            `${model}: 网关排队回执（phase=${phaseQ}，未开始推理）—— upstream overloaded，按过载重试`,
          ),
          { statusCode: 503 },
        );
        throw err;
      }
    }
    // 200+json 但既非排队回执也非 SSE：显式报错（带 body 片段），不再流入 SSE 解析器
    if (!trimmed.startsWith("data:")) {
      cleanup();
      throw new Error(`${model}: 非 SSE 响应（content-type=${ctMeta}）：${trimmed.slice(0, 200)}`);
    }
  }

  // SSE 解析：按行拆，取 data: 载荷；[DONE] 结束；content 增量回调
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
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
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
        }
      }
    }
    // 流结束 flush：最后一块可能不带换行（规范上 SSE 事件以 \n 结尾，但防御非规范上游丢尾包）
    if (buf.trim().startsWith("data:")) {
      const payload = buf.trim().slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            text += delta;
          }
        } catch { /* 尾包非法 JSON 则放弃 */ }
      }
    }
  } finally {
    cleanup();
    try { await reader.cancel(); } catch { /* 已结束则忽略 */ }
  }

  if (!text) throw new Error(`${model}: 空响应（流结束无 content）`);
  return text;
}

function cancellationReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("请求已取消");
}

// 可中断退避：外部 abort 后不再等满 backoff（否则截止后仍会空转数秒）。
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancellationReason(signal)); return; }
    let timer;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(cancellationReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // 监听器注册与 abort 可能竞态：注册后复查一次，避免漏事件。
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
  });
}

// 对外接口（兼容旧签名：直接 await 返回字符串）。signal 可选取消透传。
// 重试墙钟预算（2026-09-22 审查必须项）：
//   - 「总时长超时」类失败不重试——剩余预算已装不下一次完整尝试，重试只是再烧 timeoutMs；
//   - 已耗时 ≥ timeoutMs 不再发起新尝试。
//   单次 ask 最坏墙钟从 ~3×timeout 收敛到 ~2×timeout（快速失败类仍有重试保护）。
export async function ask({ baseURL, key, model, prompt, timeoutMs, idleMs, attempts, signal }) {
  if (signal?.aborted) throw cancellationReason(signal);
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : MAX_ATTEMPTS;
  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : FALLBACK_TIMEOUT_MS;
  const t0 = Date.now();
  const requestEpoch = cbEpoch; // 本次请求所属状态代次：closed 态迟到 503 不得污染新阈值
  let lastErr;
  let holdProbe = false; // 本次 ask 是否持有 half-open probe 锁（finally 兜底仅限持锁者）
  let bodyShrinkLevel = 0; // 413 逐级裁剪层数（最多 3 级，原始 + 3 次裁剪 = 4 次请求）
  let probeGeneration = -1; // 本次 probe 的代次（仅 holdProbe 时有效）
  try {
    for (let i = 0; i < maxAttempts; i++) {
      if (signal?.aborted) throw cancellationReason(signal);
      // 断路器检查：open → fail fast；half-open → 放单 probe（cbProbeInFlight 锁防并发穿透）
      const gate = cbAllowRequest();
      if (!gate) {
        // 时钟回拨下差值为负时不再显示负数秒数（与回拨放行口径一致）
        const cooldownLeft = Math.ceil(Math.max(CB_COOLDOWN_MS - Math.max(0, Date.now() - cbOpenedAt), 0) / 1000);
        const e = Object.assign(new Error(`${model}: 断路器 open（上游网关过载），${cooldownLeft}s 后探测恢复。跳过请求。`), { circuitOpen: true });
        await logAskFailure(e, model, Date.now() - t0);
        throw e;
      }
      if (gate === "probe") { holdProbe = true; probeGeneration = cbProbeGeneration; }
      try {
        const text = await attemptOnce({ baseURL, key, model, prompt, timeoutMs, idleMs, signal });
        // 截止/取消与成功同刻到达：不返回迟到结果（调用方已按取消收口）。
        if (signal?.aborted) {
          cbOnProbeNeutral(holdProbe, probeGeneration);
          holdProbe = false;
          throw cancellationReason(signal);
        }
        cbOnSuccess(holdProbe, probeGeneration, requestEpoch);
        return text;
      } catch (e) {
        lastErr = e;
        // 外部取消不是网关故障：立即退出重试循环（原路径会继续 backoff/重试，截止后仍空转）。
        if (signal?.aborted) {
          cbOnProbeNeutral(holdProbe, probeGeneration);
          holdProbe = false;
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        const status = statusOf(e);
        // 413 体积超限：同一 body 重试必然再 413，换模型也无用（体积与模型无关）。
        // 直连 prompt 是单字符串：逐级半长裁剪，最多 3 级后仍超限才按原文 fatal；
        // 每次裁剪用 i -= 1 抵消循环自增，不占用普通重试预算，总量由层数封顶。
        // 413 是客户端体积问题、不是网关过载：half-open probe 也中性释放后裁剪重试，
        // 不把该错误算成网关故障（否则所有健康模型陪跑 30s 冷却）。
        if (isBodyTooLarge(e)) {
          cbOnProbeNeutral(holdProbe, probeGeneration);
          holdProbe = false;
          if (bodyShrinkLevel < MAX_BODY_SHRINK_LEVELS && typeof prompt === "string" && prompt.length > BODY_SHRINK_MIN_CHARS) {
            const beforeChars = prompt.length;
            const beforeBytes = utf8Bytes(prompt);
            const nextPrompt = clipText(prompt, Math.max(BODY_SHRINK_MIN_CHARS, Math.floor(prompt.length / 2)));
            if (nextPrompt.length < prompt.length) {
              bodyShrinkLevel++;
              prompt = nextPrompt;
              await logAskShrink(model, beforeChars, prompt.length, beforeBytes, utf8Bytes(prompt), status, Date.now() - t0);
              i -= 1;
              continue;
            }
          }
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        // 400 区域策略 / 402 余额签名：单模型渠道约束，快速失败交上层 askRoute 换模型，
        // 不在同一 body/同一 key 上空转重试（与 provider 侧换 hop 同口径）。
        // 模型级 4xx 不重开熔断：网关已返回确定响应，说明可达且未过载。
        if (isModelUnavailable(e)) {
          cbOnProbeNeutral(holdProbe, probeGeneration);
          holdProbe = false;
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        // 确定性失败（HTTP 4xx 已知状态码）不重试；中断（AbortError 由我们主动 abort 触发）按超时算可重试
        if (NON_RETRYABLE_STATUS.has(status)) {
          cbOnProbeNeutral(holdProbe, probeGeneration); // half-open probe 遭 4xx：网关可达，中性释放
          holdProbe = false;
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        // 2026-09-27 查漏补缺：503 渠道/模型不可用（model_not_found 类）也是确定性失败——
        // 渠道不会因退避恢复，3 连重试纯空转 ~8s 且每次都 trip 断路器（网关本身健康），
        // 反而把后续 moa/dual_review 请求挡在断路器外（实证：2026-09-27 探测-拦截循环）。
        // 不重试、不 trip、不退避，快速失败交给上层降级链换模型。
        if (status === 503 && !isOverloadErr(e)) {
          cbOnProbeNeutral(holdProbe, probeGeneration);
          holdProbe = false;
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        // 墙钟预算耗尽（总时长超时或已耗时过半途预算）：不再重试
        const totalTimeout = typeof e?.message === "string" && e.message.includes("总时长超过");
        if (totalTimeout || Date.now() - t0 >= budgetMs) {
          if (isOverloadErr(e)) cbOnOverloadFail(holdProbe, probeGeneration, requestEpoch);
          else cbOnProbeFail(holdProbe, probeGeneration); // probe 超时/网络错：同样回退 open
          await logAskFailure(e, model, Date.now() - t0);
          throw e;
        }
        // 503 过载：断路器计数 + 专用退避（2s/6s 给上游喘息，而非 400ms 火上浇油）
        if (isOverloadErr(e)) {
          cbOnOverloadFail(holdProbe, probeGeneration, requestEpoch);
          // 断路器已翻 open（含 half-open probe 过载失败）：剩余重试不再发请求
          if (cbState === "open" && i < maxAttempts - 1) {
            continue; // 下一轮 cbAllowRequest() 判定，open 时直接 fail fast
          }
          if (i < maxAttempts - 1) {
            await sleepWithSignal(OVERLOAD_BACKOFF_MS[i] ?? 6000, signal);
          }
        } else {
          // 4xx（408 超时除外）是模型/请求级错误：网关可达，中性释放 probe 后照常退避重试；
          // 只有 5xx/超时/网络错才回退 open。408 语义是网关超时，仍按探测失败处理。
          if (typeof status === "number" && status >= 400 && status < 500 && status !== 408) {
            cbOnProbeNeutral(holdProbe, probeGeneration);
            holdProbe = false;
          } else {
            cbOnProbeFail(holdProbe, probeGeneration); // probe 超时/网络错/5xx：回退 open（closed 态无操作）
          }
          if (i < maxAttempts - 1) {
            await sleepWithSignal(BACKOFF_MS[i] ?? 1200, signal);
          }
        }
      }
    }
    cbOnProbeFail(holdProbe, probeGeneration); // 重试耗尽的最终失败：probe 态同样回退
    await logAskFailure(lastErr, model, Date.now() - t0);
    throw lastErr;
  } finally {
    // probe 锁兜底（仅本次 ask 持锁时）：正常路径已由 cbOnSuccess/cbOnProbeFail/
    // cbOnProbeNeutral/cbOnOverloadFail 释放；异常/取消/未分类错误路径可能跳过结局处理器——finally 确保
    // 不永久卡死 half-open。未持锁的并发请求（fail fast 路径）不触发，防破坏在途 probe。
    if (holdProbe) cbReleaseProbeIfStuck(probeGeneration);
  }
}

// 带硬墙钟的 ask：到点 abort 底层 fetch（不再只 race 一个结果无人消费），并统一错误文案。
// 调用方传绝对截止时间；每个候选模型独立计时，路由层仍可按剩余预算续试。
export async function askWithDeadline(args, deadlineMs, tag) {
  const remaining = Math.max(1, deadlineMs - Date.now());
  const controller = new AbortController();
  const reason = new Error(`${tag} 墙钟预算 ${Math.round(remaining / 1000)}s 到期`);
  const timer = setTimeout(() => controller.abort(reason), remaining);
  timer.unref?.();
  try {
    return await ask({ ...args, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── 测试钩子（仅 scripts/test-circuit-breaker.mjs 消费；生产代码不得调用）──
// cbReleaseProbeIfStuck 属防御性兜底：logAskFailure/logAskEvent 均自捕获，正常路径
// 不可达，无法通过公开 ask() 稳定注入异常；钩子仅用于验证状态机兜底语义本身。
export const _test = {
  forceHalfOpenProbe(gen) {
    cbState = "half-open";
    cbProbeInFlight = true;
    cbGeneration = gen;
    cbProbeGeneration = gen;
  },
  releaseProbeIfStuck(gen) {
    cbReleaseProbeIfStuck(gen);
  },
};