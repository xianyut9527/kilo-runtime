#!/usr/bin/env node
// prompt-gate.mjs
// task 委派 prompt 长度复核工具（手动诊断，非运行时门）。
//
// 定位：委派 prompt ≤1500 字符由生成时自检纪律保证（conductor 铁律 9：
// 禁止复述文件内容、超限当场精简）。本脚本保留为人工/CI 复核工具
// （审计、复盘、抽查历史委派包），不再要求每次委派前运行时调用——
// 每次调用 = 一次 node 进程启动开销，约束已内化于提示词（编译时优先原则）。
//
// 用法：
//   node scripts/prompt-gate.mjs --file <path>
//   echo "$prompt" | node scripts/prompt-gate.mjs --stdin
//   node scripts/prompt-gate.mjs --stdin --max 2000
//   node scripts/prompt-gate.mjs --help
//
// 退出码：
//   0 = 通过（≤ 阈值），stdout 含 PASS
//   1 = 超限（> 阈值），stderr 含 [PROMPT_OVER_LIMIT] 及实际长度
//   2 = 参数错误
//
// 仅使用 Node 内置模块（Node 14 兼容）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 工具
// ============================================================

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/prompt-gate.mjs --file <path>',
    '  echo "$prompt" | node scripts/prompt-gate.mjs --stdin',
    '  node scripts/prompt-gate.mjs --stdin --max <n>',
    '  node scripts/prompt-gate.mjs --help',
    '',
    'Manual prompt length audit tool (conductor iron-law 9, non-runtime).',
    '',
    'Options:',
    '  --file <path>   Read prompt from file',
    '  --stdin         Read prompt from stdin',
    '  --max <n>       Override default threshold (default: 1500)',
    '  --help, -h      Show this help',
    '',
    'Exit codes:',
    '  0 = PASS (length <= threshold)',
    '  1 = [PROMPT_OVER_LIMIT] (length > threshold)',
    '  2 = usage error',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

// ============================================================
// stdin 读取
// ============================================================

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', (err) => reject(err));
  });
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage();

  const fileIdx = args.indexOf('--file');
  const stdinFlag = args.includes('--stdin');
  const maxIdx = args.indexOf('--max');

  // 互斥校验
  if (fileIdx !== -1 && stdinFlag) {
    die(2, 'Error: --file and --stdin are mutually exclusive');
  }
  if (fileIdx === -1 && !stdinFlag) {
    die(2, 'Error: must specify --file <path> or --stdin');
  }

  // 阈值
  let maxChars = 1500;
  if (maxIdx !== -1) {
    if (maxIdx + 1 >= args.length) die(2, 'Error: --max requires a numeric value');
    const raw = args[maxIdx + 1];
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1) die(2, `Error: --max must be a positive integer, got "${raw}"`);
    maxChars = n;
  }

  // 读取内容
  let content;
  if (fileIdx !== -1) {
    if (fileIdx + 1 >= args.length) die(2, 'Error: --file requires a path');
    const filePath = path.resolve(args[fileIdx + 1]);
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      die(2, `Error: cannot read file "${filePath}": ${e.message}`);
    }
  } else {
    // --stdin
    try {
      content = await readStdin();
    } catch (e) {
      die(2, `Error: failed to read stdin: ${e.message}`);
    }
  }

  const len = content.length;

  if (len > maxChars) {
    die(1, `[PROMPT_OVER_LIMIT] prompt length ${len} exceeds threshold ${maxChars} (iron-law 9: task prompt must be <= ${maxChars} chars)`);
  }

  process.stdout.write(`PASS prompt length ${len} <= ${maxChars}\n`);
  process.exit(0);
}

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
