#!/usr/bin/env node
// agent-timeout-guard.mjs
// 智能体超时守卫 CLI — 将 lifecycle/config.yaml timeouts 段从死配置变为可执行。
// 经 task 工具启动的外部智能体（coder/verifier/reviewer/planner/fixer）在派发前
// 记录超时预算，派发后由 conductor 定时 check；超时写 status:'timeout'，
// clear 时按 retry.agent_timeout_max_retries 决策 RETRY / ESCALATE。
//
// 用法：
//   node scripts/agent-timeout-guard.mjs start <task_id> --agent <name> --tier <T0|T1|T2> --dispatch-seq <N>
//     注意：start 在 dispatch_log 无该 seq 时（task dispatch 前 dispatch_log 尚空）
//     自动追加一条条目到末尾，实际 seq = dispatch_log.length-1（stdout 提示）。
//   node scripts/agent-timeout-guard.mjs check <task_id> --dispatch-seq <N>
//   node scripts/agent-timeout-guard.mjs clear <task_id> --dispatch-seq <N> --result <pass|fail|timeout>
//   node scripts/agent-timeout-guard.mjs --help
//
// 退出码：
//   start: 0=ok / 1=参数或权限错 / 2=config.yaml 缺 timeouts 段
//   check: 0=未超时 / 3=[AGENT_TIMEOUT]（已写 status:'timeout' + timed_out_at_ms）
//   clear: 0=pass|fail 已清（写 status:'cleared' + actual_duration_s）
//          / 4=[RETRY]（timeout 且计数 ≤ agent_timeout_max_retries）
//          / 5=[ESCALATE]（timeout 且计数 > agent_timeout_max_retries）
//          / 1=参数或权限错 / 2=config.yaml 缺 timeouts 段
//
// guard 记录写入 task_context.dispatch_log[N].timeout_guard：
//   { start_time_ms, budget_s, deadline_ms, status:'running'|'timeout'|'cleared',
//     agent, tier, timed_out_at_ms?, actual_duration_s? }
//
// 文件位置：os.tmpdir()/kilo/task_context_<task_id>.json（与 task-context.mjs 一致，
// 复用 task-context-runtime.mjs 的 contextPath / readContext / writeContext）。
// config.yaml 解析沿用仓库惯例（手写 yaml 子集解析，非第三方库）。
//
// 仅使用 Node 内置模块；跨平台：Windows PowerShell 5.1 + Linux bash 兼容。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  contextPath, readContext, writeContext, assertValidTaskId, die,
} from './task-context-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');

const VALID_TIERS = ['T0', 'T1', 'T2'];
const VALID_RESULTS = ['pass', 'fail', 'timeout'];

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/agent-timeout-guard.mjs start <task_id> --agent <name> --tier <T0|T1|T2> --dispatch-seq <N>',
    '  node scripts/agent-timeout-guard.mjs check <task_id> --dispatch-seq <N>',
    '  node scripts/agent-timeout-guard.mjs clear <task_id> --dispatch-seq <N> --result <pass|fail|timeout>',
    '  node scripts/agent-timeout-guard.mjs --help',
    '',
    'Exit codes:',
    '  start: 0=ok / 1=arg|perm / 2=config.yaml missing timeouts',
    '  check: 0=not timed out / 3=[AGENT_TIMEOUT] (writes status:timeout)',
    '  clear: 0=pass|fail cleared / 4=[RETRY] / 5=[ESCALATE] / 1=arg|perm / 2=missing timeouts',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

// 解析命名参数 --<name> <value>（可出现在任意位置），返回 Map<name, value>。
function parseNamed(args) {
  const map = new Map();
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([A-Za-z][A-Za-z0-9-]*)$/);
    if (m && i + 1 < args.length) {
      map.set(m[1], args[i + 1]);
      i++;
    }
  }
  return map;
}

