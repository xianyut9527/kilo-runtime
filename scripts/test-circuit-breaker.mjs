// 断路器离线验证 v7：断路器全生命周期 + 三轮审查必须项场景。
// v6 新增：跨代迟到成功/失败不污染 half-open、open 态迟到过载不刷新冷却。
// v7 新增（2026-09-28 查漏补缺）：404 NO_ROUTE_CANDIDATE 与 503 "no active channel
// candidate" 变体均为确定性渠道故障——单次即抛、不重试、不进退避、不 trip（42 断言全绿为过）。
// 运行：node --experimental-strip-types scripts/test-circuit-breaker.mjs
// （直接动态 import lib/hx-client.ts，靠 ?r= 查询串击穿 ESM 缓存取得全新断路器状态；
//   网络层打桩，不联网、不起 Kilo）
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// bun 守卫：bun 的 fetch 打桩/Response 语义与 node 不同，401 与网络错场景会假失败
// （2026-09-22 实测 bun 3 假失败 / node 18 全绿）——必须用文档口径的 node 跑。
if (typeof Bun !== "undefined") {
  console.error("需要 node --experimental-strip-types 运行（bun 的 fetch/TS 语义差异会产生假失败）：node --experimental-strip-types scripts/test-circuit-breaker.mjs");
  process.exit(2);
}

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
const TMP = path.join(tmpdir(), "cb-test-" + Date.now());
mkdirSync(TMP, { recursive: true });
process.env.KILO_CONFIG_DIR = TMP;
process.env.XDG_DATA_HOME = TMP;
writeFileSync(path.join(TMP, "kilo.json"), JSON.stringify({
  provider: { hx: { options: { baseURL: "http://stub.local/v1", timeout: 5000, chunkTimeout: 2000 } } },
}));
writeFileSync(path.join(TMP, "auth.json"), JSON.stringify({ hx: { key: "test-key" } }));

const results = [];
const assert = (name, cond) => { results.push(`${cond ? "✅" : "❌"} ${name}`); if (!cond) process.exitCode = 1; };

const realNow = Date.now.bind(Date);
let fakeTime = realNow();
Date.now = () => fakeTime;

let fetchCalls = 0;
let fetchMode = "overload";

function makeFetch() {
  return async () => {
    fetchCalls++;
    if (fetchMode === "overload") return { ok: false, status: 503, text: async () => "system cpu overloaded" };
    if (fetchMode === "nochan") return { ok: false, status: 503, text: async () => JSON.stringify({ error: { code: "model_not_found", message: "No available channel for model glm-5.2 under group svip (distributor)" } }) };
    if (fetchMode === "nochan503b") return { ok: false, status: 503, text: async () => JSON.stringify({ code: "NO_ROUTE_CANDIDATE", msg: "no active channel candidate for model (protocol=openai)", data: null }) };
    if (fetchMode === "nochan404") return { ok: false, status: 404, text: async () => JSON.stringify({ code: "NO_ROUTE_CANDIDATE", msg: "no active channel candidate for model (protocol=openai)", data: null }) };
    if (fetchMode === "nochan404b") return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: "Model not exist.", type: "invalid_request_error", param: "", code: "model_not_found" } }) };
    if (fetchMode === "neterr") throw new Error("ECONNRESET");
    if (fetchMode === "throw") throw new Error("SYNC_THROW_BEFORE_PARSE");
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
}

const freshLoad = async (n) => {
  fetchCalls = 0; fetchMode = "overload";
  globalThis.fetch = makeFetch();
  return await import(`file://${pathToFileUrl(path.join(PLUGIN_DIR, "hx-client.ts"))}?r=${n}-${Math.random()}`);
};

// path → URL（Windows 盘符等特殊字符安全），避免 node:url 导入顶置依赖顺序问题
function pathToFileUrl(p) {
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1").split("/").map(encodeURIComponent).join("/");
}

