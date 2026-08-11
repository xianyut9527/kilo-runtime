// runtime.mjs
// --runtime 模式：运行时 task_context 探针 + --dry-run 端到端验证
// 拆分自 scripts/lifecycle-doctor.mjs L513-948

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { VALID_STATUSES, buildInitialContext } from '../task-context-runtime.mjs';
import { isConditionalRole } from '../lib/stage-roles.mjs';
import { readText, parseGraphFile, parseStageFrontmatter } from './lib/parse.mjs';

export { runRuntimeMode };

// ============================================================
// 运行时探针检测项（8 个）
// ============================================================

function rtCheckStatus(ctx, env, rtCheck) {
  const s = ctx.status;
  if (typeof s !== 'string') {
    const t = s === null ? 'null' : (s === undefined ? 'undefined' : typeof s);
    rtCheck('FAIL', 'runtime.status', `status is ${t} (should be string)`);
    return;
  }
  if (VALID_STATUSES.includes(s)) {
    rtCheck('PASS', 'runtime.status', `status=${s}`);
  } else {
    rtCheck('FAIL', 'runtime.status', `status="${s}" ∉ {${VALID_STATUSES.join(',')}}`);
  }
}

function rtCheckCurrentStage(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  if (!stage) {
    rtCheck('WARN', 'runtime.current_stage', 'current_stage 未设置（可能尚未流转或漏调 transition-check）');
    return;
  }
  if (env.graph.nodes.has(stage)) {
    rtCheck('PASS', 'runtime.current_stage', `current_stage=${stage}`);
  } else {
    rtCheck('FAIL', 'runtime.current_stage', `current_stage="${stage}" 不在 graph.yaml 节点集合`);
  }
}

function rtCheckConvergence(ctx, env, rtCheck) {
  const q = ctx.quality || {};
  const c = ctx.convergence || {};
  const { round, max_rounds } = q;
  const { mm_fusion_rounds, mm_fusion_max_rounds } = c;
  let ok = true;
  const parts = [`quality=${round}/${max_rounds} mm_fusion=${mm_fusion_rounds}/${mm_fusion_max_rounds}`];
  if (!Number.isInteger(round) || round < 0) { ok = false; parts.push('quality.round 非非负整数'); }
  if (Number.isInteger(max_rounds) && round > max_rounds) { ok = false; parts.push('quality.round 超阈值'); }
  if (!Number.isInteger(mm_fusion_rounds) || mm_fusion_rounds < 0) { ok = false; parts.push('mm_fusion_rounds 非非负整数'); }
  if (Number.isInteger(mm_fusion_max_rounds) && mm_fusion_rounds > mm_fusion_max_rounds) { ok = false; parts.push('mm_fusion_rounds 超阈值'); }
  rtCheck(ok ? 'PASS' : 'FAIL', 'runtime.convergence', parts.join(' | '));
}

function rtCheckBreaker(ctx, env, rtCheck) {
  const q = ctx.quality || {};
  const c = ctx.convergence || {};
  const qr = q.round || 0;
  const qm = q.max_rounds || 7;
  const fr = c.mm_fusion_rounds || 0;
  const fm = c.mm_fusion_max_rounds || 3;
  const qPct = Math.round((qr / qm) * 100);
  const fPct = Math.round((fr / fm) * 100);
  if (qPct >= 100 || fPct >= 100) {
    rtCheck('FAIL', 'runtime.breaker', `已触发熔断 quality=${qr}/${qm}(${qPct}%) mm_fusion=${fr}/${fm}(${fPct}%)`);
  } else if (qPct >= 80 || fPct >= 80) {
    rtCheck('WARN', 'runtime.breaker', `接近熔断 quality=${qPct}% mm_fusion=${fPct}%（建议人工介入）`);
  } else {
    rtCheck('PASS', 'runtime.breaker', `熔断安全 quality=${qPct}% mm_fusion=${fPct}%`);
  }
}

