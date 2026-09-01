#!/usr/bin/env node
// flow-audit.mjs
// 独立流程审计器 — kilocode 架构内的编排流程合规检测工具。
//
// 定位：纯 kilo 工具，不绑外部机制（git hook 等）。由 conductor 在 DELIVERING
//   阶段内建调用 + lifecycle-doctor --runtime 集成 + 手动可跑，三层检测冗余。
//   校验 T1/T2 EXECUTION 任务是否走完 INIT→PLANNING→EXECUTING→QUALITY→DELIVERING
//   链路 + dispatch_log 含必经阶段 required_roles 派发。违规 → [FLOW_AUDIT_FAIL]。
//
// 校验对象：$TEMP/kilo/task_context_*.json 中所有 intent_type=EXECUTION 且
//   tier∈{T1,T2} 的活跃 task_context（status ∈ {initialized, RUNNING, PAUSED, DEGRADED}）。
//   DONE/FAILED 状态的 task_context 不校验（已结束）。
//
// 校验规则（T1/T2 执行类任务必经链路）：
//   1. transition_log 必须包含完整阶段序列：
//      T1/T2: INIT→PLANNING→EXECUTING→QUALITY→DELIVERING
//      T0:     INIT→EXECUTING→DELIVERING
//   2. dispatch_log 必须包含每个必经阶段的 required_roles 派发记录
//      （从 lifecycle/stages/<id>.md frontmatter required_roles 读取）
//   3. quality.verdict ∈ {PASS, CIRCUIT_BREAKER}（QUALITY 阶段必须有合法结论）
//   4. 豁免：T0 任务（T0 极速通道无 PLANNING/QUALITY）；INQUIRY 直通按 requiredStages intent 分流
//
// 用法：
//   node scripts/flow-audit.mjs                    # 扫活跃 task_context（mtime 30min 内）
//   node scripts/flow-audit.mjs --all              # 扫全部 task_context（含历史残留）
//   node scripts/flow-audit.mjs <task_id>          # 只校验指定 task_context
//   node scripts/flow-audit.mjs --clean-stale      # 清理超期违规 task_context（标记 FAILED）
//   node scripts/flow-audit.mjs --help
//
// 退出码：
//   0 = 全 PASS（或无活跃 task_context）
//   1 = 有 FAIL（[FLOW_AUDIT_FAIL]）
//   2 = 参数错误
//
// "活跃"定义：mtime 在 ACTIVE_THRESHOLD_MS（30min）内——正在进行中的任务。
//   conductor 在 DELIVERING 阶段内建调用本脚本（无参模式）做交付前合规自检。
//   `--all` 扫全部（含历史残留），供人工全量审计。
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContext, writeContext } from './task-context-runtime.mjs';
import { getStageRequiredRoles, isConditionalRole, hasCoverageMatrix, validateCoverageMatrix, hasSpreadTrigger } from './lib/stage-roles.mjs';
import { formatStage, formatTier, formatIntent, formatStatus, formatVerdict } from './lib/stage-i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = path.join(os.tmpdir(), 'kilo');

// ============================================================
// 工具
// ============================================================

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/flow-audit.mjs              # audit active task_contexts (mtime 30min)',
    '  node scripts/flow-audit.mjs --all        # audit all (incl. stale)',
    '  node scripts/flow-audit.mjs <task_id>    # audit single task_context',
    '  node scripts/flow-audit.mjs --clean-stale  # mark stale violated contexts as FAILED',
    '  node scripts/flow-audit.mjs --help',
    '',
    'Mechanical flow audit — verifies T1/T2 EXECUTION tasks completed the full',
    'PLANNING→EXECUTING→QUALITY→DELIVERING chain with required agent dispatches.',
    'Called by conductor in DELIVERING stage + lifecycle-doctor --runtime + manual.',
    '',
    'Exit codes:',
    '  0 = all PASS (or no active task_context)',
    '  1 = FAIL ([FLOW_AUDIT_FAIL])',
    '  2 = usage error',
  ].join('\n') + '\n');
  process.exit(0);
}

