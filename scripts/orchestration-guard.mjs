#!/usr/bin/env node
// orchestration-guard.mjs — 编排合规门：防 conductor 绕过编排直接改 governance 文件
// 纯 Node 内置模块，无外部依赖。exit 0 = 合规/无变更，exit 1 = 检测到绕过（--strict）。
// 用法：
//   node scripts/orchestration-guard.mjs              → 默认 warn 模式（绕过仅警告，exit 0）
//   node scripts/orchestration-guard.mjs --strict     → 严格模式（绕过即 fail，exit 1）
//   node scripts/orchestration-guard.mjs --list-only  → 仅列出 governance 变更文件
//   node scripts/orchestration-guard.mjs --install-hook → 安装 git pre-commit hook（幂等）
//   node scripts/orchestration-guard.mjs --help       → 显示帮助

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const LIST_ONLY = args.includes('--list-only');
const INSTALL_HOOK = args.includes('--install-hook');
const HELP = args.includes('--help');

const TMP_DIR = path.join(os.tmpdir(), 'kilo');
const NOW_MS = Date.now();
// 12h 窗口：收窄活跃调度窗口，提高伪造时间戳的成本
const WINDOW_12H_MS = 12 * 60 * 60 * 1000; // 43200000

// ─── 动态生成 LEGAL_AGENTS：扫描 agent/*.md frontmatter name 字段 ───
// 对每个智能体同时生成连字符原名与下划线变体，覆盖 dispatch_log 两种命名惯例。
// 扫描失败时回退硬编码默认集合，确保 fail-safe。
function deriveLegalAgents() {
  const agentDir = path.resolve(__dirname, '..', 'agent');
  const names = [];
  let files;
  try {
    files = fs.readdirSync(agentDir);
  } catch {
    console.warn('[ORCHESTRATION_GUARD_WARN] Cannot read agent/ directory, falling back to hardcoded LEGAL_AGENTS');
    return null;
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(agentDir, file);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    // 提取 frontmatter 中的 name 字段（首个 --- ... --- 之间）
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = fmMatch ? fmMatch[1] : null;
    let agentName = null;
    if (fm) {
      const nameMatch = fm.match(/^name:\s*(.+?)\s*$/m);
      if (nameMatch) agentName = nameMatch[1].trim();
    }
    // 无 name 字段则回退文件名（去 .md 后缀）
    if (!agentName) agentName = file.slice(0, -'.md'.length);
    names.push(agentName);
  }
  if (names.length === 0) {
    console.warn('[ORCHESTRATION_GUARD_WARN] No agents found, falling back to hardcoded LEGAL_AGENTS');
    return null;
  }
  const set = new Set();
  for (const name of names) {
    set.add(name);
    set.add(name.replace(/-/g, '_'));
  }
  return set;
}

const LEGAL_AGENTS = deriveLegalAgents() || new Set([
  'planner', 'plan-reviewer', 'plan_reviewer',
  'coder',
  'verifier',
  'reverse-auditor', 'reverse_auditor',
  'side-checker', 'side_checker',
  'reviewer',
  'fixer',
  'conductor',
  'meta-auditor', 'meta_auditor',
]);

// ─── 动态生成 LEGAL_STAGES：lifecycle/graph.yaml 节点 ID + agent mount at 值 ───
// 读 graph.yaml 节点 ID 集合 + 扫描 agent/*.md mount[].at 值，消除硬编码漂移。
// 扫描失败时回退硬编码默认集合。
function deriveLegalStages() {
  const stages = new Set();

  // 1. 读取 graph.yaml 节点 ID（与 task-context.mjs readGraphNodeIds 逻辑一致）
  const graphPath = path.resolve(__dirname, '..', 'lifecycle', 'graph.yaml');
  let graphText;
  try {
    graphText = fs.readFileSync(graphPath, 'utf8');
  } catch {
    console.warn('[ORCHESTRATION_GUARD_WARN] Cannot read lifecycle/graph.yaml, falling back to hardcoded LEGAL_STAGES');
    return null;
  }
  let inNodes = false;
  for (const raw of graphText.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line) continue;
    if (line === 'nodes:') { inNodes = true; continue; }
    if (line === 'edges:') { inNodes = false; continue; }
    if (inNodes) {
      const m = line.match(/^-\s*id\s*:\s*(\S+)\s*$/);
      if (m) stages.add(m[1]);
    }
  }

  // 2. 扫描 agent/*.md frontmatter mount[].at 值（如 post:PLANNING / on:done）
  const agentDir = path.resolve(__dirname, '..', 'agent');
  let files;
  try {
    files = fs.readdirSync(agentDir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(agentDir, file), 'utf8');
    } catch {
      continue;
    }
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    // 匹配 mount 块中的 at 值：`  - at: QUALITY` 或 `  at: post:PLANNING`
    const atMatches = fm.matchAll(/^\s*-?\s*at\s*:\s*(\S+)\s*$/gm);
    for (const m of atMatches) {
      stages.add(m[1]);
    }
  }

  return stages;
}

