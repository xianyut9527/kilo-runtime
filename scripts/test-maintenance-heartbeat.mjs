#!/usr/bin/env node
// maintenance-heartbeat 离线回归（纯函数注入路径，不触碰真实维护目录；esbuild bundle 模式
// 同 test-memory-bootstrap.mjs）。钉死 v2 行为：
//   - 证据链告警：state 过期 / error.log 48h / flag 三态（POSIX、禁用、自愈缺链、>3 天未解决）
//   - 速率/收敛判定：日增 >2GB、空闲页多轮不收敛、autoVacuum≠2 无 flag
//   - reclaim-intent 意图判定（MoA P0-4）：日增超限 → {rounds:40}；过期/缺链 → null
//   - 状态目录体量证据（MoA P0-3）：>200MB 告警（opts 注入上限可测）
//   - 回归钉死 v1 误报：大 DB 文件 + 维护健康 = 不告警（本测试从头到尾不存在 DB 文件——
//     证明判定根本不读 DB 尺寸）
// 用法：node scripts/test-maintenance-heartbeat.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const esbuildBin = path.join(ROOT, "provider/hx-failover/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuildBin)) {
  console.error("[test] esbuild 未安装：先在 provider/hx-failover 跑 npm install");
  process.exit(2);
}
const bundle = path.join(os.tmpdir(), `mh-test-${process.pid}.mjs`);
execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "maintenance-heartbeat.ts"),
  "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle}`], { stdio: "inherit" });
let mod;
try {
  mod = await import(pathToFileURL(bundle).href);
} finally {
  fs.rmSync(bundle, { force: true });
}
const { computeMaintReasons, maintPathsFor, readStatsFile, computeReclaimIntent,
  gcWarnCache, refreshWarning, consumeWarning,
  WARN_TTL_MS, WARN_RECHECK_MS, WARN_CACHE_KEEP_MS, WARN_CACHE_MAX,
  STALE_DAYS, BOOTSTRAP_STALE_DAYS, RECLAIM_BOOST_ROUNDS, STATE_DIR_MAX_BYTES } = mod._export ?? mod;
// 文案红线（2026-11-05）：健康/可自愈路径不得要求用户执行命令（用户明确拒绝半自动）。
const SRC = fs.readFileSync(path.join(ROOT, "plugin", "maintenance-heartbeat.ts"), "utf8");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  let ok = false;
  try { ok = typeof cond === "function" ? !!cond() : !!cond; }
  catch (e) { failed.push(`${name}（抛错：${String(e?.message ?? e).slice(0, 120)}）`); console.error(`  FAIL(throw): ${name}`); fail++; return; }
  if (ok) { pass++; console.log(`  ok: ${name}`); }
  else { failed.push(name); console.error(`  FAIL: ${name}`); fail++; }
};

// ── 沙箱：每个场景独立 tmp 目录 + 全套路径注入 ──────────────────────────
const DAY = 86400 * 1000;
const NOW = Date.parse("2026-11-04T04:00:00.000Z");
function sandbox(setup, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sandbox-"));
  const p = maintPathsFor(dir);
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(p.bootstrapLnk), { recursive: true });
  setup(p, dir);
  const reasons = computeMaintReasons(p, NOW, true, opts);
  fs.rmSync(dir, { recursive: true, force: true });
  return reasons;
}
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const writeStats = (p, o) => fs.writeFileSync(p.statsFile,
  Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
const freshState = (p) => fs.writeFileSync(p.stateFile,
  `{"lastCleanup":"${iso(0.1)}","lastDb":"${iso(0.1)}"}`);
const touch = (f, hoursAgo) => {
  fs.writeFileSync(f, "x");
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000);
  fs.utimesSync(f, t, t);
};

console.log("== 1) 健康基线（全程无 DB 文件 → 判定不读 DB 尺寸，v1 误报回归钉死）==");
t("维护健康（新 state、无 error/flag、stats 正常）零告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(0.1), dbBytes: 13 * 1024 ** 3, prevBytes: 13 * 1024 ** 3,
    prevUpdatedAt: iso(1.1), freeBytes: 10 ** 6, prevFreeBytes: 10 ** 6, autoVacuum: 2 });
}).length === 0);

