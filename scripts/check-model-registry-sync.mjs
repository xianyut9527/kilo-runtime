#!/usr/bin/env node
// check-model-registry-sync.mjs
// 防漂移脚本：校验 docs/model-registry.md 与 kilo.json 模型配置同步。
//
// 断言：
//   1. model-registry.md frontmatter models: 键集合 == kilo.json provider.hx.models 键集合（含 hx/ 前缀）
//   2. 决策记录表当前模型(kilo.json)列 == kilo.json agent.<name>.model
//      （conductor/coder/fixer/planner/verifier/plan-reviewer/reviewer/reverse-auditor）
//   3. small_model 行 == kilo.json 顶层 small_model
//
// 任一断言失败 → exit 1 + 打印漂移明细；全过 → exit 0 + "SYNC OK"
//
// 仅使用 Node 内置模块：node:fs / node:path / node:process / node:url
// 跨平台：Windows PowerShell 5.1 + Linux bash 兼容
// 用正则解析 model-registry.md 表格（参考 lifecycle/runtime/index.mjs 纯正则读 config.yaml 模式，不引入 yaml 库）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO_JSON_PATH = path.join(ROOT, 'kilo.json');
const REGISTRY_PATH = path.join(ROOT, 'docs', 'model-registry.md');

// 决策记录表 agent 键 → kilo.json agent 名（支持组合键）
const AGENT_KEY_MAP = {
  'conductor': ['conductor'],
  'coder': ['coder'],
  'fixer': ['fixer'],
  'planner/verifier': ['planner', 'verifier'],
  'planner': ['planner'],
  'verifier': ['verifier'],
  'plan-reviewer/reviewer': ['plan-reviewer', 'reviewer'],
  'plan-reviewer': ['plan-reviewer'],
  'reviewer': ['reviewer'],
  'reverse-auditor': ['reverse-auditor'],
};

// 自动派生：从 agent/*.md 动态读取（U3 恢复），过滤未绑定决策表的 agent
const AGENTS_DIR = path.join(ROOT, 'agent');
const UNBOUND_AGENTS = new Set(['analyst-1', 'analyst-2', 'analyst-3', 'analyst-critic', 'analyst-synthesizer']);
const REQUIRED_AGENTS = fs.readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .filter((a) => !UNBOUND_AGENTS.has(a));

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// 提取 frontmatter 块（--- ... ---）
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// 行级解析 frontmatter models: 键集合（支持无引号/带引号键，2 空格缩进）
function parseFrontmatterModels(fmText) {
  const models = new Set();
  const lines = fmText.split(/\r?\n/);
  let inModels = false;
  for (const line of lines) {
    if (/^models\s*:/.test(line)) { inModels = true; continue; }
    if (!inModels) continue;
    if (line && !/^\s/.test(line)) break; // 下一个顶层键
    const m = line.match(/^\s{2}["']?([^"':\s]+)["']?\s*:\s*$/);
    if (m) models.add(m[1]);
  }
  return models;
}

// 解析决策记录表：返回 { agentModel: Map<agentName, model>, smallModel: string|null }
function parseDecisionTable(text) {
  const agentModel = new Map();
  let smallModel = null;
  const lines = text.split(/\r?\n/);
  let inDecision = false;
  for (const line of lines) {
    // 章节切换：## 标题
    if (/^##\s/.test(line)) {
      inDecision = /当前模型绑定决策记录/.test(line);
      continue;
    }
    if (!inDecision) continue;
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!row) continue;
    const key = row[1].replace(/\([^)]*\)$/, '').trim();
    const model = row[2].trim();
    if (!model.startsWith('hx/')) continue;
    if (key === 'small_model') { smallModel = model; continue; }
    const mapped = AGENT_KEY_MAP[key];
    if (mapped) for (const a of mapped) agentModel.set(a, model);
  }
  return { agentModel, smallModel };
}

function main() {
  // 1. 读 kilo.json
  let kj;
  try {
    kj = JSON.parse(fs.readFileSync(KILO_JSON_PATH, 'utf8'));
  } catch (e) {
    die(1, '[DRIFT] kilo.json 解析失败: ' + e.message);
  }

  // kilo.json provider.*.models 键集合（含 provider 前缀）
  const kjModels = new Set();
  const provider = kj.provider || {};
  for (const [providerName, providerCfg] of Object.entries(provider)) {
    if (providerCfg && providerCfg.models && typeof providerCfg.models === 'object') {
      for (const modelId of Object.keys(providerCfg.models)) {
        kjModels.add(providerName + '/' + modelId);
      }
    }
  }

  // 2. 读 model-registry.md
  let text;
  try {
    text = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (e) {
    die(1, '[DRIFT] 无法读取 ' + REGISTRY_PATH + ': ' + e.message);
  }

  const drift = [];
  let nCheck = 0;

  // 3. 断言 1：frontmatter models 键集合
  const fm = extractFrontmatter(text);
  if (!fm) die(1, '[DRIFT] model-registry.md 缺 frontmatter 块');
  const docModels = parseFrontmatterModels(fm);
  nCheck++;
  for (const m of kjModels) if (!docModels.has(m)) drift.push('断言1: doc frontmatter 缺 ' + m + '（kilo.json 已注册）');
  for (const m of docModels) if (!kjModels.has(m)) drift.push('断言1: doc frontmatter 多 ' + m + '（kilo.json 未注册）');

  // 4. 断言 2 + 3：决策记录表
  const { agentModel, smallModel } = parseDecisionTable(text);
  nCheck++;
  for (const a of REQUIRED_AGENTS) {
    const docModel = agentModel.get(a);
    const kjModel = kj.agent && kj.agent[a] && kj.agent[a].model;
    if (docModel === undefined) drift.push('断言2: 决策表缺 ' + a + ' 行');
    else if (docModel !== kjModel) drift.push('断言2: ' + a + ' 表=' + docModel + ' vs kilo.json=' + kjModel);
  }
  nCheck++;
  if (smallModel === null) drift.push('断言3: 决策表缺 small_model 行');
  else if (smallModel !== kj.small_model) drift.push('断言3: small_model 表=' + smallModel + ' vs kilo.json=' + kj.small_model);

  // 5. 汇总
  if (drift.length === 0) {
    process.stdout.write('SYNC OK (' + nCheck + ' 断言, ' + REQUIRED_AGENTS.length + ' agents)\n');
    process.exit(0);
  }
  process.stdout.write('[DRIFT] ' + drift.length + ' 处漂移 (共 ' + nCheck + ' 断言):\n');
  for (const d of drift) process.stdout.write('  - ' + d + '\n');
  process.exit(1);
}

main();
