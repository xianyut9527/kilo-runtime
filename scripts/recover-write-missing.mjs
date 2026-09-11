#!/usr/bin/env node
// scripts/recover-write-missing.mjs
// WRITE_MISSING 恢复路径检测脚本（U2）。
//
// 定位：subagent 完工未按 frontmatter task_context.write 落盘产物时，
//       conductor 委派本脚本做机械检测 + 推荐动作（不自动重派）。
//       决策权保留在 conductor，本脚本只输出 JSON + exit code。
//
// 用法：
//   node scripts/recover-write-missing.mjs <task_id> --agent <name> [--fields a,b,c]
//
// 参数：
//   <task_id>              必填，定位 $env:TEMP/kilo/task_context_<task_id>.json
//   --agent <name>         必填，agent 名（决定期望字段集派生来源）
//   --fields <dot,list>    可选，显式指定期望字段集（逗号分隔）
//                          省略时按 agent/<name>.md frontmatter task_context.write 自动派生
//                          （与 scripts/task-context.mjs WRITE_MATRIX 同源逻辑）
//
// 输出：单行 JSON 到 stdout，含 task_id / agent / expected_fields / missing_fields
//       / present_fields / retry_count / max_retries / recommended_action /
//       byte_verification[]。
//
// 退出码：
//   0 = all-present（无需恢复）
//   1 = missing 且 retry 可用（recommend retry）
//   2 = usage error（参数缺失/agent 未注册/--fields 格式错误）
//   3 = retry 已耗尽（recommend escalate，熔断）
//
// 仅使用 Node 内置模块：node:fs / node:path / node:process / node:url
// 跨平台：Windows PowerShell + Linux bash 兼容；输出 ASCII 避免 PS5.1 GBK 乱码

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContext } from './task-context-runtime.mjs';
import { verifyFields } from './lib/byte-verify.mjs';
import { extractFrontmatter, extractTaskContextWrite } from './lib/frontmatter.mjs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(REPO_ROOT, 'agent');

// 默认重试配额（与 lifecycle/config.yaml retry.agent_timeout_max_retries 同源思路；
// 若 task_context.quality.write_max_retries 存在则覆盖；U6 扩展后会从 config.yaml 读）
const DEFAULT_MAX_RETRIES = 1;

// ============================================================
// 输出 + 退出工具
// ============================================================

function emitJsonAndExit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode);
}

function usageError(message) {
  const usage = [
    'usage: node scripts/recover-write-missing.mjs <task_id> --agent <name> [--fields a,b,c]',
    '  --agent  <name>   required, registered agent name (matches agent/<name>.md)',
    '  --fields  <list>  optional, comma-separated dot paths;',
    '                   omit to derive from frontmatter task_context.write',
    '',
    'exit codes: 0=all-present, 1=missing(retry-available),',
    '            2=usage-error, 3=retry-exhausted',
  ].join('\n');
  process.stderr.write(`Error: ${message}\n\n${usage}\n`);
  process.exit(2);
}

// ============================================================
// CLI 解析（极简：仅支持 --agent / --fields；--help 走 usage）
// ============================================================

function parseArgs(argv) {
  const out = { taskId: null, agent: null, fields: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') {
      out.agent = argv[++i];
    } else if (a === '--fields') {
      out.fields = argv[++i];
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 0) out.taskId = positional[0];
  return out;
}

// frontmatter 解析与 task_context.write 提取统一走 scripts/lib/frontmatter.mjs（canonical）

