// maintenance-heartbeat.ts —— 维护链路心跳（2026-11-05 v3，入仓库 SSOT）
//
// 背景：维护已全自动（计划任务 + 登录自启 + VACUUM 门槛 + 引导死锁自愈快捷方式），但链路
// 停摆时用户无从得知。本插件在维护异常时把告警注入对话，平时零输出。
//
// v3 修复（第四轮查漏补缺，全部有离线回归钉死）：
//   ① P0 死链：event 误用 ev.name/ev.sessionID，而 Kilo 实际分发 {type, properties} →
//      session.created 恒不触发、缓存恒空，插件整体静默失效；改为 type/properties（旧形态兜底）。
//   ② 告警时效：until 只写不读 → 陈旧告警可能数小时后照样注入；改为 recheckAt 到期必重估，
//      恢复健康即丢弃文案；每次工具调用刷新（负缓存保证廉价），创建后新出现的故障也能被告。
//   ③ 缓存无界：改为 24h 无活动 GC + 128 条硬上限淘汰，常驻 serve 进程不再随会话数增长。
//   ④ 通道覆盖：新增 session.idle 兜底（client.session.promptAsync，仅首条告警、fail-open），
//      从不用 todowrite 的会话也收得到；refresh/consume 分离，未注入绝不标记已投递。
//
// v2 重构动机（v1 误报实证）：旧版用「裸 DB 文件尺寸 ≥12GB」告警——DB 12.87GB 但维护
// 完全健康（当日 state、error.log 干净、空闲页已增量回收）时照样喊停摆，逼用户手动 -Status。
// 尺寸本身不是病，病是「证据链断了」。v2 只按证据告警：
//   1. state.json 缺失或 lastCleanup/lastDb > STALE_DAYS(7 天)     → 维护任务停摆
//   2. error.log 48h 内有报错                                      → 执行在跑但有失败
//   3. vacuum-needed.flag 存在（auto_vacuum≠2 引导死锁）：
//      - POSIX：无登录自愈机制，如实提示需手动引导
//      - win32 + 哨兵（vacuum-bootstrap.disabled）：用户主动 opt-out → 提示手动 -VacuumNow
//      - win32 + 自愈快捷方式缺失：RunOnce 未跑/装不上 → 告警（自愈排队断链）
//      - win32 + 自愈在排队 + unresolvedSince > 3 天：多次登录都没等到无写者窗口 → 升级提示
//      - win32 + 自愈在排队 + ≤3 天：健康，静默（已排队，无需打扰）
//   4. db-stats.txt（db-maintain.sh 每轮写入）速率/收敛判定，取代裸尺寸：
//      - prev→cur 日增长 > 2GB：写入速度超回收上限 → 告警 + 原子下发 reclaim-intent.json
//        （{issuedAt, rounds:40} 声明式白名单意图；db-maintain.sh 消费时夹 20..40、
//        24h 新鲜度、单次消费 rename——意图绝不携带路径/命令，伪造最坏效果=多耗 IO）
//      - prev/cur freeBytes 均 ≥2GB 且间隔 ≥1 天（连续两轮）：增量回收不收敛 → 告警
//      - stats 新鲜且 autoVacuum≠2 但无 flag：死锁在但 flag 丢失（写失败/旧版脚本）→ 告警
//   5. 维护状态目录体量 > 200MB → 告警（日志只增不删=新的泄漏面，MoA P0-3 证据）
//   注意：明确不按 DB 文件尺寸告警（回归钉死：大库 + 维护健康 = 不告）。
//
// 契约（repo 硬约束）：单导出工厂函数 + _export 命名空间（对象无 server 属性被加载器跳过）；
// 全路径 never-throw（心跳自身故障绝不打扰会话）；仅用 node: 内建模块。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STALE_DAYS = 7;
const STALE_ERROR_HOURS = 48;
const BOOTSTRAP_STALE_DAYS = 3; // flag 未解决超 3 天（多次登录都没等到空窗）→ 升级
const GROW_WARN_BYTES_PER_DAY = 2 * 1024 ** 3; // 日增 >2GB 超出增量回收上限
const FREE_STALL_BYTES = 2 * 1024 ** 3; // 空闲页 ≥2GB 连续多轮不收敛
const STATS_FRESH_MS = 7 * 86400 * 1000;
const RECLAIM_BOOST_ROUNDS = 40; // reclaim-intent 的 ivac 趟数（db-maintain 消费时硬夹 20..40）
const STATE_DIR_MAX_BYTES = 200 * 1024 * 1024; // 状态目录体量证据上限（轮转/卫生失效）
const WARN_TTL_MS = 30 * 60 * 1000;        // 同会话同类告警 30 分钟内不重复注入
const WARN_RECHECK_MS = 5 * 60 * 1000;     // 重估间隔（健康也负缓存：工具调用不每次都扫盘）
const WARN_CACHE_KEEP_MS = 24 * 3600 * 1000; // 会话条目 24h 无活动即回收（常驻进程防无界增长）
const WARN_CACHE_MAX = 128;                // 硬上限：超出淘汰最久未活动会话

