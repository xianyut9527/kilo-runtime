// 断路器离线验证 v7：断路器全生命周期 + 三轮审查必须项场景。
// v6 新增：跨代迟到成功/失败不污染 half-open、open 态迟到过载不刷新冷却。
// v7 新增（2026-09-28 查漏补缺）：404 NO_ROUTE_CANDIDATE 与 503 "no active channel
// candidate" 变体均为确定性渠道故障——单次即抛、不重试、不进退避、不 trip（42 断言全绿为过）。
// v8 新增（2026-10-16 查漏补缺）：loadCfg 结构回归——provider 改名 hx→openllamas 后
//   新旧结构优先级无常驻覆盖（22 处 ask 全部显式传参绕过 loadCfg，顶部夹具仅 legacy 形态），
//   锁死 openllamas 优先 + 两侧独立兜底 + 错误文案点名。
// v9 新增（2026-10-24 二轮审查）：half-open probe 遇 400/402/413 模型级错误走中性释放，
//   不重开熔断；413 裁剪后日志记 before/after 长度。
// 运行：node --experimental-strip-types scripts/test-circuit-breaker.mjs
// （直接动态 import lib/hx-client.ts，靠 ?r= 查询串击穿 ESM 缓存取得全新断路器状态；
//   网络层打桩，不联网、不起 Kilo）
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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
mkdirSync(path.join(TMP, "kilo"), { recursive: true }); // DATA_DIR = XDG_DATA_HOME/kilo
process.env.KILO_CONFIG_DIR = TMP;
process.env.XDG_DATA_HOME = TMP;
writeFileSync(path.join(TMP, "kilo.json"), JSON.stringify({
  provider: { hx: { options: { baseURL: "http://stub.local/v1", timeout: 5000, chunkTimeout: 2000 } } },
}));
writeFileSync(path.join(TMP, "kilo", "auth.json"), JSON.stringify({ hx: { key: "test-key" } }));

const results = [];
const assert = (name, cond) => { results.push(`${cond ? "✅" : "❌"} ${name}`); if (!cond) process.exitCode = 1; };

const realNow = Date.now.bind(Date);
let fakeTime = realNow();
Date.now = () => fakeTime;

let fetchCalls = 0;
let fetchMode = "overload";
let lastRequestBody = "";
let body413Calls = 0;

function makeFetch() {
  return async (_url, opts) => {
    fetchCalls++;
    lastRequestBody = String(opts?.body ?? "");
    if (fetchMode === "overload") return { ok: false, status: 503, text: async () => "system cpu overloaded" };
    if (fetchMode === "nochan") return { ok: false, status: 503, text: async () => JSON.stringify({ error: { code: "model_not_found", message: "No available channel for model glm-5.2 under group svip (distributor)" } }) };
    if (fetchMode === "nochan503b") return { ok: false, status: 503, text: async () => JSON.stringify({ code: "NO_ROUTE_CANDIDATE", msg: "no active channel candidate for model (protocol=openai)", data: null }) };
    if (fetchMode === "nochan404") return { ok: false, status: 404, text: async () => JSON.stringify({ code: "NO_ROUTE_CANDIDATE", msg: "no active channel candidate for model (protocol=openai)", data: null }) };
    if (fetchMode === "nochan404b") return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: "Model not exist.", type: "invalid_request_error", param: "", code: "model_not_found" } }) };
    if (fetchMode === "policy400") return { ok: false, status: 400, text: async () => "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it." };
    if (fetchMode === "quota402") return { ok: false, status: 402, text: async () => "insufficient personal balance" };
    if (fetchMode === "payment402") return { ok: false, status: 402, text: async () => "Payment required" };
    if (fetchMode === "plain400") return { ok: false, status: 400, text: async () => "bad request" };
    if (fetchMode === "plain404") return { ok: false, status: 404, text: async () => "not found" };
    if (fetchMode === "plain422") return { ok: false, status: 422, text: async () => "invalid input" };
    if (fetchMode === "overloaded400") return { ok: false, status: 400, text: async () => "system cpu overloaded" };
    if (fetchMode === "overloadedNet") throw new Error("system cpu overloaded");
    if (fetchMode === "overloaded502") return { ok: false, status: 502, text: async () => "system cpu overloaded" };
    if (fetchMode === "bodyLimit") {
      if (Buffer.byteLength(lastRequestBody, "utf8") > 2_000_000) {
        return { ok: false, status: 413, text: async () => "request body too large" };
      }
    }
    if (fetchMode === "body413") {
      body413Calls++;
      if (body413Calls === 1) return { ok: false, status: 413, text: async () => "request body too large" };
    }
    if (fetchMode === "body413always") return { ok: false, status: 413, text: async () => "request body too large" };
    if (fetchMode === "neterr") throw new Error("ECONNRESET");
    if (fetchMode === "throw") throw new Error("SYNC_THROW_BEFORE_PARSE");
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
}

