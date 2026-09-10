#!/usr/bin/env node
// diff-boundary-check.mjs
// 机械边界门（A 层，模型无关）——机械防 SCOPE_CREEP / FORBIDDEN_TOUCH。
// 读 task_context：execution.changes[].file（coder 实际改动）vs plan.task_dag.units[].key_files（允许集）
//   + plan.task_dag.units[].forbidden_files（禁止集）。
// 任一改动文件不在任何 unit 的 key_files → [SCOPE_CREEP]；触及 forbidden_files → [FORBIDDEN_TOUCH]。
//
// 沉淀意义：reverse-auditor 对 SCOPE_CREEP/FORBIDDEN_TOUCH 的判定转为机器断言（exit code），
// 使 reverse-auditor 可改为 T2 升级介入，T1 happy path 由本门 + acceptance-check + verifier 托底（快）。
//
// 用法（CLI）：
//   node scripts/diff-boundary-check.mjs <task_id>
// 退出码：0=全部改动在边界内；1=无 plan/changes（建议性，回退 LLM）；2=越界（FAIL，列出哪条）
//
// 也可被 import（H2 quality-gate 合并三门时复用）：
//   import { checkDiffBoundary } from './diff-boundary-check.mjs';
//   const r = checkDiffBoundary(taskId); // {exit, scopeCreep, forbiddenTouch, allowedCount, changesCount}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { contextPath } from './lib/task-context-io.mjs';

function die(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

function readCtx(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) die(1, `diff-boundary-check: task_context 不存在 task_id=${taskId}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(1, `解析失败: ${e.message}`); }
}

// 可导入核心
export function checkDiffBoundary(taskId) {
  const ctx = readCtx(taskId);
  const units = ctx?.plan?.task_dag;
  const changes = ctx?.execution?.changes;
  if (!Array.isArray(units) || units.length === 0) {
    process.stdout.write('diff-boundary-check: 无 plan.task_dag（T0 或无单元），回退 LLM\n');
    return { exit: 1, scopeCreep: [], forbiddenTouch: [], allowedCount: 0, changesCount: Array.isArray(changes) ? changes.length : 0 };
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    process.stdout.write('diff-boundary-check: 无 execution.changes，回退 LLM\n');
    return { exit: 1, scopeCreep: [], forbiddenTouch: [], allowedCount: 0, changesCount: 0 };
  }

  // 允许集 = 所有 unit key_files 并集；禁止集 = 所有 forbidden_files 并集
  const allowed = new Set();
  const forbidden = new Set();
  for (const u of units) {
    for (const f of u.key_files || []) allowed.add(f);
    for (const f of u.forbidden_files || []) forbidden.add(f);
  }

  const scopeCreep = [];
  const forbiddenTouch = [];
  for (const c of changes) {
    const f = c && c.file;
    if (!f || typeof f !== 'string') continue;
    if (forbidden.has(f)) forbiddenTouch.push(f);
    else if (!allowed.has(f)) scopeCreep.push(f);
  }

  if (forbiddenTouch.length > 0 || scopeCreep.length > 0) {
    process.stdout.write('FAIL diff-boundary-check:\n');
    if (forbiddenTouch.length > 0) process.stdout.write(`  [FORBIDDEN_TOUCH] 触及禁止文件: ${forbiddenTouch.join(', ')}\n`);
    if (scopeCreep.length > 0) process.stdout.write(`  [SCOPE_CREEP] 改动超出 key_files 允许集: ${scopeCreep.join(', ')}\n`);
    process.stdout.write(`  允许集(${allowed.size}): ${[...allowed].join(', ') || '(空)'}\n`);
    return { exit: 2, scopeCreep, forbiddenTouch, allowedCount: allowed.size, changesCount: changes.length };
  }
  process.stdout.write(`PASS diff-boundary-check: ${changes.length} 个改动文件全部在 ${allowed.size} 个允许文件边界内\n`);
  return { exit: 0, scopeCreep: [], forbiddenTouch: [], allowedCount: allowed.size, changesCount: changes.length };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('Usage: node scripts/diff-boundary-check.mjs <task_id>\n');
    process.stdout.write('Exit: 0=in-bounds, 1=no plan/changes (fall back to LLM), 2=out-of-bounds\n');
    process.exit(args.length !== 1 ? 2 : 0);
  }
  const r = checkDiffBoundary(args[0]);
  process.exit(r.exit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}