// 剥离命名参数，返回剩余位置参数数组。
function stripNamed(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (/^--[A-Za-z]/.test(args[i]) && i + 1 < args.length) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// ============================================================
// config.yaml timeouts 段解析（手写 yaml 子集，仓库惯例）
// 返回：
//   { agent_startup_s, stage_default_s, per_agent_s, per_tier_multiplier,
//     agent_timeout_max_retries }
// 无 timeouts 顶层段 → 返回 null（调用方按 exit 2 处理）。
// ============================================================
function parseTimeouts(text) {
  const lines = text.split(/\r?\n/);
  let inTimeouts = false;
  let inPerAgent = false;
  let inPerTier = false;
  let inRetry = false;
  const t = {
    agent_startup_s: null,
    stage_default_s: null,
    per_agent_s: {},
    per_tier_multiplier: {},
    agent_timeout_max_retries: null,
  };

  for (const raw of lines) {
    // strip inline comment（保留值内 #，timeouts 段无引号值）
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;

    // 顶层键切换
    if (/^timeouts\s*:/.test(line)) { inTimeouts = true; inPerAgent = false; inPerTier = false; inRetry = false; continue; }
    if (/^[a-z_]+\s*:/.test(line) && !/^\s/.test(line)) {
      inTimeouts = false; inPerAgent = false; inPerTier = false; inRetry = false;
      continue;
    }
    if (!inTimeouts) continue;

    // 2-space keys under timeouts
    const sub = line.match(/^  ([a-z_]+)\s*:\s*(.*)$/);
    if (sub) {
      const key = sub[1];
      const val = sub[2].trim();
      if (key === 'per_agent_s') { inPerAgent = true; inPerTier = false; inRetry = false; continue; }
      if (key === 'per_tier_multiplier') { inPerTier = true; inPerAgent = false; inRetry = false; continue; }
      if (key === 'retry') { inRetry = true; inPerAgent = false; inPerTier = false; continue; }
      inPerAgent = false; inPerTier = false; inRetry = false;
      if (key === 'agent_startup_s' && /^\d+$/.test(val)) t.agent_startup_s = parseInt(val, 10);
      if (key === 'stage_default_s' && /^\d+$/.test(val)) t.stage_default_s = parseInt(val, 10);
      continue;
    }

    // per_agent_s: 4-space indent key -> integer
    if (inPerAgent) {
      const m = line.match(/^    ([a-z_]+)\s*:\s*(\d+)\s*$/);
      if (m) { t.per_agent_s[m[1]] = parseInt(m[2], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inPerAgent = false; }
    }
    // per_tier_multiplier: 4-space indent T0/T1/T2 -> float
    if (inPerTier) {
      const m = line.match(/^    (T[0-3])\s*:\s*([\d.]+)\s*$/);
      if (m) { t.per_tier_multiplier[m[1]] = parseFloat(m[2]); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inPerTier = false; }
    }
    // retry.agent_timeout_max_retries: 4-space indent
    if (inRetry) {
      const m = line.match(/^    agent_timeout_max_retries\s*:\s*(\d+)\s*$/);
      if (m) { t.agent_timeout_max_retries = parseInt(m[1], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inRetry = false; }
    }
  }

  return t;
}

// 读取 config.yaml timeouts；文件缺失或缺少 timeouts 段 → null。
function readTimeouts() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_SOURCE, 'utf8');
  } catch {
    return null;
  }
  if (!/^\s*timeouts\s*:/m.test(text)) return null;
  return parseTimeouts(text);
}

// ============================================================
// guard 读写辅助（独立读写 dispatch_log[N].timeout_guard，不改 task-context.mjs）
// ============================================================

function getDispatchLog(ctx) {
  return Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : null;
}

// 取 dispatch_log[N]（N 为数组索引）。越界 → 返回 null。
function getLogEntry(ctx, seq) {
  const log = getDispatchLog(ctx);
  if (!log || !Number.isInteger(seq) || seq < 0 || seq >= log.length) return null;
  return log[seq];
}

