#!/usr/bin/env node
// Usage: node scripts/new-stage.mjs <stage-id> "<description>" [executor]
// 作用：自动注册新 lifecycle stage
//   - 写 lifecycle/stages/<id>.md（frontmatter 模板）
//   - 改 lifecycle/graph.yaml 加节点
//   - 改 lifecycle/stages/README.md 加目录行
//   - 提示 transition-check.mjs 加新边的位置
//
// Example: node scripts/new-stage.mjs REVIEW "代码审查阶段——T1+ 必经，T0 跳过" conductor

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const [, , id, desc, executor = 'conductor'] = process.argv;
if (!id || !desc) {
  console.error('Usage: node scripts/new-stage.mjs <stage-id> "<description>" [executor]');
  process.exit(2);
}

if (!['conductor', 'subagent'].includes(executor)) {
  console.error(`Error: executor must be 'conductor' or 'subagent' (got: ${executor})`);
  process.exit(2);
}

// 1. 写 lifecycle/stages/<id>.md
const stageFile = path.join(ROOT, 'lifecycle', 'stages', `${id.toLowerCase()}.md`);
const stageTemplate = `---
description: ${desc}
executor: ${executor}        # conductor 内建 或 subagent 委派
token_budget: 4000
# required_roles 仅 subagent 模式需要，conductor 内建省略
${executor === 'subagent' ? 'required_roles: [<agent-name>]' : ''}
---

# ${id}

[在此填该阶段的输入/处理流程/输出信号/路由规则/硬规则]

## 思维模型

[阶段核心目标 + 与相邻阶段的边界]

## 输入

[前置阶段的产物要求]

## 处理流程

[核心步骤 1-N 条]

## 输出信号

[本阶段产出的 task_context 字段]

## 路由规则

[本阶段到下一阶段的边条件]
`;
fs.writeFileSync(stageFile, stageTemplate);
console.log(`✓ wrote ${stageFile}`);

// 2. 改 lifecycle/graph.yaml 加节点
const graphFile = path.join(ROOT, 'lifecycle', 'graph.yaml');
let graph = fs.readFileSync(graphFile, 'utf8');
if (!graph.includes(`  - id: ${id}\n`)) {
  // 在 # 终态 之前插入
  graph = graph.replace(
    /(  # 终态)/,
    `  - id: ${id}\n    type: stage\n    ${executor === 'conductor' ? 'executor: conductor' : ''}\n\n$1`
  );
  fs.writeFileSync(graphFile, graph);
  console.log(`✓ updated ${graphFile}（加节点 ${id}）`);
}

// 3. 改 lifecycle/stages/README.md 加目录行
const readmeFile = path.join(ROOT, 'lifecycle', 'stages', 'README.md');
let readme = fs.readFileSync(readmeFile, 'utf8');
if (!readme.includes(`${id.toLowerCase()}.md`)) {
  readme = readme.replace(
    /(├──|└──) (delivering\.md)/,
    `$1 ${id.toLowerCase()}.md       # ${id.padEnd(10)} — ${executor} ${executor === 'conductor' ? '内建' : 'mount'}\n    $2`
  );
  fs.writeFileSync(readmeFile, readme);
  console.log(`✓ updated ${readmeFile}`);
}

console.log(`\n[完成] 新 stage "${id}" 已注册。建议:`);
console.log(`  1. 编辑 lifecycle/stages/${id.toLowerCase()}.md 完善输入/处理/输出/路由`);
console.log(`  2. 改 lifecycle/graph.yaml 加边（XX -> ${id} -> YY）`);
console.log(`  3. 跑 node scripts/lifecycle-doctor/index.mjs 验证`);
console.log(`  4. 跑 node scripts/transition-check.mjs scan-cleanup-009 --from ${id} --to DONE 测试流转`);
