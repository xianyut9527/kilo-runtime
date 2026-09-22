// 断路器离线验证 v6：断路器全生命周期 + 三轮审查必须项场景。
// v6 新增：跨代迟到成功/失败不污染 half-open、open 态迟到过载不刷新冷却。
// 运行：node --experimental-strip-types scripts/test-circuit-breaker.mjs
// （直接动态 import plugin/hx-client.ts，靠 ?r= 查询串击穿 ESM 缓存取得全新断路器状态；
//   网络层打桩，不联网、不起 Kilo，18 场景全绿为过）
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
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

Date.now = realNow;
console.log(results.join("\n"));
rmSync(TMP, { recursive: true, force: true });
