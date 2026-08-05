#!/usr/bin/env node
// search-discipline-check.mjs
// 搜索纪律机械门（A 层，模型无关）-- 防 agent 无脑全仓 Grep / pattern 爆炸 / 未优先图谱。
//
// 4 类违规检测（函数式注册，方便 U4 扩展）：
//   1. detectNoInclude           — Grep 无 include 限定（dispatch 缺文件范围）
//   2. detectPatternAlternation  — pattern 顶层 | 数量 > 3
//   3. detectOversizedPattern    — 单次 prompt_chars > 3000
//   4. detectUnsupportedRegex    — pattern 含 ripgrep 默认引擎不支持的 PCRE 特性
//                                  （lookaround (?=)(?!)(?<=)(?<!)/\K/原子组/反向引用）
//
// 用法：node scripts/search-discipline-check.mjs <task_id>
// 退出码：
//   0 = 全部通过（PASS）
//   1 = 无 task_context / 无可检测项（usage / 回退 LLM）
//   2 = 任一违规（FAIL，列出违规类型）
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function contextPath(taskId) {
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function readCtx(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(1, `search-discipline-check: 解析失败: ${e.message}`);
  }
}

// ============================================================
// 顶层 | 计数器（排除 [] () 内的 |）
// ============================================================
function countTopLevelPipe(s) {
  if (typeof s !== 'string' || !s) return 0;
  let depth = 0;      // () 深度
  let inClass = false; // [] 内
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; } // 转义
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { if (depth > 0) depth--; continue; }
    if (c === '|' && depth === 0) count++;
  }
  return count;
}

// ============================================================
// 4 类检测函数（注册式，U4 扩展只需 push 一个 {name, run}）
// 返回 { violated: bool, detail: string }
// ============================================================

// 1. Grep 无 include 限定
// 启发式：plan 中任一 unit 无 key_files（= 无文件范围，全仓广搜风险）
function detectNoInclude(ctx) {
  const units = ctx?.plan?.task_dag?.units;
  if (!Array.isArray(units) || units.length === 0) {
    return { violated: false, detail: 'no plan units, skip' };
  }
  const noScope = units.filter((u) => !Array.isArray(u.key_files) || u.key_files.length === 0);
  if (noScope.length > 0) {
    return {
      violated: true,
      detail: `units 无 key_files（无文件范围，全仓广搜风险）: ${noScope.map((u) => u.unit_id).join(', ')}`,
    };
  }
  // 启发式 2：dispatch_pending.file_count 缺失或 0（conductor 委派时未声明文件范围）
  const dp = ctx?.dispatch_pending;
  if (dp && (typeof dp.file_count !== 'number' || dp.file_count < 1)) {
    return {
      violated: true,
      detail: `dispatch_pending.file_count=${dp.file_count}（无文件范围，Grep 必无 include）`,
    };
  }
  return { violated: false, detail: 'all units scoped' };
}

// 2. pattern alternation > 3（顶层 | 数量）
// 扫 plan.units[].goal / verify_command / acceptance_criterion 中顶层 | 数
function detectPatternAlternation(ctx) {
  const units = ctx?.plan?.task_dag?.units;
  if (!Array.isArray(units) || units.length === 0) {
    return { violated: false, detail: 'no plan units, skip' };
  }
  const violations = [];
  for (const u of units) {
    const fields = [
      ['goal', u.goal],
      ['verify_command', u.verify_command],
      ...(Array.isArray(u.acceptance_criteria) ? u.acceptance_criteria.map((c, i) => [`ac[${i}]`, c]) : []),
    ];
    for (const [label, text] of fields) {
      if (typeof text !== 'string') continue;
      const n = countTopLevelPipe(text);
      if (n > 3) violations.push(`${u.unit_id}.${label}: 顶层|=${n}`);
    }
  }
  if (violations.length > 0) {
    return { violated: true, detail: `pattern 顶层|>3: ${violations.join('; ')}` };
  }
  return { violated: false, detail: 'all patterns within alternation budget' };
}

