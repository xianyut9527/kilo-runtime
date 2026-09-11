#!/usr/bin/env node
// build-derivations.mjs
// 编译时预生成静态派生数据：将 WRITE_MATRIX / graph / config 派生数据预生成为
// scripts/lib/.generated/derivations.json，供 task-context.mjs 用 fs.readFileSync
// 探测静态 JSON + JSON.parse 加载（失败回退 cachedDerive），避免每次脚本启动
// 全量扫描 agent/*.md + 解析 graph.yaml/config.yaml。
//
// 独立 CLI 入口：
//   node scripts/build-derivations.mjs           生成 derivations.json
//   node scripts/build-derivations.mjs --doctor-hook  生成 + 输出 [BUILD_DERIVATIONS] 摘要
//                                                     （供 lifecycle-doctor 集成触发，本脚本不修改 doctor）
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。
// 输出文件不入 git（.gitignore 已追加 scripts/lib/.generated/ 规则）。

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTierDefaults, parseTimeouts, parseHooks, parseThresholds, parseRecovery } from './lib/config-parser.mjs';
import { extractFrontmatter, extractTaskContextWrite } from './lib/frontmatter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'agent');
const GRAPH_PATH = path.join(ROOT, 'lifecycle', 'graph.yaml');
const CONFIG_PATH = path.join(ROOT, 'lifecycle', 'config.yaml');
const OUT_DIR = path.join(__dirname, 'lib', '.generated');
const OUT_FILE = path.join(OUT_DIR, 'derivations.json');
const DERIVATIONS_VERSION = 2;

// ============================================================
// 源文件内容摘要指纹（sha256 hex 截断 12 位；含增删：缺失标 MISSING）
// ============================================================
function sourceFingerprint(files) {
  const sorted = [...files].sort();
  const parts = [];
  for (const f of sorted) {
    let key;
    try {
      const content = fs.readFileSync(f);
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
      key = `${path.basename(f)}@${digest}`;
    } catch {
      key = `${path.basename(f)}@MISSING`;
    }
    parts.push(key);
  }
  return parts.join('|');
}

// frontmatter 解析与 task_context.write 提取统一走 scripts/lib/frontmatter.mjs（canonical）

function deriveWriteMatrix() {
  const matrix = {};
  let files;
  try {
    files = fs.readdirSync(AGENT_DIR);
  } catch {
    return matrix;
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -'.md'.length);
    let text;
    try {
      text = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
    } catch {
      continue;
    }
    const fm = extractFrontmatter(text);
    if (!fm) continue;
    const writes = extractTaskContextWrite(fm);
    if (writes.length > 0) matrix[name] = writes;
  }
  return matrix;
}

// ============================================================
// graph.yaml 拓扑：node ids + edges + executors
// ============================================================
function deriveGraph() {
  const nodes = [];
  const edges = [];
  const executors = {};
  let text;
  try {
    text = fs.readFileSync(GRAPH_PATH, "utf8");
  } catch {
    return { nodes, edges, executors };
  }
  let inNodes = false;
  let inEdges = false;
  let curId = null;
  let curEdge = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "");
    if (!line.trim()) continue;
    if (line.trim() === "nodes:") { inNodes = true; inEdges = false; continue; }
    if (line.trim() === "edges:") { inNodes = false; inEdges = true; continue; }
    if (inNodes) {
      const idm = line.match(/^\s*-\s*id\s*:\s*(\S+)\s*$/);
      if (idm) { curId = idm[1]; nodes.push(curId); continue; }
      const em = line.match(/^\s*executor\s*:\s*(\S+)\s*$/);
      if (em && curId) executors[curId] = em[1];
      continue;
    }
    if (inEdges) {
      const inline = line.match(/^\s*-\s*\{(.+)\}\s*$/);
      if (inline) {
        const e = {};
        for (const part of inline[1].split(",")) {
          const kv = part.match(/([a-z_]+)\s*:\s*(.+)$/);
          if (kv) e[kv[1].trim()] = kv[2].trim().replace(/^["\x27]|["\x27]$/g, "");
        }
        if (e.from && e.to) edges.push(e);
        continue;
      }
      const fromM = line.match(/^\s*-\s*from\s*:\s*(\S+)\s*$/);
      if (fromM) { curEdge = { from: fromM[1] }; continue; }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curEdge) {
        const [, key, val] = fm;
        curEdge[key] = val.trim().replace(/^["\x27]|["\x27]$/g, "");
        if (curEdge.from && curEdge.to) { edges.push(curEdge); curEdge = null; }
      }
      continue;
    }
  }
  return { nodes, edges, executors };
}

// ============================================================
// config.yaml 派生数据：tier_defaults / timeouts / hooks / size_check_threshold 等
// 解析器复用 scripts/lib/config-parser.mjs（单一来源，消除双份复制）
// ============================================================

function deriveConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    text = null;
  }
  const cfg = {
    tier_defaults: text ? parseTierDefaults(text) : { execution: {} },
    timeouts: text && /^\s*timeouts\s*:/m.test(text) ? parseTimeouts(text) : null,
    hooks: { max_total_cycles: 3 },
    size_check_threshold: 150000,
    dispatch_prompt_threshold: 4000,
    max_files_per_task: null,
    recovery: { max_write_retry: 1, overload_threshold: 3, circuit_breaker_overload: 5 },
  };
  if (text) {
    // hooks/thresholds/recovery 解析统一走 scripts/lib/config-parser.mjs（单一来源）
    cfg.hooks = { max_total_cycles: parseHooks(text, 3).max_total_cycles };
    const th = parseThresholds(text);
    cfg.size_check_threshold = th.size_check_threshold;
    cfg.dispatch_prompt_threshold = th.dispatch_prompt_threshold;
    cfg.max_files_per_task = th.max_files_per_task;
    cfg.recovery = parseRecovery(text);
  }
  return cfg;
}

// ============================================================
// 主构建
// ============================================================
function build() {
  const agentFiles = (() => {
    try {
      return fs.readdirSync(AGENT_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(AGENT_DIR, f));
    } catch {
      return [];
    }
  })();
  const srcFiles = [...agentFiles, GRAPH_PATH, CONFIG_PATH];
  const fingerprint = sourceFingerprint(srcFiles);

  const writeMatrix = deriveWriteMatrix();
  const graph = deriveGraph();
  const config = deriveConfig();

  const payload = {
    version: DERIVATIONS_VERSION,
    fingerprint,
    generated_at: new Date().toISOString(),
    writeMatrix,
    graph,
    config,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  try { fs.unlinkSync(OUT_FILE); } catch { /* 目标不存在则忽略 */ }
  try {
    fs.renameSync(tmp, OUT_FILE);
  } catch (err) {
    process.stderr.write(`[BUILD_DERIVATIONS] renameSync failed: ${err.message}\n`);
    process.exit(1);
  }

  return payload;
}

// ============================================================
// CLI 入口
// ============================================================
const DOCTOR_HOOK = process.argv.includes('--doctor-hook');
const payload = build();
const summary = `[BUILD_DERIVATIONS] version=${payload.version} writeMatrix=${Object.keys(payload.writeMatrix).length} graphNodes=${payload.graph.nodes.length} graphEdges=${payload.graph.edges.length} out=${path.relative(ROOT, OUT_FILE)}`;
process.stdout.write(summary + '\n');
if (DOCTOR_HOOK) {
  process.stdout.write(`[BUILD_DERIVATIONS] fingerprint=${payload.fingerprint}\n`);
}
process.exit(0);
