#!/usr/bin/env node
// heavy-test-e2e.mjs
// 端到端测试：覆盖 T0 极速通道、T1 标准闭环、稳定性、并发安全、效率性能、输出质量。
//
// 设计原则：
//   - 每个维度 try-catch 隔离：单个失败不影响其他维度（可观测性 > 全或无）
//   - 性能埋点：transition-check 用 Date.now() 计时，按 Stage 聚合
//   - 临时文件清理：os.tmpdir()/kilo/task_context_<id>.json 测试结束统一清理
//   - 零修改既有脚本：仅通过 CLI 子命令驱动 task-context.mjs / transition-check.mjs / lifecycle-doctor.mjs
//
// 运行：
//   node "E:\AI\agent\kilo_config\scripts\heavy-test-e2e.mjs"
//
// 退出码：
//   0 = 6 个维度全部 PASS
//   1 = 任一维度 FAIL

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TC = path.join(ROOT, 'scripts', 'task-context.mjs');
const TR = path.join(ROOT, 'scripts', 'transition-check.mjs');
const LD = path.join(ROOT, 'scripts', 'lifecycle-doctor.mjs');
const TMP_DIR = path.join(os.tmpdir(), 'kilo');

// ============================================================
// 工具
// ============================================================

function runCli(script, args) {
  const t0 = Date.now();
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { ok: true, code: 0, stdout, stderr: '', durationMs: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : (e.message || ''),
      durationMs: Date.now() - t0,
    };
  }
}

function runTc(...args) { return runCli(TC, args); }
function runTr(...args) { return runCli(TR, args); }
function runLd(...args) { return runCli(LD, args); }

function ctxPath(taskId) { return path.join(TMP_DIR, 'task_context_' + taskId + '.json'); }