// 判定核心（纯函数，经 _export 供离线回归断言；路径由调用方注入）
// 注意：除工厂函数外任何导出都会被 Kilo 加载器当插件工厂调（repo 契约）——常量/函数
// 一律只经 _export 命名空间暴露，不得直接 export。
export interface MaintPaths {
  stateFile: string;      // kilo-maintenance.ps1 写的 state.json（lastCleanup/lastDb）
  errorLog: string;       // 维护错误日志（48h 内有内容=有失败）
  flagFile: string;       // db-maintain.sh 写的 vacuum-needed.flag（引导死锁）
  bootstrapLnk: string;   // 登录自愈快捷方式（win32 Startup）
  disabledSentinel: string; // vacuum-bootstrap.disabled（用户 opt-out）
  statsFile: string;      // db-stats.txt（db-maintain.sh 每轮写的 key=value 快照）
  intentFile: string;     // reclaim-intent.json（心跳写、db-maintain.sh 单次消费）
}

const num = (v: string | undefined): number => (v !== undefined && /^\d+$/.test(v) ? Number(v) : Number.NaN);

// db-stats.txt 解析（key=value → map；供速率/收敛判定与意图下发复用）
function readStatsFile(statsFile: string): Record<string, string> | null {
  try {
    const stats: Record<string, string> = {};
    for (const line of fs.readFileSync(statsFile, "utf8").split(/\r?\n/)) {
      const m = /^(\w+)=(.*)$/.exec(line);
      if (m) stats[m[1]] = m[2];
    }
    return stats;
  } catch { return null; }
}

// 意图判定（纯函数）：stats 新鲜且日增超回收上限 → 提升增量回收趟数；否则 null（不写文件）
function computeReclaimIntent(stats: Record<string, string> | null, nowMs: number): { rounds: number } | null {
  if (!stats) return null;
  const at = Date.parse(stats.updatedAt ?? "");
  if (Number.isNaN(at) || nowMs - at > STATS_FRESH_MS) return null;
  const curBytes = num(stats.dbBytes), prevBytes = num(stats.prevBytes);
  const prevAt = Date.parse(stats.prevUpdatedAt ?? "");
  const days = (at - prevAt) / 86400000;
  if (Number.isNaN(curBytes) || Number.isNaN(prevBytes) || days < 1) return null;
  const perDay = (curBytes - prevBytes) / days;
  if (perDay > GROW_WARN_BYTES_PER_DAY) return { rounds: RECLAIM_BOOST_ROUNDS };
  return null;
}