console.log("== 2) state.json 证据链 ==");
t("state 缺失告警「尚未跑过」", sandbox((p) => {}).some((r) => /尚未跑过/.test(r)));
t("lastDb 超 7 天告警停摆（天数按毫秒换算，8 天不得显示成 8000 天）", sandbox((p) => {
  fs.writeFileSync(p.stateFile, `{"lastCleanup":"${iso(0.1)}","lastDb":"${iso(8)}"}`);
}).some((r) => /DB 瘦身已 8 天没跑/.test(r)));
t(`STALE_DAYS=${STALE_DAYS} 常量`, STALE_DAYS === 7);

console.log("== 3) error.log 证据链 ==");
t("error.log 1 小时前告警", sandbox((p) => { freshState(p); touch(p.errorLog, 1); }).some((r) => /error\.log/.test(r)));
t("error.log 3 天前不告警", sandbox((p) => { freshState(p); touch(p.errorLog, 72); }).length === 0);

console.log("== 4) 引导死锁 flag 三态 ==");
const flagWith = (p, sinceDays) => fs.writeFileSync(p.flagFile,
  `unresolvedSince=${iso(sinceDays)}\nreason=auto_vacuum=0\n`);
t("flag + 自愈 lnk 在 + ≤3 天：静默（已排队）", sandbox((p) => {
  freshState(p); flagWith(p, 1); fs.writeFileSync(p.bootstrapLnk, "lnk");
}).length === 0);
t("flag + 自愈 lnk 在 + 4 天：升级告警（天数按毫秒换算，不得显示成 4000 天）", sandbox((p) => {
  freshState(p); flagWith(p, 4); fs.writeFileSync(p.bootstrapLnk, "lnk");
}).some((r) => /自愈排队 4 天仍未完成/.test(r)));
t("4 天文案含「重启≠关机」（Fast Startup 口径）", sandbox((p) => {
  freshState(p); flagWith(p, 4); fs.writeFileSync(p.bootstrapLnk, "lnk");
}).some((r) => /重启≠关机/.test(r)));
t("flag + 无 lnk：告警自愈缺链（RunOnce 未跑）", sandbox((p) => {
  freshState(p); flagWith(p, 1);
}).some((r) => /快捷方式缺失/.test(r)));
t("flag + opt-out 哨兵：告警被禁用", sandbox((p) => {
  freshState(p); flagWith(p, 1); fs.writeFileSync(p.bootstrapLnk, "lnk");
  fs.writeFileSync(p.disabledSentinel, "");
}).some((r) => /被禁用/.test(r)));
t("flag + 非 win32：告警需手动引导", (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sandbox-"));
  const p = maintPathsFor(dir);
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  freshState(p); flagWith(p, 1);
  const reasons = computeMaintReasons(p, NOW, false);
  fs.rmSync(dir, { recursive: true, force: true });
  return reasons.some((r) => /POSIX/.test(r));
})());
t(`BOOTSTRAP_STALE_DAYS=${BOOTSTRAP_STALE_DAYS} 常量`, BOOTSTRAP_STALE_DAYS === 3);

console.log("== 4b) POSIX 活性证据（state.json 在 POSIX 无写入者，改用 db-stats.txt）==");
const posixSandbox = (setup) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-posix-"));
  const p = maintPathsFor(dir);
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  setup?.(p, dir);
  const reasons = computeMaintReasons(p, NOW, false); // isWin32=false
  fs.rmSync(dir, { recursive: true, force: true });
  return reasons;
};
const healthyStats = (p, daysAgo = 0.1) => writeStats(p, {
  updatedAt: iso(daysAgo), dbBytes: 10 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
  prevUpdatedAt: iso(daysAgo + 1), freeBytes: 0, prevFreeBytes: 0, autoVacuum: 2 });
