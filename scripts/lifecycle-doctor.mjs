#!/usr/bin/env node
// lifecycle-doctor.mjs
// 生命周期装配校验器 — conductor.md §启动期装配 第 4 条的机械化实现。
//
// 架构正交三层：
//   lifecycle/graph.yaml        纯拓扑（节点 id/type/executor/on_fail + 边）——稳定大框架，零智能体名
//   lifecycle/stages/<id>.md    阶段语义（执行逻辑 + frontmatter required_roles 契约）
//   agent/<name>.md             智能体（行为 + frontmatter mount/role/task_context）——丢文件即注册
//
// 用法：
//   node scripts/lifecycle-doctor.mjs [--verbose]
// 退出码：
//   0 = 全 PASS（WARN 不阻塞）
//   1 = 有 FAIL（对应 [ASSEMBLY_FAIL]）
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。
// 与 task-context.mjs 共享 frontmatter 解析逻辑（本地副本，脚本自包含）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'lifecycle', 'graph.yaml');
const SUBGRAPH_PATH = path.join(ROOT, 'lifecycle', 'multimodel-graph.yaml');
const CONFIG_PATH = path.join(ROOT, 'lifecycle', 'config.yaml');
const STAGES_DIR = path.join(ROOT, 'lifecycle', 'stages');
const AGENT_DIR = path.join(ROOT, 'agent');

const VERBOSE = process.argv.includes('--verbose');

const NODE_ON_FAIL = new Set(['abort', 'retry_once', 'degrade', 'escalate', 'pause']);
// 挂载点 on_fail：abort 中止流转 / warn 告警放行 / skip 静默跳过 / degrade 跳过+标 DEGRADED（可选视角）
const MOUNT_ON_FAIL = new Set(['abort', 'warn', 'skip', 'degrade']);
const TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

const results = []; // { level: 'PASS'|'FAIL'|'WARN', name, detail }

function check(level, name, detail = '') {
  results.push({ level, name, detail });
}
function pass(name, detail = '') { check('PASS', name, detail); }
function fail(name, detail = '') { check('FAIL', name, detail); }
function warn(name, detail = '') { check('WARN', name, detail); }