function rtCheckTransitionLog(ctx, env, rtCheck) {
  const log = ctx.transition_log;
  const stage = ctx.current_stage;
  if (!Array.isArray(log) || log.length === 0) {
    if (stage) {
      rtCheck('FAIL', 'runtime.transition_log', `current_stage=${stage} 但 transition_log 空（可能漏调 transition-check 或手工 set current_stage）`);
    } else {
      rtCheck('PASS', 'runtime.transition_log', '无流转记录（初始状态）');
    }
    return;
  }
  const last = log[log.length - 1];
  if (stage && last.to !== stage) {
    rtCheck('FAIL', 'runtime.transition_log', `transition_log 末条 to=${last.to} ≠ current_stage=${stage}（状态漂移）`);
  } else {
    rtCheck('PASS', 'runtime.transition_log', `${log.length} 条流转，最近: ${last.from}->${last.to}`);
  }
}

function rtCheckTier(ctx, env, rtCheck) {
  const tier = ctx.sizing && ctx.sizing.tier;
  if (!tier) {
    const status = ctx.status;
    const finalStatuses = ['DELIVERING', 'DONE'];
    if (finalStatuses.includes(status)) {
      rtCheck('FAIL', 'runtime.tier', `status=${status} 但 sizing.tier 未设置（DELIVERING/DONE 阶段必须先有 tier）`);
    } else {
      rtCheck('WARN', 'runtime.tier', 'sizing.tier 未设置（可能尚未 INIT 定级）');
    }
    return;
  }
  const agents = ctx.config && ctx.config.agents;
  if (!agents || typeof agents !== 'object') {
    rtCheck('FAIL', 'runtime.tier', `tier=${tier} 但 config.agents 缺失`);
    return;
  }
  const bad = Object.entries(agents).filter(([, v]) => typeof v !== 'boolean');
  if (bad.length > 0) {
    rtCheck('FAIL', 'runtime.tier', `config.agents 非布尔键: ${bad.map(([k]) => k).join(', ')}`);
    return;
  }
  const TIER_EXPECTED = { T0: {}, T1: {}, T2: {} };
  const expected = TIER_EXPECTED[tier];
  if (expected) {
    const mismatches = [];
    for (const [k, v] of Object.entries(expected)) {
      const actual = agents[k];
      if (actual !== v) {
        mismatches.push(`${k}: expected=${v}, got=${actual === undefined ? '(missing)' : actual}`);
      }
    }
    if (mismatches.length > 0) {
      rtCheck('FAIL', 'runtime.tier', `tier=${tier} config.agents 与 tier_defaults 不一致: ${mismatches.join('; ')}。应执行: task-context.mjs apply-tier-auto <task_id> ${tier} --agent conductor`);
      return;
    }
  }
  rtCheck('PASS', 'runtime.tier', `tier=${tier} agents={${Object.entries(agents).map(([k,v]) => `${k}:${v}`).join(',')}}`);
}

function rtCheckVerification(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  const tier = ctx.sizing && ctx.sizing.tier;
  if (tier === 'T0') {
    rtCheck('PASS', 'runtime.verification', `tier=${tier}（T0 跳过 QUALITY，不要求 verification.forward）`);
    return;
  }
  const postQuality = ['DELIVERING', 'DONE'];
  if (!stage || !postQuality.includes(stage)) {
    rtCheck('PASS', 'runtime.verification', `current_stage=${stage || '(未设置)'} 不要求 verification`);
    return;
  }
  const qFwd = ctx.quality && ctx.quality.verify && ctx.quality.verify.forward;
  const vFwd = ctx.verification && ctx.verification.forward;
  const fwd = qFwd || vFwd;
  if (!fwd || (typeof fwd === 'object' && !fwd.verdict)) {
    rtCheck('FAIL', 'runtime.verification', `current_stage=${stage} 但 quality.verify.forward.verdict / verification.forward.verdict 未填充`);
  } else {
    const verdict = (fwd && fwd.verdict) || (qFwd && qFwd.verdict) || (vFwd && vFwd.verdict);
    rtCheck('PASS', 'runtime.verification', `forward.verdict=${verdict}`);
  }
}