function computeMaintReasons(
  p: MaintPaths, nowMs: number, isWin32: boolean,
  opts?: { stateDirMaxBytes?: number },
): string[] {
  const reasons: string[] = [];
  try {
    // stats 提前读：POSIX 的活性证据与后面的速率/收敛判定共用同一次磁盘读。
    const stats = readStatsFile(p.statsFile);
    // ── 维护活性主证据（按平台分流，2026-11-05 第五轮修）──
    // win32：state.json 由 kilo-maintenance.ps1（登录自启 + 每日计划任务）写，是最直接的活性证据。
    // POSIX：state.json 没有任何写入者（kilo-maintenance.ps1 不能跑），拿它当证据会**恒报
    // 「维护尚未跑过」**，且原文案承诺的「登录自启/每日任务自动补跑」在 POSIX 根本不存在——
    // 假告警 + 虚假承诺。POSIX 唯一由维护自身产出的证据是 db-maintain.sh 每轮写的 db-stats.txt。
    if (isWin32) {
      let stateRaw: string | null = null;
      try { stateRaw = fs.readFileSync(p.stateFile, "utf8"); } catch { stateRaw = null; }
      if (stateRaw === null) {
        reasons.push("state.json 不存在——维护尚未跑过；登录自启/每日任务会自动补跑（连续 2 天仍缺失再查看 -Status）");
      } else {
        const lastCleanup = Date.parse((/"lastCleanup"\s*:\s*"([^"]+)"/.exec(stateRaw) || [""])[1]);
        const lastDb = Date.parse((/"lastDb"\s*:\s*"([^"]+)"/.exec(stateRaw) || [""])[1]);
        for (const [k, t] of [["清理", lastCleanup], ["DB 瘦身", lastDb]] as const) {
          if (Number.isNaN(t)) { reasons.push(`state.json 缺 ${k} 时间戳（维护注册后未完整跑过）`); break; }
          if (nowMs - t > STALE_DAYS * 86400 * 1000) reasons.push(`${k}已 ${Math.floor((nowMs - t) / 86400000)} 天没跑（下次登录自启会自动补跑；连续 2 天仍停摆再查看 -Status）`);
        }
      }
    } else {
      const at = Date.parse(stats?.updatedAt ?? "");
      if (stats === null) {
        reasons.push("db-maintain.sh 从未运行（无 db-stats.txt）——POSIX 无登录自启/计划任务，需用 cron 或 systemd timer 每日调度（一次性配置）");
      } else if (Number.isNaN(at)) {
        reasons.push("db-stats.txt 缺 updatedAt（db-maintain.sh 未完整跑过）");
      } else if (nowMs - at > STALE_DAYS * 86400 * 1000) {
        reasons.push(`db-maintain.sh 已 ${Math.floor((nowMs - at) / 86400000)} 天未运行——POSIX 需 cron 或 systemd timer 每日调度（一次性配置）`);
      }
    }

    // ── error.log：48h 内有失败 ──
    try {
      const st = fs.statSync(p.errorLog);
      if (st.size > 0 && nowMs - st.mtimeMs < STALE_ERROR_HOURS * 3600 * 1000) {
        reasons.push(`error.log ${STALE_ERROR_HOURS}h 内有报错（看 $HOME/.local/state/kilo/maintenance/error.log 尾部）`);
      }
    } catch { /* 无 error.log = 没失败，健康 */ }

    // ── 引导死锁 flag 闭环状态 ──
    let flagContent: string | null = null;
    try { flagContent = fs.readFileSync(p.flagFile, "utf8"); } catch { flagContent = null; }
    const lnkExists = (() => { try { fs.accessSync(p.bootstrapLnk); return true; } catch { return false; } })();
    const disabled = (() => { try { fs.accessSync(p.disabledSentinel); return true; } catch { return false; } })();
    if (flagContent !== null) {
      if (!isWin32) {
        reasons.push("auto_vacuum≠2 引导死锁（vacuum-needed.flag）：POSIX 无登录自愈，需手动关闭 Kilo 后跑 db-maintain.sh 离线 VACUUM");
      } else if (disabled) {
        reasons.push("引导死锁但自愈被禁用（vacuum-bootstrap.disabled）——需手动 -VacuumNow 或删哨兵恢复自愈");
      } else if (!lnkExists) {
        reasons.push("引导死锁但登录自愈快捷方式缺失——下次登录/每日维护会自动补装");
      } else {
        const since = (/^unresolvedSince=(.+)$/m.exec(flagContent) || [""])[1].trim();
        const t = Date.parse(since);
        if (!Number.isNaN(t) && nowMs - t > BOOTSTRAP_STALE_DAYS * 86400 * 1000) {
          reasons.push(`自愈排队 ${Math.floor((nowMs - t) / 86400000)} 天仍未完成——重启电脑即可自动修复（重启≠关机：Fast Startup 下关机不触发自愈）`);
        }
        // ≤3 天：自愈已排队且会自己重试，静默
      }
    }

    // ── db-stats.txt 速率/收敛判定（取代裸尺寸告警；stats 已在活性证据处读过一次）──
    if (stats !== null) {
        const at = Date.parse(stats.updatedAt ?? "");
        const fresh = !Number.isNaN(at) && nowMs - at <= STATS_FRESH_MS;
        if (fresh) {
          const curBytes = num(stats.dbBytes), prevBytes = num(stats.prevBytes);
          const prevAt = Date.parse(stats.prevUpdatedAt ?? "");
          const days = (at - prevAt) / 86400000; // ms → 天
        if (!Number.isNaN(curBytes) && !Number.isNaN(prevBytes) && days >= 1) {
          const perDay = (curBytes - prevBytes) / days;
          if (perDay > GROW_WARN_BYTES_PER_DAY) {
            reasons.push(`DB 日增 ${(perDay / 1024 ** 3).toFixed(1)}GB 超回收上限 2GB/天——已下发 reclaim-intent 提升增量回收趟数；持续偏高请减小 --days 保留期`);
          }
        }
        const curFree = num(stats.freeBytes), prevFree = num(stats.prevFreeBytes);
        // days>=1：stats 只内嵌「上一轮」快照，日维护节拍下 prev 间隔恒 ≈1 天（≥2 永不满足）
        if (!Number.isNaN(curFree) && !Number.isNaN(prevFree) && curFree >= FREE_STALL_BYTES && prevFree >= FREE_STALL_BYTES && days >= 1) {
          reasons.push(`空闲页连续多轮 ≥2GB 未收敛——维护会自动重试增量回收；连续 3 天不收敛再查看 -DbStatus`);
        }
        const av = num(stats.autoVacuum);
        if (!Number.isNaN(av) && av !== 2 && flagContent === null) {
          reasons.push("stats 显示 auto_vacuum≠2 但引导 flag 不在（db-maintain.sh 版本旧或 flag 写失败）——下次维护会自动修正，无需手动");
        }
      }
    }

    // ── 状态目录体量（MoA P0-3）：日志只增不删=新的泄漏面；正常 <10MB，超限=轮转/卫生失效 ──
    try {
      const dir = path.dirname(p.stateFile);
      let total = 0;
      for (const f of fs.readdirSync(dir)) {
        try { total += fs.statSync(path.join(dir, f)).size; } catch { }
      }
      const maxBytes = opts?.stateDirMaxBytes ?? STATE_DIR_MAX_BYTES;
      if (total > maxBytes) {
        reasons.push(`维护状态目录 ${(total / 1024 ** 2).toFixed(0)}MB 超上限（日志轮转/卫生失效？——kilo-maintenance.ps1 -Status 查看）`);
      }
    } catch { /* 目录不存在=零体量，健康 */ }
  } catch {
    return []; // never-throw：心跳自身故障一律静默
  }
  return reasons;
}