// 列活跃 task_context 文件（mtime 在 activeThresholdMs 内）
function listActiveContexts(allMode = false, activeThresholdMs = 30 * 60 * 1000) {
  if (!fs.existsSync(CONTEXT_DIR)) return [];
  const now = Date.now();
  return fs.readdirSync(CONTEXT_DIR)
    .filter((f) => /^task_context_.+\.json$/.test(f))
    .map((f) => {
      const m = f.match(/^task_context_(.+)\.json$/);
      if (!m) return null;
      const taskId = m[1];
      if (allMode) return taskId;
      // 只取 mtime 在 activeThresholdMs 内的
      try {
        const stat = fs.statSync(path.join(CONTEXT_DIR, f));
        if (now - stat.mtimeMs < activeThresholdMs) return taskId;
        return null;
      } catch { return null; }
    })
    .filter(Boolean);
}

// ============================================================
// 单 task_context 审计
// ============================================================

// 必经阶段序列（按 tier + intent_type + t1_strength：M1 起 intent 参与，INQUIRY 直通跳过 EXECUTING/QUALITY；
// T1 EXECUTION 按强度分流——low/medium 直通跳过 PLANNING，high/undefined 走完整设计门）
function requiredStages(tier, intentType, strength) {
  // M1 INQUIRY 直通分流
  if (intentType === 'INQUIRY' && tier === 'T0') return ['INIT', 'DELIVERING'];
  if (intentType === 'INQUIRY' && (tier === 'T1' || tier === 'T2')) return ['INIT', 'PLANNING', 'DELIVERING'];
  if (tier === 'T0') return ['INIT', 'EXECUTING', 'DELIVERING'];
  // T1 EXECUTION 强度分流：low/medium 直通（无 PLANNING）；high/undefined 走完整设计门
  if (tier === 'T1' && intentType === 'EXECUTION' && (strength === 'low' || strength === 'medium')) {
    return ['INIT', 'EXECUTING', 'QUALITY', 'DELIVERING'];
  }
  if (tier === 'T1' || tier === 'T2') return ['INIT', 'PLANNING', 'EXECUTING', 'QUALITY', 'DELIVERING'];
  return [];
}

// 校验 transition_log 包含完整阶段序列（允许连续边，不要求单条边一一对应）
function checkTransitionLog(ctx, required) {
  const errors = [];
  const log = Array.isArray(ctx.transition_log) ? ctx.transition_log : [];

  if (required.length === 0) return errors;  // 豁免

  if (log.length === 0) {
    errors.push(`transition_log 为空（必经阶段=${required.map(formatStage).join('→')}）`);
    return errors;
  }

  // 从 transition_log 重建访问过的阶段序列（首节点 START 不记录，从 INIT 开始）
  // transition_log 每条 {from, to, timestamp}，按顺序遍历，collect visited stages
  const visited = [];
  for (const e of log) {
    if (!visited.includes(e.from)) visited.push(e.from);
    if (!visited.includes(e.to)) visited.push(e.to);
  }
  // INIT 是 conductor 内建阶段,无 transition_check 入口,无条件注入 visited
  if (!visited.includes('INIT')) visited.unshift('INIT');

  // 校验 required 序列都在 visited 中且相对顺序正确
  let lastIdx = -1;
  for (const stage of required) {
    const idx = visited.indexOf(stage);
    if (idx === -1) {
      errors.push(`transition_log 缺少阶段 ${formatStage(stage)}（必经阶段=${required.map(formatStage).join('→')}, 已访问=${visited.map(formatStage).join('→')}）`);
    } else if (idx < lastIdx) {
      errors.push(`transition_log 阶段 ${formatStage(stage)} 顺序错位（必经阶段=${required.map(formatStage).join('→')}, 已访问=${visited.map(formatStage).join('→')}）`);
    } else {
      lastIdx = idx;
    }
  }

  return errors;
}

// 校验 dispatch_log 含每个必经阶段的 required_roles 派发（CONDITIONAL skip：INIT 无条件 skip；DELIVERING 仅在无 required_roles 时 skip）
function checkDispatchLog(ctx, required) {
  const errors = [];
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const dispatchedAgents = new Set(dispatchLog.map((e) => (e.agent || '').replace(/-/g, '_')));

  if (required.length === 0) return errors;  // 豁免

  // 对每个需要委派的阶段（非 conductor 内建），校验 required_roles 已派发
  // INIT 仍为 conductor 内建（无条件 skip）；DELIVERING 仅在无 required_roles 时 skip
  // DELIVERING 与 INIT 同为 conductor 内建阶段（executor: conductor），无需 required_roles 校验
  // T1 直通链（required 无 PLANNING）：PLANNING roles 自然被跳过，仅校验 EXECUTING/QUALITY/DELIVERING roles
  for (const stage of required) {
    if (stage === 'INIT') continue;
    if (stage === 'DELIVERING' && getStageRequiredRoles('DELIVERING').length === 0) continue;
    const roles = getStageRequiredRoles(stage);
    // QUALITY→DELIVERING 边的 fixer 是 onFail 条件角色，PASS 路径不派发属正确
    const rolesToCheck = stage === 'QUALITY' ? roles.filter((r) => !isConditionalRole(r)) : roles;
    for (const role of rolesToCheck) {
      const roleNorm = role.replace(/-/g, '_');
      if (!dispatchedAgents.has(roleNorm)) {
        errors.push(`dispatch_log 缺少 ${formatStage(stage)} 阶段必配角色 ${role}（已派发: ${[...dispatchedAgents].join(',') || '(空)'}）`);
      }
    }
  }

  return errors;
}