function rtCheckDispatchProvenance(ctx, env, rtCheck) {
  const tier = ctx.sizing && ctx.sizing.tier;
  const stage = ctx.current_stage;
  if (tier !== 'T1' && tier !== 'T2') {
    rtCheck('PASS', 'runtime.dispatch_provenance', `tier=${tier}（非 T1/T2，豁免；与 intent 无关）`);
    return;
  }
  const requiredStages = ['PLANNING', 'EXECUTING', 'QUALITY'];
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const dispatchedAgents = new Set(dispatchLog.map((e) => (e.agent || '').replace(/-/g, '_')));
  const errors = [];
  for (const st of requiredStages) {
    const stagePath = path.join(env.stagesDir, `${st.toLowerCase()}.md`);
    if (!fs.existsSync(stagePath)) continue;
    const text = fs.readFileSync(stagePath, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const roles = parseStageFrontmatter(fm[1]);
    const rolesToCheck = st === 'QUALITY' ? roles.filter((r) => !isConditionalRole(r)) : roles;
    for (const role of rolesToCheck) {
      const roleNorm = role.replace(/-/g, '_');
      if (!dispatchedAgents.has(roleNorm)) {
        errors.push(`${st} 缺 ${role}`);
      }
    }
  }
  if (errors.length > 0) {
    rtCheck('FAIL', 'runtime.dispatch_provenance', `dispatch_log 缺必配角色: ${errors.join(', ')}（已派发: ${[...dispatchedAgents].join(',') || '(空)'}）——疑似 conductor 亲为绕过委派（铁律 #6 违规）`);
  } else {
    rtCheck('PASS', 'runtime.dispatch_provenance', `T1/T2 必经阶段角色已派发: ${[...dispatchedAgents].join(',') || '(空)'} ${stage ? `@${stage}` : ''}`);
  }
}

function rtCheckGcResidue(ctx, env, rtCheck) {
  if (ctx.status !== 'initialized') {
    rtCheck('PASS', 'runtime.gc_residue', `status=${ctx.status} 非 initialized，不受 GC 管辖`);
    return;
  }
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  try {
    const stat = fs.statSync(env.filePath);
    if (Date.now() - stat.mtimeMs > ONE_DAY_MS) {
      rtCheck('FAIL', 'runtime.gc_residue', `status=initialized 且 mtime>24h（应被 GC 清理，下次 init 将删除）`);
    } else {
      rtCheck('PASS', 'runtime.gc_residue', `status=initialized, age=${Math.round((Date.now() - stat.mtimeMs) / 3600000)}h (<24h, 未超期)`);
    }
  } catch (e) {
    rtCheck('WARN', 'runtime.gc_residue', `无法读取文件状态: ${e.message}`);
  }
}

const runtimeChecks = [
  rtCheckStatus,
  rtCheckCurrentStage,
  rtCheckConvergence,
  rtCheckBreaker,
  rtCheckTransitionLog,
  rtCheckTier,
  rtCheckVerification,
  rtCheckDispatchProvenance,
  rtCheckGcResidue,
];

function runRuntimeChecksForTask(filePath, taskId, graph, stagesDir) {
  const runtimeResults = [];
  const rtCheck = (level, name, detail = '') => runtimeResults.push({ level, name, detail });
  let ctx;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    ctx = JSON.parse(raw);
    rtCheck('PASS', 'runtime.json_parse', 'task_context 可解析');
  } catch (e) {
    rtCheck('FAIL', 'runtime.json_parse', e.message);
    return runtimeResults;
  }
  const env = { graph, taskId, filePath, stagesDir };
  for (const check of runtimeChecks) {
    try {
      check(ctx, env, rtCheck);
    } catch (e) {
      rtCheck('FAIL', `runtime.${check.name}`, `检测异常: ${e.message}`);
    }
  }
  return runtimeResults;
}

