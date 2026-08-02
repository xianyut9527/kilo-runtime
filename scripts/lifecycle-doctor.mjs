#!/usr/bin/env node
// lifecycle-doctor.mjs
// 生命周期装配校验器 — conductor.md §启动期装配 第 4 条的机械化实现。
//
// 两种模式（正交，互不依赖）：
//   默认模式（静态）：校验 lifecycle/ + agent/ 文件互相一致——零运行时状态依赖。
//     node scripts/lifecycle-doctor.mjs [--verbose]
//   --runtime 模式（运行时探针）：扫描 $TEMP/kilo/task_context_*.json，对每个活跃
//     task_context 做静态契约 × 运行时状态交叉验证——发现"LLM 漂移"最早信号。
//     node scripts/lifecycle-doctor.mjs --runtime [--verbose]
//     退出码：0=全 PASS（含 runtime 扫描无活跃 context 时报 PASS 空），1=有 FAIL
//
// 架构正交三层：
//   lifecycle/graph.yaml        纯拓扑（节点 id/type/executor/on_fail + 边）——稳定大框架，零智能体名
//   lifecycle/stages/<id>.md    阶段语义（执行逻辑 + frontmatter required_roles 契约）
//   agent/<name>.md             智能体（行为 + frontmatter mount/role/task_context）——丢文件即注册
//
// --runtime 检测项注册式扩展：新增检测只需 runtimeChecks.push({ name, run(ctx, ...) })。
// 每个 run 返回 { level: 'PASS'|'FAIL'|'WARN', detail }。单数职责，互不依赖。
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。
// 与 task-context.mjs 共享 frontmatter 解析逻辑（本地副本，脚本自包含）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VALID_STATUSES, readTierDefaults } from './task-context-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const GRAPH_PATH = path.join(ROOT, 'lifecycle', 'graph.yaml');
const CONFIG_PATH = path.join(ROOT, 'lifecycle', 'config.yaml');
const STAGES_DIR = path.join(ROOT, 'lifecycle', 'stages');
const AGENT_DIR = path.join(ROOT, 'agent');
const KILO_JSON_PATH = path.join(ROOT, 'kilo.json');

// ============================================================
// 解析 kilo.json（标准 JSON，Node 内置）
// ============================================================
function parseKiloJson(text) {
  const data = JSON.parse(text);
  const agents = new Map(); // name -> { model, mode }
  if (data.agent && typeof data.agent === 'object') {
    for (const [name, cfg] of Object.entries(data.agent)) {
      if (cfg && typeof cfg === 'object') {
        agents.set(name, {
          model: cfg.model || null,
          mode: cfg.mode || null,
        });
      }
    }
  }
  // 收集 provider 下所有模型 ID
  const models = new Set();
  if (data.provider && typeof data.provider === 'object') {
    for (const [providerName, providerCfg] of Object.entries(data.provider)) {
      if (providerCfg.models && typeof providerCfg.models === 'object') {
        for (const modelId of Object.keys(providerCfg.models)) {
          models.add(`${providerName}/${modelId}`);
        }
      }
    }
  }
  return {
    defaultAgent: data.default_agent || null,
    agents,
    models,
  };
}

// 解析 model-registry.md frontmatter 中的 diversity_map（嵌套 YAML）
function parseDiversityMap(fmText) {
  const map = {};
  const lines = fmText.split(/\r?\n/);
  let currentModel = null;
  let inMap = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 顶层键 diversity_map:
    if (/^diversity_map\s*:/.test(line)) {
      inMap = true;
      continue;
    }
    if (!inMap) continue;

    // 模型ID行（缩进2空格）："hx/glm-5.2":
    const modelMatch = line.match(/^  "?([^":\s]+)"?\s*:\s*$/);
    if (modelMatch) {
      currentModel = modelMatch[1];
      map[currentModel] = {};
      continue;
    }

    // 属性行（缩进4空格）：vendor: zhipu
    if (currentModel) {
      const attrMatch = line.match(/^    ([a-z_]+)\s*:\s*(\S+)\s*$/);
      if (attrMatch) {
        const [, attrKey, attrVal] = attrMatch;
        map[currentModel][attrKey] = attrVal;
      }
    }
  }

  // 解析 deprecated_for_critical 行（在 diversity_map 之前，顶层键）
  const depMatch = fmText.match(/^deprecated_for_critical\s*:\s*\[(.*)\]\s*$/m);
  const deprecated = depMatch
    ? depMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : [];

  // 解析 diversity_rule.applies_to（列表或字符串）
  let appliesTo = [];
  const ruleStartMatch = fmText.match(/^diversity_rule\s*:\s*$/m);
  if (ruleStartMatch) {
    const ruleBlock = fmText.slice(ruleStartMatch.index + ruleStartMatch[0].length);
    // 匹配 applies_to: 下一行起的缩进列表
    const listMatch = ruleBlock.match(/^  applies_to\s*:\s*\n((?:    - [^\n]+\n?)+)/m);
    if (listMatch) {
      appliesTo = listMatch[1].split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith('- ')).map(s => s.slice(2).trim());
    } else {
      const scalarMatch = ruleBlock.match(/^  applies_to\s*:\s*["']?([^\n"']+)["']?/m);
      if (scalarMatch) appliesTo = [scalarMatch[1].trim()];
    }
  }

  return { map, deprecated, applies_to: appliesTo };
}

const VERBOSE = process.argv.includes('--verbose');
const RUNTIME = process.argv.includes('--runtime');
const SYNC_PROMPT = process.argv.includes('--sync');
const FAST_MODE = process.argv.includes('--fast');
const FULL_MODE = process.argv.includes('--full');