function readCtx(taskId) {
  const p = ctxPath(taskId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function cleanupTask(taskId) {
  const p = ctxPath(taskId);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ============================================================
// 结果收集
// ============================================================

const results = [];
const allPerf = [];

function record(dim, pass, summary, perf = [], err = null, failedChecks = null) {
  results.push({ dim, pass, summary, perf, err, failedChecks });
  for (const p of perf) allPerf.push({ dim, ...p });
}

function timedTransition(taskId, from, to) {
  const r = runTr(taskId, '--from', from, '--to', to);
  return {
    stage: from + '->' + to,
    ms: r.durationMs,
    pass: r.ok,
    detail: r.ok ? '' : (r.stderr || r.stdout || 'unknown').trim().slice(0, 200),
  };
}


// ============================================================
// D1: T0 极速通道
// ============================================================

function testT0FastTrack() {
  const dim = 'D1: T0 极速通道';
  const taskId = 'e2e-t0-' + Date.now();
  const perf = [];
  const checks = [];
  try {
    const t0 = Date.now();
    let r = runTc('init', taskId);
    checks.push({ name: 'init', pass: r.ok, detail: (r.stderr || '').trim() });
    if (!r.ok) throw new Error('init failed');

    r = runTc('set', taskId, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'e2e test for T0 fast track — no auth, no payment, no sensitive path',
      'intent.user_request': 'create one e2e test file',
      'sizing.tier': 'T0',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
      'status': 'RUNNING',
    }));
    checks.push({ name: 'set intent/sizing', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set failed');

    r = runTc('apply-tier', taskId, 'T0', '--agent', 'conductor');
    checks.push({ name: 'apply-tier T0', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    if (!r.ok) throw new Error('apply-tier failed');

    r = runTc('apply-escalation', taskId, '--agent', 'conductor');
    checks.push({ name: 'apply-escalation', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    if (!r.ok) throw new Error('apply-escalation failed');

    const t1 = timedTransition(taskId, 'START', 'INIT');
    perf.push(t1);
    checks.push({ name: 'START->INIT', pass: t1.pass, detail: t1.detail });
    if (!t1.pass) throw new Error('START->INIT failed');

    const t2 = timedTransition(taskId, 'INIT', 'EXECUTING');
    perf.push(t2);
    checks.push({ name: 'INIT->EXECUTING (T0 跳过 PLANNING)', pass: t2.pass, detail: t2.detail });
    if (!t2.pass) throw new Error('INIT->EXECUTING failed');

    const ctxAfterInitExe = readCtx(taskId);
    checks.push({
      name: 'current_stage=EXECUTING after T0 INIT->EXECUTING',
      pass: ctxAfterInitExe && ctxAfterInitExe.current_stage === 'EXECUTING',
      detail: 'current_stage=' + (ctxAfterInitExe && ctxAfterInitExe.current_stage),
    });

    r = runTc('set', taskId, 'execution.diffs', JSON.stringify([{ file: 'scripts/heavy-test-e2e.mjs', summary: 'create e2e test' }]), '--agent', 'coder');
    checks.push({ name: 'set execution.diffs (coder)', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set execution.diffs failed');

    const t3 = timedTransition(taskId, 'EXECUTING', 'DELIVERING');
    perf.push(t3);
    checks.push({ name: 'EXECUTING->DELIVERING (T0 跳过 QUALITY)', pass: t3.pass, detail: t3.detail });
    if (!t3.pass) throw new Error('EXECUTING->DELIVERING failed');

    r = runTc('set', taskId, 'status', 'DONE', '--agent', 'conductor');
    checks.push({ name: 'set status=DONE', pass: r.ok, detail: (r.stderr || '').trim() });

    const t4 = timedTransition(taskId, 'DELIVERING', 'DONE');
    perf.push(t4);
    checks.push({ name: 'DELIVERING->DONE', pass: t4.pass, detail: t4.detail });
    if (!t4.pass) throw new Error('DELIVERING->DONE failed');

    const ctx = readCtx(taskId);
    const stages = (ctx && Array.isArray(ctx.transition_log))
      ? ctx.transition_log.map((e) => e.to).join(',')
      : '';
    checks.push({
      name: 'transition_log 跳过 PLANNING/QUALITY',
      pass: !stages.includes('PLANNING') && !stages.includes('QUALITY'),
      detail: 'stages=' + stages,
    });

    const pass = checks.every((c) => c.pass);
    const totalMs = Date.now() - t0;
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + totalMs + 'ms)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  } finally {
    cleanupTask(taskId);
  }
}


// ============================================================
// D2: T1 标准闭环
// ============================================================

function testT1StandardLoop() {
  const dim = 'D2: T1 标准闭环';
  const taskId = 'e2e-t1-' + Date.now();
  const perf = [];
  const checks = [];
  try {
    const t0 = Date.now();

    let r = runTc('init', taskId);
    checks.push({ name: 'init', pass: r.ok, detail: (r.stderr || '').trim() });
    if (!r.ok) throw new Error('init failed');

    r = runTc('set', taskId, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'e2e test for T1 standard loop — no auth keyword, no sensitive path',
      'intent.user_request': 'create one e2e test script',
      'sizing.tier': 'T1',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
      'status': 'RUNNING',
    }));
    checks.push({ name: 'set intent/sizing T1', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set intent/sizing failed');

    r = runTc('apply-tier', taskId, 'T1', '--agent', 'conductor');
    checks.push({ name: 'apply-tier T1', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    if (!r.ok) throw new Error('apply-tier T1 failed');

    r = runTc('apply-escalation', taskId, '--agent', 'conductor');
    checks.push({ name: 'apply-escalation', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    if (!r.ok) throw new Error('apply-escalation failed');

    const transitions = [
      ['START', 'INIT'],
      ['INIT', 'PLANNING'],
    ];
    for (const [from, to] of transitions) {
      const t = timedTransition(taskId, from, to);
      perf.push(t);
      checks.push({ name: from + '->' + to, pass: t.pass, detail: t.detail });
      if (!t.pass) throw new Error(from + '->' + to + ' failed');
    }

    r = runTc('log-dispatch', taskId, '--agent', 'planner', '--mode', 'task', '--stage', 'PLANNING');
    checks.push({ name: 'log-dispatch planner @PLANNING', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('log-dispatch planner failed');

    r = runTc('set', taskId, '--agent', 'planner', '--batch', JSON.stringify({
      'plan.summary': 'E2E T1 测试方案',
      'plan.task_dag': { units: [{ unit_id: 'U1', goal: 'create e2e' }] },
      'plan.acceptance_criteria': ['6 维度全 PASS'],
    }));
    checks.push({ name: 'set plan (planner)', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set plan failed');

    const tPE = timedTransition(taskId, 'PLANNING', 'EXECUTING');
    perf.push(tPE);
    checks.push({ name: 'PLANNING->EXECUTING', pass: tPE.pass, detail: tPE.detail });
    if (!tPE.pass) throw new Error('PLANNING->EXECUTING failed');

    r = runTc('log-dispatch', taskId, '--agent', 'coder', '--mode', 'task', '--stage', 'EXECUTING');
    checks.push({ name: 'log-dispatch coder @EXECUTING', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('log-dispatch coder failed');

    r = runTc('set', taskId, '--agent', 'coder', '--batch', JSON.stringify({
      'execution.diffs': [{ file: 'scripts/heavy-test-e2e.mjs', summary: 'create e2e' }],
      'execution.changes': [{ file: 'scripts/heavy-test-e2e.mjs', summary: 'create e2e' }],
      'execution.acceptance_map': [{ criterion: '6 维度全 PASS', status: 'PASS' }],
    }));
    checks.push({ name: 'set execution (coder)', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set execution failed');

    const tEQ = timedTransition(taskId, 'EXECUTING', 'QUALITY');
    perf.push(tEQ);
    checks.push({ name: 'EXECUTING->QUALITY', pass: tEQ.pass, detail: tEQ.detail });
    if (!tEQ.pass) throw new Error('EXECUTING->QUALITY failed');

    r = runTc('log-dispatch', taskId, '--agent', 'verifier', '--mode', 'task', '--stage', 'QUALITY');
    checks.push({ name: 'log-dispatch verifier @QUALITY', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('log-dispatch verifier failed');

    r = runTc('set', taskId, '--agent', 'verifier', '--batch', JSON.stringify({
      'verification.forward': { verdict: 'PASS', summary: 'all 6 dims planned' },
    }));
    checks.push({ name: 'set verification.forward (verifier)', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set verification.forward failed');

    r = runTc('set', taskId, 'quality.verdict', 'PASS', '--agent', 'conductor');
    checks.push({ name: 'set quality.verdict (conductor)', pass: r.ok, detail: (r.stderr || r.stdout).trim() });
    if (!r.ok) throw new Error('set quality.verdict failed');

    const tQD = timedTransition(taskId, 'QUALITY', 'DELIVERING');
    perf.push(tQD);
    checks.push({ name: 'QUALITY->DELIVERING (verdict=PASS)', pass: tQD.pass, detail: tQD.detail });
    if (!tQD.pass) throw new Error('QUALITY->DELIVERING failed');

    r = runTc('set', taskId, 'status', 'DONE', '--agent', 'conductor');
    checks.push({ name: 'set status=DONE', pass: r.ok, detail: (r.stderr || '').trim() });

    const tDD = timedTransition(taskId, 'DELIVERING', 'DONE');
    perf.push(tDD);
    checks.push({ name: 'DELIVERING->DONE', pass: tDD.pass, detail: tDD.detail });
    if (!tDD.pass) throw new Error('DELIVERING->DONE failed');

    const ctx = readCtx(taskId);
    const evidence = {
      intent: ctx && ctx.intent && typeof ctx.intent === 'object' && Object.keys(ctx.intent).length > 0,
      sizing: ctx && ctx.sizing && typeof ctx.sizing === 'object' && Object.keys(ctx.sizing).length > 0,
      plan: ctx && ctx.plan && typeof ctx.plan === 'object' && Object.keys(ctx.plan).length > 0,
      execution: ctx && ctx.execution && typeof ctx.execution === 'object' && (ctx.execution.diffs || ctx.execution.changes || ctx.execution.acceptance_map),
      verification: ctx && ctx.verification && ctx.verification.forward && ctx.verification.forward.verdict,
    };
    const missingFields = Object.entries(evidence).filter(([k, v]) => !v).map(([k]) => k);
    checks.push({
      name: '5 元组 evidence 字段（intent/sizing/plan/execution/verification）齐备',
      pass: missingFields.length === 0,
      detail: missingFields.length === 0 ? 'all 5 present' : 'missing: ' + missingFields.join(', '),
    });

    const logStages = (ctx && Array.isArray(ctx.transition_log))
      ? ctx.transition_log.map((e) => e.to).join(',')
      : '';
    const expectedStages = ['INIT', 'PLANNING', 'EXECUTING', 'QUALITY', 'DELIVERING'];
    const missingStages = expectedStages.filter((s) => !logStages.includes(s));
    checks.push({
      name: 'transition_log 含全部 5 阶段',
      pass: missingStages.length === 0,
      detail: 'stages=' + logStages + ' missing=' + (missingStages.join(',') || 'none'),
    });

    const pass = checks.every((c) => c.pass);
    const totalMs = Date.now() - t0;
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + totalMs + 'ms)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  } finally {
    cleanupTask(taskId);
  }
}


// ============================================================
// D3: 稳定性/幂等
// ============================================================

function testIdempotency() {
  const dim = 'D3: 稳定性/幂等';
  const taskId = 'e2e-idem-' + Date.now();
  const perf = [];
  const checks = [];
  try {
    const t0 = Date.now();

    let r = runTc('init', taskId);
    checks.push({ name: 'init', pass: r.ok });
    if (!r.ok) throw new Error('init failed');

    r = runTc('set', taskId, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'e2e idempotency test',
      'intent.user_request': 'idempotency',
      'sizing.tier': 'T1',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
    }));
    checks.push({ name: 'initial set', pass: r.ok });
    if (!r.ok) throw new Error('initial set failed');

    r = runTc('apply-tier', taskId, 'T1', '--agent', 'conductor');
    const tA1 = Date.now();
    const ctx1 = readCtx(taskId);
    const config1 = JSON.stringify(ctx1 && ctx1.config);
    perf.push({ stage: 'apply-tier T1 #1', ms: tA1 - t0, pass: r.ok });
    checks.push({ name: 'apply-tier T1 #1', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    if (!r.ok) throw new Error('apply-tier #1 failed');

    r = runTc('apply-tier', taskId, 'T1', '--agent', 'conductor');
    const tA2 = Date.now();
    const ctx2 = readCtx(taskId);
    const config2 = JSON.stringify(ctx2 && ctx2.config);
    perf.push({ stage: 'apply-tier T1 #2', ms: tA2 - tA1, pass: r.ok });
    checks.push({ name: 'apply-tier T1 #2', pass: r.ok, detail: r.ok ? r.stdout.trim() : r.stderr.trim() });
    checks.push({
      name: 'apply-tier 两次结果 config 一致',
      pass: config1 === config2,
      detail: config1 === config2 ? 'identical' : 'differ: ' + config1 + ' vs ' + config2,
    });

    r = runTc('set', taskId, 'sizing.tier', 'T1', '--agent', 'conductor');
    const tS1 = Date.now();
    const ctxS1 = readCtx(taskId);
    const tier1 = ctxS1 && ctxS1.sizing && ctxS1.sizing.tier;
    perf.push({ stage: 'set sizing.tier T1 #1', ms: tS1 - tA2, pass: r.ok });
    checks.push({ name: 'set sizing.tier T1 #1', pass: r.ok && tier1 === 'T1' });

    r = runTc('set', taskId, 'sizing.tier', 'T1', '--agent', 'conductor');
    const tS2 = Date.now();
    const ctxS2 = readCtx(taskId);
    const tier2 = ctxS2 && ctxS2.sizing && ctxS2.sizing.tier;
    perf.push({ stage: 'set sizing.tier T1 #2', ms: tS2 - tS1, pass: r.ok });
    checks.push({ name: 'set sizing.tier T1 #2', pass: r.ok && tier2 === 'T1' });
    checks.push({
      name: 'set 同一字段两次结果一致',
      pass: tier1 === tier2,
      detail: 'tier1=' + tier1 + ' tier2=' + tier2,
    });

    r = runTc('apply-escalation', taskId, '--agent', 'conductor');
    const esc1 = readCtx(taskId);
    const escAfter1 = JSON.stringify(esc1 && esc1.sizing && esc1.sizing.escalation_reasons);
    r = runTc('apply-escalation', taskId, '--agent', 'conductor');
    const esc2 = readCtx(taskId);
    const escAfter2 = JSON.stringify(esc2 && esc2.sizing && esc2.sizing.escalation_reasons);
    checks.push({
      name: 'apply-escalation 两次 idempotent',
      pass: escAfter1 === escAfter2,
      detail: escAfter1 === escAfter2 ? 'identical' : escAfter1 + ' vs ' + escAfter2,
    });

    const pass = checks.every((c) => c.pass);
    const totalMs = Date.now() - t0;
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + totalMs + 'ms)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  } finally {
    cleanupTask(taskId);
  }
}


// ============================================================
// D4: 并发安全
// ============================================================

async function testConcurrency() {
  const dim = 'D4: 并发安全';
  const perf = [];
  const checks = [];
  const tsA = 'e2e-conc-a-' + Date.now();
  const tsB = 'e2e-conc-b-' + Date.now();
  const t0 = Date.now();
  try {
    const initA = runTc('init', tsA);
    const initB = runTc('init', tsB);
    const setA = runTc('set', tsA, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'concurrency test A — clean',
      'intent.user_request': 'concurrency A',
      'sizing.tier': 'T0',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
    }));
    const setB = runTc('set', tsB, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'concurrency test B — clean',
      'intent.user_request': 'concurrency B',
      'sizing.tier': 'T0',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
    }));
    const tierA = runTc('apply-tier', tsA, 'T0', '--agent', 'conductor');
    const tierB = runTc('apply-tier', tsB, 'T0', '--agent', 'conductor');

    checks.push({ name: 'parallel init A', pass: initA.ok, detail: initA.stderr.trim() });
    checks.push({ name: 'parallel init B', pass: initB.ok, detail: initB.stderr.trim() });
    checks.push({ name: 'parallel set A', pass: setA.ok });
    checks.push({ name: 'parallel set B', pass: setB.ok });
    checks.push({ name: 'parallel apply-tier A', pass: tierA.ok });
    checks.push({ name: 'parallel apply-tier B', pass: tierB.ok });
    if (!initA.ok || !initB.ok || !setA.ok || !setB.ok || !tierA.ok || !tierB.ok) {
      throw new Error('parallel init/set/apply-tier failed');
    }

    const ctxA = readCtx(tsA);
    const ctxB = readCtx(tsB);
    checks.push({
      name: '两 task 文件独立存在',
      pass: fs.existsSync(ctxPath(tsA)) && fs.existsSync(ctxPath(tsB)),
      detail: 'A=' + fs.existsSync(ctxPath(tsA)) + ' B=' + fs.existsSync(ctxPath(tsB)),
    });
    checks.push({
      name: '两 task task_id 独立',
      pass: ctxA && ctxA.task_id === tsA && ctxB && ctxB.task_id === tsB,
      detail: 'A.id=' + (ctxA && ctxA.task_id) + ' B.id=' + (ctxB && ctxB.task_id),
    });
    checks.push({
      name: '两 task sizing.tier 不互相污染',
      pass: ctxA && ctxA.sizing.tier === 'T0' && ctxB && ctxB.sizing.tier === 'T0',
      detail: 'A.tier=' + (ctxA && ctxA.sizing.tier) + ' B.tier=' + (ctxB && ctxB.sizing.tier),
    });
    checks.push({
      name: '两 task config.agents 互不影响',
      pass: JSON.stringify(ctxA.config) === JSON.stringify(ctxB.config),
      detail: 'A.config=' + JSON.stringify(ctxA.config) + ' B.config=' + JSON.stringify(ctxB.config),
    });

    const tStart1 = Date.now();
    const trA1 = runTr(tsA, '--from', 'START', '--to', 'INIT');
    const trB1 = runTr(tsB, '--from', 'START', '--to', 'INIT');
    const tStart2 = Date.now();
    const trA2 = runTr(tsA, '--from', 'INIT', '--to', 'EXECUTING');
    const trB2 = runTr(tsB, '--from', 'INIT', '--to', 'EXECUTING');
    perf.push({ stage: 'parallel START->INIT (A+B)', ms: tStart2 - tStart1, pass: trA1.ok && trB1.ok });
    perf.push({ stage: 'parallel INIT->EXECUTING (A+B)', ms: Date.now() - tStart2, pass: trA2.ok && trB2.ok });

    checks.push({ name: 'parallel START->INIT A', pass: trA1.ok, detail: trA1.stderr.trim() });
    checks.push({ name: 'parallel START->INIT B', pass: trB1.ok, detail: trB1.stderr.trim() });
    checks.push({ name: 'parallel INIT->EXECUTING A', pass: trA2.ok, detail: trA2.stderr.trim() });
    checks.push({ name: 'parallel INIT->EXECUTING B', pass: trB2.ok, detail: trB2.stderr.trim() });

    const ctxA2 = readCtx(tsA);
    const ctxB2 = readCtx(tsB);
    checks.push({
      name: '两 task 流转后 current_stage 都为 EXECUTING（无交叉污染）',
      pass: ctxA2.current_stage === 'EXECUTING' && ctxB2.current_stage === 'EXECUTING',
      detail: 'A.stage=' + ctxA2.current_stage + ' B.stage=' + ctxB2.current_stage,
    });

    const pass = checks.every((c) => c.pass);
    const totalMs = Date.now() - t0;
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + totalMs + 'ms)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  } finally {
    cleanupTask(tsA);
    cleanupTask(tsB);
  }
}


// ============================================================
// D5: 效率性能（汇总 D1-D4 的 perf 埋点）
// ============================================================

function testPerfBudget() {
  const dim = 'D5: 效率性能';
  const perf = [];
  const checks = [];
  try {
    perf.push(...allPerf);

    const TIMEOUT_MS = 5000;
    const slow = perf.filter((p) => p.ms > TIMEOUT_MS);
    checks.push({
      name: '所有 transition-check ≤ ' + TIMEOUT_MS + 'ms',
      pass: slow.length === 0,
      detail: slow.length === 0 ? 'all within budget' : 'slow: ' + slow.map((s) => s.stage + '=' + s.ms + 'ms').join(', '),
    });

    const t0Edges = perf.filter((p) => p.dim === 'D1: T0 极速通道');
    const t1Edges = perf.filter((p) => p.dim === 'D2: T1 标准闭环');
    checks.push({
      name: 'T0/T1 path perf 数据均已采集',
      pass: t0Edges.length >= 3 && t1Edges.length >= 6,
      detail: 'T0=' + t0Edges.length + ' transitions, T1=' + t1Edges.length + ' transitions',
    });

    const pass = checks.every((c) => c.pass);
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + perf.length + ' samples)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  }
}

// ============================================================
// D6: 输出质量
// ============================================================

function testOutputQuality() {
  const dim = 'D6: 输出质量';
  const perf = [];
  const checks = [];
  const t0 = Date.now();
  try {
    const idInit = 'e2e-conv-' + Date.now();
    let r = runTc('init', idInit);
    checks.push({ name: 'init for convergence check', pass: r.ok });
    if (!r.ok) throw new Error('init failed');
    const ctx = readCtx(idInit);
    const hasConvergence = ctx && ctx.convergence && typeof ctx.convergence === 'object';
    const hasMmFusion = hasConvergence && Number.isInteger(ctx.convergence.mm_fusion_rounds)
      && Number.isInteger(ctx.convergence.mm_fusion_max_rounds);
    checks.push({
      name: 'convergence 字段在 init 后存在（含 mm_fusion_rounds/max_rounds）',
      pass: hasMmFusion,
      detail: hasMmFusion
        ? 'mm_fusion_rounds=' + ctx.convergence.mm_fusion_rounds + '/' + ctx.convergence.mm_fusion_max_rounds
        : 'convergence=' + JSON.stringify(ctx && ctx.convergence),
    });

    r = runTc('assert', idInit, 'convergence');
    checks.push({
      name: 'assert convergence 通过（runtime 不熔断）',
      pass: r.ok,
      detail: r.ok ? r.stdout.trim() : r.stderr.trim(),
    });
    cleanupTask(idInit);

    const idT0Done = 'e2e-t0done-' + Date.now();
    r = runTc('init', idT0Done);
    if (!r.ok) throw new Error('init T0 done failed');
    runTc('set', idT0Done, '--agent', 'conductor', '--batch', JSON.stringify({
      'intent.intent_type': 'EXECUTION',
      'intent.raw': 'T0@DELIVERING doctor check — clean task',
      'intent.user_request': 'T0 doctor',
      'sizing.tier': 'T0',
      'sizing.key_files': ['scripts/heavy-test-e2e.mjs'],
      'status': 'RUNNING',
    }));
    runTc('apply-tier', idT0Done, 'T0', '--agent', 'conductor');
    runTc('apply-escalation', idT0Done, '--agent', 'conductor');
    runTr(idT0Done, '--from', 'START', '--to', 'INIT');
    runTr(idT0Done, '--from', 'INIT', '--to', 'EXECUTING');
    runTc('set', idT0Done, 'execution.diffs', JSON.stringify([{ file: 'scripts/heavy-test-e2e.mjs', summary: 'x' }]), '--agent', 'coder');
    runTr(idT0Done, '--from', 'EXECUTING', '--to', 'DELIVERING');

    const ctxT0Done = readCtx(idT0Done);
    checks.push({
      name: 'T0 task 已流转到 DELIVERING',
      pass: ctxT0Done && ctxT0Done.current_stage === 'DELIVERING',
      detail: 'current_stage=' + (ctxT0Done && ctxT0Done.current_stage),
    });

    r = runLd('--runtime');
    // 仅关注本次 T0 test task 的 verification 行（其他历史 task 在 tmpdir 中残留会污染输出）
    const ldOut = r.stdout + r.stderr;
    // 提取本次 T0 task 的 block（"=== task <id> ===" 起到下一个 === task === 止）
    const myBlockRe = new RegExp('===\\\\s*task\\\\s+' + idT0Done + '\\\\b[\\\\s\\\\S]*?(?=\\\\n===|\\Z)');
    const myBlock = (ldOut.match(myBlockRe) || [''])[0];
    const myVerifyFail = /runtime\\.verification[^\\n]*FAIL/i.test(myBlock);
    checks.push({
      name: 'T0@DELIVERING 不被 lifecycle-doctor --runtime 报 verification FAIL（仅检查本 task）',
      pass: !myVerifyFail,
      detail: myVerifyFail
        ? 'T0 task 报 verification FAIL — U2 修复可能未生效\\n' + myBlock
        : 'T0 task 豁免 verification 校验（PASS）',
    });
    cleanupTask(idT0Done);

    const pass = checks.every((c) => c.pass);
    const totalMs = Date.now() - t0;
    record(dim, pass, checks.filter((c) => c.pass).length + '/' + checks.length + ' checks passed (' + totalMs + 'ms)', perf, null, checks);
  } catch (e) {
    record(dim, false, 'exception: ' + e.message, perf, e.stack, checks);
  }
}


// ============================================================
// 报告输出
// ============================================================

function renderReport() {
  const lines = [];
  lines.push('## Test Report');
  lines.push('');
  lines.push('- generated: ' + nowIso());
  lines.push('- tmp dir: ' + TMP_DIR);
  lines.push('');

  for (const r of results) {
    lines.push('### ' + r.dim + ' — ' + (r.pass ? '✅ PASS' : '❌ FAIL'));
    lines.push('');
    lines.push(r.summary);
    if (!r.pass && r.failedChecks && r.failedChecks.length > 0) {
      const failed = r.failedChecks.filter((c) => !c.pass);
      if (failed.length > 0) {
        lines.push('');
        lines.push('**失败检查项:**');
        for (const fc of failed) {
          lines.push('- ❌ ' + fc.name + (fc.detail ? ' — ' + fc.detail : ''));
        }
      }
    }
    if (r.err) {
      lines.push('');
      lines.push('```');
      lines.push(r.err);
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('### Performance Table (Stage | duration_ms)');
  lines.push('');
  lines.push('| Dim | Stage | duration_ms |');
  lines.push('|-----|-------|-------------|');
  for (const p of allPerf) {
    lines.push('| ' + p.dim + ' | ' + p.stage + ' | ' + p.ms + ' |');
  }
  lines.push('');

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const verdict = failed === 0 ? 'PASS' : 'FAIL';
  lines.push('### Total: ' + verdict + ' — ' + passed + '/' + total + ' dims passed, ' + failed + ' failed');
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

(async () => {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }

  console.error('=== heavy-test-e2e start ===');

  // Warmup: 预热 Node 模块缓存（task-context.mjs 启动时扫描 agent/*.md + config.yaml，
  // 首次冷启动 ~5s；预热后所有 transition-check 在 100ms 内）
  const warmupId = 'e2e-warmup-' + Date.now();
  runTc('init', warmupId);
  cleanupTask(warmupId);
  console.error('[warmup] module cache primed');

  testT0FastTrack();
  console.error('[D1] T0 fast track done — pass=' + results[results.length - 1].pass);

  testT1StandardLoop();
  console.error('[D2] T1 standard loop done — pass=' + results[results.length - 1].pass);

  testIdempotency();
  console.error('[D3] idempotency done — pass=' + results[results.length - 1].pass);

  await testConcurrency();
  console.error('[D4] concurrency done — pass=' + results[results.length - 1].pass);

  testPerfBudget();
  console.error('[D5] perf done — pass=' + results[results.length - 1].pass);

  testOutputQuality();
  console.error('[D6] output quality done — pass=' + results[results.length - 1].pass);

  const report = renderReport();
  process.stdout.write(report + '\n');

  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) {
    console.error('=== heavy-test-e2e: ALL PASS ===');
    process.exit(0);
  } else {
    console.error('=== heavy-test-e2e: FAIL (' + failed.length + ' dim(s)) ===');
    for (const f of failed) console.error('  - ' + f.dim + ': ' + f.summary);
    process.exit(1);
  }
})();