// 按机器环境解析真实路径（db-maintain.sh / kilo-maintenance.ps1 共用的同一口径）
function maintPathsFor(homedir: string): MaintPaths {
  const dir = path.join(homedir, ".local", "state", "kilo", "maintenance");
  return {
    stateFile: path.join(dir, "state.json"),
    errorLog: path.join(dir, "error.log"),
    flagFile: path.join(dir, "vacuum-needed.flag"),
    bootstrapLnk: path.join(homedir, "AppData", "Roaming", "Microsoft", "Windows",
      "Start Menu", "Programs", "Startup", "kilo-vacuum-bootstrap.lnk"),
    disabledSentinel: path.join(dir, "vacuum-bootstrap.disabled"),
    statsFile: path.join(dir, "db-stats.txt"),
    intentFile: path.join(dir, "reclaim-intent.json"),
  };
}

// ── 告警缓存（2026-11-05 v3 重写）──────────────────────────────────────
// v2 两个生产级缺陷：① `until` 只写不读 → TTL 名存实亡，session.created 时算的文案可能数小时后
// 才注入（早已修复也照告），且创建后才出现的故障本会话永不告警；② `warned` Map 只在 todowrite
// 后 delete，无 todowrite 的会话条目永久驻留 → 常驻 serve 进程里随会话数无界增长。
// v3 语义：refresh 只负责「到期重估 + GC」，consume 才负责「TTL 节流 + 标记已投递」——
// 分离后任意工具调用都能安全刷新缓存，不会把未注入的告警标记成已投递（吞告警）。
export interface WarnEntry {
  text: string | null;   // 当前告警文案；null=健康（负缓存）
  recheckAt: number;     // 到期必须重估（陈旧文案绝不复用）
  notifyAfter: number;   // 同会话重复告警节流锚点
  seen: number;          // 最近活动时间（GC/淘汰依据）
  delivered: boolean;    // 本会话是否已通过任一通道展示过告警（idle 兜底只看这个）
}
export type WarnCache = Map<string, WarnEntry>;