const freshLoad = async (n) => {
  fetchCalls = 0; fetchMode = "overload"; lastRequestBody = ""; body413Calls = 0;
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

// 8b. 跨代隔离（4xx）：trip 前发出的旧请求迟到 400 不得关断新一代 half-open probe。
{
  const { ask, circuitState } = await freshLoad(9.5);
  let releaseOld;
  let releaseProbe;
  let call = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    call++;
    if (call === 1) {
      await new Promise((r) => { releaseOld = r; });
      return { ok: false, status: 400, text: async () => "bad request" };
    }
    if (call === 5) {
      await new Promise((r) => { releaseProbe = r; });
      const enc = new TextEncoder();
      const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
    }
    return { ok: false, status: 503, text: async () => "system cpu overloaded" };
  };
  const pOld = ask({ baseURL: "http://x/v1", key: "k", model: "old", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); // 旧请求已进入冻结 fetch（非 probe）
  await tripCircuit(ask); // 旧请求在途时 3 连过载 trip
  fakeTime += 31_000;
  const pProbe = ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); // 新代 probe 已持锁
  releaseOld?.();
  await pOld;
  assert("旧请求迟到 400 不关断 half-open", circuitState() === "half-open");
  fetchCalls = 0;
  let blocked = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "blocked", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch (e) { blocked = e; }
  assert("旧请求 400 后 probe 锁仍有效", blocked && /断路器/.test(blocked.message) && fetchCalls === 0);
  releaseProbe?.();
  await pProbe;
  assert("新代 probe 成功后才关断", circuitState() === "closed");
}

// 8c. 跨代隔离（503 计数）：trip 前发出的旧请求迟到 503 不得污染新一代过载阈值。
{
  const { ask, circuitState } = await freshLoad(9.7);
  let releaseStale;
  let call = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    call++;
    if (call === 1) {
      await new Promise((r) => { releaseStale = r; });
      return { ok: false, status: 503, text: async () => "system cpu overloaded" };
    }
    if (call === 5) {
      const enc = new TextEncoder();
      const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
    }
    return { ok: false, status: 503, text: async () => "system cpu overloaded" };
  };
  const pStale = ask({ baseURL: "http://x/v1", key: "k", model: "stale", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); // 旧 503 已冻结
  await tripCircuit(ask); // calls 2-4 → open
  fakeTime += 31_000;
  const rProbe = await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 });
  assert("8c 探针成功关断", rProbe === "hello" && circuitState() === "closed");
  releaseStale?.();
  await pStale;
  assert("8c 旧 503 不污染计数（仍 closed）", circuitState() === "closed");
  for (let i = 0; i < 2; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: `fresh-${i}`, prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("8c 两次新 503 未提前开断", circuitState() === "closed");
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "fresh-3", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  assert("8c 第三次新 503 才开断", circuitState() === "open");
}

// 8d. 跨代隔离（迟到成功）：trip 前发出的旧请求迟到 200 不得清零新一代过载计数。
{
  const { ask, circuitState } = await freshLoad(9.9);
  let releaseStale;
  let call = 0;
  const sse = () => {
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: chunk }; } }) } };
  };
  globalThis.fetch = async () => {
    fetchCalls++;
    call++;
    if (call === 1) {
      await new Promise((r) => { releaseStale = r; });
      return sse();
    }
    if (call === 5) return sse();
    return { ok: false, status: 503, text: async () => "system cpu overloaded" };
  };
  const pStale = ask({ baseURL: "http://x/v1", key: "k", model: "stale-ok", prompt: "x", timeoutMs: 120000, idleMs: 2000, attempts: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await tripCircuit(ask); // calls 2-4 → open
  fakeTime += 31_000;
  assert("8d 探针成功关断", (await ask({ baseURL: "http://x/v1", key: "k", model: "probe", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 })) === "hello" && circuitState() === "closed");
  for (let i = 0; i < 2; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: `fresh-${i}`, prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("8d 两次新 503 计数中", circuitState() === "closed");
  releaseStale?.();
  assert("8d 旧成功返回", (await pStale) === "hello");
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "fresh-3", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  assert("8d 旧成功未清零计数（第三次新 503 开断）", circuitState() === "open");
}

// 8e. 兜底释放钩子：当前 probe 异常退出回退 open，陈旧 probe 不释放。
{
  const { ask, _test, circuitState } = await freshLoad(10.1);
  _test.forceHalfOpenProbe(7);
  _test.releaseProbeIfStuck(7);
  assert("8e 当前 probe 兜底释放回退 open", circuitState() === "open");
  _test.forceHalfOpenProbe(8);
  _test.releaseProbeIfStuck(7);
  assert("8e 陈旧 probe 兜底不回退", circuitState() === "half-open");
  fetchCalls = 0;
  let blocked = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "blocked", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); }
  catch (e) { blocked = e; }
  assert("8e 陈旧 finally 不清当前锁", blocked && /断路器/.test(blocked.message) && fetchCalls === 0);
}

