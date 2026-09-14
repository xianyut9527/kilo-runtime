#!/usr/bin/env node
// 本地遥测汇总（W6）
//   node scripts/metrics-report.mjs [--dir <project>] [--days 7] [--json]
//
// 数据源（均为本地文件，绝不联网 —— 反模式 R7）：
//   1. <project>/.kilo/metrics/telemetry-*.jsonl       （plugin/telemetry-local.ts 产出）
//   2. ~/.local/share/kilo/failover-events.jsonl       （provider/hx-failover 产出，跨项目）
// 产出：工具分布 / 拦截或失败 / 会话事件 / 重试与压缩 / agent 与模型分布 / 降级统计。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

const root = path.resolve(flag("dir", process.cwd()));
const days = Number(flag("days", "7")) || 7;
const asJson = args.includes("--json");
const metricsDir = path.join(root, ".kilo", "metrics");
const failoverFile = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "kilo",
  "failover-events.jsonl"
);

if (!fs.existsSync(metricsDir) && !fs.existsSync(failoverFile)) {
  console.error(`未找到遥测数据：`);
  console.error(`  ${metricsDir}${fs.existsSync(metricsDir) ? "" : "（不存在）"}`);
  console.error(`  ${failoverFile}${fs.existsSync(failoverFile) ? "" : "（不存在）"}`);
  console.error("请先在启用 telemetry-local 插件的项目里产生一些会话。");
  process.exit(1);
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - days + 1);
const cutoffKey = dayKey(cutoff);
const withinWindow = (iso) => typeof iso === "string" && iso.slice(0, 10) >= cutoffKey;

const files = fs.existsSync(metricsDir)
  ? fs
      .readdirSync(metricsDir)
      .filter((f) => /^telemetry-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .filter((f) => f.slice("telemetry-".length, -".jsonl".length) >= cutoffKey)
      .sort()
  : [];

const records = [];
let badLines = 0;
function ingest(file) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (withinWindow(r.ts)) records.push(r);
    } catch {
      badLines++;
    }
  }
}
for (const f of files) ingest(path.join(metricsDir, f));
const failoverAvailable = fs.existsSync(failoverFile);
if (failoverAvailable) ingest(failoverFile);

if (!records.length) {
  console.error(`最近 ${days} 天内无遥测记录（>= ${cutoffKey}）。`);
  process.exit(1);
}

const countBy = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) ?? "(unknown)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const toolCalls = records.filter((r) => r.kind === "tool_call");
const blocked = records.filter((r) => r.kind === "tool_blocked_or_failed");
const events = records.filter((r) => r.kind === "event");
const failovers = records.filter((r) => r.kind === "failover");
const fallbacks = failovers.filter((r) => r.action === "fallback");
const exhausted = failovers.filter((r) => r.action === "exhausted");

const summary = {
  root,
  window: { days, from: cutoffKey, files: files.length, failoverLog: failoverAvailable },
  totalRecords: records.length,
  badLines,
  tools: countBy(toolCalls, (r) => r.tool),
  blockedOrFailed: blocked.length,
  blockedByTool: countBy(blocked, (r) => r.tool),
  events: countBy(events, (r) => r.type),
  agents: countBy(records.filter((r) => r.data?.agent), (r) => r.data.agent),
  models: countBy(records.filter((r) => r.data?.model), (r) => r.data.model),
  retries: events.filter((r) => r.type === "session.next.retried").length,
  compactions: events.filter((r) => String(r.type).includes("compaction")).length,
  failover: {
    events: failovers.length,
    fallbacks: fallbacks.length,
    exhausted: exhausted.length,
    byPair: countBy(fallbacks.filter((r) => r.to), (r) => `${r.from} -> ${r.to}`),
    byFailedModel: countBy(fallbacks, (r) => r.at),
  },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

function table(title, rows) {
  console.log(`\n## ${title}`);
  if (!rows.length) {
    console.log("  （无）");
    return;
  }
  const w = Math.max(...rows.map(([k]) => String(k).length), 4);
  for (const [k, v] of rows) {
    const bar = "█".repeat(Math.min(40, v));
    console.log(`  ${String(k).padEnd(w)}  ${String(v).padStart(5)}  ${bar}`);
  }
}

console.log(`# 本地遥测汇总`);
console.log(`项目：${root}`);
console.log(`窗口：最近 ${days} 天（${cutoffKey} 起，${files.length} 个 telemetry 文件${failoverAvailable ? " + failover 日志" : ""}）`);
console.log(`记录：${records.length} 条${badLines ? `（${badLines} 行解析失败已跳过）` : ""}`);
if (summary.retries || summary.compactions || summary.blockedOrFailed || summary.failover.events) {
  console.log(
    `信号：重试 ${summary.retries} · 压缩 ${summary.compactions} · 拦截/失败 ${summary.blockedOrFailed} · 降级 ${summary.failover.fallbacks}（耗尽 ${summary.failover.exhausted}）`
  );
}

table("工具调用分布", summary.tools);
table("拦截 / 失败（按工具）", summary.blockedByTool);
table("会话事件", summary.events);
table("Agent 出场", summary.agents);
table("模型出场", summary.models);
table("模型降级（from -> to）", summary.failover.byPair);
table("降级触发模型", summary.failover.byFailedModel);

console.log(`\n> 数据来源：本地 JSONL（项目 .kilo/metrics/ + 全局 failover-events.jsonl），不上传。`);