// GC：24h 无活动删除；超容量淘汰最久未活动。每次 refresh 顺带执行，O(n) 且 n≤128。
function gcWarnCache(cache: WarnCache, now: number): void {
  for (const [k, e] of cache) if (now - e.seen > WARN_CACHE_KEEP_MS) cache.delete(k);
  while (cache.size > WARN_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, e] of cache) if (e.seen < oldest) { oldest = e.seen; oldestKey = k; }
    if (oldestKey === null) break;
    cache.delete(oldestKey);
  }
}

// 重估（不消费）：recheckAt 到期才真的扫盘，健康同样写负缓存——每次工具调用调本函数是廉价的。
function refreshWarning(cache: WarnCache, sid: string, now: number, recompute: () => string | null): void {
  gcWarnCache(cache, now);
  const prev = cache.get(sid);
  if (prev && now < prev.recheckAt) { prev.seen = now; return; }
  const text = recompute(); // 已恢复健康 → text=null，陈旧告警随之丢弃
  cache.set(sid, {
    text,
    recheckAt: now + WARN_RECHECK_MS,
    notifyAfter: prev?.notifyAfter ?? 0,
    seen: now,
    delivered: prev?.delivered ?? false,
  });
  gcWarnCache(cache, now); // 插入后再收一次：容量上限即时成立，不留「等到下次 refresh 才淘汰」窗口
}

// 消费（仅在真正把文案注入对话时调用）：TTL 内返回 null；成功取出即推进节流并标记已投递。
function consumeWarning(cache: WarnCache, sid: string, now: number): string | null {
  const e = cache.get(sid);
  if (!e || !e.text || now < e.notifyAfter) return null;
  e.notifyAfter = now + WARN_TTL_MS;
  e.delivered = true;
  e.seen = now;
  return e.text;
}

