#!/usr/bin/env node
// Usage: node scripts/new-validator.mjs <error-code> "<description>" "<from-stage>" "<to-stage>"
// 作用：自动注册新 transition validator
//   - 写 scripts/error-codes.mjs 加 ERROR_CODES.<code> 条目
//   - 改 scripts/transition-check.mjs 加 validator 段（提示插入位置）
//   - 改 lifecycle/stages/<from>.md + <to>.md 加契约描述（提示）
//
// Example: node scripts/new-validator.mjs MISSING_USER_INPUT "user_prompt 必填非空" PLANNING EXECUTING

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const [, , code, desc, fromStage, toStage] = process.argv;
if (!code || !desc || !fromStage || !toStage) {
  console.error('Usage: node scripts/new-validator.mjs <error-code> "<description>" <from-stage> <to-stage>');
  process.exit(2);
}

// 1. 写 scripts/error-codes.mjs 加 ERROR_CODES.<code>
const ecFile = path.join(ROOT, 'scripts', 'error-codes.mjs');
let ec = fs.readFileSync(ecFile, 'utf8');
if (!ec.includes(`${code}:`)) {
  // 在 // === 既有错误码（保留原名... === 段前插入
  ec = ec.replace(
    /(  \/\/ === 既有错误码)/,
    `  ${code}: {
    code: '${code}',
    msg: '${desc}',
    see: 'lifecycle/stages/${fromStage.toLowerCase()}.md',
  },\n\n$1`
  );
  fs.writeFileSync(ecFile, ec);
  console.log(`✓ updated ${ecFile}（加 ${code}）`);
}

// 2. 提示插入位置（不自动改 transition-check.mjs — 需手工核对）
const tcFile = path.join(ROOT, 'scripts', 'transition-check.mjs');
console.log(`\n[手工步骤] 改 ${tcFile}:`);
console.log(`  在 \`if (FROM === '${fromStage}' && TO === '${toStage}')\` 段加:`);
console.log(`    die(1, codeMsg('${code}', '具体描述'));`);
console.log(`  注意:放在校验块合适位置,可参考 L488-516 现有 8 个 die 模板`);

console.log(`\n[完成] 新 validator "${code}" 已登记。建议:`);
console.log(`  1. 手工改 transition-check.mjs 加 die 调用（context-dependent）`);
console.log(`  2. 改 lifecycle/stages/${fromStage.toLowerCase()}.md 与 ${toStage.toLowerCase()}.md 加契约描述`);
console.log(`  3. 跑 node scripts/lifecycle-doctor/index.mjs 验证`);
console.log(`  4. 跑模拟测试：构造正/反 fixture 验证 die 工作`);
