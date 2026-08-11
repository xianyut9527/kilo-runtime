#!/usr/bin/env node
// acceptance-check.mjs
// 可执行验收门（A 层第一门，机械断言，模型无关）。
//
// 读 task_context.execution.acceptance_map[]，对每条带 verify_command 的项机械执行命令，
// exit code 硬门。在 LLM verifier 之前跑（机械门优先，fail fast）——把"代码对不对"从
// LLM 判定转为机器证明：验收命令 exit 0 才算过，模型说不算。
//
// 沉淀点：acceptance_map 每条可选 verify_command（可执行命令）。能机械化的 criterion
// 写 verify_command → 本门机械断言；不能的留 LLM verifier。随使用越来越多 criterion
// 机械化（能力沉淀进脚本，不进模型）。
//
// 用法（CLI）：
//   node scripts/acceptance-check.mjs <task_id>
//   命令在 conductor 的 cwd（= 被编码项目根）下执行。
// 退出码：
//   0 = 全部机械验收项通过
//   1 = 无 acceptance_map / 无 verify_command（建议性，回退 LLM verifier，不算 FAIL）
//   2 = 任一 verify_command exit 非零（FAIL，列出哪条）
//
// 也可被 import（H2 quality-gate 合并三门时复用）：
//   import { checkAcceptance } from './acceptance-check.mjs';
//   const r = checkAcceptance(taskId); // {exit, passed, failures}
// import 时不执行 main()，由 caller 决定聚合。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function contextPath(taskId) {
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function readAcceptanceMap(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) die(1, `acceptance-check: task_context 不存在 task_id=${taskId}`);
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(1, `acceptance-check: task_context 解析失败 task_id=${taskId}: ${e.message}`);
  }
  const am = ctx && ctx.execution && ctx.execution.acceptance_map;
  if (!Array.isArray(am)) return null;
  return am;
}

const CMD_TIMEOUT_MS = 120000;

function runCommand(cmd) {
  // 返回 {exit, stdout, stderr}；超时/异常也返回非零 exit，不抛
  try {
    const stdout = execSync(cmd, {
      cwd: process.cwd(),
      shell: true,
      timeout: CMD_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    return { exit: 0, stdout: String(stdout || '').trim(), stderr: '' };
  } catch (err) {
    const exit = typeof err.status === 'number' ? err.status : 124; // 124 = timeout 约定
    return {
      exit,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || '').trim() || (err.killed ? `（超时 >${CMD_TIMEOUT_MS}ms）` : err.message),
    };
  }
}

// 可导入核心：checkAcceptance(taskId) -> {exit, passed, failures}
// CLI 与 import 共用：写逐项 PASS/FAIL 行到 stdout（人类可读），返回值给 caller 聚合。
export function checkAcceptance(taskId) {
  const am = readAcceptanceMap(taskId);
  if (am === null) {
    process.stdout.write('acceptance-check: 无 acceptance_map，回退 LLM verifier\n');
    return { exit: 1, passed: 0, failures: [] };
  }
  const mechanical = am.filter((e) => e && typeof e.verify_command === 'string' && e.verify_command.trim());
  if (mechanical.length === 0) {
    process.stdout.write(`acceptance-check: ${am.length} 条验收标准均无 verify_command，回退 LLM verifier（建议能机械化的写 verify_command 沉淀为机械门）\n`);
    return { exit: 1, passed: 0, failures: [] };
  }

  const failures = [];
  let passed = 0;
  for (const e of mechanical) {
    const r = runCommand(e.verify_command);
    const criterion = e.criterion || '(未命名)';
    if (r.exit === 0) {
      passed++;
      process.stdout.write(`PASS  ${criterion}\n      $ ${e.verify_command}\n`);
    } else {
      failures.push({ criterion, command: e.verify_command, exit: r.exit, stderr: r.stderr });
      process.stdout.write(`FAIL  ${criterion} (exit=${r.exit})\n      $ ${e.verify_command}\n`);
      if (r.stderr) process.stdout.write(`      stderr: ${r.stderr.split('\n').slice(0, 3).join(' | ')}\n`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\nFAIL acceptance-check: ${failures.length}/${mechanical.length} 机械验收项失败（passed=${passed}）\n`);
    process.stdout.write('  失败项：\n');
    for (const f of failures) process.stdout.write(`  - ${f.criterion} (exit=${f.exit})\n`);
    return { exit: 2, passed, failures };
  }
  process.stdout.write(`\nPASS acceptance-check: ${passed}/${mechanical.length} 机械验收项全部通过\n`);
  return { exit: 0, passed, failures: [] };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('Usage: node scripts/acceptance-check.mjs <task_id>\n');
    process.stdout.write('Exit: 0=all mechanical acceptance passed, 1=no verify_command (fall back to LLM), 2=any command failed\n');
    process.exit(args.length !== 1 ? 2 : 0);
  }
  const r = checkAcceptance(args[0]);
  process.exit(r.exit);
}

// CLI guard：仅当直接作为入口运行时执行 main()，import 时不触发（避免 process.exit）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}