// ============================================================
// start：记录守卫
// ============================================================
function cmdStart(taskId, agent, tier, seq) {
  if (!agent || !['T0', 'T1', 'T2'].includes(tier)) {
    die(1, 'Error: start requires --agent <name> --tier <T0|T1|T2>');
  }
  if (!Number.isInteger(seq) || seq < 0) {
    die(1, 'Error: start requires --dispatch-seq <non-negative integer>');
  }
  const to = readTimeouts();
  if (!to) die(2, 'Error: lifecycle/config.yaml missing "timeouts" section');

  const perAgentS = (to.per_agent_s && typeof to.per_agent_s[agent] === 'number')
    ? to.per_agent_s[agent] : null;
  const stageDefault = (typeof to.stage_default_s === 'number') ? to.stage_default_s : 600;
  const baseS = (perAgentS !== null) ? perAgentS : stageDefault;
  const mult = (to.per_tier_multiplier && typeof to.per_tier_multiplier[tier] === 'number')
    ? to.per_tier_multiplier[tier] : 1.0;
  const budgetS = baseS * mult;

  const { ctx } = readContext(taskId);
  let entry = getLogEntry(ctx, seq);
  let effectiveSeq = seq;
  if (!entry) {
    // 真实接线时序：conductor 在 task dispatch 前调用 start，此时 dispatch_log 尚为空
    // （log-dispatch 是 task 返回后才追加条目）。dispatch_log 缺失或 seq 越界时
    // 追加一条新条目到末尾，实际 seq = dispatch_log.length-1。
    if (!Array.isArray(ctx.dispatch_log)) ctx.dispatch_log = [];
    ctx.dispatch_log.push({ agent, stage: null, mode: 'task', timeout_guard: null });
    effectiveSeq = ctx.dispatch_log.length - 1;
    entry = ctx.dispatch_log[effectiveSeq];
  }
  if (!entry.timeout_guard || typeof entry.timeout_guard !== 'object') {
    entry.timeout_guard = {};
  }
  const now = Date.now();
  entry.timeout_guard = {
    start_time_ms: now,
    budget_s: budgetS,
    deadline_ms: now + Math.round(budgetS * 1000),
    status: 'running',
    agent,
    tier,
  };
  writeContext(taskId, ctx);
  const appendedNote = effectiveSeq !== seq ? ` (appended dispatch_log[${effectiveSeq}])` : '';
  process.stdout.write(
    `ok: timeout_guard started (agent=${agent} tier=${tier} seq=${effectiveSeq} budget_s=${budgetS} ` +
    `per_agent_s=${perAgentS !== null ? perAgentS : '(fallback stage_default)'} multiplier=${mult}${appendedNote})\n`
  );
  process.exit(0);
}

// ============================================================
// check：判定超时
// ============================================================
function cmdCheck(taskId, seq) {
  if (!Number.isInteger(seq) || seq < 0) die(1, 'Error: check requires --dispatch-seq <non-negative integer>');
  const { ctx } = readContext(taskId);
  const entry = getLogEntry(ctx, seq);
  if (!entry) die(1, `Error: dispatch_log[${seq}] not found for task_id=${taskId}`);
  const g = entry.timeout_guard;
  if (!g || typeof g !== 'object') die(1, `Error: timeout_guard not started for dispatch_log[${seq}]. Run start first.`);

  const elapsed = Date.now() - (typeof g.start_time_ms === 'number' ? g.start_time_ms : Date.now());
  const budgetS = (typeof g.budget_s === 'number') ? g.budget_s : 0;
  const alreadyTimeout = g.status === 'timeout';
  const isOver = elapsed > budgetS * 1000;

  if (alreadyTimeout || isOver) {
    if (!alreadyTimeout) {
      g.status = 'timeout';
      g.timed_out_at_ms = Date.now();
      writeContext(taskId, ctx);
    }
    process.stdout.write(
      `[AGENT_TIMEOUT] seq=${seq} elapsed_ms=${elapsed} budget_s=${budgetS} status=${g.status}\n`
    );
    process.exit(3);
  }
  process.stdout.write(`ok: seq=${seq} elapsed_ms=${elapsed} budget_s=${budgetS} remaining_s=${(budgetS - elapsed / 1000).toFixed(1)} (not timed out)\n`);
  process.exit(0);
}

