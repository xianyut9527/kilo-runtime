#!/usr/bin/env node
// trust-transfer-check.mjs
// convergence-auditor 三步校验脚本化（机械汇总反自验）。
// 矩阵源：agent/conductor.md §交叉验证组合判定 — convergence-auditor 段
//
// 用法：
//   node scripts/trust-transfer-check.mjs <task_id> [--round N]
//   node scripts/trust-transfer-check.mjs --help
//
// 三步校验：
//   1. 独立 evidence：task_context.verification 已填充的每个视角
//      （forward/reverse/side/review）必须含非空 evidence 字段。
//      数组或对象非空；非空字符串引用不算独立证据（视为缺失）。
//   2. 信任传递措辞扫描：扫描 verification.* 各视角的文本内容
//      （JSON.stringify 后正则），命中 /coder 说的对|verifier 已
//      PASS|正向已验证|按 coder 结论|信任传递/i 报该视角。
//   3. fresh 性：若提供 --round N，verification.*.round 必须 === N。
//      缺失 round 字段的视角报 warning 不 fail。
//
// 退出码：
//   0 = 全 PASS
//   1 = 任一 FAIL（且输出 [TRUST_TRANSFER]）
//
// 仅使用 Node 内置模块：node:fs / node:path / node:os / node:process / node:url
// 跨平台：Windows PowerShell 5.1 + Linux bash 兼容

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 信任传递措辞正则（case-insensitive，跨多行）
// 矩阵源：conductor.md §交叉验证组合判定 — convergence-auditor 段
const TRUST_TRANSFER_RE = /(coder 说的对|verifier 已 PASS|正向已验证|按 coder 结论|信任传递)/i;

const PERSPECTIVES = ['forward', 'reverse', 'side', 'review'];

function contextPath(taskId) {
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

// 白名单校验 taskId：仅允许字母数字下划线连字符，长度 1-64
function assertValidTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    die(1, `Error: invalid task_id "${taskId}". Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-). Max length 64.`);
  }
}

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/trust-transfer-check.mjs <task_id> [--round N]',
    '  node scripts/trust-transfer-check.mjs --help',
    '',
    'Options:',
    '  --round N   Require verification.*.round === N. Missing round is warning, not fail.',
    '',
    'Exit codes: 0=all pass, 1=any fail (and prints [TRUST_TRANSFER])',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// evidence 字段"非空且非纯字符串引用"判定。
// - undefined / null → 缺失
// - 字符串（任何非空字符串）→ 视为引用，不算独立证据 → 缺失
// - 数组 → length > 0 通过
// - 对象 → Object.keys().length > 0 通过
// - 其他原始类型（number/boolean）→ 缺失
function isIndependentEvidence(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return false; // 非空字符串引用不算独立证据
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

// 判断视角是否"已填充"：verification.<p> 是非空对象/数组
// （视图中至少应有 verdict 或 evidence 才算填充）
function isPerspectiveFilled(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
  }
  const taskId = args[0];
  assertValidTaskId(taskId);
  let round = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--round') {
      if (i + 1 >= args.length) die(2, 'Error: --round requires a value');
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 0) {
        die(2, 'Error: --round must be a non-negative integer');
      }
      round = n;
      i++;
    } else {
      die(2, `Error: unknown argument "${args[i]}"`);
    }
  }

  const p = contextPath(taskId);
  if (!fs.existsSync(p)) {
    die(1, `Error: task_context not found for task_id=${taskId}`);
  }
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(1, `Error: cannot parse task_context for task_id=${taskId}: ${e.message}`);
  }

  const v = ctx.verification || {};
  let hasFail = false;
  const lines = [];

  // 步骤 1：独立 evidence
  for (const persp of PERSPECTIVES) {
    const view = v[persp];
    if (!isPerspectiveFilled(view)) {
      // 未填充 — 跳过（不计入失败；该视角可能未启用）
      lines.push(`PASS verification.${persp}.evidence: not filled (skipped)`);
      continue;
    }
    // 已填充视角必须有独立 evidence 字段
    const ev = view.evidence;
    if (!isIndependentEvidence(ev)) {
      hasFail = true;
      lines.push(
        `FAIL verification.${persp}.evidence: missing or not independent (string references are not accepted as evidence)`
      );
    } else {
      lines.push(`PASS verification.${persp}.evidence: independent evidence present`);
    }
  }

  // 步骤 2：信任传递措辞扫描
  for (const persp of PERSPECTIVES) {
    const view = v[persp];
    if (!isPerspectiveFilled(view)) continue;
    const text = JSON.stringify(view);
    const m = text.match(TRUST_TRANSFER_RE);
    if (m) {
      hasFail = true;
      lines.push(
        `FAIL verification.${persp}: trust-transfer phrase detected: "${m[0]}"`
      );
    } else {
      lines.push(`PASS verification.${persp}: no trust-transfer phrase`);
    }
  }

  // 步骤 3：fresh 性
  if (round !== null) {
    for (const persp of PERSPECTIVES) {
      const view = v[persp];
      if (!isPerspectiveFilled(view)) continue;
      if (!Object.prototype.hasOwnProperty.call(view, 'round')) {
        lines.push(
          `WARN verification.${persp}.round: missing round field (warning, not fail)`
        );
        continue;
      }
      if (view.round !== round) {
        hasFail = true;
        lines.push(
          `FAIL verification.${persp}.round: expected ${round}, got ${JSON.stringify(view.round)}`
        );
      } else {
        lines.push(`PASS verification.${persp}.round: ${round} matches current round`);
      }
    }
  }

  for (const l of lines) {
    process.stdout.write(l + '\n');
  }
  if (hasFail) {
    process.stderr.write('[TRUST_TRANSFER] convergence-auditor check failed\n');
    process.exit(1);
  }
  process.stdout.write('all checks passed\n');
  process.exit(0);
}

// ============================================================
// 模块导出
// ============================================================

export {
  TRUST_TRANSFER_RE,
  PERSPECTIVES,
  contextPath,
  isIndependentEvidence,
  isPerspectiveFilled,
};

// ============================================================
// 脚本入口
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