// 插件工厂（Kilo 加载器调用；单导出函数契约）
export const maintenanceHeartbeat = async (ctx: { session?: { id?: string }; log?: unknown } & Record<string, unknown>) => {
  const cache: WarnCache = new Map();
  const TAG = "[maintenance-heartbeat]";
  const isWin32 = os.platform() === "win32";
  // idle 兜底通道（同 quality-gate 出口门禁的 client.session.promptAsync）；无 client 时该通道
  // 静默关闭（fail-open），todowrite 通道不受影响。
  const client = (ctx as { client?: { session?: { promptAsync?: unknown } } })?.client;

  const currentWarning = (now: number): string | null => {
    try {
      const reasons = computeMaintReasons(maintPathsFor(os.homedir()), now, isWin32);
      if (reasons.length === 0) return null;
      return `${TAG} ⚠️ 维护链路需要关注：${reasons.join("；")}。详情：scripts/kilo-maintenance.ps1 -Status`;
    } catch { return null; }
  };

  // 意图下发（MoA P0-4）：证据=「日增超回收上限」。声明式白名单 {issuedAt, rounds}，原子
  // tmp+rename；已有未消费意图不覆盖（db-maintain.sh 单次消费，防多会话并发重写）。
  // 绝不携带路径/命令；消费侧硬夹 20..40 + 24h 新鲜度——伪造文件最坏效果=多耗 IO。
  const maybeWriteReclaimIntent = () => {
    try {
      const p = maintPathsFor(os.homedir());
      const intent = computeReclaimIntent(readStatsFile(p.statsFile), Date.now());
      if (!intent) return;
      try { fs.accessSync(p.intentFile); return; } catch { /* 不存在则写下发 */ }
      const tmp = `${p.intentFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ issuedAt: new Date().toISOString(), rounds: intent.rounds }) + "\n");
      fs.renameSync(tmp, p.intentFile);
    } catch { /* never-throw */ }
  };

  // 事件形态（2026-11-05 v3 修的 P0 死链）：Kilo 分发的是 `{ event: { id, type, properties } }`，
  // properties.sessionID / properties.info.id 携带会话 id（memory-bootstrap、memory-store、
  // quality-gate 三处一致）。v2 误用 `ev.name` + `ev.sessionID` → session.created 分支恒不触发、
  // 缓存永远为空，整个插件在生产中静默失效。这里以 type/properties 为准，旧形态仅作兜底兼容。
  const parseEvent = (input: unknown): { type: string; sid: string } | null => {
    const ev = (input as { event?: Record<string, unknown> })?.event;
    if (!ev) return null;
    const props = ev.properties as Record<string, unknown> | undefined;
    const info = props?.info as Record<string, unknown> | undefined;
    const type = String(ev.type ?? ev.name ?? "");
    const sidRaw = props?.sessionID ?? info?.id ?? ev.sessionID;
    if (!type || !sidRaw) return null;
    return { type, sid: String(sidRaw) };
  };

  return {
    event: async (input: unknown) => {
      try {
        const ev = parseEvent(input);
        if (!ev) return;
        if (ev.type === "session.created") {
          maybeWriteReclaimIntent();
          refreshWarning(cache, ev.sid, Date.now(), () => currentWarning(Date.now()));
          return;
        }
        if (ev.type === "session.idle") {
          // 兜底通道：从不用 todowrite 的会话（纯问答/闲聊）也要能看到首条告警。
          // 已投递过的会话不在 idle 重复打扰（后续重复提醒由 todowrite 通道按 TTL 承担）。
          if (cache.get(ev.sid)?.delivered) return;
          const promptAsync = client?.session?.promptAsync;
          // 无注入通道就直接返回，绝不 consume——否则告警被标记成已投递却没人看到（吞告警）。
          if (typeof promptAsync !== "function") return;
          refreshWarning(cache, ev.sid, Date.now(), () => currentWarning(Date.now()));
          const text = consumeWarning(cache, ev.sid, Date.now());
          if (!text) return;
          try {
            await (promptAsync as (a: unknown) => Promise<unknown>).call(client.session, {
              path: { id: ev.sid },
              body: {
                parts: [{ type: "text", text: `${text}\n（为维护链路自动巡检结果，无需回复；如已知晓可忽略）` }],
                messageID: `msg_maintenance_heartbeat_${ev.sid}_${Date.now().toString(36)}`,
              },
            });
          } catch {
            // 发送失败回滚投递标记与节流锚点：todowrite 通道/下次 idle 仍可补发，不丢告警。
            const e = cache.get(ev.sid);
            if (e) { e.delivered = false; e.notifyAfter = 0; }
          }
        }
      } catch { /* never-throw */ }
    },
    "tool.execute.after": async (input: {
      tool?: string; sessionID?: string; output?: { output?: string };
    }) => {
      try {
        if (!input?.sessionID) return;
        const sid = String(input.sessionID);
        // 每次工具调用都刷新（负缓存保证 5 分钟内零 IO）：创建之后才出现的故障也能被发现，
        // 且缓存文案永远新鲜。注意 refresh 不消费——只有真正注入时才 consume。
        refreshWarning(cache, sid, Date.now(), () => currentWarning(Date.now()));
        if (input.tool !== "todowrite") return;
        const out = input.output?.output;
        if (typeof out !== "string") return; // 无可注入载体：不消费，留给下一次
        const text = consumeWarning(cache, sid, Date.now());
        if (!text) return;
        input.output.output = `${out}\n\n${text}`;
      } catch { /* never-throw */ }
    },
  };
};

// ── 测试出口（命名空间对象无 server 属性，加载器会跳过；仅供 scripts/test-maintenance-heartbeat.mjs）──
export const _export = {
  computeMaintReasons, maintPathsFor, readStatsFile, computeReclaimIntent,
  gcWarnCache, refreshWarning, consumeWarning,
  STALE_DAYS, STALE_ERROR_HOURS, BOOTSTRAP_STALE_DAYS,
  GROW_WARN_BYTES_PER_DAY, FREE_STALL_BYTES, STATS_FRESH_MS,
  RECLAIM_BOOST_ROUNDS, STATE_DIR_MAX_BYTES,
  WARN_TTL_MS, WARN_RECHECK_MS, WARN_CACHE_KEEP_MS, WARN_CACHE_MAX,
};