const tripCircuit = async (ask) => {
  fetchMode = "overload";
  // 3 次单尝试过载（等价一次默认重试链的 trip 语义，且无 2s/6s 真实退避等待）
  for (let i = 0; i < 3; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
};

// 1. trip + 3 fetch
{
  const { ask, circuitState } = await freshLoad(1);
  await tripCircuit(ask);
  assert("3 连过载 trip → open", circuitState() === "open" && fetchCalls === 3);
}

// 2. open 态迟到成功不关断（串行模拟）
//    trip → open → 在 open 期间跑一个成功 ask（但 open 态应 fail fast，不会真 fetch 成功）
//    所以测 cbOnSuccess 语义：open 态下任何成功调用不改变 open
{
  const { ask, circuitState } = await freshLoad(2);
  await tripCircuit(ask);
  assert("trip 后 open", circuitState() === "open");
  // open 态 + cooldown 未过 → fail fast（不会 fetch、不会走 cbOnSuccess）
  fetchCalls = 0;
  let err = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "late", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { err = e; }
  assert("open 态 fail fast（0 fetch）", fetchCalls === 0 && err && /断路器/.test(err.message));
  assert("open 态未被迟到成功关断", circuitState() === "open");
}

// 3. probe 锁泄漏兜底：half-open probe 失败 → 回退 open → 后续不卡死
{
  const { ask, circuitState } = await freshLoad(3);
  await tripCircuit(ask);
  fakeTime += 31_000; // 进 half-open
  fetchMode = "neterr";
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 3000, idleMs: 1000, attempts: 1 }); } catch {}
  assert("probe 失败回退 open", circuitState() === "open");
  // 后续 fail fast（证明 probe 锁已释放）
  fetchCalls = 0;
  let err = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "next", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { err = e; }
  assert("probe 释放后不卡死（fail fast）", err && /断路器/.test(err.message) && fetchCalls === 0);
}

// 4. probe 成功关断
{
  const { ask, circuitState } = await freshLoad(4);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "ok";
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000 });
  assert("probe 成功 → closed", r === "hello" && circuitState() === "closed");
}

// 5. probe 过载失败回退 open
{
  const { ask, circuitState } = await freshLoad(5);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "overload";
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); } catch {}
  assert("probe 过载失败回退 open", circuitState() === "open");
}

// 6. 401 不触发 + closed 态网络错不触发
{
  const { ask, circuitState } = await freshLoad(6);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { assert("401 直接抛", e.statusCode === 401); }
  assert("401 不触发断路器", circuitState() === "closed");

  const mod2 = await freshLoad(7);
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  try { await mod2.ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 1000, idleMs: 500, attempts: 1 }); } catch {}
  assert("closed 态网络错不触发", mod2.circuitState() === "closed");
}

// 6b. 410 Gone 确定性失败不重试（2026-09-27 补：退役端点重试纯属浪费）
//     410 语义 = 资源永久移除，与 404 同类；NON_RETRYABLE_STATUS 纳入后应只发 1 次请求。
{
  const { ask, circuitState } = await freshLoad("6b");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 410, text: async () => "model retired" }; };
  let err = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "retired", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { err = e; }
  assert("410 直接抛（statusCode 透传）", err && err.statusCode === 410);
  assert("410 不重试（仅 1 次 fetch，无 400/1200ms 空转）", calls === 1);
  assert("410 不触发断路器", circuitState() === "closed");
}