// 从 agent/<name>.md 派生期望字段集
// 失败原因分两类：agent 文件不存在 / agent 文件无 task_context.write 声明
function deriveExpectedFields(agentName) {
  const agentFile = path.join(AGENT_DIR, `${agentName}.md`);
  if (!fs.existsSync(agentFile)) {
    return { ok: false, reason: `agent "${agentName}" not found at ${path.relative(REPO_ROOT, agentFile)}` };
  }
  let text;
  try {
    text = fs.readFileSync(agentFile, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read agent file: ${e.message}` };
  }
  // 剥离 UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const fm = extractFrontmatter(text);
  if (!fm) {
    return { ok: false, reason: `agent "${agentName}" has no frontmatter` };
  }
  const writes = extractTaskContextWrite(fm);
  if (writes.length === 0) {
    return { ok: false, reason: `agent "${agentName}" frontmatter task_context.write is empty` };
  }
  return { ok: true, fields: writes };
}

// ============================================================
// retry_count / max_retries 读取
// 来源：task_context.quality.write_retry_count（缺省 0）
//       task_context.quality.write_max_retries（缺省 DEFAULT_MAX_RETRIES）
// 暂未硬门要求 schema 包含这两个字段；缺省给安全值
// ============================================================

function readRetryState(ctx) {
  const q = (ctx && ctx.quality) || {};
  const retryCount = Number.isInteger(q.write_retry_count) ? q.write_retry_count : 0;
  const maxRetries = Number.isInteger(q.write_max_retries) ? q.write_max_retries : DEFAULT_MAX_RETRIES;
  return { retryCount, maxRetries };
}

// ============================================================
// 主流程
// ============================================================

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    return usageError(e.message);
  }
  if (args.help) {
    return usageError('--help shown');
  }
  if (!args.taskId) {
    return usageError('missing required positional <task_id>');
  }
  if (!args.agent) {
    return usageError('missing required --agent <name>');
  }
  // taskId 白名单：与 task-context-runtime.mjs assertValidTaskId 同源规则
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.taskId)) {
    return usageError(`invalid task_id "${args.taskId}" (allowed: [A-Za-z0-9_-]{1,64})`);
  }

  // 期望字段集：--fields 优先；缺省按 frontmatter 派生
  let expected;
  if (args.fields !== null) {
    const parts = args.fields.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      return usageError('--fields provided but empty after split');
    }
    expected = parts;
  } else {
    const derived = deriveExpectedFields(args.agent);
    if (!derived.ok) {
      return usageError(derived.reason);
    }
    expected = derived.fields;
  }

  // 预检 task_context 文件（readContext 内部 die exit 1 不可捕获，归 usage-error）
  // 路径必须与 task-context-runtime.mjs contextPath() 同源（$env:TEMP/kilo/task_context_<id>.json）
  const ctxPath = path.join(os.tmpdir(), 'kilo', `task_context_${args.taskId}.json`);
  if (!fs.existsSync(ctxPath)) {
    return usageError(`task_context not found: ${ctxPath}`);
  }
  // 读 task_context；JSON 损坏等异常归 usage-error
  let ctx;
  try {
    const r = readContext(args.taskId);
    ctx = r.ctx;
  } catch (e) {
    return usageError(`cannot read task_context: ${e.message}`);
  }

  // byte-level 校验（DRY：空值判定走 byte-verify.mjs，禁止内联重复）
  const byteVerification = verifyFields(ctx, expected);
  const missing = byteVerification.filter((r) => !r.present).map((r) => r.field);
  const present = byteVerification.filter((r) => r.present).map((r) => r.field);

  // retry 状态
  const { retryCount, maxRetries } = readRetryState(ctx);

  // recommended_action 与 exit code 决策
  let recommendedAction;
  let exitCode;
  if (missing.length === 0) {
    recommendedAction = 'none';
    exitCode = 0;
  } else if (retryCount < maxRetries) {
    recommendedAction = 'retry';
    exitCode = 1;
  } else {
    recommendedAction = 'escalate';
    exitCode = 3;
  }

  const payload = {
    task_id: args.taskId,
    agent: args.agent,
    expected_fields: expected,
    missing_fields: missing,
    present_fields: present,
    retry_count: retryCount,
    max_retries: maxRetries,
    recommended_action: recommendedAction,
    byte_verification: byteVerification,
  };
  emitJsonAndExit(payload, exitCode);
}

main();