function runDryRunApplyTierAuto(ctx) {
  const { ROOT, SCRIPTS_DIR } = ctx;
  const SCENARIOS = [
    { id: 1, label: "场景 1: 命中关键词（intent=权限管理, 无 key_files）", build: () => ({ intent: { raw: '权限管理' }, sizing: { tier: 'T0', key_files: [] } }), expect: { tier: 'T2', reasonMin: 1, hasPath: false } },
    { id: 2, label: "场景 2: 不命中（intent=重构Button组件, key_files=[src/components/Button.tsx]）", build: () => ({ intent: { raw: '重构Button组件' }, sizing: { tier: 'T0', key_files: ['src/components/Button.tsx'] } }), expect: { tier: 'T0', reasonEq: 0, hasPath: false } },
    { id: 3, label: "场景 3: 路径命中（intent=UI优化, key_files=[src/auth/login.ts]）", build: () => ({ intent: { raw: 'UI优化' }, sizing: { tier: 'T0', key_files: ['src/auth/login.ts'] } }), expect: { tier: 'T2', reasonMin: 1, hasPath: true } },
    { id: 4, label: "场景 4: 混合命中（intent=权限管理, key_files=[src/auth/login.ts]）", build: () => ({ intent: { raw: '权限管理' }, sizing: { tier: 'T0', key_files: ['src/auth/login.ts'] } }), expect: { tier: 'T2', reasonEq: 2, hasPath: true } },
    { id: 5, label: "场景 5: custom_overrides 覆盖（intent=权限审计, custom_overrides.tier=T1）", build: () => ({ intent: { raw: '权限审计' }, sizing: { tier: 'T0', key_files: [] }, config: { custom_overrides: { tier: 'T1' } } }), expect: { tier: 'T0', reasonMin: 1, skipped: true } },
  ];
  const tmpDir = path.join(os.tmpdir(), 'kilo');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  let passCount = 0, failCount = 0;
  const failDetails = [];
  for (const sc of SCENARIOS) {
    const taskId = `dryrun_s${sc.id}_${Date.now()}`;
    const ctxPath = path.join(tmpDir, `task_context_${taskId}.json`);
    const ctx0 = buildInitialContext(taskId);
    const seed = sc.build();
    if (seed.intent) ctx0.intent = Object.assign({}, ctx0.intent, seed.intent);
    if (seed.sizing) ctx0.sizing = Object.assign({}, ctx0.sizing, seed.sizing);
    if (seed.config) ctx0.config = Object.assign({}, ctx0.config, seed.config);
    try {
      fs.writeFileSync(ctxPath, JSON.stringify(ctx0, null, 2), 'utf8');
    } catch (e) {
      process.stdout.write(`[FAIL] ${sc.label}\n  写 task_context 失败: ${e.message}\n`);
      failCount++; failDetails.push(sc.id); continue;
    }
    const declaredTier = (seed.sizing && seed.sizing.tier) || 'T1';
    const r = spawnSync(
      process.execPath,
      [path.join(SCRIPTS_DIR, 'task-context.mjs'), 'apply-tier-auto', taskId, declaredTier, '--agent', 'conductor'],
      { cwd: ROOT, encoding: 'utf8', timeout: 15000 }
    );
    if (r.status !== 0) {
      process.stdout.write(`[FAIL] ${sc.label}\n  apply-tier-auto 退出码=${r.status} stderr=${(r.stderr || "").trim().split("\n")[0] || "(empty)"}\n`);
      failCount++; failDetails.push(sc.id);
      try { fs.unlinkSync(ctxPath); } catch {}
      continue;
    }
    let result;
    try {
      result = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
    } catch (e) {
      process.stdout.write(`[FAIL] ${sc.label}\n  读回 task_context 失败: ${e.message}\n`);
      failCount++; failDetails.push(sc.id);
      try { fs.unlinkSync(ctxPath); } catch {}
      continue;
    }
    const tier = result.sizing && result.sizing.tier;
    const reasons = Array.isArray(result.sizing && result.sizing.escalation_reasons) ? result.sizing.escalation_reasons : [];
    const exp = sc.expect;
    const errs = [];
    if (tier !== exp.tier) errs.push(`tier=${tier} (期望 ${exp.tier})`);
    if (typeof exp.reasonEq === 'number' && reasons.length !== exp.reasonEq) {
      errs.push(`reasons 数=${reasons.length} (期望 =${exp.reasonEq})`);
    } else if (typeof exp.reasonMin === 'number' && reasons.length < exp.reasonMin) {
      errs.push(`reasons 数=${reasons.length} (期望 ≥${exp.reasonMin})`);
    }
    if (exp.hasPath && !reasons.some((rr) => String(rr).startsWith('path:'))) {
      errs.push('缺少 path: 原因项');
    }
    if (exp.skipped && !reasons.some((rr) => String(rr).startsWith('skipped:'))) {
      errs.push('缺少 skipped: 原因项');
    }
    if (errs.length === 0) {
      const preview = reasons.length > 2 ? reasons.slice(0, 2).join(', ') + '...' : reasons.join(', ');
      process.stdout.write(`[PASS] ${sc.label}\n  tier=${tier} reasons=${reasons.length} (${preview})\n`);
      passCount++;
    } else {
      process.stdout.write(`[FAIL] ${sc.label}\n  tier=${tier} reasons=${reasons.length}\n  断言: ${errs.join("; ")}\n  reasons=${JSON.stringify(reasons)}\n`);
      failCount++; failDetails.push(sc.id);
    }
    try { fs.unlinkSync(ctxPath); } catch {}
  }
  process.stdout.write(`\nDRYRUN SUMMARY: ${passCount} PASS / ${failCount} FAIL (5 场景)\n`);
  if (failCount > 0) {
    process.stderr.write(`[DRYRUN_VIOLATION] 失败场景 id: ${failDetails.join(", ")}\n`);
    process.exit(1);
  }
}

