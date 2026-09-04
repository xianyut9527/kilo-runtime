#!/usr/bin/env node
// init-gate.mjs
// 会话首个任务前装配门禁（U4）：合并 lifecycle-doctor + apply-tier-auto 为单进程。
// 一次进程完成：静态装配校验（doctor）-> 定级机械应用（apply-tier-auto）。
// exit code 矩阵：
//   0 = 全通过（doctor PASS + apply-tier-auto 成功）
//   1 = doctor FAIL 阻断（装配校验未通过，不进入运行）
//   2 = apply-tier-auto FAIL（定级应用失败）
//   3 = 参数错误
// 用法：node scripts/init-gate.mjs <task_id> <T0|T1|T2> --agent conductor
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

import { spawnSync } from 'node:child_process';
import { scanLessons } from './lessons-inject.mjs';
import { readContext } from './task-context-runtime.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCTOR = path.join(__dirname, 'lifecycle-doctor', 'index.mjs');
const TASK_CONTEXT = path.join(__dirname, 'task-context.mjs');

// ---- 参数解析 ----
const args = process.argv.slice(2);
if (args.length < 3) {
  process.stderr.write('Error: init-gate requires <task_id> <T0|T1|T2> --agent conductor\n');
  process.exit(3);
}
const taskId = args[0];
const tier = args[1];
if (!['T0', 'T1', 'T2'].includes(tier)) {
  process.stderr.write('Error: init-gate requires <T0|T1|T2>, got "' + tier + '"\n');
  process.exit(3);
}
const agentIdx = args.indexOf('--agent');
const agent = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1] : null;
if (!agent) {
  process.stderr.write('Error: init-gate requires --agent <name>\n');
  process.exit(3);
}

// ---- 阶段1：lifecycle-doctor --fast（指纹缓存命中 ~75ms，未命中全量 ~2.2s + 写缓存）----
const doctor = spawnSync(process.execPath, [DOCTOR, '--quiet', '--fast'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
});
if (doctor.error) {
  process.stderr.write('[INIT_GATE] lifecycle-doctor 调用失败: ' + doctor.error.message + '\n');
  process.exit(1);
}
if (doctor.status !== 0) {
  process.stderr.write('[INIT_GATE] lifecycle-doctor FAIL 阻断（exit ' + doctor.status + '）\n');
  process.stderr.write((doctor.stdout || '') + (doctor.stderr || ''));
  process.exit(1);
}

// ---- 阶段2：apply-tier-auto ----
const apply = spawnSync(process.execPath, [TASK_CONTEXT, 'apply-tier-auto', taskId, tier, '--agent', agent], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
});
if (apply.error) {
  process.stderr.write('[INIT_GATE] apply-tier-auto 调用失败: ' + apply.error.message + '\n');
  process.exit(2);
}
if (apply.status !== 0) {
  process.stderr.write('[INIT_GATE] apply-tier-auto FAIL（exit ' + apply.status + '）\n');
  process.stderr.write((apply.stdout || '') + (apply.stderr || ''));
  process.exit(2);
}

process.stdout.write('ok: init-gate doctor=PASS apply-tier-auto=' + (apply.stdout || '').trim() + '\n');

// ---- 经验注入 (lessons-inject): 扫描当月 lessons 命中当前 intent.raw, 写入 intent.prior_lessons ----
// 增强非硬门: 任何 IO/解析错误只 stderr, 不阻断 init-gate 退出语义。
const dryRun = args.includes('--dry-run');
try {
  const { ctx } = readContext(taskId);
  const raw = (ctx.intent && typeof ctx.intent.raw === 'string') ? ctx.intent.raw : '';
  if (raw.trim().length > 0) {
    const month = new Date().toISOString().slice(0, 7);
    const hits = scanLessons(raw, { month });
    if (hits.length > 0) {
      const json = JSON.stringify(hits);
      if (dryRun) {
        process.stdout.write('lessons-inject (dry-run) hits=' + hits.length + ': ' + json + '\n');
      } else {
        const inj = spawnSync(process.execPath, [TASK_CONTEXT, 'set', taskId, '--batch', JSON.stringify({ 'intent.prior_lessons': hits }), '--agent', 'conductor'], {
          cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
        });
        if (inj.error) throw inj.error;
        if (inj.status !== 0) throw new Error('task-context set intent.prior_lessons failed exit=' + inj.status + ': ' + (inj.stderr || inj.stdout || ''));
        process.stdout.write('lessons-inject: wrote ' + hits.length + ' prior_lesson(s) to intent.prior_lessons\n');
      }
    }
  }
} catch (e) {
  // 经验注入失败不阻断 init-gate (增强非硬门)
  process.stderr.write('[lessons-inject] skipped (non-fatal): ' + (e && e.message || e) + '\n');
}
process.exit(0);