// ============================================================
// 迷你解析器（YAML 子集 / frontmatter，无外部依赖）
// ============================================================

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 去掉 YAML 行注释（" #" 之后的部分；行首 # 整行）
function stripComment(line) {
  const idx = line.search(/\s#/);
  if (idx >= 0) return line.slice(0, idx);
  if (/^\s*#/.test(line)) return '';
  return line;
}

// 解析 graph.yaml / multimodel-graph.yaml 的 nodes + edges + 顶层标量
// 返回 { nodes: Map<id, {type, executor, on_fail, provider, graph, required}>,
//        edges: [{from,to,when,gate}], top: {provider, entry, exit} }
function parseGraphFile(text) {
  const nodes = new Map();
  const edges = [];
  const top = {};
  let section = null;
  let curNode = null;
  let curEdge = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;

    // 顶层键
    if (/^[^\s-]/.test(line)) {
      const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (key === 'nodes') { section = 'nodes'; curNode = null; continue; }
        if (key === 'edges') { section = 'edges'; curEdge = null; continue; }
        // 其他顶层键（version/provider/entry/exit/diversity_rule）
        if (val) top[key] = val.trim();
        if (key === 'diversity_rule') section = null;
        continue;
      }
      continue;
    }

    if (section === 'nodes') {
      // 新节点：  - id: XXX
      const idm = line.match(/^\s*-\s*id\s*:\s*(\S+)\s*$/);
      if (idm) {
        curNode = { id: idm[1] };
        nodes.set(curNode.id, curNode);
        continue;
      }
      // 节点字段
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curNode) {
        const [, key, val] = fm;
        curNode[key] = val.trim();
      }
      continue;
    }

    if (section === 'edges') {
      // 行内边：  - { from: A, to: B, ... }
      const inline = line.match(/^\s*-\s*\{(.+)\}\s*$/);
      if (inline) {
        const e = {};
        for (const part of inline[1].split(',')) {
          const kv = part.match(/([a-z_]+)\s*:\s*(.+)$/);
          if (kv) e[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
        }
        edges.push(e);
        curEdge = null;
        continue;
      }
      // 多行边：  - from: A
      const fromM = line.match(/^\s*-\s*from\s*:\s*(\S+)\s*$/);
      if (fromM) {
        curEdge = { from: fromM[1] };
        edges.push(curEdge);
        continue;
      }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curEdge) {
        const [, key, val] = fm;
        curEdge[key] = val.trim().replace(/^["']|["']$/g, '');
      }
      continue;
    }
  }
  return { nodes, edges, top };
}

// 提取 md frontmatter 块
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// 解析 agent frontmatter：mount 条目 / role / task_context.write / type
function parseAgentFrontmatter(fm) {
  const agent = { mount: [], role: null, writes: [], type: null };
  const lines = fm.split(/\r?\n/);
  let section = null;      // 'mount' | 'task_context' | null
  let curMount = null;
  let inWrite = false;

  for (const line of lines) {
    // 顶层键
    if (/^[^\s#]/.test(line)) {
      if (section === 'task_context' && inWrite) inWrite = false;
      section = null;
      const km = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (km) {
        const [, key, val] = km;
        if (key === 'mount') { section = 'mount'; continue; }
        if (key === 'task_context') { section = 'task_context'; continue; }
        if (key === 'role' && val) { agent.role = val.trim(); continue; }
        if (key === 'type' && val) { agent.type = val.trim().replace(/\s+#.*$/, ''); continue; }
      }
      continue;
    }

    if (section === 'mount') {
      const atm = line.match(/^\s*-\s*at\s*:\s*(\S+)\s*(?:#.*)?$/);
      if (atm) {
        curMount = { at: atm[1] };
        agent.mount.push(curMount);
        continue;
      }
      const fm2 = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm2 && curMount) {
        const [, key, val] = fm2;
        curMount[key] = val.trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
      }
      continue;
    }

    if (section === 'task_context') {
      const inline = line.match(/^\s+write\s*:\s*\[(.*)\]\s*(?:#.*)?$/);
      if (inline) {
        for (const part of inline[1].split(',')) {
          const v = part.trim();
          if (v) agent.writes.push(v);
        }
        continue;
      }
      if (/^\s+write\s*:\s*$/.test(line)) { inWrite = true; continue; }
      if (inWrite) {
        const li = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
        if (li) { agent.writes.push(li[1]); continue; }
        inWrite = false;
      }
      continue;
    }
  }
  return agent;
}

// 解析 stages frontmatter：required_roles（行内数组）
function parseStageFrontmatter(fm) {
  const m = fm.match(/^required_roles\s*:\s*\[(.*)\]\s*(?:#.*)?$/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// 解析 config.yaml 关注段：tier_defaults / overrides.disabled_agents / timeouts
function parseConfig(text) {
  const cfg = {
    tierAgents: new Map(),   // tier -> Set(agentKey)
    disabledAgents: [],
    perAgentKeys: [],
    multiplierEntries: [],   // {key, value}
  };
  const lines = text.split(/\r?\n/);
  // 段路径跟踪：tier_defaults / T1 / agents
  let l1 = null, l2 = null, l3 = null;
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;

    if (indent === 0) {
      const m = line.match(/^([a-z_]+)\s*:/);
      l1 = m ? m[1] : null; l2 = null; l3 = null;
      continue;
    }
    if (l1 === 'tier_defaults') {
      if (indent === 2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l2 = m ? m[1] : null; l3 = null;
        if (l2 && !cfg.tierAgents.has(l2)) cfg.tierAgents.set(l2, new Set());
        continue;
      }
      if (indent === 4) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l3 = m ? m[1] : null;
        continue;
      }
      if (indent >= 6 && l3 === 'agents' && l2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        if (m) cfg.tierAgents.get(l2).add(m[1]);
        continue;
      }
      continue;
    }
    if (l1 === 'overrides') {
      if (l2 === null && indent === 2) {
        const m = line.match(/^\s+disabled_agents\s*:\s*\[(.*)\]/);
        if (m) {
          cfg.disabledAgents = m[1].split(',').map((s) => s.trim()).filter(Boolean);
          l2 = 'disabled_agents';
          continue;
        }
        const m2 = line.match(/^\s+(\w+)\s*:/);
        l2 = m2 ? m2[1] : null;
        continue;
      }
      if (l2 === 'disabled_agents' && indent >= 4) {
        const li = line.match(/^\s+-\s+(.+)$/);
        if (li) cfg.disabledAgents.push(li[1].trim());
        continue;
      }
      continue;
    }
    if (l1 === 'timeouts') {
      if (indent === 2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l2 = m ? m[1] : null;
        continue;
      }
      if (l2 === 'per_agent_s' && indent >= 4) {
        const m = line.match(/^\s+(\w+)\s*:\s*(\d+)/);
        if (m) cfg.perAgentKeys.push(m[1]);
        continue;
      }
      if (l2 === 'per_tier_multiplier' && indent >= 4) {
        const m = line.match(/^\s+(\w+)\s*:\s*([\d.]+)/);
        if (m) cfg.multiplierEntries.push({ key: m[1], value: parseFloat(m[2]) });
        continue;
      }
      continue;
    }
  }
  return cfg;
}

// ============================================================
// 加载输入
// ============================================================

const graphText = readText(GRAPH_PATH);
if (!graphText) {
  fail('input.graph', `无法读取 ${GRAPH_PATH}`);
  report();
}
const graph = parseGraphFile(graphText);
pass('input.graph', `${graph.nodes.size} nodes / ${graph.edges.length} edges`);

const subText = readText(SUBGRAPH_PATH);
const sub = subText ? parseGraphFile(subText) : null;
if (sub) pass('input.subgraph', `${sub.nodes.size} nodes / ${sub.edges.length} edges`);
else warn('input.subgraph', 'multimodel-graph.yaml 缺失（T3 不可用）');

const cfgText = readText(CONFIG_PATH);
const cfg = cfgText ? parseConfig(cfgText) : null;
if (cfg) pass('input.config', `tiers: ${[...cfg.tierAgents.keys()].join(',')}`);
else fail('input.config', `无法读取 ${CONFIG_PATH}`);

// 加载全部 agent frontmatter
const agents = new Map(); // name -> parsed frontmatter
for (const file of fs.readdirSync(AGENT_DIR)) {
  if (!file.endsWith('.md')) continue;
  const name = file.slice(0, -3);
  const text = readText(path.join(AGENT_DIR, file));
  if (!text) continue;
  const fm = extractFrontmatter(text);
  if (!fm) { fail(`agent.${name}.frontmatter`, '缺 frontmatter 块'); continue; }
  agents.set(name, parseAgentFrontmatter(fm));
}
pass('input.agents', `${agents.size} 个 agent frontmatter 已解析`);

// ============================================================
// A. 图结构校验
// ============================================================

// A1/A2. edges 引用已声明节点（主图 + 子图）
for (const [label, g] of [['graph', graph], ['subgraph', sub]]) {
  if (!g) continue;
  let bad = 0;
  for (const e of g.edges) {
    if (!e.from || !g.nodes.has(e.from)) { fail(`${label}.edges`, `from "${e.from}" 未声明`); bad++; }
    if (!e.to || !g.nodes.has(e.to)) { fail(`${label}.edges`, `to "${e.to}" 未声明`); bad++; }
  }
  if (!bad) pass(`${label}.edges.resolve`, `${g.edges.length} 条边全部引用已声明节点`);
}

// A3. 主图节点 on_fail 取值集
{
  let bad = 0;
  for (const [id, n] of graph.nodes) {
    if (n.on_fail && !NODE_ON_FAIL.has(n.on_fail)) {
      fail('graph.node.on_fail', `${id}: "${n.on_fail}" ∉ {${[...NODE_ON_FAIL].join(',')}}`); bad++;
    }
  }
  if (!bad) pass('graph.node.on_fail', '节点 on_fail 取值全部合法');
}

// A4. 纯拓扑守护：主图节点不得出现 required 字段（契约在 stages frontmatter）
{
  const bad = [...graph.nodes.entries()].filter(([, n]) => n.required);
  if (bad.length === 0) pass('graph.pure_topology', '主图零 required 字段（角色契约在 stages frontmatter）');
  for (const [id] of bad) fail('graph.pure_topology', `${id} 仍声明 required（应移到 stages/${id.toLowerCase()}.md frontmatter required_roles）`);
}

// A5. type: stage 节点的 stages/<id-lower>.md 存在
{
  let bad = 0;
  for (const [id, n] of graph.nodes) {
    if (n.type !== 'stage') continue;
    const p = path.join(STAGES_DIR, `${id.toLowerCase()}.md`);
    if (!fs.existsSync(p)) { fail('graph.stage.file', `${id} → stages/${id.toLowerCase()}.md 缺失`); bad++; }
  }
  if (!bad) pass('graph.stage.file', '全部 stage 节点执行逻辑文件存在');
}

// A6. subgraph 节点：graph 文件存在 + provider 对应 lifecycle_provider
for (const [id, n] of graph.nodes) {
  if (n.type !== 'subgraph') continue;
  if (n.graph && fs.existsSync(path.join(ROOT, 'lifecycle', n.graph))) {
    pass(`graph.subgraph.${id}.graph`, `${n.graph} 存在`);
  } else {
    fail(`graph.subgraph.${id}.graph`, `${n.graph ?? '(未声明)'} 不存在`);
  }
  if (n.provider && agents.has(n.provider) && agents.get(n.provider).type === 'lifecycle_provider') {
    pass(`graph.subgraph.${id}.provider`, `provider ${n.provider} = lifecycle_provider`);
  } else {
    fail(`graph.subgraph.${id}.provider`, `provider ${n.provider ?? '(未声明)'} 无 lifecycle_provider 智能体`);
  }
}

// ============================================================
// B. 挂载点校验
// ============================================================

// 派生挂载点全集：on:bootstrap / on:done ∪ (主图 ∪ 子图节点) × {pre:N, N, post:N}
const mountPoints = new Set(['on:bootstrap', 'on:done']);
for (const g of [graph, sub]) {
  if (!g) continue;
  for (const id of g.nodes.keys()) {
    mountPoints.add(id);
    mountPoints.add(`pre:${id}`);
    mountPoints.add(`post:${id}`);
  }
}

for (const [name, a] of agents) {
  for (const m of a.mount) {
    // B1. at 命中派生挂载点
    if (mountPoints.has(m.at)) {
      if (VERBOSE) pass(`agent.${name}.mount.at`, m.at);
    } else {
      fail(`agent.${name}.mount.at`, `"${m.at}" 未命中派生挂载点`);
    }
    // B2. on_fail 取值集
    if (m.on_fail && !MOUNT_ON_FAIL.has(m.on_fail)) {
      fail(`agent.${name}.mount.on_fail`, `"${m.on_fail}" ∉ {abort,warn,skip}`);
    }
    // B3. order 是数字
    if (m.order !== undefined && !/^\d+$/.test(m.order)) {
      fail(`agent.${name}.mount.order`, `"${m.order}" 非数字`);
    }
  }
  if (a.mount.length > 0) {
    const bad = a.mount.filter((m) => !mountPoints.has(m.at) || (m.on_fail && !MOUNT_ON_FAIL.has(m.on_fail)));
    if (bad.length === 0) pass(`agent.${name}.mount`, `${a.mount.length} 个挂载条目合法`);
  }
}

// B4. when 引用的 config.agents.<key> 至少在任一 tier_defaults 声明（防孤儿开关）
{
  const allTierKeys = new Set();
  if (cfg) for (const keys of cfg.tierAgents.values()) for (const k of keys) allTierKeys.add(k);
  for (const [name, a] of agents) {
    for (const m of a.mount) {
      if (!m.when) continue;
      const wm = m.when.match(/config\.agents\.(\w+)/);
      if (wm && !allTierKeys.has(wm[1])) {
        warn(`agent.${name}.mount.when`, `config.agents.${wm[1]} 未在任何 tier_defaults 声明（恒为 false，永不加载）`);
      }
    }
  }
  pass('config.tier.coverage', `tier 开关键: ${[...allTierKeys].join(', ') || '(无)'}`);
}

// ============================================================
// C. 角色契约校验
// ============================================================

// 智能体角色：frontmatter role ?? 文件名
function roleOf(name) {
  return agents.get(name)?.role ?? name;
}

// 智能体挂载 key：config.agents 键 = 文件名连字符转下划线
function agentKeyOf(name) {
  return name.replace(/-/g, '_');
}

// C1/C2. 主图无 executor 的 stage 节点：stages frontmatter required_roles 非空且每角色有履行者
for (const [id, n] of graph.nodes) {
  if (n.type !== 'stage' || n.executor) continue;
  const stagePath = path.join(STAGES_DIR, `${id.toLowerCase()}.md`);
  const stageText = readText(stagePath);
  if (!stageText) continue; // A5 已报
  const fm = extractFrontmatter(stageText);
  const roles = fm ? parseStageFrontmatter(fm) : [];
  if (roles.length === 0) {
    fail(`stage.${id}.required_roles`, `非内建 stage 节点缺 frontmatter required_roles`);
    continue;
  }
  for (const role of roles) {
    const fulfillers = [...agents.keys()].filter(
      (name) => roleOf(name) === role && agents.get(name).mount.some((m) => m.at === id)
    );
    if (fulfillers.length > 0) {
      pass(`stage.${id}.role.${role}`, `履行者: ${fulfillers.join(', ')}`);
    } else {
      fail(`stage.${id}.role.${role}`, `无智能体履行（需 role=${role} 且 mount at: ${id}）`);
    }
  }
}

// C3. disabled_agents 不得禁用 required_roles 唯一履行者
if (cfg && cfg.disabledAgents.length > 0) {
  for (const [id, n] of graph.nodes) {
    if (n.type !== 'stage' || n.executor) continue;
    const stageText = readText(path.join(STAGES_DIR, `${id.toLowerCase()}.md`));
    if (!stageText) continue;
    const fm = extractFrontmatter(stageText);
    const roles = fm ? parseStageFrontmatter(fm) : [];
    for (const role of roles) {
      const fulfillers = [...agents.keys()].filter(
        (name) => roleOf(name) === role && agents.get(name).mount.some((m) => m.at === id)
      );
      const remaining = fulfillers.filter((f) => !cfg.disabledAgents.includes(f));
      if (fulfillers.length > 0 && remaining.length === 0) {
        fail('config.disabled_agents', `禁用 ${cfg.disabledAgents.join(',')} 后 ${id}.required_roles.${role} 无履行者`);
      }
    }
  }
  pass('config.disabled_agents', `已声明: ${cfg.disabledAgents.join(', ')}`);
}

// C4. 子图节点 required（子图契约保留在 multimodel-graph.yaml）每角色有履行者
if (sub) {
  for (const [id, n] of sub.nodes) {
    if (!n.required) continue;
    const roles = n.required.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const role of roles) {
      const fulfillers = [...agents.keys()].filter(
        (name) => (roleOf(name) === role || name === role) && agents.get(name).mount.some((m) => m.at === id)
      );
      if (fulfillers.length > 0) {
        pass(`subgraph.${id}.role.${role}`, `履行者: ${fulfillers.join(', ')}`);
      } else {
        fail(`subgraph.${id}.role.${role}`, `无智能体履行（需 mount at: ${id}）`);
      }
    }
  }
}

// ============================================================
// D. 配置校验
// ============================================================

if (cfg) {
  // D1. per_agent_s 每键有对应 agent 文件（防幽灵键；agent 文件可无键——回退 stage_default_s）
  {
    const ghost = cfg.perAgentKeys.filter((k) => ![...agents.keys()].some((name) => agentKeyOf(name) === k));
    if (ghost.length === 0) pass('config.timeouts.per_agent_s', `${cfg.perAgentKeys.length} 个键全部有对应 agent 文件`);
    for (const g of ghost) fail('config.timeouts.per_agent_s', `幽灵键 "${g}"（无对应 agent/*.md）`);
  }
  // D2. per_tier_multiplier 键 ⊆ {T0..T3} 且值为正数
  {
    let bad = 0;
    for (const { key, value } of cfg.multiplierEntries) {
      if (!TIERS.has(key)) { fail('config.timeouts.multiplier', `键 "${key}" ⊄ {T0,T1,T2,T3}`); bad++; }
      if (!(value > 0)) { fail('config.timeouts.multiplier', `${key}=${value} 非正数`); bad++; }
    }
    if (!bad) pass('config.timeouts.multiplier', `${cfg.multiplierEntries.length} 个条目合法`);
  }
  // D3. tier_defaults 键 ⊆ {T0..T3}
  {
    const bad = [...cfg.tierAgents.keys()].filter((t) => !TIERS.has(t));
    if (bad.length === 0) pass('config.tier.keys', 'tier 键全部合法');
    for (const t of bad) fail('config.tier.keys', `"${t}" ⊄ {T0,T1,T2,T3}`);
  }
  // D4. tier 开关键应对应"带 when 的智能体"（防僵尸开关）
  {
    const whenKeys = new Set();
    for (const [, a] of agents) {
      for (const m of a.mount) {
        if (!m.when) continue;
        const wm = m.when.match(/config\.agents\.(\w+)/);
        if (wm) whenKeys.add(wm[1]);
      }
    }
    for (const [tier, keys] of cfg.tierAgents) {
      for (const k of keys) {
        if (!whenKeys.has(k)) {
          warn(`config.tier.${tier}.${k}`, `无任何智能体 when 引用 config.agents.${k}（僵尸开关）`);
        }
      }
    }
  }
}

// ============================================================
// E. 权限矩阵校验
// ============================================================

// E1. F2 invariant：conductor writes 含 memory_injection
{
  const c = agents.get('conductor');
  if (c && c.writes.includes('memory_injection')) {
    pass('matrix.conductor.memory_injection', 'F2 invariant 成立');
  } else {
    fail('matrix.conductor.memory_injection', 'agent/conductor.md frontmatter task_context.write 缺 memory_injection');
  }
}

// E2. conductor.md 人类速查矩阵表与 frontmatter 派生一致（drift 检测）
// 矩阵表行格式（规整）：| <name> | <read> | w1, w2, w3 | <forbid> |
{
  const conductorText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
  const rows = conductorText.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\|[^|]+\|[^|]*\|[^|]*\|[^|]*\|$/.test(l) && !/^\|[\s:-]+\|/.test(l));
  let checked = 0;
  let drift = 0;
  for (const row of rows) {
    // 规整：split('|') 后首尾为空串
    const parts = row.split('|').slice(1, -1).map((s) => s.trim());
    if (parts.length < 3) continue;
    const name = parts[0];
    if (!agents.has(name)) continue; // 表头/非智能体行
    const writeCell = parts[2];
    if (!writeCell || writeCell === '—' || writeCell === '全部') continue;
    const tableWrites = writeCell.split(',').map((s) => s.trim()).filter(Boolean);
    const fmWrites = (agents.get(name)?.writes ?? []).slice().sort();
    const tableSorted = tableWrites.slice().sort();
    checked++;
    if (JSON.stringify(tableSorted) !== JSON.stringify(fmWrites)) {
      drift++;
      fail('matrix.drift', `${name}: 表=[${tableSorted.join(', ')}] vs frontmatter=[${fmWrites.join(', ')}]`);
    }
  }
  if (drift === 0 && checked > 0) pass('matrix.drift', `${checked} 个智能体矩阵表与 frontmatter 一致`);
  if (checked === 0) warn('matrix.drift', 'conductor.md 未找到可校验的矩阵表行（格式应为 | name | read | w1, w2 | forbid |）');
}

// ============================================================
// 报告
// ============================================================

function report() {
  let nPass = 0, nFail = 0, nWarn = 0;
  for (const r of results) {
    if (r.level === 'PASS') { nPass++; if (!VERBOSE && r.detail === '') continue; }
    if (r.level === 'FAIL') nFail++;
    if (r.level === 'WARN') nWarn++;
    if (r.level === 'PASS' && !VERBOSE) continue;
    process.stdout.write(`${r.level} ${r.name}${r.detail ? ' — ' + r.detail : ''}\n`);
  }
  process.stdout.write(`\nSUMMARY: ${nPass} PASS / ${nFail} FAIL / ${nWarn} WARN\n`);
  if (nFail > 0) {
    process.stderr.write('[ASSEMBLY_FAIL] 装配校验未通过，修复上述 FAIL 后重跑\n');
    process.exit(1);
  }
  process.exit(0);
}

report();