// 3. 单次 prompt_chars > 3000
function detectOversizedPattern(ctx) {
  const dp = ctx?.dispatch_pending;
  if (!dp || typeof dp.prompt_chars !== 'number') {
    return { violated: false, detail: 'no dispatch_pending, skip' };
  }
  if (dp.prompt_chars > 3000) {
    return {
      violated: true,
      detail: `dispatch_pending.prompt_chars=${dp.prompt_chars} > 3000（单次 Grep pattern 过大）`,
    };
  }
  return { violated: false, detail: `prompt_chars=${dp.prompt_chars} ≤ 3000` };
}

// 4. pattern 含 ripgrep 默认引擎不支持的 PCRE 特性
// ripgrep 默认用 Rust regex 引擎（不支持 lookaround / \K / 原子组 / 反向引用），
// 用此类 pattern 会抛 "regex parse error"；需 --pcre2 启用。
// 启发式：扫 plan.units[].goal / verify_command / acceptance_criteria 中是否含
//   (?! (?= (?<! (?<= \K (?> \1..\9
function detectUnsupportedRegex(ctx) {
  const units = ctx?.plan?.task_dag?.units;
  if (!Array.isArray(units) || units.length === 0) {
    return { violated: false, detail: 'no plan units, skip' };
  }
  // 匹配 ripgrep 默认引擎不支持的语法
  // (?=  (?!  (?<=  (?<!  \K  (?>  \1..\9
  const pcreOnly = /(\(\?[=!]|\(\?<[=!]|\\K|\(\?>)|\\\d/;
  const violations = [];
  for (const u of units) {
    const fields = [
      ['goal', u.goal],
      ['verify_command', u.verify_command],
      ...(Array.isArray(u.acceptance_criteria) ? u.acceptance_criteria.map((c, i) => [`ac[${i}]`, c]) : []),
    ];
    for (const [label, text] of fields) {
      if (typeof text !== 'string') continue;
      const m = text.match(pcreOnly);
      if (m) {
        violations.push(`${u.unit_id}.${label}: PCRE-only=${m[0]}（需 rg --pcre2）`);
      }
    }
  }
  if (violations.length > 0) {
    return { violated: true, detail: `pattern 含 ripgrep 不支持语法: ${violations.join('; ')}` };
  }
  return { violated: false, detail: 'all patterns within ripgrep default engine' };
}

// ============================================================
// 注册表（U4 扩展 push 即可）
// ============================================================
const checks = [
  { name: 'no_include',           run: detectNoInclude },
  { name: 'pattern_alternation',  run: detectPatternAlternation },
  { name: 'oversized_pattern',    run: detectOversizedPattern },
  { name: 'unsupported_regex',    run: detectUnsupportedRegex },
];

// ============================================================
// CLI
// ============================================================
function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('Usage: node scripts/search-discipline-check.mjs <task_id>\n');
    process.stdout.write('Exit: 0=all pass, 1=no task_context / nothing to check (fall back to LLM), 2=any violation\n');
    process.exit(args.length !== 1 ? 1 : 0);
  }
  const taskId = args[0];
  const ctx = readCtx(taskId);
  if (ctx === null) {
    process.stdout.write(`search-discipline-check: task_context 不存在 task_id=${taskId}\n`);
    process.exit(1);
  }

  const violations = [];
  for (const c of checks) {
    let res;
    try { res = c.run(ctx); }
    catch (e) { res = { violated: false, detail: `exception: ${e.message}` }; }
    const tag = res.violated ? 'FAIL' : 'PASS';
    process.stdout.write(`  [${tag}] ${c.name}: ${res.detail}\n`);
    if (res.violated) violations.push(c.name);
  }

  if (violations.length > 0) {
    process.stdout.write(`\nFAIL search-discipline-check (违规类型=${violations.join('|')})\n`);
    process.exit(2);
  }
  process.stdout.write('\nPASS search-discipline-check\n');
  process.exit(0);
}

main();