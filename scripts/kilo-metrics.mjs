#!/usr/bin/env node
// Kilo 会话语料画像（只读）：从 kilo.db 的 step-finish 账本聚合步数/缓存命中/耗时。
// 背景（2026-10-18 v3.md 评审）：本机缓存命中率已约 89%，真正贵的是步数、切模型失效
// 与长 prompt——调参需要数据，本脚本把 tokens + elapsed + reason 按模型/agent 聚合出来。
// 依赖 node:sqlite（Node 22+ 实验特性，纯标准库；更旧的 node 需 --experimental-sqlite）。
// 只读打开（readOnly），绝不写库。退出码：0 正常 / 1 参数、DB 或查询错误。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAG = "kilo-metrics";

// 口径说明与缓存写入：cache.write=0 是 OpenAI 兼容协议常态（部分上游只在响应里回
// cache.read），不代表未命中；命中率统一按 cache.read/(input+cache.read) 计。
const NOTE =
  "cache.write=0 是 OpenAI 兼容协议常态，不代表缓存未命中；命中率按 cache.read/(input+cache.read) 口径看。";

function usage() {
  return [
    "用法: node scripts/kilo-metrics.mjs [选项]",
    "  --days N   统计最近 N 天（默认 3）",
    "  --db PATH  会话库路径（默认 <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db）",
    "  --top N    分模型表行数上限（默认 12）",
    "  --json     输出单个 JSON 对象供自动化（不打印表格）",
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

// ── 参数解析（简单 while，不引依赖）────────────────────────────
let days = 3;
let topN = 12;
let jsonOut = false;
let dbPath = null;
const argv = process.argv.slice(2);
let i = 0;
while (i < argv.length) {
  const arg = argv[i++];
  if (arg === "--days" || arg === "--db" || arg === "--top") {
    const val = argv[i++];
    if (val === undefined || val.startsWith("--")) fail(`${arg} 缺少参数值（--help 看用法）`);
    if (arg === "--days") {
      days = Number(val);
      if (!Number.isFinite(days) || days <= 0) fail(`--days 需为正数：${val}`);
    } else if (arg === "--top") {
      topN = Number(val);
      if (!Number.isInteger(topN) || topN <= 0) fail(`--top 需为正整数：${val}`);
    } else {
      dbPath = val;
    }
  } else if (arg === "--json") {
    jsonOut = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else {
    console.error(usage());
    fail(`未知参数：${arg}`);
  }
}
if (!dbPath) dbPath = defaultDbPath();
// 便利展开 `~`（PowerShell/Unix shell 不一定会替参数展开）；只认路径开头的 ~。
dbPath = dbPath.replace(/^~(?=$|[\\/])/, os.homedir());

// ── 打开只读库并查询 ──────────────────────────────────────────
// 时间窗：part.time_created 是 INTEGER 毫秒时间戳（schema 实证）。不能按 ISO 字符串
// 绑定——SQLite 亲和性规则下 "2026-…" 非良构数字、保持 TEXT，INTEGER >= TEXT 恒 false
// （实测返回 0 行）；必须绑毫秒数。
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

// 查询文本与 v3.md 评审结论一致：时间过滤放在 json_valid 之后，可吃
// part_session_step_finish_idx 部分索引，不额外建索引。
const SQL = `
SELECT p.time_created AS ts,
       json_extract(p.data,'$.tokens.input') AS input,
       json_extract(p.data,'$.tokens.cache.read') AS cacheRead,
       json_extract(p.data,'$.tokens.cache.write') AS cacheWrite,
       json_extract(p.data,'$.tokens.output') AS output,
       json_extract(p.data,'$.tokens.reasoning') AS reasoning,
       json_extract(p.data,'$.time.elapsed') AS elapsed,
       json_extract(p.data,'$.reason') AS reason,
       json_extract(m.data,'$.modelID') AS model,
       json_extract(m.data,'$.agent') AS agent
FROM part p LEFT JOIN message m ON m.id = p.message_id
WHERE json_valid(p.data) AND json_extract(p.data,'$.type')='step-finish'
  AND p.time_created >= ?`;

let db;
let rows;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  rows = db.prepare(SQL).all(sinceMs);
} catch (e) {
  fail(`查询失败：${e?.message ?? e}`);
} finally {
  try { db?.close(); } catch { /* 关闭失败不影响输出 */ }
}

// ── 聚合 ─────────────────────────────────────────────────────
// Number() 归一是唯一入口：json_extract 缺字段为 null（Number(null)=0）；非数字垃圾
// 转出 NaN 的按 0 计；elapsed 的 NaN 作 null 处理（跳过分位与均值，不虚增样本）。
const num0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const acc = {
  steps: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  elapsedVals: [],
  byModel: new Map(),
  byReason: new Map(),
};

for (const r of rows) {
  const input = num0(r.input);
  const cacheRead = num0(r.cacheRead);
  const output = num0(r.output);
  const reasoning = num0(r.reasoning);
  const elapsed = numOrNull(r.elapsed);
  const model = r.model == null ? "unknown" : String(r.model);
  const agent = r.agent == null ? "unknown" : String(r.agent);
  const reason = r.reason == null ? "unknown" : String(r.reason);

  acc.steps += 1;
  acc.input += input;
  acc.cacheRead += cacheRead;
  acc.cacheWrite += num0(r.cacheWrite);
  acc.output += output;
  acc.reasoning += reasoning;
  if (elapsed != null) acc.elapsedVals.push(elapsed);

  const key = `${model} / ${agent}`;
  let g = acc.byModel.get(key);
  if (!g) {
    g = { model, agent, steps: 0, input: 0, cacheRead: 0, elapsedSum: 0, elapsedCount: 0 };
    acc.byModel.set(key, g);
  }
  g.steps += 1;
  g.input += input;
  g.cacheRead += cacheRead;
  if (elapsed != null) {
    g.elapsedSum += elapsed;
    g.elapsedCount += 1;
  }

  acc.byReason.set(reason, (acc.byReason.get(reason) ?? 0) + 1);
}

// 分位：升序后取 floor((n-1)*q)，单元素退化为 idx 0，边界安全。
function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * q)));
  return sortedAsc[idx];
}