function runRuntimeMode(ctx) {
  const { ROOT, GRAPH_PATH, STAGES_DIR } = ctx;
  if (process.argv.includes('--dry-run')) {
    runDryRunApplyTierAuto(ctx);
    return;
  }
  const tmpDir = path.join(os.tmpdir(), 'kilo');
  let files = [];
  try {
    files = fs.readdirSync(tmpDir)
      .filter((f) => f.startsWith('task_context_') && f.endsWith('.json'));
  } catch { /* 目录不存在 */ }
  if (files.length === 0) {
    process.stdout.write('RUNTIME: 无活跃 task_context 文件\n');
    process.stdout.write('SUMMARY: 0 active tasks / 0 FAIL\n');
    return;
  }
  const graphText = readText(GRAPH_PATH);
  const graph = graphText ? parseGraphFile(graphText) : { nodes: new Map(), edges: [] };
  let totalPass = 0, totalFail = 0, totalWarn = 0;
  for (const file of files) {
    const taskId = file.replace(/^task_context_/, '').replace(/\.json$/, '');
    const filePath = path.join(tmpDir, file);
    const results = runRuntimeChecksForTask(filePath, taskId, graph, STAGES_DIR);
    process.stdout.write(`\n=== task ${taskId} ===\n`);
    for (const r of results) {
      process.stdout.write(`${r.level} ${r.name} [${taskId}]${r.detail ? ' - ' + r.detail : ''}\n`);
      if (r.level === 'PASS') totalPass++;
      if (r.level === 'FAIL') totalFail++;
      if (r.level === 'WARN') totalWarn++;
    }
  }
  process.stdout.write(`\nSUMMARY: ${files.length} active tasks / ${totalPass} PASS / ${totalFail} FAIL / ${totalWarn} WARN\n`);
  if (totalFail > 0) {
    process.stderr.write('[RUNTIME_VIOLATION] 检测到运行时状态违规，见上述 FAIL\n');
    process.exit(1);
  }
}