// ============================================================
// clear：pass|fail 清理 / timeout 重试或升级决策
// ============================================================
function cmdClear(taskId, seq, result) {
  if (!VALID_RESULTS.includes(result)) {
    die(1, `Error: clear requires --result <${VALID_RESULTS.join('|')}>`);
  }
  if (!Number.isInteger(seq) || seq < 0) die(1, 'Error: clear requires --dispatch-seq <non-negative integer>');
  const { ctx } = readContext(taskId);
  const entry = getLogEntry(ctx, seq);
  if (!entry) die(1, `Error: dispatch_log[${seq}] not found for task_id=${taskId}`);
  const g = entry.timeout_guard;
  if (!g || typeof g !== 'object') die(1, `Error: timeout_guard not started for dispatch_log[${seq}]. Run start first.`);

  const startMs = (typeof g.start_time_ms === 'number') ? g.start_time_ms : Date.now();
  const actualS = Math.round((Date.now() - startMs) / 1000);

  if (result === 'pass' || result === 'fail') {
    g.status = 'cleared';
    g.actual_duration_s = actualS;
    g.clear_result = result;
    writeContext(taskId, ctx);
    process.stdout.write(`ok: seq=${seq} cleared result=${result} actual_duration_s=${actualS}\n`);
    process.exit(0);
  }

  // result === 'timeout'：读 retry 配额，统计同 agent 已 timeout 次数
  const to = readTimeouts();
  if (!to) die(2, 'Error: lifecycle/config.yaml missing "timeouts" section');
  const maxRetries = (typeof to.agent_timeout_max_retries === 'number')
    ? to.agent_timeout_max_retries : 1;
  const agent = g.agent;

  // 统计 dispatch_log 中同 agent 的 timeout_guard.status==='timeout' 次数
  let timeoutCount = 0;
  for (const e of getDispatchLog(ctx) || []) {
    if (e && e.timeout_guard && e.timeout_guard.status === 'timeout'
        && e.timeout_guard.agent === agent) {
      timeoutCount++;
    }
  }

  // 本守卫若尚未标 timeout（clear 直接 timeout）则补标，参与计数
  if (g.status !== 'timeout') {
    g.status = 'timeout';
    g.timed_out_at_ms = g.timed_out_at_ms || Date.now();
  }
  writeContext(taskId, ctx);

  if (timeoutCount <= maxRetries) {
    process.stdout.write(`[RETRY] seq=${seq} agent=${agent} timeout_count=${timeoutCount} max_retries=${maxRetries} → 允许重跑\n`);
    process.exit(4);
  }
  process.stdout.write(`[ESCALATE] seq=${seq} agent=${agent} timeout_count=${timeoutCount} > max_retries=${maxRetries} → 升级处理\n`);
  process.exit(5);
}

// ============================================================
// 入口
// ============================================================
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();
  const sub = args[0];
  const rest = args.slice(1);
  const named = parseNamed(rest);
  const positional = stripNamed(rest);

  const taskId = positional[0];

  if (sub === 'start') {
    if (!taskId) die(1, 'Error: start requires <task_id>');
    const agent = named.get('agent');
    const tier = named.get('tier');
    const seqStr = named.get('dispatch-seq');
    if (seqStr === undefined) die(1, 'Error: start requires --dispatch-seq <N>');
    const seq = Number.parseInt(seqStr, 10);
    assertValidTaskId(taskId);
    cmdStart(taskId, agent, tier, seq);
  } else if (sub === 'check') {
    if (!taskId) die(1, 'Error: check requires <task_id>');
    const seqStr = named.get('dispatch-seq');
    if (seqStr === undefined) die(1, 'Error: check requires --dispatch-seq <N>');
    const seq = Number.parseInt(seqStr, 10);
    assertValidTaskId(taskId);
    cmdCheck(taskId, seq);
  } else if (sub === 'clear') {
    if (!taskId) die(1, 'Error: clear requires <task_id>');
    const seqStr = named.get('dispatch-seq');
    const result = named.get('result');
    if (seqStr === undefined || result === undefined) die(1, 'Error: clear requires --dispatch-seq <N> --result <pass|fail|timeout>');
    const seq = Number.parseInt(seqStr, 10);
    assertValidTaskId(taskId);
    cmdClear(taskId, seq, result);
  } else {
    die(1, `Error: unknown subcommand "${sub}". Use --help.`);
  }
}

main();