t("POSIX + 新鲜 stats + 无 state.json → 零告警（修前恒报「尚未跑过」）", posixSandbox((p) => {
  healthyStats(p);
}).length === 0);
t("POSIX + state.json 陈旧但 stats 新鲜 → 零告警（state.json 不作 POSIX 证据）", posixSandbox((p) => {
  fs.writeFileSync(p.stateFile, `{"lastCleanup":"${iso(30)}","lastDb":"${iso(30)}"}`);
  healthyStats(p);
}).length === 0);
t("POSIX + 无 stats → 如实提示从未运行，且不承诺「自动补跑」", (() => {
  const r = posixSandbox();
  return r.length === 1 && /从未运行/.test(r[0]) && /cron|systemd/.test(r[0])
    && !/自动补跑/.test(r[0]) && !/state\.json 不存在/.test(r[0]);
})());
t("POSIX + stats 8 天未更新 → 告警天数 + 调度提示", posixSandbox((p) => {
  healthyStats(p, 8);
}).some((r) => /已 8 天未运行/.test(r) && /cron|systemd/.test(r)));
t("POSIX + stats 缺 updatedAt → 提示未完整跑过", posixSandbox((p) => {
  writeStats(p, { dbBytes: 1, autoVacuum: 2 });
}).some((r) => /未完整跑过/.test(r)));
t("win32 仍以 state.json 为活性证据（不读 stats 顶替）", sandbox((p) => {
  healthyStats(p); // stats 新鲜但 state.json 缺失 → win32 必须仍告警
}).some((r) => /state\.json 不存在/.test(r)));

console.log("== 5) db-stats 速率/收敛判定（取代裸尺寸）==");
t("日增 3GB > 2GB 上限告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(1), dbBytes: 13 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
    prevUpdatedAt: iso(2), freeBytes: 10 ** 6, prevFreeBytes: 10 ** 6, autoVacuum: 2 });
}).some((r) => /日增 3\.0GB/.test(r)));
t("日增 0.5GB 不告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(1), dbBytes: 10.5 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
    prevUpdatedAt: iso(2), freeBytes: 10 ** 6, prevFreeBytes: 10 ** 6, autoVacuum: 2 });
}).length === 0);
t("空闲页连续 ≥2GB 多轮不收敛告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(3), dbBytes: 13 * 1024 ** 3, prevBytes: 12.9 * 1024 ** 3,
    prevUpdatedAt: iso(6), freeBytes: 3 * 1024 ** 3, prevFreeBytes: 3 * 1024 ** 3, autoVacuum: 2 });
}).some((r) => /空闲页连续多轮/.test(r)));
t("生产节拍回归：prev 快照 1.05 天前（日维护间隔）空闲页双高也告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(0), dbBytes: 13 * 1024 ** 3, prevBytes: 12.9 * 1024 ** 3,
    prevUpdatedAt: iso(1.05), freeBytes: 3 * 1024 ** 3, prevFreeBytes: 3 * 1024 ** 3, autoVacuum: 2 });
}).some((r) => /空闲页连续多轮/.test(r)));
t("同日双跑（间隔 <1 天）不误报空闲页不收敛", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(0), dbBytes: 13 * 1024 ** 3, prevBytes: 13 * 1024 ** 3,
    prevUpdatedAt: iso(0.2), freeBytes: 3 * 1024 ** 3, prevFreeBytes: 3 * 1024 ** 3, autoVacuum: 2 });
}).length === 0);
t("stats autoVacuum=0 且无 flag：告警 flag 丢失", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(0.1), dbBytes: 10 * 1024 ** 3, autoVacuum: 0, freeBytes: 0 });
}).some((r) => /flag 不在/.test(r)));
t("stats 缺失/过期不告警（state 新鲜=任务在跑）", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(8), dbBytes: 10 * 1024 ** 3, autoVacuum: 2 });
}).length === 0);

console.log("== 6) reclaim-intent 意图判定（MoA P0-4 声明式意图，纯函数）==");
const intentStats = (o) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-intent-"));
  const p = maintPathsFor(dir);
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  writeStats(p, o);
  const s = readStatsFile(p.statsFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return s;
};
const GROW = { updatedAt: iso(1), dbBytes: 13 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
  prevUpdatedAt: iso(2), freeBytes: 10 ** 6, prevFreeBytes: 10 ** 6, autoVacuum: 2 };