// 7. half-open 单 probe 锁：并发 fanout 第二路被拦（冻结 probe 使其在途）
{
  const { ask, circuitState } = await freshLoad(8);
  await tripCircuit(ask);
  fakeTime += 31_000;
  // 冻结式 fetch：probe 请求挂起不返回，保持在途
  let unfreeze = null;
  globalThis.fetch = async () => {
    await new Promise((r) => { unfreeze = r; });
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
  const p1 = ask({ baseURL: "http://x/v1", key: "k", model: "p1", prompt: "x", timeoutMs: 5000, idleMs: 2000 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); // 等 p1 拿到 probe 锁并进入冻结 fetch
  fetchCalls = 0;
  let err2 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "p2", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { err2 = e; }
  assert("并发 fanout 被 probe 锁拦（0 fetch）", err2 && /断路器/.test(err2.message) && fetchCalls === 0);
  unfreeze?.(); // 解冻 p1
  await p1;
  assert("p1 解冻后完成并关断", circuitState() === "closed");
}

// 8. 跨代隔离：trip 前发出的旧请求迟到成功不提前关断 half-open probe
{
  const { ask, circuitState } = await freshLoad(9);
  await tripCircuit(ask);
  fakeTime += 31_000; // 进 half-open
  // 真 probe 挂起（模拟在途），同时模拟一个旧请求迟到成功
  let unfreeze = null;
  globalThis.fetch = async () => {
    await new Promise((r) => { unfreeze = r; });
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
  const p1 = ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); // p1 拿到 probe 锁
  // half-open 态下非 probe 路径不应关断/不应释放 probe 锁：
  // p2 在 probe 锁占用时被 fail fast（若旧请求成功能释放锁，p2 会 fetch 并关断）
  fetchCalls = 0;
  let err2 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "old-late", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); }
  catch (e) { err2 = e; }
  assert("half-open 态非 probe 请求仍被 probe 锁拦", err2 && /断路器/.test(err2.message) && fetchCalls === 0);
  assert("half-open 态未被关断（等待 probe）", circuitState() === "half-open");
  unfreeze?.();
  await p1;
  assert("probe 完成后关断", circuitState() === "closed");
}

// 9. open 态迟到过载不刷新 openedAt：冷却自 trip 时刻起算
{
  const { ask, circuitState } = await freshLoad(10);
  await tripCircuit(ask);
  const tripTime = Date.now();
  // 模拟一个 trip 前发出的旧请求在 open 态迟到过载失败（经 cbOnOverloadFail(false)）
  // 实现：在 open 态 + cooldown 未满时再跑一次 overload ask → 被 fail fast 不 fetch
  // 但若回调路径有 leak（如 open 态迟到过载刷新 openedAt），冷却会顺延
  fetchMode = "overload";
  fetchCalls = 0;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "late-overload", prompt: "x", timeoutMs: 5000, idleMs: 2000 }); } catch {}
  // open 态应 fail fast（0 fetch），且冷却起点不变
  assert("open 态迟到过载被 fail fast（0 fetch）", fetchCalls === 0);
  // 推进到原冷却结束时间 → 应能进 half-open（若 openedAt 被刷新则此时还 open）
  fakeTime = tripTime + 31_000;
  fetchMode = "ok";
  fetchCalls = 0;
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 });
  assert("冷却自 trip 时刻起算（31s 后 probe 成功关断）", r === "hello" && circuitState() === "closed" && fetchCalls === 1);
}

// 10. 排队回执拦截（2026-09-24 专项）：200+JSON {"phase":"queued"} 必须按过载处理
//     ——旧路径 SSE 解析器丢弃无 data: 前缀的 JSON 行 → 「空响应」通用错误，
//     不过载分类、不进 CB 计数（比 provider 侧晚一个身位的同口径补齐）。
{
  const { ask, circuitState } = await freshLoad(11);
  // 10a：单次 ask → 抛「排队回执」且 statusCode 503、消息含 overloaded 措辞
  const queuedBody = JSON.stringify({ request_id: "req-q", seq: 1, position: 0, phase: "queued" });
  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true, status: 200, body: {},
      headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => queuedBody,
    };
  };
  fetchCalls = 0;
  let err10 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "q1", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); }
  catch (e) { err10 = e; }
  assert("排队回执转 503 语义错误", err10 && /排队回执/.test(err10.message) && err10.statusCode === 503 && /overloaded/.test(err10.message) && fetchCalls === 1);

  // 10b：连续 3 次排队回执 → 断路器 open（证明被 isOverloadErr 分类计数，而非通用错误）
  for (let i = 0; i < 2; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: `q2-${i}`, prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("排队回执计入断路器（3 连 → open）", circuitState() === "open");

  // 10c：200+json 非 SSE 且非排队回执 → 显式「非 SSE 响应」错误，不进 CB 计数
  fakeTime += 31_000; // 出冷却进 half-open
  const oddJson = JSON.stringify({ foo: "bar" });
  globalThis.fetch = async () => ({
    ok: true, status: 200, body: {},
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => oddJson,
  });
  let err10c = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "q3", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); }
  catch (e) { err10c = e; }
  assert("非排队 JSON 显式报错", err10c && /非 SSE 响应/.test(err10c.message) && err10c.statusCode === undefined);

  // 10d：正常 SSE（无 headers 属性的旧打桩形状）不受拦截影响。
  //     10c 的 probe 失败已把 CB 打回 open，推进冷却进 half-open 再探。
  fakeTime += 31_000;
  const enc = new TextEncoder();
  const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
  globalThis.fetch = async () => {
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
  const r10 = await ask({ baseURL: "http://x/v1", key: "k", model: "q4", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }).catch((e) => `ERR:${e.message}`);
  assert("SSE 正常路径不受拦截影响", r10 === "hello");
}

