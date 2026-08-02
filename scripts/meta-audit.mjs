#!/usr/bin/env node
// meta-audit.mjs — 元审计脚本：死引用扫描 / 重复规则检测 / doc drift 审计 / 健康度评分
// 纯 Node 内置模块，无外部依赖。exit 0 = 健康，exit 1 = 发现问题。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// ===== 1. 死引用扫描 =====
function scanDeadRefs() {
  const issues = [];
  const scanDirs = ['agent', 'lifecycle/stages', '.kilo/instructions'];
  const refPattern = /`([^`]+\.(?:md|yaml|json|mjs|sql|ps1|sh))`/g;

  // Common path aliases: references that resolve to known locations
  const pathAliases = {
    'core.md': '.kilo/instructions/core.md',
    'workflow-core.md': '.kilo/instructions/workflow-core.md',
    'reflection.md': '.kilo/instructions/reflection.md',
    'security-checklist.md': '.kilo/instructions/security-checklist.md',
    'output-schema.md': '.kilo/instructions/output-schema.md',
    'evolution.md': '.kilo/instructions/evolution.md',
    'skill-upgrade.md': '.kilo/instructions/skill-upgrade.md',
    'skill-usage-tracking.md': '.kilo/instructions/skill-usage-tracking.md',
    'skills-lifecycle.md': '.kilo/instructions/skills-lifecycle.md',
    'workflow-reference.md': '.kilo/instructions/workflow-reference.md',
    'guardrails.md': '.kilo/instructions/guardrails.md',
    'memory-ops.md': 'docs/memory-ops-reference.md',
    'memory-ops-reference.md': 'docs/memory-ops-reference.md',
    'MEMORY.md': '.kilo/memory/README.md',
    'USER.md': '.kilo/memory/README.md',
    'lifecycle/capabilities.yaml': 'lifecycle/config.yaml',
    'contracts/health_check.sql': '.kilo/memory/contracts/health_check.sql',
    'schema/init.sql': '.kilo/memory/schema/init.sql',
    'init.sql': '.kilo/memory/schema/init.sql',
    'planning.md': 'lifecycle/stages/planning.md',
    'executing.md': 'lifecycle/stages/executing.md',
    'intent.md': 'lifecycle/stages/intent.md',
    'sizing.md': 'lifecycle/stages/sizing.md',
    'quality.md': 'lifecycle/stages/quality.md',
    'delivering.md': 'lifecycle/stages/delivering.md',
    'parallel_execution.md': 'lifecycle/stages/parallel_execution.md',
    'synthesizing.md': 'lifecycle/stages/synthesizing.md',
    'graph.yaml': 'lifecycle/graph.yaml',
    'config.yaml': 'lifecycle/config.yaml',
    'transition-check.mjs': 'scripts/transition-check.mjs',
    'task-context.mjs': 'scripts/task-context.mjs',
    'lifecycle-doctor.mjs': 'scripts/lifecycle-doctor.mjs',
    'scan-encoding.mjs': 'scripts/scan-encoding.mjs',
    'sync-agent-prompt.mjs': 'scripts/sync-agent-prompt.mjs',
    'agent-mount-guide.md': 'docs/agent-mount-guide.md',
    'model-registry.md': 'docs/model-registry.md',
    'conductor.md': 'agent/conductor.md',
    'planner.md': 'agent/planner.md',
    'coder.md': 'agent/coder.md',
    'verifier.md': 'agent/verifier.md',
    'reviewer.md': 'agent/reviewer.md',
    'fixer.md': 'agent/fixer.md',
    'reverse-auditor.md': 'agent/reverse-auditor.md',
    'side-checker.md': 'agent/side-checker.md',
    'plan-reviewer.md': 'agent/plan-reviewer.md',
    'meta-auditor.md': 'agent/meta-auditor.md',
    'multiModel.md': 'archive/agents/multiModel.md',
    'planner-a.md': 'archive/agents/planner-a.md',
    'planner-b.md': 'archive/agents/planner-b.md',
    'planner-c.md': 'archive/agents/planner-c.md',
  };

  for (const dir of scanDirs) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir, { recursive: true }).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(fullDir, file);
      const text = readText(filePath);
      if (!text) continue;
      const matches = [...text.matchAll(refPattern)];
      for (const m of matches) {
        const ref = m[1];
        if (ref.startsWith('http') || ref.startsWith('/')) continue;
        // Skip command-like references (contain spaces or start with node/sqlite3)
        if (/\s/.test(ref) || ref.startsWith('node ') || ref.startsWith('sqlite3 ')) continue;
        // Skip template placeholders
        if (ref.includes('<') || ref.includes('>') || ref.includes('*') || ref.includes('节点')) continue;

        // Try alias first
        const aliasTarget = pathAliases[ref];
        if (aliasTarget && fs.existsSync(path.join(ROOT, aliasTarget))) continue;

        // Try relative to file's directory
        const fileDir = path.dirname(filePath);
        if (fs.existsSync(path.join(fileDir, ref))) continue;

        // Try relative to ROOT
        if (fs.existsSync(path.join(ROOT, ref))) continue;

        // Try common prefixes
        const prefixes = ['.kilo/instructions/', 'lifecycle/stages/', 'lifecycle/', 'docs/', 'scripts/', 'agent/', '.kilo/memory/', '.kilo/memory/schema/'];
        let found = false;
        for (const prefix of prefixes) {
          if (fs.existsSync(path.join(ROOT, prefix + ref))) { found = true; break; }
        }
        if (found) continue;

        issues.push({ file: path.relative(ROOT, filePath), ref, line: text.slice(0, m.index).split('\n').length });
      }
    }
  }
  return issues;
}

// ===== 2. 重复规则检测 =====
function scanDuplicateRules() {
  const issues = [];
  const files = [
    '.kilo/instructions/core.md',
    '.kilo/instructions/workflow-core.md',
    '.kilo/instructions/reflection.md',
  ];

  const rules = new Map(); // ruleText -> [{file, line}]
  for (const file of files) {
    const text = readText(path.join(ROOT, file));
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match numbered rules or bullet rules
      if (/^\d+\.\s+\*\*/.test(line) || /^-\s+\*\*/.test(line)) {
        const key = line.replace(/\*\*/g, '').slice(0, 80);
        if (!rules.has(key)) rules.set(key, []);
        rules.get(key).push({ file, line: i + 1 });
      }
    }
  }

  for (const [key, occurrences] of rules) {
    if (occurrences.length > 1) {
      issues.push({ rule: key.slice(0, 60), files: occurrences.map(o => `${o.file}:${o.line}`) });
    }
  }
  return issues;
}

// ===== 3. doc drift 审计 =====
function scanDocDrift() {
  const issues = [];
  const readmeText = readText(path.join(ROOT, 'README.md'));
  if (!readmeText) return issues;

  const lines = readmeText.split('\n');
  const prefixStack = []; // [{indent, prefix}]
  const treeRefs = [];

  for (const line of lines) {
    // Find the tree-drawing character position
    const treeMatch = line.match(/^([│ ]*)([├└])──\s+(\S+)/);
    if (!treeMatch) continue;
    const [, prefix, , name] = treeMatch;
    const indent = prefix.length;

    // Pop stack to current indent level
    while (prefixStack.length > 0 && prefixStack[prefixStack.length - 1].indent >= indent) {
      prefixStack.pop();
    }
    const parentPrefix = prefixStack.length > 0 ? prefixStack[prefixStack.length - 1].prefix : '';

    // Directory entry: name ends with /
    if (name.endsWith('/')) {
      prefixStack.push({ indent, prefix: parentPrefix + name });
      continue;
    }

    // File entry
    if (name === '...' || name.startsWith('(') || name.startsWith('#') || !name.includes('.')) continue;
    treeRefs.push(parentPrefix + name);
  }

  for (const ref of treeRefs) {
    if (!fs.existsSync(path.join(ROOT, ref))) {
      issues.push({ ref, status: 'MISSING' });
    }
  }
  return issues;
}

// ===== 4. 健康度评分 =====
function computeScore(deadRefs, dupRules, docDrifts) {
  let score = 100;
  score -= deadRefs.length * 5;
  score -= dupRules.length * 3;
  score -= docDrifts.length * 5;
  return Math.max(0, Math.min(100, score));
}

// ===== Main =====
const deadRefs = scanDeadRefs();
const dupRules = scanDuplicateRules();
const docDrifts = scanDocDrift();
const score = computeScore(deadRefs, dupRules, docDrifts);

let exitCode = 0;

if (deadRefs.length > 0) {
  console.log(`[DEAD_REFS] ${deadRefs.length} 个死引用:`);
  for (const d of deadRefs) console.log(`  ${d.file}:${d.line} → \`${d.ref}\``);
  exitCode = 1;
}

if (dupRules.length > 0) {
  console.log(`[DUP_RULES] ${dupRules.length} 组重复规则:`);
  for (const d of dupRules) console.log(`  "${d.rule}" → ${d.files.join(', ')}`);
  exitCode = 1;
}

if (docDrifts.length > 0) {
  console.log(`[DOC_DRIFT] ${docDrifts.length} 处文档漂移:`);
  for (const d of docDrifts) console.log(`  ${d.ref}: ${d.status}`);
  exitCode = 1;
}

console.log(`[SCORE] 健康度: ${score}/100 (死引用:${deadRefs.length} 重复规则:${dupRules.length} 文档漂移:${docDrifts.length})`);

if (exitCode === 0) console.log('[PASS] 元审计通过');
process.exit(exitCode);