// 校验 quality.verdict 合法（T1/T2 必经 QUALITY）
function checkQualityVerdict(ctx, required) {
  const errors = [];
  if (!required.includes('QUALITY')) return errors;  // T0 豁免（与 intent 无关）
  const verdict = ctx.quality?.verdict;
  if (verdict !== 'PASS' && verdict !== 'CIRCUIT_BREAKER') {
    errors.push(`quality.verdict="${formatVerdict(verdict)}" ∉ {${formatVerdict('PASS')}, ${formatVerdict('CIRCUIT_BREAKER')}}（T1/T2 必须经 ${formatStage('QUALITY')} 阶段）`);
  }
  return errors;
}

function auditContext(taskId) {
  let ctx;
  try {
    const result = readContext(taskId);
    ctx = result.ctx;
  } catch (e) {
    // task_context 不存在或损坏 → 跳过（非活跃任务）
    return { taskId, skipped: true, reason: e.message };
  }

  const intentType = ctx.intent?.intent_type;
  const tier = ctx.sizing?.tier;
  const strength = ctx.sizing?.t1_strength;
  const status = ctx.status;

  // 只校验活跃 task_context（DONE/FAILED 已结束）
  const ACTIVE = ['initialized', 'RUNNING', 'PAUSED', 'DEGRADED'];
  if (!ACTIVE.includes(status)) {
    return { taskId, skipped: true, reason: `状态(status)=${formatStatus(status)}（已结束）` };
  }

  // 只校验 T1/T2 任务（T0 极速通道豁免；INQUIRY/EXECUTION 不再是豁免维度）
  // 特殊：RUNNING + intent_type=undefined 不豁免 → FAIL（conductor 跳过 INIT 或 apply-tier 失败）
  if (tier !== 'T1' && tier !== 'T2') {
    return { taskId, skipped: true, reason: `等级(tier)=${formatTier(tier)}（非 T1/T2，豁免）` };
  }
  if (intentType === undefined && status === 'RUNNING') {
    // 强异常：活跃 RUNNING 任务竟然没有 intent_type，必须排查
    const errors = [
      `[FLOW_AUDIT_FAIL] task_id=${taskId} 意图(intent)=undefined on RUNNING task（conductor 跳过了 INIT 阶段或 apply-tier 失败，必须排查）`,
    ];
    return { taskId, intentType, tier, status, required: [], errors };
  }
  if (intentType !== 'INQUIRY' && intentType !== 'EXECUTION') {
    // T1/T2 必须有合法 intent_type（INQUIRY 或 EXECUTION）
    const errors = [
      `[FLOW_AUDIT_FAIL] task_id=${taskId} 意图(intent)=invalid(${JSON.stringify(intentType)}) on T1/T2 task（必须是 INQUIRY 或 EXECUTION）`,
    ];
    return { taskId, intentType, tier, status, required: [], errors };
  }

  const required = requiredStages(tier, intentType, strength);
  const errors = [
    ...checkTransitionLog(ctx, required),
    ...checkDispatchLog(ctx, required),
    ...checkQualityVerdict(ctx, required),
  ];

  // coverage_matrix 结论校验（命中扩散触发词任务交付前）
  if (hasSpreadTrigger(ctx.intent?.user_request) && required.includes('DELIVERING')) {
    for (const unit of (ctx.plan?.task_dag || [])) {
      if (hasCoverageMatrix(unit)) {
        const errs = validateCoverageMatrix(unit);
        for (const e of errs) errors.push(`[FLOW_AUDIT_FAIL] unit ${unit.unit_id} ${e}`);
      }
    }
  }

  return { taskId, intentType, tier, status, required, errors, ctx };
}