// 11. 预检死锁回归（2026-09-25 线上专项）：moa/dual_review 的断路器预检
//     改用 cbShouldFailFast()（冷却已过即放行）——预检只看 circuitState()==="open"
//     会永远拦住冷却后的第一次 ask()，而 open→half-open 迁移只发生在 ask() 内，
//     断路器将永久 open（线上实证：trip 后网关早已恢复，工具仍连续数小时秒回
//     「断路器开启，稍后重试」，hx-client 遥测零条——请求根本没发出）。
{
  const { ask, circuitState, cbShouldFailFast } = await freshLoad(12);
  await tripCircuit(ask);
  assert("预检回归前置：trip 后 open 且应 fail fast", circuitState() === "open" && cbShouldFailFast() === true);
  // 冷却窗口内预检拦截（同旧行为）
  fakeTime += 10_000;
  assert("冷却内预检仍 fail fast", cbShouldFailFast() === true);
  // 冷却到期：预检必须放行（这是修复点——旧实现此时刻 circuitState() 仍是 "open"）
  fakeTime += 21_000;
  assert("冷却到期预检放行（不再永久拦）", cbShouldFailFast() === false);
  // 预检放行后真正 ask：cbAllowRequest 迁移 half-open 放 probe，网关已恢复 → 关断
  fetchMode = "ok";
  fetchCalls = 0;
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 });
  assert("预检放行后 probe 成功关断", r === "hello" && circuitState() === "closed" && fetchCalls === 1);
}

// 12. 时钟回拨回归（2026-09-26 补审必须项）：Date.now() 回拨后 Date-cbOpenedAt 为严格负、
//     Math.max(0,…) 归一是错方（0 仍 < 冷却值恒拦截）——须按「差值 <0 视为已过冷却」
//     放行，否则死锁在时钟回拨边界复现；差值 ==0（同毫秒刚 trip）仍保守拦截。
{
  const { ask, circuitState, cbShouldFailFast } = await freshLoad(13);
  await tripCircuit(ask);
  assert("回拨前置：trip 后预检拦截", cbShouldFailFast() === true);
  // 时钟回拨 5s：cbOpenedAt 晚于当前墙钟 → 差值为负
  fakeTime -= 5_000;
  assert("时钟回拨下预检放行（负差值归一）", cbShouldFailFast() === false);
  // ask() 的 cbAllowRequest 同口径：回拨后也必须能进 half-open 放 probe（而非 fail fast 死锁）
  fetchMode = "ok";
  fetchCalls = 0;
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "skew-probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }).catch((e) => `ERR:${e.message}`);
  assert("时钟回拨下 probe 成功关断（迁移不死锁）", r === "hello" && circuitState() === "closed" && fetchCalls === 1);
}

