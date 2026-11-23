#!/usr/bin/env node
// 压缩档位审计（只读）：统计最近 N 天 agent="compaction" 消息的 variant 分布，
// 验证 agent.compaction.variant=low 是否真的被执行，以及 provider 侧
// compactionEffort clamp 是否把 low 占比抬起来。
// 背景（2026-11-17 P1-1）：7.8.18 起运行时 variant 钉选失效——近 30 天快照
// max 1037 / high 991 / low 42，配置 low 形同虚设；provider 保守 clamp 已上线，
// 本脚本是落地监控（只读、不联网、不写库）。
// 口径警告：message 表随留存窗滚动、新增事件持续写入，计数是**滚动快照口径**，
// 不是永久精确值；对比趋势看量级与 low 占比，不要把某一天的计数当常量。
// 用法：node scripts/audit-compaction.mjs [--days N] [--db PATH] [--strict]
//   --strict  low 占比 < 90% 退出 1（默认只报告、退出 0）
// 退出码：0 正常 / 1 参数、DB、查询错误或 --strict 未达标。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAG = "audit-compaction";
const LOW_SHARE_STRICT = 0.9;

function usage() {
  return [
    "用法: node scripts/audit-compaction.mjs [选项]",
    "  --days N   统计最近 N 天（默认 30）",
    "  --db PATH  会话库路径（默认 <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db）",
    "  --strict   low 占比 < 90% 退出 1（默认只报告）",
    "  --help     显示本帮助",
  ].join("\n");
}

function fail(msg) {
  console.error(`${TAG}: ${msg}`);
  process.exit(1);
}

function defaultDbPath() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "kilo", "kilo.db");
}

let days = 30;
let dbPath = null;
let strict = false;
const argv = process.argv.slice(2);
let i = 0;
while (i < argv.length) {
  const arg = argv[i++];
  if (arg === "--days" || arg === "--db") {
    const val = argv[i++];
    if (val === undefined || val.startsWith("--")) fail(`${arg} 缺少参数值（--help 看用法）`);
    if (arg === "--days") {
      days = Number(val);
      if (!Number.isFinite(days) || days <= 0) fail(`--days 需为正数：${val}`);
    } else {
      dbPath = val;
    }
  } else if (arg === "--strict") {
    strict = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else {
    console.error(usage());
    fail(`未知参数：${arg}`);
  }
}
if (!dbPath) dbPath = defaultDbPath();
dbPath = dbPath.replace(/^~(?=$|[\\/])/, os.homedir());

const nowMs = Date.now();
const sinceMs = nowMs - days * 86400000;
const sinceIso = new Date(sinceMs).toISOString();

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  fail(`无法加载 node:sqlite（Node 22+ 实验特性，旧版需 --experimental-sqlite）：${e?.message ?? e}`);
}
if (!fs.existsSync(dbPath)) fail(`数据库不存在：${dbPath}`);

// message.time_created 是 INTEGER 毫秒（schema 实证），必须绑毫秒数；绑 ISO 字符串
// 会因 SQLite 亲和性规则恒为 0 行（与 kilo-metrics 同口径）。
const SQL = `
SELECT coalesce(json_extract(data,'$.variant'),'(null)') AS variant,
       count(*) AS n
FROM message
WHERE time_created >= ?
  AND json_extract(data,'$.agent')='compaction'
GROUP BY variant
ORDER BY n DESC`;

let rows;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    rows = db.prepare(SQL).all(sinceMs);
  } finally {
    try { db.close(); } catch { /* 关闭失败不影响输出 */ }
  }
} catch (e) {
  fail(`查询失败：${e?.message ?? e}`);
}

const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
const lowCount = Number(rows.find((r) => r.variant === "low")?.n ?? 0);
const lowShare = total > 0 ? lowCount / total : null;

const fmtInt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (n) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);

const out = [];
out.push("Kilo 压缩档位审计（只读）");
out.push(`  db     : ${dbPath}`);
out.push(`  window : 最近 ${days} 天（${sinceIso} ~ ${new Date(nowMs).toISOString()}）`);
out.push(`  口径   : 滚动快照口径（message 留存窗滚动 + 新增事件，计数会随时间变化）`);
out.push(`  rows   : ${fmtInt(total)} 条 agent="compaction" 消息`);
out.push("");
out.push("[variant 分布]");
const width = Math.max(7, ...rows.map((r) => String(r.variant).length));
out.push(`${"variant".padEnd(width)}  count   share`);
for (const r of rows) {
  const share = total > 0 ? Number(r.n) / total : null;
  out.push(`${String(r.variant).padEnd(width)}  ${fmtInt(Number(r.n)).padStart(6)}  ${fmtPct(share)}`);
}
out.push("");
out.push(`low 占比: ${fmtPct(lowShare)}（${fmtInt(lowCount)}/${fmtInt(total)}）`);
out.push("");
out.push("[可复现 SQL]");
out.push(SQL.trim());
out.push(`-- bind sinceMs = ${sinceMs}（${sinceIso}）`);
out.push("");
out.push("判定：low 占比持续 <90% = 运行时 variant 钉选仍未生效/未覆盖；provider");
out.push("compactionEffort clamp 生效后应逐步抬升（failover-events.jsonl 记");
out.push('action="compaction_effort_clamped"）。');

console.log(out.join("\n"));

if (strict && (lowShare == null || lowShare < LOW_SHARE_STRICT)) {
  console.error(`\n${TAG}: --strict 未达标：low 占比 ${fmtPct(lowShare)} < ${fmtPct(LOW_SHARE_STRICT)}`);
  process.exit(1);
}
process.exit(0);