// 运行时模式与缓存模式正交：
//   --runtime 仅做运行时 task_context 探针，不走静态检查。
//   默认 / --full：完整静态检查（并更新 fingerprint 缓存）。
//   --fast：指纹匹配则跳过静态检查；指纹不匹配或缓存 I/O 失败则降级为完整检查。
//   --sync：在完整检查成功后额外运行 prompt 同步（install.ps1 已做，运行时按需触发）。


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

// 解析 graph.yaml 的 nodes + edges + 顶层标量（旧子图文件已废弃，T3 走 worktree 端到端并行）
// 返回 { nodes: Map<id, {type, executor, on_fail, provider, graph, required}>,
//        edges: [{from,to,when,gate}], top: {provider, entry, exit, diversity_rule} }
function parseGraphFile(text) {
  const nodes = new Map();
  const edges = [];
  const top = {};
  let section = null;
  let curNode = null;
  let curEdge = null;
  // diversity_rule 多行解析状态
  let inDiversity = false;
  let divRule = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;

    // diversity_rule 多行块
    if (inDiversity) {
      const indent = line.match(/^\s*/)[0].length;
      if (indent === 0) {
        // 块结束
        top.diversity_rule = divRule;
        inDiversity = false;
        // 继续处理当前行作为普通顶层
      } else {
        const dm = line.match(/^\s+([a-z_]+)\s*:\s*(.*)$/);
        if (dm) {
          const [, dkey, dval] = dm;
          if (dkey === 'applies_to') {
            divRule.applies_to = dval.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
          } else if (dkey === 'on_violation') {
            divRule.on_violation = dval.trim();
          } else if (dkey === 'dimensions') {
            divRule.dimensions = {};
          }
        }
        const dimM = line.match(/^\s+([a-z_]+)\s*:\s*(\w+)\s*$/);
        if (dimM && divRule.dimensions !== undefined) {
          const [, dimKey, dimVal] = dimM;
          if (['vendor', 'architecture'].includes(dimKey)) {
            divRule.dimensions[dimKey] = dimVal;
          }
        }
        continue;
      }
    }

    // 顶层键
    if (/^[^\s-]/.test(line)) {
      const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (key === 'nodes') { section = 'nodes'; curNode = null; continue; }
        if (key === 'edges') { section = 'edges'; curEdge = null; continue; }
        // 其他顶层键（version/provider/entry/exit/diversity_rule）
        if (val) top[key] = val.trim();
        if (key === 'diversity_rule') {
          inDiversity = true;
          divRule = {};
          section = null;
        }
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
  // 文件结束时，若仍在 diversity_rule 块内，落盘
  if (inDiversity && divRule) {
    top.diversity_rule = divRule;
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
        const [, key, rawVal] = fm2;
        const val = rawVal.trim().replace(/\s+#.*$/, '');
        // 支持 YAML 行内数组（如 after: [verifier] / deps: ["a", "b"]）
        if (val.startsWith('[') && val.endsWith(']')) {
          const inner = val.slice(1, -1).trim();
          curMount[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
        } else {
          curMount[key] = val.replace(/^["']|["']$/g, '');
        }
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

// 解析 config.yaml 关注段：tier_defaults / inquiry_tier_defaults / overrides.disabled_agents / timeouts
function parseConfig(text) {
  const cfg = {
    tierAgents: new Map(),          // tier -> Set(agentKey)  来自 tier_defaults
    inquiryTierAgents: new Map(),   // tier -> Set(agentKey)  来自 inquiry_tier_defaults
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
    // tier_defaults 与 inquiry_tier_defaults 结构完全相同，复用同解析逻辑，结果写入不同 Map
    if (l1 === 'tier_defaults' || l1 === 'inquiry_tier_defaults') {
      const targetMap = l1 === 'tier_defaults' ? cfg.tierAgents : cfg.inquiryTierAgents;
      if (indent === 2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l2 = m ? m[1] : null; l3 = null;
        if (l2 && !targetMap.has(l2)) targetMap.set(l2, new Set());
        continue;
      }
      if (indent === 4) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l3 = m ? m[1] : null;
        continue;
      }
      if (indent >= 6 && l3 === 'agents' && l2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        if (m) targetMap.get(l2).add(m[1]);
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
// 运行时模式（--runtime）：task_context 运行时状态探针
// 扫描 $TEMP/kilo/task_context_*.json，对每个活跃 task_context 做静态契约 ×
// 运行时状态交叉验证--发现"LLM 漂移"最早信号。
//
// 注册式检测项（举一反三扩展点）：新增检测只往 runtimeChecks 数组 push 一个函数，
// 零改其他代码。每个函数签名: (ctx, env, rtCheck) => void
//   ctx     task_context 对象（已解析）
//   env     { graph, taskId, filePath } 静态上下文
//   rtCheck (level, name, detail) => void  结果输出函数
// 检测项独立、无副作用、异常隔离（try/catch 包裹，单项失败不阻塞其他项）。
// ============================================================

// R1: status 字段合法
function rtCheckStatus(ctx, env, rtCheck) {
  const s = ctx.status;
  if (VALID_STATUSES.includes(s)) {
    rtCheck('PASS', 'runtime.status', `status=${s}`);
  } else {
    rtCheck('FAIL', 'runtime.status', `status="${s}" ∉ {${VALID_STATUSES.join(',')}}`);
  }
}

// R2: current_stage 在 graph 节点集合里（阶段合法性）
function rtCheckCurrentStage(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  if (!stage) {
    rtCheck('WARN', 'runtime.current_stage', 'current_stage 未设置（可能尚未流转或漏调 transition-check）');
    return;
  }
  if (env.graph.nodes.has(stage)) {
    rtCheck('PASS', 'runtime.current_stage', `current_stage=${stage}`);
  } else {
    rtCheck('FAIL', 'runtime.current_stage', `current_stage="${stage}" 不在 graph.yaml 节点集合`);
  }
}

// R3: quality / mm_fusion 计数合法（非负整数 + 不超阈值）
function rtCheckConvergence(ctx, env, rtCheck) {
  const q = ctx.quality || {};
  const c = ctx.convergence || {};
  const { round, max_rounds } = q;
  const { mm_fusion_rounds, mm_fusion_max_rounds } = c;
  let ok = true;
  const parts = [`quality=${round}/${max_rounds} mm_fusion=${mm_fusion_rounds}/${mm_fusion_max_rounds}`];
  if (!Number.isInteger(round) || round < 0) { ok = false; parts.push('quality.round 非非负整数'); }
  if (Number.isInteger(max_rounds) && round > max_rounds) { ok = false; parts.push('quality.round 超阈值'); }
  if (!Number.isInteger(mm_fusion_rounds) || mm_fusion_rounds < 0) { ok = false; parts.push('mm_fusion_rounds 非非负整数'); }
  if (Number.isInteger(mm_fusion_max_rounds) && mm_fusion_rounds > mm_fusion_max_rounds) { ok = false; parts.push('mm_fusion_rounds 超阈值'); }
  rtCheck(ok ? 'PASS' : 'FAIL', 'runtime.convergence', parts.join(' | '));
}

// R4: 熔断接近性（>=80% 预警，>=100% 已触发）
function rtCheckBreaker(ctx, env, rtCheck) {
  const q = ctx.quality || {};
  const c = ctx.convergence || {};
  const qr = q.round || 0;
  const qm = q.max_rounds || 4;
  const fr = c.mm_fusion_rounds || 0;
  const fm = c.mm_fusion_max_rounds || 3;
  const qPct = Math.round((qr / qm) * 100);
  const fPct = Math.round((fr / fm) * 100);
  if (qPct >= 100 || fPct >= 100) {
    rtCheck('FAIL', 'runtime.breaker', `已触发熔断 quality=${qr}/${qm}(${qPct}%) mm_fusion=${fr}/${fm}(${fPct}%)`);
  } else if (qPct >= 80 || fPct >= 80) {
    rtCheck('WARN', 'runtime.breaker', `接近熔断 quality=${qPct}% mm_fusion=${fPct}%（建议人工介入）`);
  } else {
    rtCheck('PASS', 'runtime.breaker', `熔断安全 quality=${qPct}% mm_fusion=${fPct}%`);
  }
}

// R5: transition_log 与 current_stage 一致（漏调 transition-check 检测）
function rtCheckTransitionLog(ctx, env, rtCheck) {
  const log = ctx.transition_log;
  const stage = ctx.current_stage;
  if (!Array.isArray(log) || log.length === 0) {
    if (stage) {
      rtCheck('FAIL', 'runtime.transition_log', `current_stage=${stage} 但 transition_log 空（可能漏调 transition-check 或手工 set current_stage）`);
    } else {
      rtCheck('PASS', 'runtime.transition_log', '无流转记录（初始状态）');
    }
    return;
  }
  const last = log[log.length - 1];
  if (stage && last.to !== stage) {
    rtCheck('FAIL', 'runtime.transition_log', `transition_log 末条 to=${last.to} ≠ current_stage=${stage}（状态漂移）`);
  } else {
    rtCheck('PASS', 'runtime.transition_log', `${log.length} 条流转，最近: ${last.from}->${last.to}`);
  }
}

// R6: config.agents 与 sizing.tier 存在性一致性
function rtCheckTier(ctx, env, rtCheck) {
  const tier = ctx.sizing && ctx.sizing.tier;
  if (!tier) {
    rtCheck('WARN', 'runtime.tier', 'sizing.tier 未设置（可能尚未 SIZING）');
    return;
  }
  const agents = ctx.config && ctx.config.agents;
  if (!agents || typeof agents !== 'object') {
    rtCheck('FAIL', 'runtime.tier', `tier=${tier} 但 config.agents 缺失`);
    return;
  }
  // 检测开关键是否为布尔值
  const bad = Object.entries(agents).filter(([, v]) => typeof v !== 'boolean');
  if (bad.length > 0) {
    rtCheck('FAIL', 'runtime.tier', `config.agents 非布尔键: ${bad.map(([k]) => k).join(', ')}`);
    return;
  }
  // tier→必填开关一致性校验（防 apply-tier 漏写 / 手工写错）
  // 规则来源：lifecycle/config.yaml tier_defaults / inquiry_tier_defaults，机械读取
  const tierDefaults = readTierDefaults();
  const intentType = (ctx.intent && ctx.intent.intent_type) || 'EXECUTION';
  const tierMap = intentType === 'INQUIRY' ? tierDefaults.inquiry : tierDefaults.execution;
  const expected = (tierMap && tierMap[tier]) ? tierMap[tier].agents : null;
  if (expected) {
    const mismatches = [];
    for (const [k, v] of Object.entries(expected)) {
      const actual = agents[k];
      if (actual !== v) {
        mismatches.push(`${k}: expected=${v}, got=${actual === undefined ? '(missing)' : actual}`);
      }
    }
    if (mismatches.length > 0) {
      rtCheck('FAIL', 'runtime.tier', `tier=${tier} config.agents 与 ${intentType === 'INQUIRY' ? 'inquiry_tier_defaults' : 'tier_defaults'} 不一致: ${mismatches.join('; ')}。应执行: task-context.mjs apply-tier <task_id> ${tier} --agent conductor`);
      return;
    }
  }
  rtCheck('PASS', 'runtime.tier', `tier=${tier} agents={${Object.entries(agents).map(([k,v]) => `${k}:${v}`).join(',')}}`);
}

// R7: 阶段产物完整性（QUALITY 后要求 quality.verify.forward 已填充；同时保留 verification.forward 向后兼容）
function rtCheckVerification(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  const postQuality = ['DELIVERING', 'DONE'];
  if (!stage || !postQuality.includes(stage)) {
    rtCheck('PASS', 'runtime.verification', `current_stage=${stage || '(未设置)'} 不要求 verification`);
    return;
  }
  const qFwd = ctx.quality && ctx.quality.verify && ctx.quality.verify.forward;
  const vFwd = ctx.verification && ctx.verification.forward;
  const fwd = qFwd || vFwd;
  if (!fwd || (typeof fwd === 'object' && !fwd.verdict)) {
    rtCheck('FAIL', 'runtime.verification', `current_stage=${stage} 但 quality.verify.forward.verdict / verification.forward.verdict 未填充`);
  } else {
    const verdict = (fwd && fwd.verdict) || (qFwd && qFwd.verdict) || (vFwd && vFwd.verdict);
    rtCheck('PASS', 'runtime.verification', `forward.verdict=${verdict}`);
  }
}

// R8: gate 状态（DELIVERING/DONE 要求 memory_write_status）
function rtCheckGate(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  if (stage !== 'DELIVERING' && stage !== 'DONE') {
    rtCheck('PASS', 'runtime.gate', `current_stage=${stage || '(未设置)'} 不要求 gate`);
    return;
  }
  const mws = ctx.memory_write_status;
  if (mws === 'OK' || mws === 'DEGRADED') {
    rtCheck('PASS', 'runtime.gate', `memory_write_status=${mws} 满足 MEMORY_WRITE_COMPLETE`);
  } else {
    rtCheck('FAIL', 'runtime.gate', `current_stage=${stage} 但 memory_write_status=${mws || '(未设置)'}（须先执行 M4-M8 记忆写入）`);
  }
}

// R9: GC 残留检测（initialized 且 mtime>24h → FAIL，与 task-context.mjs GC 规则对齐）
function rtCheckGcResidue(ctx, env, rtCheck) {
  if (ctx.status !== 'initialized') {
    rtCheck('PASS', 'runtime.gc_residue', `status=${ctx.status} 非 initialized，不受 GC 管辖`);
    return;
  }
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  try {
    const stat = fs.statSync(env.filePath);
    if (Date.now() - stat.mtimeMs > ONE_DAY_MS) {
      rtCheck('FAIL', 'runtime.gc_residue', `status=initialized 且 mtime>24h（应被 GC 清理，下次 init 将删除）`);
    } else {
      rtCheck('PASS', 'runtime.gc_residue', `status=initialized, age=${Math.round((Date.now() - stat.mtimeMs) / 3600000)}h (<24h, 未超期)`);
    }
  } catch (e) {
    rtCheck('WARN', 'runtime.gc_residue', `无法读取文件状态: ${e.message}`);
  }
}

// 注册表：新增检测项只在此 push 一个函数（扩展点单一）
const runtimeChecks = [
  rtCheckStatus,
  rtCheckCurrentStage,
  rtCheckConvergence,
  rtCheckBreaker,
  rtCheckTransitionLog,
  rtCheckTier,
  rtCheckVerification,
  rtCheckGate,
  rtCheckGcResidue,
];

function runRuntimeChecksForTask(filePath, taskId, graph) {
  const runtimeResults = [];
  const rtCheck = (level, name, detail = '') => runtimeResults.push({ level, name, detail });

  let ctx;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    ctx = JSON.parse(raw);
    rtCheck('PASS', 'runtime.json_parse', 'task_context 可解析');
  } catch (e) {
    rtCheck('FAIL', 'runtime.json_parse', e.message);
    return runtimeResults;
  }

  const env = { graph, taskId, filePath };
  for (const check of runtimeChecks) {
    try {
      check(ctx, env, rtCheck);
    } catch (e) {
      rtCheck('FAIL', `runtime.${check.name}`, `检测异常: ${e.message}`);
    }
  }
  return runtimeResults;
}

function runRuntimeMode() {
  const tmpDir = path.join(os.tmpdir(), 'kilo');
  let files = [];
  try {
    files = fs.readdirSync(tmpDir)
      .filter((f) => f.startsWith('task_context_') && f.endsWith('.json'));
  } catch {
    // 目录不存在
  }

  if (files.length === 0) {
    process.stdout.write('RUNTIME: 无活跃 task_context 文件\n');
    process.stdout.write('SUMMARY: 0 active tasks / 0 FAIL\n');
    return;
  }

  // 加载 graph.yaml（复用已有 parseGraphFile + readText）
  const graphText = readText(GRAPH_PATH);
  const graph = graphText ? parseGraphFile(graphText) : { nodes: new Map(), edges: [] };

  let totalPass = 0, totalFail = 0, totalWarn = 0;

  for (const file of files) {
    const taskId = file.replace(/^task_context_/, '').replace(/\.json$/, '');
    const filePath = path.join(tmpDir, file);
    const results = runRuntimeChecksForTask(filePath, taskId, graph);

    process.stdout.write(`\n=== task ${taskId} ===\n`);
    for (const r of results) {
      process.stdout.write(`${r.level} ${r.name}${r.detail ? ' - ' + r.detail : ''}\n`);
      if (r.level === 'PASS') totalPass++;
      if (r.level === 'FAIL') totalFail++;
      if (r.level === 'WARN') totalWarn++;
    }
  }

  process.stdout.write(`\nSUMMARY: ${files.length} active tasks / ${totalPass} PASS / ${totalFail} FAIL / ${totalWarn} WARN\n`);
  if (totalFail > 0) {
    process.stderr.write('[RUNTIME_VIOLATION] 检测到运行时状态违规，见上述 FAIL\n');
    process.exit(1);
  }
}

// ============================================================
// 报告
// ============================================================

function report() {
  finalizeStaticRun();
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

// ============================================================
// 指纹缓存（静态装配缓存）
// ============================================================

const CACHE_DIR = path.join(os.tmpdir(), 'kilo');
const FINGERPRINT_PATH = path.join(CACHE_DIR, 'lifecycle-doctor.fingerprint.json');

const FINGERPRINT_SCOPES = [
  { type: 'dir', path: path.join(ROOT, 'lifecycle') },
  { type: 'dir', path: path.join(ROOT, 'agent') },
  { type: 'dir', path: path.join(ROOT, '.kilo', 'instructions') },
  { type: 'dir', path: path.join(ROOT, 'scripts') },
  { type: 'file', path: path.join(ROOT, 'kilo.json') },
];

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); return true; } catch { return false; }
}

function listFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function hashFile(filePath) {
  try { const data = fs.readFileSync(filePath); return createHash('sha256').update(data).digest('hex'); } catch { return null; }
}

function computeFingerprint() {
  const parts = [];
  for (const scope of FINGERPRINT_SCOPES) {
    if (scope.type === 'file') {
      const hash = hashFile(scope.path);
      if (hash === null) return null;
      parts.push(`${path.relative(ROOT, scope.path).replace(/\\/g, '/')}:${hash}`);
    } else {
      for (const rel of listFiles(scope.path)) {
        const hash = hashFile(path.join(scope.path, rel));
        if (hash === null) return null;
        parts.push(`${rel}:${hash}`);
      }
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function readFingerprintCache() {
  try {
    const data = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, 'utf8'));
    return data && typeof data.fingerprint === 'string' ? data.fingerprint : null;
  } catch { return null; }
}

function writeFingerprintCache(fingerprint) {
  if (!ensureCacheDir()) return false;
  try {
    const tmp = FINGERPRINT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint, createdAt: Date.now(), version: 1 }, null, 2) + '\n', 'utf8');
    try { fs.unlinkSync(FINGERPRINT_PATH); } catch {}
    fs.renameSync(tmp, FINGERPRINT_PATH);
    return true;
  } catch { return false; }
}

function checkFingerprint() {
  const current = computeFingerprint();
  if (current === null) return { match: false, reason: 'fingerprint computation failed' };
  const cached = readFingerprintCache();
  if (cached === null) return { match: false, reason: 'no cached fingerprint' };
  if (current === cached) return { match: true, fingerprint: current };
  return { match: false, reason: 'fingerprint mismatch' };
}

function runSyncScript(scriptName, args = []) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}

function syncAgentPrompts() {
  const result = runSyncScript('sync-agent-prompt.mjs');
  if (result.error) { fail('sync.prompt', `sync-agent-prompt.mjs 调用失败: ${result.error.message}`); return; }
  if (result.status !== 0) { fail('sync.prompt', `sync-agent-prompt.mjs 退出码 ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`); return; }
  const summaryLine = (result.stdout || '').trim().split(/\r?\n/).find(l => l.startsWith('[SUMMARY]'));
  pass('sync.prompt', summaryLine ? summaryLine.replace('[SUMMARY] ', 'prompt 同步 — ') : 'agent.prompt 已同步');
}

function checkPromptDrift() {
  const result = runSyncScript('sync-agent-prompt.mjs', ['--check']);
  if (result.error) { fail('prompt.drift', `sync-agent-prompt.mjs --check 调用失败: ${result.error.message}`); return; }
  const stdout = result.stdout || '';
  // 解析 drift= 数值
  const driftMatch = stdout.match(/drift=(\d+)/);
  const driftCount = driftMatch ? parseInt(driftMatch[1], 10) : -1;
  if (driftCount === 0) {
    pass('prompt.drift', '0 drift（agent prompt 与 description 一致）');
  } else if (driftCount > 0) {
    // drift 是 install 时 sync-agent-prompt.mjs 修复对象，装配期仅提醒不阻塞（install.ps1/sh 已自动跑 sync）
    warn('prompt.drift', `检测到 ${driftCount} 个 prompt drift，运行 \`node scripts/sync-agent-prompt.mjs\` 或重跑 install 同步`);
  } else {
    warn('prompt.drift', '无法解析 drift 计数，请手动运行 sync-agent-prompt.mjs --check');
  }
}

function finalizeStaticRun() {
  if (FULL_MODE || FAST_MODE) {
    const fingerprint = computeFingerprint();
    if (fingerprint !== null) {
      if (writeFingerprintCache(fingerprint)) pass('cache.fingerprint', `fingerprint updated: ${fingerprint.slice(0, 16)}...`);
      else warn('cache.fingerprint', 'failed to write fingerprint cache (proceeding)');
    }
  }
  if (SYNC_PROMPT) {
    syncAgentPrompts();
  } else {
    // 默认装配模式：检测 prompt drift（不写入，只报告）
    checkPromptDrift();
  }
}

// ============================================================
// 启动调度（在静态检查之前执行）
// ============================================================

if (RUNTIME) { runRuntimeMode(); process.exit(0); }

if (FAST_MODE) {
  const fp = checkFingerprint();
  if (fp.match) {
    process.stdout.write(`CACHE_HIT ${fp.fingerprint}\n`);
    process.stdout.write('SUMMARY: 0 PASS / 0 FAIL / 0 WARN (fingerprint cache)\n');
    process.exit(0);
  }
  if (VERBOSE) process.stdout.write(`CACHE_MISS ${fp.reason}\n`);
}

if (SYNC_PROMPT && FAST_MODE && checkFingerprint().match) {
  process.stdout.write('CACHE_HIT but --sync requested; running full checks + prompt sync\n');
}


// 完整静态检查成功后，按模式更新缓存 / 同步 prompt，然后报告
// 注意：执行流会顺序运行下面的静态检查，最终到达本段。
const graphText = readText(GRAPH_PATH);
if (!graphText) {
  fail('input.graph', `无法读取 ${GRAPH_PATH}`);
  report();
}
const graph = parseGraphFile(graphText);
pass('input.graph', `${graph.nodes.size} nodes / ${graph.edges.length} edges`);

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

// memory 模块完整性（文件存在性；原 validate-config check14 缺口补回）
{
  const req = [
    ['.kilo/memory/README.md', '公共 API 文档'],
    ['.kilo/memory/AGENTS.md', 'agent 注入入口'],
    ['.kilo/memory/schema/init.sql', 'DDL 唯一源'],
    ['.kilo/memory/contracts/health_check.sql', '健康度查询契约源'],
  ];
  let bad = 0;
  for (const [rel, desc] of req) {
    if (!fs.existsSync(path.join(ROOT, rel))) { fail(`memory.module.files`, `${rel} 缺失（${desc}）`); bad++; }
  }
  if (!bad) pass('memory.module.files', `${req.length} 个模块入口文件齐全（README/AGENTS/schema:init.sql/contracts:health_check.sql）`);
}

// ============================================================
// A. 图结构校验
// ============================================================

// A1/A2. edges 引用已声明节点（仅主图；子图文件已废弃）
{
  let bad = 0;
  for (const e of graph.edges) {
    if (!e.from || !graph.nodes.has(e.from)) { fail(`graph.edges`, `from "${e.from}" 未声明`); bad++; }
    if (!e.to || !graph.nodes.has(e.to)) { fail(`graph.edges`, `to "${e.to}" 未声明`); bad++; }
  }
  if (!bad) pass(`graph.edges.resolve`, `${graph.edges.length} 条边全部引用已声明节点`);
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

// A6. 旧 subgraph 节点已废弃：graph 中不应再出现 type:subgraph
let subgraphNodeCount = 0;
for (const [id, n] of graph.nodes) {
  if (n.type === 'subgraph') {
    subgraphNodeCount++;
    fail(`graph.subgraph.${id}`, 'type:subgraph 已废弃（T3 改为 worktree 端到端并行，主图不再有子图节点）');
  }
}
if (subgraphNodeCount === 0) pass('graph.subgraph', '无 type:subgraph 节点（阶段级并行模式）');

// A7/A8. T3 回流守护（已移除：MM_SUBGRAPH/INQUIRY_MM_SUBGRAPH 已废弃，T3 走 PARALLEL_EXECUTION→SYNTHESIZING）
// T3 走 PARALLEL_EXECUTION worktree 端到端副本竞赛，无需子图回流守护。


// ============================================================
// B. 挂载点校验
// ============================================================

// 派生挂载点全集：on:bootstrap / on:done ∪ 主图节点 × {pre:N, N, post:N}
const mountPoints = new Set(['on:bootstrap', 'on:done']);
for (const id of graph.nodes.keys()) {
  mountPoints.add(id);
  mountPoints.add(`pre:${id}`);
  mountPoints.add(`post:${id}`);
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
      fail(`agent.${name}.mount.on_fail`, `"${m.on_fail}" ∉ {abort,warn,skip,degrade}`);
    }
    // B3a. after 引用的 agent 必须已注册（防引用不存在的 agent）
    if (m.after) {
      const deps = Array.isArray(m.after) ? m.after : [m.after];
      for (const dep of deps) {
        if (!agents.has(dep)) {
          fail(`agent.${name}.mount.after`, `"${dep}" 未注册为 agent（after 只能引用已存在的 agent 名）`);
        }
      }
    }
    // B3b. 旧 order 字段已废弃——忽略不报错（v2.1 迁移兼容）
    // B3c. hook 取值集（QUALITY 阶段内部 hooks）
    if (m.hook && !['verify', 'fix', 'review'].includes(m.hook)) {
      fail(`agent.${name}.mount.hook`, `"${m.hook}" ∉ {verify,fix,review}`);
    }
  }
  if (a.mount.length > 0) {
    const bad = a.mount.filter((m) => !mountPoints.has(m.at) || (m.on_fail && !MOUNT_ON_FAIL.has(m.on_fail)));
    if (bad.length === 0) pass(`agent.${name}.mount`, `${a.mount.length} 个挂载条目合法`);
  }
}

// B3d. after 依赖环检测（按挂载点 + hook 分组做拓扑排序）
{
  // 收集每个 (at, hook) 分组的 agent → after 映射
  const groups = new Map(); // key: "at|hook" → Map(agentName → [after deps])
  for (const [name, a] of agents) {
    for (const m of a.mount) {
      if (m.after && m.after.length > 0) {
        const key = m.hook ? `${m.at}|${m.hook}` : m.at;
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(name, Array.isArray(m.after) ? m.after : [m.after]);
      }
    }
  }
  // 每组做环检测（DFS）
  for (const [key, depMap] of groups) {
    const visited = new Set();
    const stack = new Set();
    function dfs(node) {
      if (stack.has(node)) {
        fail(`agent.${key}.after.cycle`, `${node} → ... → ${node} 存在 after 环依赖（拓扑排序无法收敛）`);
        return true;
      }
      if (visited.has(node)) return false;
      visited.add(node);
      stack.add(node);
      const deps = depMap.get(node) || [];
      for (const d of deps) {
        if (dfs(d)) return true;
      }
      stack.delete(node);
      return false;
    }
    let hasCycle = false;
    for (const [agent] of depMap) {
      if (dfs(agent)) { hasCycle = true; break; }
    }
    if (!hasCycle) pass(`agent.${key}.after.topo`, `after 依赖无环（${depMap.size} 个有 after 声明的 agent）`);
  }
  if (groups.size === 0) pass('agent.after.topo', '无 after 声明（全部串行组，按 agent 文件名字典序逐个启动，遵守零输出硬门）');
}

// B3e. deps 字段可写性校验：每个 deps 字段须命中某 agent write 或 conductor write 或白名单
{
  // 收集所有 agent write 声明（含 conductor）
  const allWrites = new Set();
  for (const [name, a] of agents) {
    for (const w of a.writes) allWrites.add(w);
  }
  // 白名单：框架字段（conductor 写入或生命周期固有字段）
  const WHITELIST = new Set(['intent', 'project_context', 'plan', 'execution.quality.issues', 'execution.code']);
  for (const [name, a] of agents) {
    for (const m of a.mount) {
      if (!m.deps || !Array.isArray(m.deps)) continue;
      for (const dep of m.deps) {
        if (!allWrites.has(dep) && !WHITELIST.has(dep)) {
          warn(`agent.${name}.mount.deps`, `"${dep}" 未命中任何 agent write 声明或白名单（可能引用框架字段，非 FAIL）`);
        }
      }
    }
  }
  pass('agent.deps.writability', 'deps 可写性校验完成');
}

// B4. when 引用的 config.agents.<key> 至少在任一 tier_defaults / inquiry_tier_defaults 声明（防孤儿开关）
{
  const allTierKeys = new Set();
  if (cfg) {
    for (const keys of cfg.tierAgents.values()) for (const k of keys) allTierKeys.add(k);
    for (const keys of cfg.inquiryTierAgents.values()) for (const k of keys) allTierKeys.add(k);
  }
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

// C4. 旧子图节点 required 角色检查已废弃（multimodel-graph.yaml / inquiry-multimodel-graph.yaml 已删除）。
// 阶段级多模型并行下，角色契约由 stages/{planning,executing,quality}.md frontmatter required_roles 声明。

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
  // D3. tier_defaults 与 inquiry_tier_defaults 键 ⊆ {T0..T3}
  {
    const bad1 = [...cfg.tierAgents.keys()].filter((t) => !TIERS.has(t));
    const bad2 = [...cfg.inquiryTierAgents.keys()].filter((t) => !TIERS.has(t));
    if (bad1.length === 0 && bad2.length === 0) pass('config.tier.keys', 'tier 键全部合法（tier_defaults + inquiry_tier_defaults）');
    for (const t of bad1) fail('config.tier.keys', `tier_defaults "${t}" ⊄ {T0,T1,T2,T3}`);
    for (const t of bad2) fail('config.tier.keys', `inquiry_tier_defaults "${t}" ⊄ {T0,T1,T2,T3}`);
  }
    // D4. tier 开关键应对应"带 when 的智能体"（防僵尸开关，全量校验无豁免）
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
    for (const [tier, keys] of cfg.inquiryTierAgents) {
      for (const k of keys) {
        if (!whenKeys.has(k)) {
          warn(`config.inquiry_tier.${tier}.${k}`, `无任何智能体 when 引用 config.agents.${k}（僵尸开关）`);
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
  if (checked === 0) {
    if (/matrix-table:\s*none/.test(conductorText)) {
      pass('matrix.drift', '矩阵表经声明显式省略（matrix-table: none），frontmatter 为单一真相');
    } else {
      warn('matrix.drift', 'conductor.md 未找到可校验的矩阵表行（格式应为 | name | read | w1, w2 | forbid |）');
    }
  }
}

// ============================================================
// F. stages 正文硬编码智能体名检测（[DOC_DRIFT]）
// ============================================================

// 框架级名称（executor / provider），从 kilo.json agent.*.mode==='primary' 动态派生
const FRAMEWORK_NAMES = (() => {
  try {
    const kjText = readText(KILO_JSON_PATH);
    if (kjText) {
      const kj = parseKiloJson(kjText);
      return new Set([...kj.agents.entries()].filter(([, v]) => v.mode === 'primary').map(([k]) => k));
    }
  } catch {}
  return new Set(['conductor']);
})();

{
  const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  let driftFound = 0;
  for (const file of stageFiles) {
    const filePath = path.join(STAGES_DIR, file);
    const text = readText(filePath) ?? '';
    const fm = extractFrontmatter(text);
    const roles = fm ? parseStageFrontmatter(fm) : [];
    const allowedInBody = new Set([...roles, ...FRAMEWORK_NAMES]);

    let cleaned = text.replace(/^---[\s\S]*?---/, ''); // 去掉 frontmatter
    // 去掉代码块、行内代码
    cleaned = cleaned
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '');

    for (const [name] of agents) {
      if (allowedInBody.has(name)) continue; // required_roles 角色名 + 框架名允许出现
      const regex = new RegExp(`(?<!\/)\\b${name.replace(/-/g, '[-_]')}\\b`, 'g');
      const hits = [...cleaned.matchAll(regex)];
      if (hits.length > 0) {
        driftFound++;
        fail('doc.drift', `${file}: 正文硬编码智能体名 "${name}"（应改用角色语义）`);
      }
    }
  }
  if (driftFound === 0) pass('doc.drift', `${stageFiles.length} 个 stage 文件正文无硬编码可选智能体名`);
}

// ============================================================
// G. kilo.json 智能体配置自检
// ============================================================

const kjText = readText(KILO_JSON_PATH);
let kj = null;
if (kjText) {
  try {
    kj = parseKiloJson(kjText);
    pass('kilojson.parse', 'kilo.json 可解析');
  } catch (e) {
    fail('kilojson.parse', `kilo.json 解析失败: ${e.message}`);
  }
} else {
  fail('kilojson.parse', `kilo.json 缺失: ${KILO_JSON_PATH}`);
}

if (kj) {
  const KJ_MODES = new Set(['primary', 'subagent', 'standby', 'local']);

  // G1. agent 条目 ↔ agent/*.md 双向一致
  {
    const mdNames = new Set(agents.keys());
    const kjNames = new Set(kj.agents.keys());
    let orphanKj = 0, orphanMd = 0;
    for (const name of kjNames) {
      if (!mdNames.has(name)) {
        orphanKj++;
        fail('kilojson.agent.md', `kilo.json agent.${name} 无对应 agent/${name}.md 文件`);
      }
    }
    for (const name of mdNames) {
      if (!kjNames.has(name)) {
        orphanMd++;
        fail('kilojson.agent.md', `agent/${name}.md 存在但 kilo.json agent.${name} 未声明`);
      }
    }
    if (orphanKj === 0 && orphanMd === 0) pass('kilojson.agent.md', `${kjNames.size} 个 agent 双向一致`);
  }

  // G2. model 合法性（provider.models 中存在）
  {
    let bad = 0;
    for (const [name, cfg] of kj.agents) {
      if (cfg.model && !kj.models.has(cfg.model)) {
        bad++;
        fail('kilojson.agent.model', `agent.${name}.model="${cfg.model}" 不在 provider.models 中`);
      }
    }
    if (bad === 0) pass('kilojson.agent.model', `全部 agent model 合法（${kj.agents.size} 个）`);

    // G2 补充：agent 有 mode 但 model 为空 → WARN
    for (const [name, cfg] of kj.agents) {
      if (cfg.mode && !cfg.model) {
        warn('kilojson.agent.model', `agent.${name} mode="${cfg.mode}" 但未声明 model`);
      }
    }
  }

  // G2.5. 关键路径模型策略校验（deprecated_for_critical 不得用于关键路径）
  {
    const REGISTRY_PATH = path.join(ROOT, 'docs', 'model-registry.md');
    const regText = readText(REGISTRY_PATH);
    let deprecatedModels = [];
    if (regText) {
      const regFm = extractFrontmatter(regText);
      if (regFm) {
        const parsed = parseDiversityMap(regFm);
        deprecatedModels = parsed.deprecated;
      }
    }

    if (deprecatedModels.length === 0) {
      pass('kilojson.agent.model_policy', '无 deprecated_for_critical 声明（跳过策略校验）');
    } else {
      // 从结构派生关键路径 agent 名单（禁止硬编码）
      const criticalAgents = new Set();

      // 1) kilo.json default_agent
      if (kj.defaultAgent) criticalAgents.add(kj.defaultAgent);

      // 2) model-registry.md diversity_rule.applies_to（旧 multimodel-graph.yaml diversity_rule 已废弃）
      let divRule = null;
      if (regText) {
        const regFm = extractFrontmatter(regText);
        if (regFm) {
          const parsed = parseDiversityMap(regFm);
          divRule = parsed.applies_to;
        }
      }
      if (divRule && divRule.length > 0) {
        for (const name of divRule) criticalAgents.add(name);
      }

      // 3) lifecycle/stages/{planning,executing,quality}.md frontmatter required_roles
      for (const stageName of ['planning', 'executing', 'quality']) {
        const stagePath = path.join(STAGES_DIR, `${stageName}.md`);
        const stageText = readText(stagePath);
        if (stageText) {
          const stageFm = extractFrontmatter(stageText);
          if (stageFm) {
            const roles = parseStageFrontmatter(stageFm);
            for (const role of roles) criticalAgents.add(role);
          }
        }
      }

      // 4) kilo.json agent.mode === 'primary'（conductor 等关键路径编排者）
      for (const [name, cfg] of kj.agents) {
        if (cfg.mode === 'primary') criticalAgents.add(name);
      }

      let policyFail = 0;
      for (const name of criticalAgents) {
        const cfg = kj.agents.get(name);
        if (!cfg || !cfg.model) continue;
        if (deprecatedModels.includes(cfg.model)) {
          policyFail++;
          fail('kilojson.agent.model_policy', `关键路径 agent.${name}.model="${cfg.model}" ∈ deprecated_for_critical [${deprecatedModels.join(', ')}]`);
        }
      }
      if (policyFail === 0) {
        pass('kilojson.agent.model_policy', `关键路径 ${criticalAgents.size} 个 agent 均未使用 deprecated 模型`);
      }
    }
  }

  // G3. mode 取值集
  {
    let bad = 0;
    for (const [name, cfg] of kj.agents) {
      if (cfg.mode && !KJ_MODES.has(cfg.mode)) {
        bad++;
        fail('kilojson.agent.mode', `agent.${name}.mode="${cfg.mode}" ∉ {${[...KJ_MODES].join(',')}}`);
      }
    }
    if (bad === 0) pass('kilojson.agent.mode', '全部 agent mode 合法');
  }

  // G4. default_agent 指向存在性
  if (kj.defaultAgent) {
    if (kj.agents.has(kj.defaultAgent)) {
      pass('kilojson.default_agent', `default_agent="${kj.defaultAgent}" 存在`);
    } else {
      fail('kilojson.default_agent', `default_agent="${kj.defaultAgent}" 未在 agent 中声明`);
    }
  } else {
    warn('kilojson.default_agent', 'default_agent 未设置');
  }

  // G5. diversity_rule 已移除（T3 走 worktree 端到端副本竞赛，不再需要 multiModel diversity 校验）
}


// 静态检查代码块结束后调用 report()
report();