// 13. 503 渠道/模型不可用回归（2026-09-27 查漏补缺）：model_not_found 类是确定性故障——
//     渠道按模型隔离且不会因退避恢复：不重试（3 连空转 ~8s 实证）、不 trip 断路器
//     （网关本身健康，真过载期不应被确定性故障误伤）、快速失败交上层降级链换模型。
{
  const { ask, circuitState } = await freshLoad(14);
  fetchMode = "nochan";
  fetchCalls = 0;
  const t0 = Date.now();
  let err13 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "glm-5.2", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err13 = e; }
  assert("渠道不可用单次失败即抛（不 3 连空转）", err13?.statusCode === 503 && fetchCalls === 1);
  assert("渠道不可用不 trip 断路器（保持 closed）", circuitState() === "closed");
  assert("渠道不可用错误不进退避（快速失败）", (Date.now() - t0) < 1000);
  // 确定性故障后断路器仍健康：过载场景照常计数（不影响真过载保护）
  fetchMode = "overload";
  await tripCircuit(ask);
  assert("渠道故障后过载保护不受影响（trip 正常）", circuitState() === "open");
}

// 14. 404 NO_ROUTE_CANDIDATE 渠道不可用回归（2026-09-28 查漏补缺，provider 侧同批）：
//     生产实证形态（glm-5.3-flash 渠道下线期网关回 404 + NO_ROUTE_CANDIDATE）。
//     hx-client 经 NON_RETRYABLE_STATUS(404) 确定性失败——单次即抛、不重试、不 trip。
//     墙钟断言用 realNow（场景内 Date.now 假时钟冻结，会掩盖真实退避睡眠）。
{
  const { ask, circuitState } = await freshLoad(15);
  fetchMode = "nochan404";
  fetchCalls = 0;
  const t0 = realNow();
  let err14 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "glm-5.3-flash", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err14 = e; }
  assert("404 渠道不可用单次失败即抛（不重试）", err14?.statusCode === 404 && fetchCalls === 1);
  assert("404 渠道不可用不 trip 断路器（保持 closed）", circuitState() === "closed");
  assert("404 渠道不可用快速失败（真实墙钟 <1s）", (realNow() - t0) < 1000);
}

// 15. 503 + "no active channel candidate" 变体（2026-09-28 口径对齐回归）：
//     同一 NO_ROUTE_CANDIDATE 报文若以 503 返回——修复前 isOverloadErr 正则缺该文案 →
//     误判过载：2s/6s 退避 + 3 连空转（~8s）+ 断路器计数；修复后与 model_not_found 同
//     语义：单次即抛、不进退避、不 trip。
{
  const { ask, circuitState } = await freshLoad(16);
  fetchMode = "nochan503b";
  fetchCalls = 0;
  const t0 = realNow();
  let err15 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "glm-5.3-flash", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err15 = e; }
  assert("503 渠道变体单次失败即抛（不 3 连空转）", err15?.statusCode === 503 && fetchCalls === 1);
  assert("503 渠道变体不 trip 断路器（保持 closed）", circuitState() === "closed");
  assert("503 渠道变体不进退避（真实墙钟 <1s）", (realNow() - t0) < 1000);
}

// 16. 404 + model_not_found "Model not exist."（2026-10-01 21:50 生产事故原样报文）：
//     hx-client 经 NON_RETRYABLE_STATUS(404) 确定性失败——单次即抛、不重试、不 trip。
//     断言错误透传完整性（statusCode + body 报文进 message）——provider 侧统一签名
//     CHANNEL_UNAVAILABLE_RE 依赖该透传命中渠道不可用判定（换链而非 fatal）。
{
  const { ask, circuitState } = await freshLoad(17);
  fetchMode = "nochan404b";
  fetchCalls = 0;
  const t0 = realNow();
  let err16 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "glm-5.3-flash", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err16 = e; }
  assert("404 notexist 单次失败即抛（不重试）", err16?.statusCode === 404 && fetchCalls === 1);
  assert("404 notexist 不 trip 断路器（保持 closed）", circuitState() === "closed");
  assert("404 notexist 快速失败（真实墙钟 <1s）", (realNow() - t0) < 1000);
  assert("404 notexist 错误透传完整（status+body 报文，供 provider 侧签名判定）", String(err16?.message ?? "").includes("Model not exist") && String(err16?.message ?? "").includes("model_not_found"));
}

Date.now = realNow;
console.log(results.join("\n"));
rmSync(TMP, { recursive: true, force: true });