t("日增 3GB → 下发 {rounds:40}", (() => {
  const r = computeReclaimIntent(intentStats(GROW), NOW);
  return r !== null && r.rounds === RECLAIM_BOOST_ROUNDS && r.rounds === 40;
})());
t("日增 0.5GB → 不下发", computeReclaimIntent(intentStats({ ...GROW, dbBytes: 10.5 * 1024 ** 3 }), NOW) === null);
t("stats 过期 8 天 → 不下发", computeReclaimIntent(intentStats({ ...GROW, updatedAt: iso(8) }), NOW) === null);
t("缺 prev 链 → 不下发", computeReclaimIntent(intentStats({ updatedAt: iso(1), dbBytes: 13 * 1024 ** 3, autoVacuum: 2 }), NOW) === null);
t("readStatsFile 缺失/不可读 → null", readStatsFile(path.join(os.tmpdir(), "mh-nonexistent-stats.txt")) === null);
t("readStatsFile 解析 key=value、跳过乱行", (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-parse-"));
  const f = path.join(dir, "db-stats.txt");
  fs.writeFileSync(f, "updatedAt=2026-11-04T00:00:00Z\ndbBytes=42\ngarbage line\n");
  const s = readStatsFile(f);
  fs.rmSync(dir, { recursive: true, force: true });
  return s !== null && s.dbBytes === "42" && s.updatedAt === "2026-11-04T00:00:00Z" && Object.keys(s).length === 2;
})());
t("maintPathsFor 含 intentFile（reclaim-intent.json）", /reclaim-intent\.json$/.test(maintPathsFor("/h").intentFile));

console.log("== 7) 状态目录体量证据（MoA P0-3，opts 注入可测）==");
t("目录体量超注入上限（3MB > 1MB）告警", sandbox((p) => {
  freshState(p);
  fs.writeFileSync(path.join(path.dirname(p.stateFile), "big.bin"), Buffer.alloc(3 * 1024 * 1024));
}, { stateDirMaxBytes: 1024 * 1024 }).some((r) => /状态目录 \d+MB 超上限/.test(r)));
t("健康小目录不因体量告警", sandbox((p) => {
  freshState(p);
  writeStats(p, { updatedAt: iso(0.1), dbBytes: 10 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
    prevUpdatedAt: iso(1.1), freeBytes: 0, prevFreeBytes: 0, autoVacuum: 2 });
  fs.writeFileSync(path.join(path.dirname(p.stateFile), "tiny.log"), "x");
}).length === 0);
t("STATE_DIR_MAX_BYTES=200MB 常量", STATE_DIR_MAX_BYTES === 200 * 1024 * 1024);

console.log("== 8) never-throw / 契约 ==");
t("损坏 stats（乱码行）不抛错、不告警", sandbox((p) => {
  freshState(p);
  fs.writeFileSync(p.statsFile, "}}garbage\nupdated\x01At=zzz\n");
}).length === 0);
t("目录全空（新机器）只报 state 缺失一条", (() => {
  const reasons = sandbox(() => {});
  return reasons.length === 1 && /尚未跑过/.test(reasons[0]);
})());
t("插件契约：默认导出工厂为函数 + _export 命名空间", typeof mod.maintenanceHeartbeat === "function"
  && typeof mod._export?.computeMaintReasons === "function" && Object.keys(mod).every((k) => k === "maintenanceHeartbeat" || k === "_export"));