const LEGAL_STAGES = deriveLegalStages() || new Set([
  'INTENT', 'SIZING', 'PLANNING', 'EXECUTING',
  'PARALLEL_EXECUTION', 'SYNTHESIZING',
  'QUALITY', 'DELIVERING', 'DONE',
  'post:PLANNING', 'post:DELIVERING',
]);

// ─── 1. Git quotepath 解码 ───
// git core.quotepath=true 时非 ASCII 字符被转义为 \ooo 八进制序列
function decodeGitPath(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }
  return raw;
}

// ─── 2. 解析 git status --porcelain ───
// 格式: XY PATH | XY "PATH" | R  OLD -> NEW | C  OLD -> NEW
// XY: index-status worktree-status, 各为 [MADRCU?! ] 之一
function parseGitStatus(output) {
  const files = [];
  const lines = output.split('\n').filter(Boolean);
  for (const line of lines) {
    // 重命名/复制：R  old -> new
    const renameMatch = line.match(/^[RC]\d*\s+.+? -> (.+)$/);
    if (renameMatch) {
      files.push(decodeGitPath(renameMatch[1].trim()));
      continue;
    }
    // XY path: 取第3个字符之后的所有内容（跳过2状态字符+1空格）
    if (line.length > 3) {
      const rest = line.substring(3).trim();
      if (rest) files.push(decodeGitPath(rest));
    }
  }
  return files;
}

// ─── 3. 判断 governance 文件 ───
// .md / .yaml / .json 或位于 agent/ lifecycle/ 目录下
function isGovernanceFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.yaml') || lower.endsWith('.json')) return true;
  if (normalized.startsWith('agent/') || normalized.startsWith('lifecycle/')) return true;
  return false;
}

