#!/usr/bin/env node
// index.mjs
// lifecycle 装配校验器 — 主调度入口
// 拆分自 scripts/lifecycle-doctor.mjs（U3 重组）
//
// 两种模式（正交，互不依赖）：
//   默认模式（静态）：校验 lifecycle/ + agent/ 文件互相一致
//     node scripts/lifecycle-doctor/index.mjs [--verbose]
//   --runtime 模式（运行时探针）：扫描 $TEMP/kilo/task_context_*.json
//     node scripts/lifecycle-doctor/index.mjs --runtime [--verbose]
//
// 架构正交三层：
//   lifecycle/graph.yaml        纯拓扑（节点 id/type/executor/on_fail + 边）
//   lifecycle/stages/<id>.md    阶段语义（执行逻辑 + frontmatter required_roles 契约）
//   agent/<name>.md             智能体（行为 + frontmatter mount/role/task_context）
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCheckFn, report, checkFingerprint, finalizeStaticRun } from './lib/util.mjs';
import { readText, parseGraphFile, parseConfig, extractFrontmatter, parseAgentFrontmatter } from './lib/parse.mjs';
import { run as runGraphMount } from './checks/graph-mount.mjs';
import { run as runRoleConfig } from './checks/role-config.mjs';
import { run as runSemantic } from './checks/semantic.mjs';
import { run as runMatrixDocsKilojsonScripts } from './checks/matrix-docs-kilojson-scripts.mjs';
import { run as runDecoupleAudit } from './checks/decouple-audit.mjs';
import { run as runPathNormalize } from './checks/path-normalize.mjs';
import { runRuntimeMode } from './runtime.mjs';

import { buildInitialContext as _bootstrapBuildInitialContext } from '../task-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const GRAPH_PATH = path.join(ROOT, 'lifecycle', 'graph.yaml');
const CONFIG_PATH = path.join(ROOT, 'lifecycle', 'config.yaml');
const STAGES_DIR = path.join(ROOT, 'lifecycle', 'stages');
const AGENT_DIR = path.join(ROOT, 'agent');
const KILO_JSON_PATH = path.join(ROOT, 'kilo.json');

const VERBOSE = process.argv.includes('--verbose');
const RUNTIME = process.argv.includes('--runtime');
const SYNC_PROMPT = process.argv.includes('--sync');
const FAST_MODE = process.argv.includes('--fast');
const FULL_MODE = process.argv.includes('--full');

const NODE_ON_FAIL = new Set(['abort', 'retry_once', 'degrade', 'escalate', 'pause']);
const MOUNT_ON_FAIL = new Set(['abort', 'warn', 'skip', 'degrade']);
const TIERS = new Set(['T0', 'T1', 'T2']);

// ============================================================
// 启动调度
// ============================================================

if (RUNTIME) {
  runRuntimeMode({ ROOT, SCRIPTS_DIR, GRAPH_PATH, STAGES_DIR, _bootstrapBuildInitialContext });
  process.exit(0);
}

if (FAST_MODE) {
  const fp = checkFingerprint(ROOT);
  if (fp.match) {
    process.stdout.write(`CACHE_HIT ${fp.fingerprint}\n`);
    process.stdout.write('SUMMARY: 0 PASS / 0 FAIL / 0 WARN (fingerprint cache)\n');
    process.exit(0);
  }
  if (VERBOSE) process.stdout.write(`CACHE_MISS ${fp.reason}\n`);
}

if (SYNC_PROMPT && FAST_MODE && checkFingerprint(ROOT).match) {
  process.stdout.write('CACHE_HIT but --sync requested; running full checks + prompt sync\n');
}

// 完整静态检查：构建 ctx + 调度各 check 模块 + report
const cf = createCheckFn();

// 加载 graph.yaml
const graphText = readText(GRAPH_PATH);
if (!graphText) {
  cf.fail('input.graph', `无法读取 ${GRAPH_PATH}`);
  report(cf, VERBOSE, { fullMode: FULL_MODE, fastMode: FAST_MODE, syncPrompt: SYNC_PROMPT, scriptsDir: SCRIPTS_DIR, root: ROOT });
}
const graph = parseGraphFile(graphText);
cf.pass('input.graph', `${graph.nodes.size} nodes / ${graph.edges.length} edges`);

// 加载 config.yaml
const cfgText = readText(CONFIG_PATH);
const cfg = cfgText ? parseConfig(cfgText) : null;
if (cfg) cf.pass('input.config', `tiers: ${[...cfg.tierAgents.keys()].join(',')}`);
else cf.fail('input.config', `无法读取 ${CONFIG_PATH}`);

// 加载全部 agent frontmatter
const agents = new Map();
for (const file of fs.readdirSync(AGENT_DIR)) {
  if (!file.endsWith('.md')) continue;
  const name = file.slice(0, -3);
  const text = readText(path.join(AGENT_DIR, file));
  if (!text) continue;
  const fm = extractFrontmatter(text);
  if (!fm) { cf.fail(`agent.${name}.frontmatter`, '缺 frontmatter 块'); continue; }
  agents.set(name, parseAgentFrontmatter(fm));
}
cf.pass('input.agents', `${agents.size} 个 agent frontmatter 已解析`);

// 注入 ctx
const ctx = {
  cf,
  graph,
  cfg,
  cfgText,
  agents,
  VERBOSE,
  RUNTIME,
  SYNC_PROMPT,
  FAST_MODE,
  FULL_MODE,
  ROOT,
  SCRIPTS_DIR,
  GRAPH_PATH,
  CONFIG_PATH,
  STAGES_DIR,
  AGENT_DIR,
  KILO_JSON_PATH,
  NODE_ON_FAIL,
  MOUNT_ON_FAIL,
  TIERS,
};

// 调度各 check 模块（顺序保持原脚本语义）
runGraphMount(ctx);
runRoleConfig(ctx);
runSemantic(ctx);
runMatrixDocsKilojsonScripts(ctx);
runDecoupleAudit(ctx);
runPathNormalize(ctx);

// 收尾：缓存 / 同步 prompt / 报告
report(cf, VERBOSE, { fullMode: FULL_MODE, fastMode: FAST_MODE, syncPrompt: SYNC_PROMPT, scriptsDir: SCRIPTS_DIR, root: ROOT });