console.log("== 9) 零手动文案红线（用户明确拒绝半自动）==");
t("可自愈路径不要求用户执行维护命令", !/(跑 scripts\/kilo-maintenance\.ps1|跑 -RunOnce|重跑 -RunOnce|关闭全部 Kilo 后 -VacuumNow)/.test(SRC));
t("state 缺失文案指向自动补跑", /state\.json 不存在[^"]*自动补跑/.test(SRC));
t("快捷方式缺失文案指向自动补装", /快捷方式缺失[^"]*自动补装/.test(SRC));
t("自愈排队文案不再附带手动命令", !/自愈排队[\s\S]{0,200}?-VacuumNow/.test(SRC));

console.log("== 10) 告警缓存纯函数（v3：时效/负缓存/GC/容量上限）==");
t("refresh 后 consume 取出文案并标记 delivered", (() => {
  const c = new Map();
  refreshWarning(c, "s", 1000, () => "W");
  const text = consumeWarning(c, "s", 1001);
  return text === "W" && c.get("s").delivered === true && c.get("s").notifyAfter === 1001 + WARN_TTL_MS;
})());
t("TTL 内重复 consume 被节流（不刷屏）", (() => {
  const c = new Map();
  refreshWarning(c, "s", 1000, () => "W");
  consumeWarning(c, "s", 1001);
  return consumeWarning(c, "s", 1002) === null;
})());
t("TTL 到期后同一告警可再次提醒（不是每会话永久沉默）", (() => {
  const c = new Map();
  refreshWarning(c, "s", 1000, () => "W");
  consumeWarning(c, "s", 1001);
  const later = 1001 + WARN_TTL_MS + 1;
  refreshWarning(c, "s", later, () => "W"); // 重估保留 notifyAfter/delivered
  return consumeWarning(c, "s", later) === "W";
})());
t("负缓存：recheckAt 内重复 refresh 不重复扫盘", (() => {
  const c = new Map();
  let calls = 0;
  const recompute = () => { calls++; return null; };
  refreshWarning(c, "s", 1000, recompute);
  refreshWarning(c, "s", 1001, recompute);
  refreshWarning(c, "s", 1000 + WARN_RECHECK_MS - 1, recompute);
  return calls === 1 && c.get("s").text === null && consumeWarning(c, "s", 1002) === null;
})());
t("recheckAt 到期必重估：恢复健康后陈旧告警被丢弃", (() => {
  const c = new Map();
  refreshWarning(c, "s", 1000, () => "STALE");
  const later = 1000 + WARN_RECHECK_MS + 1;
  refreshWarning(c, "s", later, () => null); // 维护已恢复健康
  return c.get("s").text === null && consumeWarning(c, "s", later) === null;
})());
t("refresh 不消费：只刷新不注入时不推进 notifyAfter、不标 delivered", (() => {
  const c = new Map();
  refreshWarning(c, "s", 1000, () => "W");
  const later = 1000 + WARN_RECHECK_MS + 1;
  refreshWarning(c, "s", later, () => "W");
  return c.get("s").delivered === false && c.get("s").notifyAfter === 0
    && consumeWarning(c, "s", later) === "W";
})());
t("GC：24h 无活动条目被回收", (() => {
  const c = new Map();
  refreshWarning(c, "old", 1000, () => "W");
  refreshWarning(c, "new", 1000 + WARN_CACHE_KEEP_MS + 1, () => null);
  return !c.has("old") && c.has("new");
})());
t("容量上限：超过 WARN_CACHE_MAX 淘汰最久未活动会话", (() => {
  const c = new Map();
  for (let i = 0; i <= WARN_CACHE_MAX; i++) refreshWarning(c, `s${i}`, 1000 + i, () => null);
  return c.size === WARN_CACHE_MAX && !c.has("s0") && c.has(`s${WARN_CACHE_MAX}`);
})());
t("gcWarnCache 空表/单条不抛错", (() => {
  const c = new Map();
  gcWarnCache(c, 1000);
  refreshWarning(c, "s", 1000, () => null);
  gcWarnCache(c, 1001);
  return c.size === 1;
})());

console.log("== 11) 工厂钩子端到端（真实事件形态 {type, properties}——P0 死链回归钉死）==");
// 工厂内部用 os.homedir() 定位维护目录：这里把 homedir 指到沙箱（node:os 默认导出对象可写，
// bundle 与测试共享同一模块实例），全程不触碰真实维护目录。
const realHomedir = os.homedir;
const realDateNow = Date.now;
const hookSandbox = (setup) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hook-"));
  const p = maintPathsFor(dir);
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  setup?.(p, dir);
  os.homedir = () => dir;
  return { dir, p };
};
const endHook = (h) => { os.homedir = realHomedir; Date.now = realDateNow; fs.rmSync(h.dir, { recursive: true, force: true }); };
const afterTodo = async (hooks, sid) => {
  const input = { tool: "todowrite", sessionID: sid, output: { output: "OUT" } };
  await hooks["tool.execute.after"](input);
  return input.output.output;
};

t("session.created({type,properties}) 后 todowrite 输出被追加告警（v2 恒不触发的死链）", await (async () => {
  const h = hookSandbox(); // 无 state.json → 有告警
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    const out = await afterTodo(hooks, "s1");
    return out.includes("[maintenance-heartbeat]") && out.includes("尚未跑过");
  } finally { endHook(h); }
})());
t("同会话第二次 todowrite 不重复告警（TTL 节流）", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    await afterTodo(hooks, "s1");
    return (await afterTodo(hooks, "s1")) === "OUT";
  } finally { endHook(h); }
})());
t("维护恢复健康后，过期的陈旧告警不再注入", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    freshState(h.p); // 用户侧维护已跑通
    writeStats(h.p, { updatedAt: iso(0.1), dbBytes: 10 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
      prevUpdatedAt: iso(1.1), freeBytes: 0, prevFreeBytes: 0, autoVacuum: 2 });
    const later = realDateNow() + WARN_RECHECK_MS + 1000; // 越过重估窗口
    Date.now = () => later;
    return (await afterTodo(hooks, "s1")) === "OUT";
  } finally { endHook(h); }
})());
t("创建之后才出现的故障，后续工具调用能发现并告警", await (async () => {
  const h = hookSandbox((p) => { freshState(p); }); // 创建时健康
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    if ((await afterTodo(hooks, "s1")) !== "OUT") return false; // 健康不注入
    fs.rmSync(h.p.stateFile, { force: true }); // 之后维护链断裂
    Date.now = () => realDateNow() + WARN_RECHECK_MS + 1000;
    return (await afterTodo(hooks, "s1")).includes("[maintenance-heartbeat]");
  } finally { endHook(h); }
})());
t("session.idle 兜底：无 todowrite 的会话经 promptAsync 收到首条告警，且不重复", await (async () => {
  const h = hookSandbox();
  try {
    const sent = [];
    const ctx = { client: { session: { promptAsync: async (a) => { sent.push(a); } } } };
    const hooks = await mod.maintenanceHeartbeat(ctx);
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s9" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } });
    return sent.length === 1 && sent[0].path.id === "s9"
      && sent[0].body.parts[0].text.includes("[maintenance-heartbeat]");
  } finally { endHook(h); }
})());
t("无 client 时 idle 兜底 fail-open（不抛错、不影响 todowrite 通道）", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s2" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
    return (await afterTodo(hooks, "s2")).includes("[maintenance-heartbeat]");
  } finally { endHook(h); }
})());
t("promptAsync 发送失败回滚投递标记，todowrite 通道仍可补发", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({ client: { session: { promptAsync: async () => { throw new Error("net down"); } } } });
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "s7" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s7" } } }); // 发送失败，不得吞告警
    return (await afterTodo(hooks, "s7")).includes("[maintenance-heartbeat]");
  } finally { endHook(h); }
})());
t("旧事件形态 {name, sessionID} 兜底兼容", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({ event: { name: "session.created", sessionID: "legacy" } });
    return (await afterTodo(hooks, "legacy")).includes("[maintenance-heartbeat]");
  } finally { endHook(h); }
})());
t("健康会话 created/idle/todowrite 全链路零输出、零 prompt", await (async () => {
  const h = hookSandbox((p) => {
    freshState(p);
    writeStats(p, { updatedAt: iso(0.1), dbBytes: 10 * 1024 ** 3, prevBytes: 10 * 1024 ** 3,
      prevUpdatedAt: iso(1.1), freeBytes: 0, prevFreeBytes: 0, autoVacuum: 2 });
  });
  try {
    const sent = [];
    const hooks = await mod.maintenanceHeartbeat({ client: { session: { promptAsync: async (a) => { sent.push(a); } } } });
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "ok" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ok" } } });
    const out = await afterTodo(hooks, "ok");
    return out === "OUT" && sent.length === 0;
  } finally { endHook(h); }
})());
t("事件缺 properties/sessionID、空 input、未知事件类型均不抛错", await (async () => {
  const h = hookSandbox();
  try {
    const hooks = await mod.maintenanceHeartbeat({});
    await hooks.event({});
    await hooks.event({ event: { type: "session.created" } });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "x", status: { type: "busy" } } } });
    await hooks["tool.execute.after"]({});
    return true;
  } finally { endHook(h); }
})());

console.log(`\n${pass} passed, ${fail} failed${failed.length ? `；失败：${failed.join(" | ")}` : ""}`);
process.exit(fail ? 1 : 0);