// 8f. ask() probe 快照与 finally 传参接线（静态核对：快照在获准 probe 时生成，finally 传快照而非现值）
{
  const src = readFileSync(path.join(PLUGIN_DIR, "hx-client.ts"), "utf8");
  assert(
    "8f probe 快照与 finally 传参接线",
    src.includes("probeGeneration = cbProbeGeneration") && src.includes("cbReleaseProbeIfStuck(probeGeneration)"),
  );
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

// 17. loadCfg 结构回归（2026-10-16 provider 改名 hx→openllamas）：
//     moa/dual_review 的配置入口。迁移窗口内新旧结构并存，优先级必须锁死：
//     options 与 key 是两条独立的 ?? 回退链（一侧新一侧旧也要能读）。
{
  const cfgPath = path.join(TMP, "kilo.json");
  const authPath = path.join(TMP, "kilo", "auth.json");
  const writeCfg = (kilo, auth) => { writeFileSync(cfgPath, JSON.stringify(kilo)); writeFileSync(authPath, JSON.stringify(auth)); };

  // a. 仅旧结构（迁移兜底不回归）
  writeCfg({ provider: { hx: { options: { baseURL: "http://legacy.local/v1", timeout: 1111 } } } }, { hx: { key: "legacy-key" } });
  {
    const { loadCfg } = await freshLoad(18);
    const cfg = await loadCfg();
    assert("loadCfg 旧结构兜底（options+key）", cfg?.baseURL === "http://legacy.local/v1" && cfg?.key === "legacy-key" && cfg?.options?.timeout === 1111);
  }

  // b. 仅新结构（改名后主路径）
  writeCfg({ provider: { openllamas: { options: { baseURL: "http://new.local/v1", timeout: 2222 } } } }, { openllamas: { key: "new-key" } });
  {
    const { loadCfg } = await freshLoad(19);
    const cfg = await loadCfg();
    assert("loadCfg 新结构直读（options+key）", cfg?.baseURL === "http://new.local/v1" && cfg?.key === "new-key" && cfg?.options?.timeout === 2222);
  }

  // c. 新旧并存 → openllamas 优先
  writeCfg(
    { provider: { openllamas: { options: { baseURL: "http://new.local/v1" } }, hx: { options: { baseURL: "http://legacy.local/v1" } } } },
    { openllamas: { key: "new-key" }, hx: { key: "legacy-key" } }
  );
  {
    const { loadCfg } = await freshLoad(20);
    const cfg = await loadCfg();
    assert("loadCfg 并存时 openllamas 优先（options+key）", cfg?.baseURL === "http://new.local/v1" && cfg?.key === "new-key");
  }

  // d. 混合形态：新结构 options + 旧 auth key → 两侧独立兜底
  writeCfg({ provider: { openllamas: { options: { baseURL: "http://new.local/v1" } } } }, { hx: { key: "legacy-key" } });
  {
    const { loadCfg } = await freshLoad(21);
    const cfg = await loadCfg();
    assert("loadCfg 混合形态（openllamas options + hx key 兜底）", cfg?.baseURL === "http://new.local/v1" && cfg?.key === "legacy-key");
  }

  // e. 空配置 → 报错点名 openllamas 路径（提示语与 SSOT 配置键一致）
  writeCfg({}, {});
  {
    const { loadCfg } = await freshLoad(22);
    let err17 = null;
    try { await loadCfg(); } catch (e) { err17 = e; }
    assert("loadCfg 缺 baseURL 报错点名 openllamas 路径", /provider\.openllamas\.options\.baseURL/.test(String(err17?.message ?? "")));
  }
}

// 18. 400 模型级区域策略：与 provider 侧 MODEL_POLICY_UNAVAILABLE_RE 同口径——
//     单次快速失败、不重试、不 trip，交上层 askRoute 换模型。
{
  const { ask, circuitState } = await freshLoad(23);
  fetchMode = "policy400";
  fetchCalls = 0;
  const t0 = realNow();
  let err18 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "deepseek-v4.1-flash-1017", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err18 = e; }
  assert("400 区域策略单次失败即抛（不重试）", err18?.statusCode === 400 && fetchCalls === 1);
  assert("400 区域策略不 trip 断路器（保持 closed）", circuitState() === "closed");
  assert("400 区域策略快速失败（真实墙钟 <1s）", (realNow() - t0) < 1000);
}