// 清理超期违规 task_context：把 status=initialized 且 mtime > STALE_THRESHOLD 且 audit FAIL 的标记为 FAILED
const STALE_THRESHOLD_MS = 2 * 3600 * 1000;  // 2 小时

function cleanStale() {
  const taskIds = listActiveContexts(true);  // 全量扫描，cleanStale 自己按 STALE_THRESHOLD_MS 过滤
  let cleaned = 0;
  let kept = 0;
  for (const taskId of taskIds) {
    const p = path.join(CONTEXT_DIR, `task_context_${taskId}.json`);
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const age = Date.now() - stat.mtimeMs;
    if (age < STALE_THRESHOLD_MS) { kept++; continue; }

    let ctx;
    try { ctx = readContext(taskId).ctx; } catch { continue; }

    // 只清理 status=initialized 且 audit FAIL 的（保留 RUNNING/PAUSED/DEGRADED/DONE/FAILED）
    if (ctx.status !== 'initialized') { kept++; continue; }

    const intentType = ctx.intent?.intent_type;
    const tier = ctx.sizing?.tier;
    if (tier !== 'T1' && tier !== 'T2') { kept++; continue; }

    const strength = ctx.sizing?.t1_strength;
    const required = requiredStages(tier, intentType, strength);
    const errors = [
      ...checkTransitionLog(ctx, required),
      ...checkDispatchLog(ctx, required),
      ...checkQualityVerdict(ctx, required),
    ];
    if (errors.length > 0) {
      ctx.status = 'FAILED';
      ctx.flow_audit_failure = errors.join('; ');
      writeContext(taskId, ctx);
      cleaned++;
      process.stdout.write(`flow-audit: CLEAN ${taskId} (age=${Math.round(age/3600000)}h, ${errors.length} violations → FAILED)\n`);
    } else {
      kept++;
    }
  }
  process.stdout.write(`\nflow-audit: cleaned=${cleaned} kept=${kept}\n`);
  process.exit(0);
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) usage();
  if (args.length > 0 && args[0] === '--clean-stale') cleanStale();

  const allMode = args.includes('--all');
  let taskIds;
  if (args.length > 0 && !allMode) {
    // 单 task 校验
    taskIds = [args[0]];
  } else {
    // 扫活跃（默认 30min 内）或全部（--all）
    taskIds = listActiveContexts(allMode);
  }

  if (taskIds.length === 0) {
    process.stdout.write('flow-audit: no active task_context found\n');
    process.exit(0);
  }

  let hasFail = false;
  const results = [];
  for (const taskId of taskIds) {
    const r = auditContext(taskId);
    results.push(r);
    if (r.skipped) {
      process.stdout.write(`flow-audit: SKIP ${taskId} (${r.reason})\n`);
      continue;
    }
    if (r.errors.length > 0) {
      hasFail = true;
      process.stdout.write(`\n[FLOW_AUDIT_FAIL] task_id=${r.taskId} 意图(intent)=${formatIntent(r.intentType)} 等级(tier)=${formatTier(r.tier)} 状态(status)=${formatStatus(r.status)}\n`);
      process.stdout.write(`  必经阶段: ${r.required.map(formatStage).join('→')}\n`);
      for (const e of r.errors) {
        process.stdout.write(`  - ${e}\n`);
      }
    } else {
      process.stdout.write(`flow-audit: PASS ${r.taskId} (意图(intent)=${formatIntent(r.intentType)} 等级(tier)=${formatTier(r.tier)} 链=${r.required.map(formatStage).join('→')})\n`);
    }
  }

  if (hasFail) {
    process.stderr.write('\n[FLOW_AUDIT_FAIL] 流程违规：上述 task_context 未走完必经编排链路或缺少必配智能体派发。\n');
    process.stderr.write('修复：按 lifecycle/graph.yaml DAG 走完 INIT→PLANNING→EXECUTING→QUALITY→DELIVERING，\n');
    process.stderr.write('每阶段委派 required_roles 智能体（见 lifecycle/stages/*.md），并用 transition-check 流转。\n');
    process.stderr.write('若违规改动已落盘无法重走，请回退改动或显式声明豁免（不推荐）。\n');
    die(1, '');
  }

  process.stdout.write('\nflow-audit: ALL PASS\n');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === __filename; } catch { return false; }
})();

if (isMainModule) main();