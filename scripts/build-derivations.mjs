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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'agent');
const GRAPH_PATH = path.join(ROOT, 'lifecycle', 'graph.yaml');
const CONFIG_PATH = path.join(ROOT, 'lifecycle', 'config.yaml');
const OUT_DIR = path.join(__dirname, 'lib', '.generated');
const OUT_FILE = path.join(OUT_DIR, 'derivations.json');
const DERIVATIONS_VERSION = 1;

// ============================================================
// 源文件 mtime 指纹（含增删：缺失标 MISSING）
// ============================================================
function sourceFingerprint(files) {
  const sorted = [...files].sort();
  const parts = [];
  for (const f of sorted) {
    let key;
    try {
      const st = fs.statSync(f);
      key = `${path.basename(f)}@${st.mtimeMs}`;
    } catch {
      key = `${path.basename(f)}@MISSING`;
    }
    parts.push(key);
  }
  return parts.join('|');
}

// ============================================================
// frontmatter 提取 + task_context.write 解析（与 task-context.mjs 语义一致）
// ============================================================
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function extractTaskContextWrite(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  let inTaskContext = false;
  let inWrite = false;
  const items = [];
  for (const line of lines) {
    if (/^[^\s#]/.test(line)) {
      if (inTaskContext) break;
      inTaskContext = /^task_context\s*:/.test(line);
      continue;
    }
    if (!inTaskContext) continue;
    const inline = line.match(/^\s+write\s*:\s*\[(.*)\]\s*(?:#.*)?$/);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const v = part.trim().replace(/^["']|["']$/g, '');
        if (v) items.push(v);
      }
      inWrite = false;
      continue;
    }
    if (/^\s+write\s*:\s*$/.test(line)) {
      inWrite = true;
      continue;
    }
    if (inWrite) {
      const li = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
      if (li) {
        items.push(li[1]);
        continue;
      }
      inWrite = false;
    }
  }
  return items;
}

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
// 复用 task-context-runtime.mjs 的解析语义（自包含，不 import 运行时层）
// ============================================================
function parseTierDefaults(text) {
  const result = { execution: {} };
  const lines = text.split(/\r?\n/);
  let section = null;
  let curTier = null;
  let inAgents = false;
  let curAgents = null;
  let curReviewMode = null;
  let curProvider = null;

  function flush() {
    if (curTier && section) {
      const entry = { agents: curAgents || {}, review_mode: curReviewMode || 'none' };
      if (curProvider) entry.provider = curProvider;
      result[section][curTier] = entry;
    }
    curAgents = null;
    curReviewMode = null;
    curProvider = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;
    if (/^tier_defaults\s*:/.test(line)) { flush(); section = 'execution'; curTier = null; inAgents = false; continue; }
    if (/^(overrides|convergence|hooks|timeouts|tier_escalation)\s*:/.test(line)) { flush(); section = null; curTier = null; inAgents = false; continue; }
    if (!section) continue;
    const tierM = line.match(/^  (T[0-3])\s*:\s*$/);
    if (tierM) { flush(); curTier = tierM[1]; inAgents = false; continue; }
    if (!curTier) continue;
    const agentsStart = line.match(/^    agents\s*:\s*$/);
    if (agentsStart) { inAgents = true; curAgents = {}; continue; }
    const agentsInline = line.match(/^    agents\s*:\s*\{(.*)\}\s*$/);
    if (agentsInline) { inAgents = false; curAgents = {}; continue; }
    if (inAgents) {
      const agentM = line.match(/^      ([a-z_]+)\s*:\s*(true|false)\s*$/);
      if (agentM) { curAgents[agentM[1]] = agentM[2] === 'true'; continue; }
      if (!/^ {6,}/.test(line) && line.trim()) inAgents = false;
    }
    const rmM = line.match(/^    review_mode\s*:\s*(\w+)\s*$/);
    if (rmM) { inAgents = false; curReviewMode = rmM[1]; continue; }
    const provM = line.match(/^    provider\s*:\s*(\w+)\s*$/);
    if (provM) { curProvider = provM[1]; continue; }
  }
  flush();
  return result;
}

function parseTimeouts(text) {
  const lines = text.split(/\r?\n/);
  let inTimeouts = false;
  let inPerAgent = false;
  let inPerTier = false;
  let inRetry = false;
  const t = {
    agent_startup_s: null,
    stage_default_s: null,
    per_agent_s: {},
    per_tier_multiplier: {},
    agent_timeout_max_retries: null,
  };
  for (const raw of lines) {
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;
    if (/^timeouts\s*:/.test(line)) { inTimeouts = true; inPerAgent = false; inPerTier = false; inRetry = false; continue; }
    if (/^[a-z_]+\s*:/.test(line) && !/^\s/.test(line)) { inTimeouts = false; inPerAgent = false; inPerTier = false; inRetry = false; continue; }
    if (!inTimeouts) continue;
    const sub = line.match(/^  ([a-z_]+)\s*:\s*(.*)$/);
    if (sub) {
      const key = sub[1];
      const val = sub[2].trim();
      if (key === 'per_agent_s') { inPerAgent = true; inPerTier = false; inRetry = false; continue; }
      if (key === 'per_tier_multiplier') { inPerTier = true; inPerAgent = false; inRetry = false; continue; }
      if (key === 'retry') { inRetry = true; inPerAgent = false; inPerTier = false; continue; }
      inPerAgent = false; inPerTier = false; inRetry = false;
      if (key === 'agent_startup_s' && /^\d+$/.test(val)) t.agent_startup_s = parseInt(val, 10);
      if (key === 'stage_default_s' && /^\d+$/.test(val)) t.stage_default_s = parseInt(val, 10);
      continue;
    }
    if (inPerAgent) {
      const m = line.match(/^    ([a-z_]+)\s*:\s*(\d+)\s*$/);
      if (m) { t.per_agent_s[m[1]] = parseInt(m[2], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) inPerAgent = false;
    }
    if (inPerTier) {
      const m = line.match(/^    (T[0-3])\s*:\s*([\d.]+)\s*$/);
      if (m) { t.per_tier_multiplier[m[1]] = parseFloat(m[2]); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) inPerTier = false;
    }
    if (inRetry) {
      const m = line.match(/^    agent_timeout_max_retries\s*:\s*(\d+)\s*$/);
      if (m) { t.agent_timeout_max_retries = parseInt(m[1], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) inRetry = false;
    }
  }
  return t;
}

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
    hooks: { max_total_cycles: 7, auto_fix: true },
    size_check_threshold: 120000,
    dispatch_prompt_threshold: 3000,
    max_files_per_task: null,
    recovery: { max_write_retry: 1, overload_threshold: 3, circuit_breaker_overload: 5 },
  };
  if (text) {
    const mtc = text.match(/max_total_cycles:\s*(\d+)/);
    if (mtc) cfg.hooks.max_total_cycles = parseInt(mtc[1], 10);
    const af = text.match(/auto_fix:\s*(true|false)/);
    if (af) cfg.hooks.auto_fix = af[1] === 'true';
    const sct = text.match(/size_check_threshold:\s*(\d+)/);
    if (sct) cfg.size_check_threshold = parseInt(sct[1], 10);
    const dpt = text.match(/dispatch_prompt_threshold:\s*(\d+)/);
    if (dpt) cfg.dispatch_prompt_threshold = parseInt(dpt[1], 10);
    const mf = text.match(/max_files_per_task:\s*(\d+)/);
    if (mf) cfg.max_files_per_task = parseInt(mf[1], 10);
    const mw = text.match(/max_write_retry:\s*(\d+)/);
    const ot = text.match(/overload_threshold:\s*(\d+)/);
    const cb = text.match(/circuit_breaker_overload:\s*(\d+)/);
    if (mw) cfg.recovery.max_write_retry = parseInt(mw[1], 10);
    if (ot) cfg.recovery.overload_threshold = parseInt(ot[1], 10);
    if (cb) cfg.recovery.circuit_breaker_overload = parseInt(cb[1], 10);
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