// 19. 402 模型级余额签名：与 provider 侧 MODEL_QUOTA_UNAVAILABLE_RE 同口径；
//     普通 402 也属不可重试，但同样不 trip。
{
  const { ask, circuitState } = await freshLoad(24);
  fetchMode = "quota402";
  fetchCalls = 0;
  let err19 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "kimi-k3.1-pro", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err19 = e; }
  assert("402 余额签名单次失败即抛（不重试）", err19?.statusCode === 402 && fetchCalls === 1);
  assert("402 余额签名不 trip 断路器（保持 closed）", circuitState() === "closed");
  fetchMode = "payment402";
  fetchCalls = 0;
  let err20 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err20 = e; }
  assert("普通 402 同样快速失败（不重试）", err20?.statusCode === 402 && fetchCalls === 1);
}

// 20. 413 体积超限：直连 prompt 逐级半长裁剪后原地重试；3 级仍超限才 fatal。
{
  const { ask } = await freshLoad(25);
  fetchMode = "body413";
  fetchCalls = 0; body413Calls = 0;
  const original = "x".repeat(4000);
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: original, timeoutMs: 5000, idleMs: 2000, attempts: 3 });
  const sentPrompt = JSON.parse(lastRequestBody).messages[0].content;
  assert("413 裁剪后原地重试成功（2 次 fetch）", r === "hello" && fetchCalls === 2);
  assert("413 重试 prompt 已裁剪且带截断标注", sentPrompt.length < original.length && sentPrompt.includes("截断"));
}
{
  const { ask } = await freshLoad(26);
  fetchMode = "body413always";
  fetchCalls = 0; body413Calls = 0;
  let err21 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "y".repeat(4000), timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err21 = e; }
  assert("413 持续超限裁剪 3 级后 fatal（4 次 fetch）", err21?.statusCode === 413 && fetchCalls === 4);
}

// 21. half-open probe 遇模型级 400/402：中性释放并关断，不把单模型约束误算成
//     网关故障重开熔断；随后健康请求必须立即可用。
{
  const { ask, circuitState } = await freshLoad(27);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "policy400";
  fetchCalls = 0;
  let err22 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch (e) { err22 = e; }
  assert("half-open 400 策略中性释放并关断", err22?.statusCode === 400 && circuitState() === "closed" && fetchCalls === 1);
  fetchMode = "ok";
  fetchCalls = 0;
  const ok22 = await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 });
  assert("400 中性释放后健康请求立即通过", ok22 === "hello" && fetchCalls === 1 && circuitState() === "closed");
}
{
  const { ask, circuitState } = await freshLoad(28);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "quota402";
  fetchCalls = 0;
  let err23 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch (e) { err23 = e; }
  assert("half-open 402 余额签名中性释放并关断", err23?.statusCode === 402 && circuitState() === "closed" && fetchCalls === 1);
}
// 21b. plain 4xx（非区域策略/余额签名）同样确定性中性释放：400/402/404/422 不重开熔断。
for (const [mode, status] of [["plain400", 400], ["plain404", 404], ["plain422", 422], ["payment402", 402]]) {
  const { ask, circuitState } = await freshLoad(`28b-${status}`);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = mode;
  fetchCalls = 0;
  let err = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch (e) { err = e; }
  assert(`half-open plain ${status} 中性释放并关断`, err?.statusCode === status && circuitState() === "closed" && fetchCalls === 1);
}

