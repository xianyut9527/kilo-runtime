#!/usr/bin/env node
// recover-context-unsafe.mjs
// 机械检测 task_context 的 overload_count + size_check 状态
// 用法: node scripts/recover-context-unsafe.mjs <task_id> --action <check|compact-done|worktree-switched>
// 退出码: 0=safe / 1=needs-recovery / 2=usage-error / 3=circuit-breaker

import process from 'node:process';
import { readContext, readSizeCheckThreshold } from './task-context-runtime.mjs';

const OVERLOAD_CIRCUIT_BREAKER = 5;
const SIZE_WARN_RATIO = 0.8;
const VALID_ACTIONS = Object.freeze(['check', 'compact-done', 'worktree-switched']);

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function usage() {
  process.stderr.write('Usage: node scripts/recover-context-unsafe.mjs <task_id> --action <check|compact-done|worktree-switched>\n');
}

function parseArgs(argv) {
  const out = { taskId: null, action: null, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--action') {
      out.action = argv[++i] || null;
    } else if (!out.taskId) {
      out.taskId = a;
    } else {
      out.errors.push('unexpected arg: ' + a);
    }
  }
  if (!out.taskId) out.errors.push('missing <task_id>');
  if (!out.action) out.errors.push('missing --action');
  else if (!VALID_ACTIONS.includes(out.action)) {
    out.errors.push('invalid --action: ' + out.action + ' (allowed: ' + VALID_ACTIONS.join(', ') + ')');
  }
  return out;
}

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce(function (o, k) { return (o == null ? o : o[k]); }, obj);
}

function measureContextChars(ctx) {
  return Buffer.byteLength(JSON.stringify(ctx), 'utf8');
}

function recommend(state) {
  const overload = state.overload;
  const contextChars = state.contextChars;
  const sizeThreshold = state.sizeThreshold;
  const action = state.action;
  if (overload >= OVERLOAD_CIRCUIT_BREAKER) {
    return { recommended: 'circuit-breaker', reason: 'overload_count=' + overload + ' >= ' + OVERLOAD_CIRCUIT_BREAKER };
  }
  if (overload > 0) {
    return { recommended: 'compact', reason: 'overload_count=' + overload + ' > 0' };
  }
  if (contextChars >= sizeThreshold) {
    return { recommended: 'compact', reason: 'context_chars=' + contextChars + ' >= size_threshold=' + sizeThreshold };
  }
  const warnAt = Math.floor(sizeThreshold * SIZE_WARN_RATIO);
  if (contextChars >= warnAt) {
    return { recommended: 'monitor', reason: 'context_chars=' + contextChars + ' >= ' + warnAt + ' (80% of size_threshold)' };
  }
  if (action === 'compact-done' || action === 'worktree-switched') {
    return { recommended: 'safe', reason: action + ' already called' };
  }
  return { recommended: 'safe', reason: 'overload=0 and context_chars < 80% size_threshold' };
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length > 0) {
    usage();
    for (const e of args.errors) process.stderr.write('Error: ' + e + '\n');
    process.exit(2);
  }
  let ctx, ctxPath;
  try {
    const r = readContext(args.taskId);
    ctx = r.ctx;
    ctxPath = r.path;
  } catch (e) {
    die(1, 'Error: readContext failed: ' + e.message);
  }
  const overload = Number(getByPath(ctx, 'safety.overload_count') || 0);
  const sizeThreshold = readSizeCheckThreshold();
  const contextChars = measureContextChars(ctx);
  const rec = recommend({ overload: overload, contextChars: contextChars, sizeThreshold: sizeThreshold, action: args.action });
  const result = {
    task_id: args.taskId,
    action: args.action,
    overload_count: overload,
    context_chars: contextChars,
    size_threshold: sizeThreshold,
    overload_threshold: OVERLOAD_CIRCUIT_BREAKER,
    recommended_action: rec.recommended,
    reason: rec.reason,
    context_path: ctxPath,
    timestamp: new Date().toISOString(),
  };
  emitJson(result);
  if (rec.recommended === 'circuit-breaker') process.exit(3);
  if (rec.recommended === 'safe' || rec.recommended === 'monitor') process.exit(0);
  process.exit(1);
}

main();