const sortedElapsed = acc.elapsedVals.slice().sort((a, b) => a - b);
const p50 = percentile(sortedElapsed, 0.5);
const p90 = percentile(sortedElapsed, 0.9);

const totalPrompt = acc.input + acc.cacheRead;
const hitRate = totalPrompt > 0 ? acc.cacheRead / totalPrompt : null;
const avg = (total, n) => (n > 0 ? total / n : null);
const avgPrompt = avg(totalPrompt, acc.steps);
const avgUncached = avg(acc.input, acc.steps);
const avgOutput = avg(acc.output, acc.steps);
const avgReasoning = avg(acc.reasoning, acc.steps);

const models = [...acc.byModel.values()]
  .map((g) => {
    const prompt = g.input + g.cacheRead;
    return {
      model: g.model,
      agent: g.agent,
      steps: g.steps,
      hitRate: prompt > 0 ? g.cacheRead / prompt : null,
      avgPrompt: avg(prompt, g.steps),
      avgElapsed: avg(g.elapsedSum, g.elapsedCount),
    };
  })
  .sort((a, b) => b.steps - a.steps)
  .slice(0, topN);

const reasons = [...acc.byReason.entries()]
  .map(([reason, n]) => ({
    reason,
    steps: n,
    share: acc.steps > 0 ? n / acc.steps : null,
  }))
  .sort((a, b) => b.steps - a.steps);

// ── 输出 ─────────────────────────────────────────────────────
if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        days,
        window: { since: sinceIso, now: new Date(nowMs).toISOString() },
        rows: acc.steps,
        totals: {
          steps: acc.steps,
          input: acc.input,
          cacheRead: acc.cacheRead,
          cacheWrite: acc.cacheWrite,
          output: acc.output,
          reasoning: acc.reasoning,
        },
        hitRate,
        avgPromptPerStep: avgPrompt,
        avgUncachedInputPerStep: avgUncached,
        avgOutputPerStep: avgOutput,
        avgReasoningPerStep: avgReasoning,
        elapsedMs: { p50, p90, samples: sortedElapsed.length },
        models,
        reasons,
        note: NOTE,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const fmtInt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (n) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);
const fmtMs = (n) => (n == null ? "-" : `${Math.round(n).toLocaleString("en-US")} ms`);

// padEnd 对齐即可（中文字符宽度不参与计算，列间距仍可读）
function renderTable(header, body) {
  const widths = header.map((h, ci) => Math.max(String(h).length, ...body.map((r) => String(r[ci] ?? "").length)));
  const line = (cells) => cells.map((c, ci) => String(c ?? "").padEnd(widths[ci])).join("  ");
  return [line(header), ...body.map(line)].join("\n");
}

const out = [];
out.push("Kilo 会话画像（只读）");
out.push(`  db     : ${dbPath}`);
out.push(`  window : 最近 ${days} 天（${sinceIso} ~ ${new Date(nowMs).toISOString()}）`);
out.push(`  rows   : ${fmtInt(acc.steps)} 条 step-finish`);
out.push("");
out.push("[总览]");
out.push(`  总步数            : ${fmtInt(acc.steps)}`);
out.push(`  总 input          : ${fmtInt(acc.input)}`);
out.push(`  总 cacheRead      : ${fmtInt(acc.cacheRead)}`);
out.push(`  命中率            : ${fmtPct(hitRate)}`);
out.push(`  平均每步 prompt   : ${fmtInt(avgPrompt)}`);
out.push(`  平均 uncached input: ${fmtInt(avgUncached)}`);
out.push(`  平均 output       : ${fmtInt(avgOutput)}`);
out.push(`  平均 reasoning    : ${fmtInt(avgReasoning)}`);
out.push(`  elapsed p50       : ${fmtMs(p50)}`);
out.push(`  elapsed p90       : ${fmtMs(p90)}`);
out.push("");
out.push(`[分模型 / agent]（按步数倒序，top ${topN}）`);
out.push(
  renderTable(
    ["model / agent", "steps", "hitRate", "avgPrompt", "avgElapsed"],
    models.map((m) => [
      `${m.model} / ${m.agent}`,
      fmtInt(m.steps),
      fmtPct(m.hitRate),
      fmtInt(m.avgPrompt),
      fmtMs(m.avgElapsed),
    ]),
  ),
);
out.push("");
out.push("[按 reason]");
out.push(
  renderTable(
    ["reason", "steps", "share"],
    reasons.map((r) => [r.reason, fmtInt(r.steps), fmtPct(r.share)]),
  ),
);
out.push("");
out.push(NOTE);
console.log(out.join("\n"));
