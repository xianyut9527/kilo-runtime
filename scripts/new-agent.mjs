#!/usr/bin/env node
// Usage: node scripts/new-agent.mjs <agent-name> "<description>" [model]
// 作用：自动注册新 subagent
//   - 写 agent/<name>.md（frontmatter 模板）
//   - 写 kilo.json agent.<name> 子段
//   - 改 scripts/agents-smoke-test.mjs EXPECTED_SUBAGENTS 列表
//   - 改 scripts/flow-audit.mjs 注释（如果引用）
//
// Example: node scripts/new-agent.mjs tester "测试智能体——单元测试/E2E 测试设计与执行" hx/MiniMax-M3

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const [, , name, desc, model = 'hx/MiniMax-M3'] = process.argv;
if (!name || !desc) {
  console.error('Usage: node scripts/new-agent.mjs <agent-name> "<description>" [model]');
  process.exit(2);
}

// 1. 写 agent/<name>.md
const agentFile = path.join(ROOT, 'agent', `${name}.md`);
const agentTemplate = `---
description: ${desc}
mode: subagent
model: ${model}
---

# ${name}

[在此填该智能体的详细职责、行为、约束、返回契约]

## 角色

[description]

## 行为

[核心行为 1-N 条]

## 权限

[bash / read / write / edit / task 权限清单]

## 返回契约

≤4000 字符结构化摘要，verdict + 证据 file:line + 关键结论。详见 \`.kilo/instructions/output-schema.md\` §返回契约。
`;
fs.writeFileSync(agentFile, agentTemplate);
console.log(`✓ wrote ${agentFile}`);

// 2. 改 kilo.json
const kiloFile = path.join(ROOT, 'kilo.json');
const kilo = JSON.parse(fs.readFileSync(kiloFile, 'utf8'));
kilo.agent[name] = {
  mode: 'subagent',
  model,
  prompt: desc,
};
fs.writeFileSync(kiloFile, JSON.stringify(kilo, null, 2) + '\n');
console.log(`✓ updated ${kiloFile}`);

// 3. 改 scripts/agents-smoke-test.mjs EXPECTED_SUBAGENTS
const smokeFile = path.join(ROOT, 'scripts', 'agents-smoke-test.mjs');
let smoke = fs.readFileSync(smokeFile, 'utf8');
if (!smoke.includes(`'${name}'`)) {
  smoke = smoke.replace(/EXPECTED_SUBAGENTS = \[([\s\S]*?)\];/, (m, list) => {
    const items = list.split(',').map(s => s.trim()).filter(Boolean);
    items.push(`'${name}'`);
    items.sort();
    return `EXPECTED_SUBAGENTS = [\n  ${items.join(',\n  ')}\n];`;
  });
  fs.writeFileSync(smokeFile, smoke);
  console.log(`✓ updated ${smokeFile}`);
}

console.log(`\n[完成] 新 subagent "${name}" 已注册。建议:`);
console.log(`  1. 编辑 agent/${name}.md 完善行为/权限/返回契约`);
console.log(`  2. 跑 node scripts/lifecycle-doctor.mjs 验证`);
console.log(`  3. 跑 node scripts/agents-smoke-test.mjs --full 测试连通性`);