// 21c. 过载兜底不误伤 4xx/网络错：400 与无状态码网络错即使消息含 overloaded，
//      也不得计过载、不得 trip 断路器（3 连即开断的阈值语义作对照）。
{
  const { ask, circuitState } = await freshLoad("21c-400");
  fetchMode = "overloaded400";
  for (let i = 0; i < 3; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("400+overloaded 不 trip 断路器", circuitState() === "closed" && fetchCalls === 3);
}
{
  const { ask, circuitState } = await freshLoad("21c-net");
  fetchMode = "overloadedNet";
  for (let i = 0; i < 3; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("网络错+overloaded 不 trip 断路器", circuitState() === "closed" && fetchCalls === 3);
}

// 21d. 对照组：网关 502 + overloaded 仍按过载 trip——收紧只排除 4xx/网络错，不误伤真过载。
{
  const { ask, circuitState } = await freshLoad("21d-502");
  fetchMode = "overloaded502";
  for (let i = 0; i < 3; i++) {
    try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "x", timeoutMs: 5000, idleMs: 2000, attempts: 1 }); } catch {}
  }
  assert("502+overloaded 仍按过载 trip", circuitState() === "open" && fetchCalls === 3);
}

// 22. half-open probe 遇 413：中性释放后裁剪重试，自愈成功；持续超限也不重开熔断。
{
  const { ask, circuitState } = await freshLoad(29);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "body413";
  fetchCalls = 0; body413Calls = 0;
  const original = "x".repeat(4000);
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: original, timeoutMs: 5000, idleMs: 2000, attempts: 3 });
  const sentPrompt = JSON.parse(lastRequestBody).messages[0].content;
  assert("half-open 413 中性释放并裁剪自愈", r === "hello" && fetchCalls === 2 && circuitState() === "closed");
  assert("half-open 413 裁剪带截断标注", sentPrompt.length < original.length && sentPrompt.includes("截断"));
  const shrinkRows = readFileSync(path.join(TMP, "kilo", "failover-events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((x) => x.action === "body_shrink_retry");
  assert("413 裁剪遥测记录前后长度", shrinkRows.some((x) => x.beforeChars === original.length && x.afterChars < x.beforeChars));
  assert("413 裁剪遥测记录前后字节", shrinkRows.some((x) => Number.isInteger(x.bytesBefore) && Number.isInteger(x.bytesAfter) && x.bytesBefore > x.bytesAfter));
}
{
  const { ask, circuitState } = await freshLoad(30);
  await tripCircuit(ask);
  fakeTime += 31_000;
  fetchMode = "body413always";
  fetchCalls = 0; body413Calls = 0;
  let err24 = null;
  try { await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: "y".repeat(4000), timeoutMs: 5000, idleMs: 2000, attempts: 3 }); } catch (e) { err24 = e; }
  assert("half-open 413 持续超限裁剪 3 级后 fatal（4 次 fetch）", err24?.statusCode === 413 && fetchCalls === 4);
  assert("half-open 413 持续超限不重开熔断", circuitState() === "closed");
}

// 22b. 12MB 生产尺寸：单次半长裁剪不够，必须逐级缩到网关阈值以下；3 级封顶。
{
  const { ask, circuitState } = await freshLoad(30.5);
  fetchMode = "bodyLimit";
  fetchCalls = 0;
  const original = "z".repeat(12 * 1024 * 1024);
  const r = await ask({ baseURL: "http://x/v1", key: "k", model: "m", prompt: original, timeoutMs: 5000, idleMs: 2000, attempts: 3 });
  const sentPrompt = JSON.parse(lastRequestBody).messages[0].content;
  assert("12MB 413 逐级裁剪 3 级后成功（4 次 fetch）", r === "hello" && fetchCalls === 4);
  assert("12MB 裁剪后字节低于模拟网关阈值", Buffer.byteLength(sentPrompt, "utf8") < 2_000_000);
  assert("12MB 裁剪后熔断保持 closed", circuitState() === "closed");
}

// 23. 遥测安全边界：error 只能是固定枚举/http_xxx，不能出现上游 responseBody/x-error 原文。
{
  const rows = readFileSync(path.join(TMP, "kilo", "failover-events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((x) => x.kind === "hx-client" && x.error !== undefined);
  const allowed = new Set(["circuit_open", "request_body_too_large", "model_unavailable", "timeout_total", "timeout_idle", "empty_response", "no_body", "network_error"]);
  const enumOnly = rows.every((x) => allowed.has(x.error) || /^http_[1-5]\d\d$/.test(x.error));
  const noUpstreamText = !rows.some((x) => /Global regions|Upstream request failed|balance|responseBody/i.test(String(x.error)));
  assert("遥测 error 仅固定枚举（无上游原文）", enumOnly && noUpstreamText);
}

Date.now = realNow;
console.log(results.join("\n"));
rmSync(TMP, { recursive: true, force: true });