// ─── 4. 检测活跃 dispatch ───
// 遍历 os.tmpdir()/kilo/task_context_*.json，要求 dispatch_log 条目同时满足：
//   - timestamp 在 12h 窗口内
//   - agent ∈ LEGAL_AGENTS（若字段存在）
//   - stage ∈ LEGAL_STAGES（若字段存在）
// 残差风险：本方案无密钥基础设施，无法做密码学签名校验；攻击者仍可构造合法字段的伪造
// task_context 文件。此增强仅提高伪造成本（需了解合法 agent/stage 枚举），不提供密码学保证。
// 未来若有 key mgmt 基础设施，可升级为 HMAC-SHA256 签名校验。
function hasActiveDispatch() {
  if (!fs.existsSync(TMP_DIR)) return false;
  let entries;
  try {
    entries = fs.readdirSync(TMP_DIR);
  } catch {
    return false;
  }
  const ctxFiles = entries.filter(f => f.startsWith('task_context_') && f.endsWith('.json'));
  for (const file of ctxFiles) {
    try {
      const raw = fs.readFileSync(path.join(TMP_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      const dispatchLog = data.dispatch_log;
      if (!Array.isArray(dispatchLog) || dispatchLog.length === 0) continue;
      for (const entry of dispatchLog) {
        const ts = entry.timestamp;
        if (typeof ts !== 'number' || (NOW_MS - ts) >= WINDOW_12H_MS) continue;
        // 增强活跃判定：若 agent 字段存在，必须属于合法集合
        if (entry.agent !== undefined && !LEGAL_AGENTS.has(entry.agent)) continue;
        // 增强活跃判定：若 stage 字段存在，必须属于合法集合
        if (entry.stage !== undefined && !LEGAL_STAGES.has(entry.stage)) continue;
        return true;
      }
    } catch {
      // 跳过解析失败/无权限的文件
    }
  }
  return false;
}

// ─── 5. --help ───
if (HELP) {
  console.log(`orchestration-guard.mjs — 编排合规门

用法:
  node scripts/orchestration-guard.mjs [选项]

选项:
  --strict       严格模式：检测到绕过时 exit 1（用于 CI/pre-commit hook）
  --list-only    仅列出变更的 governance 文件，不检查编排合规
  --install-hook 安装 git pre-commit hook（幂等：已存在同名内容则跳过）
  --help         显示此帮助

行为:
  - 检测 git working tree 中变更的 governance 文件（.md/.yaml/.json、agent/*、lifecycle/*）
  - 查找 ${TMP_DIR}/task_context_*.json 中的活跃 dispatch_log（12h 窗口）
  - 有活跃调度 → PASS；无活跃调度 → BYPASS
  - 默认模式：BYPASS 仅输出警告，exit 0（避免 CI 误伤）
  - --strict 模式：BYPASS 输出错误，exit 1
  - --install-hook 生成的 hook 自动使用 --strict 模式`);
  process.exit(0);
}

// ─── 6. --install-hook ───
if (INSTALL_HOOK) {
  let gitDir;
  try {
    gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    console.error('[ORCHESTRATION_GUARD_ERR] Not a git repository, cannot install hook');
    process.exit(1);
  }

  const hookDir = path.resolve(process.cwd(), gitDir, 'hooks');
  if (!fs.existsSync(hookDir)) {
    fs.mkdirSync(hookDir, { recursive: true });
  }

  const hookPath = path.join(hookDir, 'pre-commit');
  const hookContent = `#!/bin/sh
# Auto-generated by orchestration-guard.mjs --install-hook
# 阻断未编排的 governance 文件变更提交
REPO_ROOT=$(git rev-parse --show-toplevel)
node "$REPO_ROOT/scripts/orchestration-guard.mjs" --strict
`;

  // 幂等：已存在同名内容则跳过
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing === hookContent) {
      console.log('[ORCHESTRATION_GUARD_HOOK] pre-commit hook already installed (identical content), skip');
      process.exit(0);
    }
    console.warn('[ORCHESTRATION_GUARD_HOOK] pre-commit hook exists with different content, overwriting...');
  }

  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  console.log('[ORCHESTRATION_GUARD_HOOK] pre-commit hook installed: ' + hookPath);
  process.exit(0);
}

// ─── 7. Main ───
let gitOut;
try {
  gitOut = execSync('git status --porcelain', {
    encoding: 'utf8',
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error('[ORCHESTRATION_GUARD_ERR] git status 执行失败:', e.message);
  process.exit(1);
}

const allFiles = parseGitStatus(gitOut);
const govFiles = allFiles.filter(isGovernanceFile);

// --list-only: 仅输出清单
if (LIST_ONLY) {
  if (govFiles.length === 0) {
    console.log('(no governance file changes)');
  } else {
    for (const f of govFiles) console.log(f);
  }
  console.log(`\nTotal governance files: ${govFiles.length}`);
  process.exit(0);
}

// 无 governance 变更 → PASS
if (govFiles.length === 0) {
  console.log('[ORCHESTRATION_GUARD_PASS] No governance file changes detected');
  process.exit(0);
}

// 有活跃 dispatch → PASS（通过 conductor 编排）
if (hasActiveDispatch()) {
  console.log(`[ORCHESTRATION_GUARD_PASS] ${govFiles.length} governance file(s) changed with active conductor dispatch`);
  process.exit(0);
}

// 有变更但无活跃 dispatch → 绕过
const header = `[ORCHESTRATION_BYPASS] ${govFiles.length} governance file(s) changed without active conductor dispatch:`;
console.error(header);
for (const f of govFiles) console.error(`  ${f}`);

if (STRICT) {
  process.exit(1);
}

console.warn('[ORCHESTRATION_GUARD_WARN] Running in default warn mode — bypass allowed (use --strict for hard fail)');
process.exit(0);
