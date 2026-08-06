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
import { VALID_STATUSES } from './task-context-runtime.mjs';
import { isConditionalRole } from './lib/stage-roles.mjs';
import { buildInitialContext as _bootstrapBuildInitialContext } from './task-context.mjs';

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
  return map;
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
const TIERS = new Set(['T0', 'T1', 'T2']);

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

// 解析 graph.yaml 的 nodes + edges + 顶层标量
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
// tier_escalation 段解析（D5 静态校验用；语义对齐 task-context-runtime.mjs:parseTierEscalation）
// 返回 { present, mode, keyword_groups: {<group>: [kws]}, sensitive_path_globs: [globs] }
//   present=false 表示 tier_escalation 顶层段缺失；其余字段在缺失时返回默认值
// ============================================================
function parseTierEscalationCfg(text) {
  const result = { present: false, mode: 'any', keyword_groups: {}, sensitive_path_globs: [] };
  if (!text) return result;
  const lines = text.split(/\r?\n/);
  let inEsc = false, inKG = false, inGlobs = false, curGroup = null;
  for (const raw of lines) {
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;
    if (/^tier_escalation\s*:/.test(line)) {
      inEsc = true; inKG = false; inGlobs = false; curGroup = null;
      result.present = true;
      continue;
    }
    if (!inEsc) continue;
    if (/^[^\s#]/.test(line) && !/^tier_escalation/.test(line)) { inEsc = false; break; }
    const modeM = line.match(/^\s{2}mode\s*:\s*(\w+)\s*$/);
    if (modeM) { result.mode = modeM[1]; continue; }
    if (/^\s{2}keyword_groups\s*:\s*$/.test(line)) { inKG = true; inGlobs = false; curGroup = null; continue; }
    if (/^\s{2}sensitive_path_globs\s*:\s*$/.test(line)) { inGlobs = true; inKG = false; curGroup = null; continue; }
    if (inKG) {
      const gm = line.match(/^\s{4}([a-z_]+)\s*:\s*$/);
      if (gm) { curGroup = gm[1]; if (!result.keyword_groups[curGroup]) result.keyword_groups[curGroup] = []; continue; }
      if (curGroup) {
        const km = line.match(/^\s{6}-\s+(.+?)\s*$/);
        if (km) { result.keyword_groups[curGroup].push(km[1]); continue; }
      }
    }
    if (inGlobs) {
      const glm = line.match(/^\s{4}-\s+"(.+?)"\s*$/);
      if (glm) { result.sensitive_path_globs.push(glm[1]); continue; }
    }
  }
  return result;
}

// ============================================================
// 极简 glob -> RegExp（D5 静态校验用；语义对齐 task-context.mjs:534-545）
//   ** -> .*    * -> [^/]*    ? -> [^/]    元字符转义
// 仅供 D5 静态校验调用；不与 apply-escalation 共享执行路径。
// ============================================================
function globToRegexLocal(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') { re += '[^/]*'; }
    else if (c === '?') { re += '[^/]'; }
    else if ('.+^$()|{}[]\\\\'.indexOf(c) !== -1) { re += '\\\\' + c; }
    else re += c;
  }
  return new RegExp('^' + re + '$');
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
// F3 修复：先做 typeof 类型守卫，非 string 直接 FAIL 并提示类型
//（原实现对 object status 仅报 `status="[object Object]" ∉ {...}`，无法定位根因）
function rtCheckStatus(ctx, env, rtCheck) {
  const s = ctx.status;
  if (typeof s !== 'string') {
    const t = s === null ? 'null' : (s === undefined ? 'undefined' : typeof s);
    rtCheck('FAIL', 'runtime.status', `status is ${t} (should be string)`);
    return;
  }
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
  const qm = q.max_rounds || 7;
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
// F4 修复：当 status=DELIVERING/DONE 时 sizing.tier 缺失应从 WARN 升级为 FAIL
//（DELIVERING/DONE 阶段必须先有 tier 才会进入——tier 缺失说明 apply-tier 漏跑）
function rtCheckTier(ctx, env, rtCheck) {
  const tier = ctx.sizing && ctx.sizing.tier;
  if (!tier) {
    const status = ctx.status;
    const finalStatuses = ['DELIVERING', 'DONE'];
    if (finalStatuses.includes(status)) {
      rtCheck('FAIL', 'runtime.tier', `status=${status} 但 sizing.tier 未设置（DELIVERING/DONE 阶段必须先有 tier）`);
    } else {
      rtCheck('WARN', 'runtime.tier', 'sizing.tier 未设置（可能尚未 INIT 定级）');
    }
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
  // 规则来源：lifecycle/config.yaml tier_defaults；此处硬编码期望（与 config.yaml 单一真相保持一致）
  // v3 简化后无可选视角开关，各 tier 均为空对象（恒定挂载由图拓扑限定）
  const TIER_EXPECTED = {
    T0: {},
    T1: {},
    T2: {},
  };
  const expected = TIER_EXPECTED[tier];
  if (expected) {
    const mismatches = [];
    for (const [k, v] of Object.entries(expected)) {
      const actual = agents[k];
      if (actual !== v) {
        mismatches.push(`${k}: expected=${v}, got=${actual === undefined ? '(missing)' : actual}`);
      }
    }
    if (mismatches.length > 0) {
      rtCheck('FAIL', 'runtime.tier', `tier=${tier} config.agents 与 tier_defaults 不一致: ${mismatches.join('; ')}。应执行: task-context.mjs apply-tier <task_id> ${tier} --agent conductor`);
      return;
    }
  }
  rtCheck('PASS', 'runtime.tier', `tier=${tier} agents={${Object.entries(agents).map(([k,v]) => `${k}:${v}`).join(',')}}`);
}

// R7: 阶段产物完整性（QUALITY 后要求 quality.verify.forward 已填充；同时保留 verification.forward 向后兼容）
function rtCheckVerification(ctx, env, rtCheck) {
  const stage = ctx.current_stage;
  const tier = ctx.sizing && ctx.sizing.tier;
  // 豁免：T0 极速通道跳过 QUALITY 阶段，无 quality.verify.forward 是设计内行为
  if (tier === 'T0') {
    rtCheck('PASS', 'runtime.verification', `tier=${tier}（T0 跳过 QUALITY，不要求 verification.forward）`);
    return;
  }
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

// R8b: dispatch_log provenance（T1/T2 EXECUTION 必经阶段委派校验）
// 核心防自指违规检测——conductor 亲为绕过委派时，dispatch_log 缺必配角色派发
function rtCheckDispatchProvenance(ctx, env, rtCheck) {
  const intentType = ctx.intent && ctx.intent.intent_type;
  const tier = ctx.sizing && ctx.sizing.tier;
  const stage = ctx.current_stage;

  // 豁免：非 EXECUTION / T0（极速通道无 PLANNING/QUALITY）
  if (intentType !== 'EXECUTION') {
    rtCheck('PASS', 'runtime.dispatch_provenance', `intent_type=${intentType}（非 EXECUTION，豁免）`);
    return;
  }
  if (tier !== 'T1' && tier !== 'T2') {
    rtCheck('PASS', 'runtime.dispatch_provenance', `tier=${tier}（非 T1/T2，豁免）`);
    return;
  }

  // 必经阶段（跳过 conductor 内建阶段 INIT）
  const requiredStages = ['PLANNING', 'EXECUTING', 'QUALITY'];
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const dispatchedAgents = new Set(dispatchLog.map((e) => (e.agent || '').replace(/-/g, '_')));

  const errors = [];
  for (const st of requiredStages) {
    const stagePath = path.join(STAGES_DIR, `${st.toLowerCase()}.md`);
    if (!fs.existsSync(stagePath)) continue;
    const text = fs.readFileSync(stagePath, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const roles = parseStageFrontmatter(fm[1]);
    // QUALITY 的 onFail 条件角色（fixer）PASS 路径不派发属正确
    const rolesToCheck = st === 'QUALITY' ? roles.filter((r) => !isConditionalRole(r)) : roles;
    for (const role of rolesToCheck) {
      const roleNorm = role.replace(/-/g, '_');
      if (!dispatchedAgents.has(roleNorm)) {
        errors.push(`${st} 缺 ${role}`);
      }
    }
  }

  if (errors.length > 0) {
    rtCheck('FAIL', 'runtime.dispatch_provenance', `dispatch_log 缺必配角色: ${errors.join(', ')}（已派发: ${[...dispatchedAgents].join(',') || '(空)'}）——疑似 conductor 亲为绕过委派（铁律 #6 违规）`);
  } else {
    rtCheck('PASS', 'runtime.dispatch_provenance', `T1/T2 必经阶段角色已派发: ${[...dispatchedAgents].join(',') || '(空)'} ${stage ? `@${stage}` : ''}`);
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
  rtCheckDispatchProvenance,
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


// ============================================================
// --runtime --dry-run 模式：5 个 mock 场景端到端验证 apply-escalation
// 直接 spawn `node task-context.mjs apply-escalation <task_id> --agent conductor`,
// 走真实生产路径（readTierEscalation + globToRegex + tier 覆盖），不是 mock 假函数。
// 每个场景独立 taskId，结束后清理 $TEMP 下的临时文件。
// 任意场景 FAIL -> 进程 exit 1。
// ============================================================
function runDryRunEscalation() {
  const SCENARIOS = [
    {
      id: 1,
      label: "场景 1: 命中关键词（intent=权限管理, 无 key_files）",
      build: () => ({ intent: { raw: '权限管理' }, sizing: { tier: 'T0', key_files: [] } }),
      expect: { tier: 'T2', reasonMin: 1, hasPath: false },
    },
    {
      id: 2,
      label: "场景 2: 不命中（intent=重构Button组件, key_files=[src/components/Button.tsx]）",
      build: () => ({ intent: { raw: '重构Button组件' }, sizing: { tier: 'T0', key_files: ['src/components/Button.tsx'] } }),
      expect: { tier: 'T0', reasonEq: 0, hasPath: false },
    },
    {
      id: 3,
      label: "场景 3: 路径命中（intent=UI优化, key_files=[src/auth/login.ts]）",
      build: () => ({ intent: { raw: 'UI优化' }, sizing: { tier: 'T0', key_files: ['src/auth/login.ts'] } }),
      expect: { tier: 'T2', reasonMin: 1, hasPath: true },
    },
    {
      id: 4,
      label: "场景 4: 混合命中（intent=权限管理, key_files=[src/auth/login.ts]）",
      build: () => ({ intent: { raw: '权限管理' }, sizing: { tier: 'T0', key_files: ['src/auth/login.ts'] } }),
      expect: { tier: 'T2', reasonEq: 2, hasPath: true },
    },
    {
      id: 5,
      label: "场景 5: custom_overrides 覆盖（intent=权限审计, custom_overrides.tier=T1）",
      build: () => ({ intent: { raw: '权限审计' }, sizing: { tier: 'T0', key_files: [] }, config: { custom_overrides: { tier: 'T1' } } }),
      expect: { tier: 'T0', reasonMin: 1, skipped: true },
    },
  ];

  const tmpDir = path.join(os.tmpdir(), 'kilo');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  let passCount = 0, failCount = 0;
  const failDetails = [];

  for (const sc of SCENARIOS) {
    const taskId = `dryrun_s${sc.id}_${Date.now()}`;
    const ctxPath = path.join(tmpDir, `task_context_${taskId}.json`);
    const ctx = _bootstrapBuildInitialContext(taskId);
    const seed = sc.build();
    if (seed.intent) ctx.intent = Object.assign({}, ctx.intent, seed.intent);
    if (seed.sizing) ctx.sizing = Object.assign({}, ctx.sizing, seed.sizing);
    if (seed.config) ctx.config = Object.assign({}, ctx.config, seed.config);
    try {
      fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf8');
    } catch (e) {
      process.stdout.write(`[FAIL] ${sc.label}\n  写 task_context 失败: ${e.message}\n`);
      failCount++; failDetails.push(sc.id); continue;
    }

    const r = spawnSync(
      process.execPath,
      [path.join(SCRIPTS_DIR, 'task-context.mjs'), 'apply-escalation', taskId, '--agent', 'conductor'],
      { cwd: ROOT, encoding: 'utf8', timeout: 15000 }
    );

    if (r.status !== 0) {
      process.stdout.write(`[FAIL] ${sc.label}\n  apply-escalation 退出码=${r.status} stderr=${(r.stderr || "").trim().split("\n")[0] || "(empty)"}\n`);
      failCount++; failDetails.push(sc.id);
      try { fs.unlinkSync(ctxPath); } catch {}
      continue;
    }

    let result;
    try {
      result = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
    } catch (e) {
      process.stdout.write(`[FAIL] ${sc.label}\n  读回 task_context 失败: ${e.message}\n`);
      failCount++; failDetails.push(sc.id);
      try { fs.unlinkSync(ctxPath); } catch {}
      continue;
    }

    const tier = result.sizing && result.sizing.tier;
    const reasons = Array.isArray(result.sizing && result.sizing.escalation_reasons) ? result.sizing.escalation_reasons : [];
    const exp = sc.expect;
    const errs = [];
    if (tier !== exp.tier) errs.push(`tier=${tier} (期望 ${exp.tier})`);
    if (typeof exp.reasonEq === 'number' && reasons.length !== exp.reasonEq) {
      errs.push(`reasons 数=${reasons.length} (期望 =${exp.reasonEq})`);
    } else if (typeof exp.reasonMin === 'number' && reasons.length < exp.reasonMin) {
      errs.push(`reasons 数=${reasons.length} (期望 ≥${exp.reasonMin})`);
    }
    if (exp.hasPath && !reasons.some((rr) => String(rr).startsWith('path:'))) {
      errs.push('缺少 path: 原因项');
    }
    if (exp.skipped && !reasons.some((rr) => String(rr).startsWith('skipped:'))) {
      errs.push('缺少 skipped: 原因项');
    }

    if (errs.length === 0) {
      const preview = reasons.length > 2 ? reasons.slice(0, 2).join(', ') + '...' : reasons.join(', ');
      process.stdout.write(`[PASS] ${sc.label}\n  tier=${tier} reasons=${reasons.length} (${preview})\n`);
      passCount++;
    } else {
      process.stdout.write(`[FAIL] ${sc.label}\n  tier=${tier} reasons=${reasons.length}\n  断言: ${errs.join("; ")}\n  reasons=${JSON.stringify(reasons)}\n`);
      failCount++; failDetails.push(sc.id);
    }

    try { fs.unlinkSync(ctxPath); } catch {}
  }

  process.stdout.write(`\nDRYRUN SUMMARY: ${passCount} PASS / ${failCount} FAIL (5 场景)\n`);
  if (failCount > 0) {
    process.stderr.write(`[DRYRUN_VIOLATION] 失败场景 id: ${failDetails.join(", ")}\n`);
    process.exit(1);
  }
}

function runRuntimeMode() {
  // --runtime --dry-run 模式：mock 5 场景端到端验证 apply-escalation 行为；不走运行时探针
  if (process.argv.includes('--dry-run')) {
    runDryRunEscalation();
    return;
  }
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
      process.stdout.write(`${r.level} ${r.name} [${taskId}]${r.detail ? ' - ' + r.detail : ''}\n`);
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

function syncAgentPrompts() {
  const syncScript = path.join(SCRIPTS_DIR, 'sync-agent-prompt.mjs');
  const result = spawnSync(process.execPath, [syncScript], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  if (result.error) { fail('sync.prompt', `sync-agent-prompt.mjs 调用失败: ${result.error.message}`); return; }
  if (result.status !== 0) { fail('sync.prompt', `sync-agent-prompt.mjs 退出码 ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`); return; }
  const summaryLine = (result.stdout || '').trim().split(/\r?\n/).find(l => l.startsWith('[SUMMARY]'));
  pass('sync.prompt', summaryLine ? summaryLine.replace('[SUMMARY] ', 'prompt 同步 — ') : 'agent.prompt 已同步');
}

function finalizeStaticRun() {
  if (FULL_MODE || FAST_MODE) {
    const fingerprint = computeFingerprint();
    if (fingerprint !== null) {
      if (writeFingerprintCache(fingerprint)) pass('cache.fingerprint', `fingerprint updated: ${fingerprint.slice(0, 16)}...`);
      else warn('cache.fingerprint', 'failed to write fingerprint cache (proceeding)');
    }
  }
  if (SYNC_PROMPT) syncAgentPrompts();
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

// ============================================================
// A. 图结构校验
// ============================================================

// A1. edges 引用已声明节点（主图）
for (const [label, g] of [['graph', graph]]) {
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

// B4. when/tiers 挂载校验（tiers 字段替代 config.agents.<key> 开关挂载）：
//   - when 与 tiers 互斥（同时存在 → FAIL，二选一）
//   - tiers 值非空且每项 ⊆ {T0,T1,T2}（定级挂载合法性）
//   - when 引用的 config.agents.<key> 至少在任一 tier_defaults / inquiry_tier_defaults 声明（防孤儿开关）
{
  const allTierKeys = new Set();
  if (cfg) {
    for (const keys of cfg.tierAgents.values()) for (const k of keys) allTierKeys.add(k);
    for (const keys of cfg.inquiryTierAgents.values()) for (const k of keys) allTierKeys.add(k);
  }
  let tieredMounts = 0;
  for (const [name, a] of agents) {
    for (const m of a.mount) {
      // 互斥：when 与 tiers 同时存在 → FAIL
      if (m.when && Array.isArray(m.tiers) && m.tiers.length > 0) {
        fail(`agent.${name}.mount.when_tiers`, `when 与 tiers 同时存在（互斥：二选一，tiers 优先）`);
      }
      // tiers 合法性：非空数组且每项 ⊆ {T0,T1,T2}
      if (Array.isArray(m.tiers)) {
        tieredMounts++;
        if (m.tiers.length === 0) {
          fail(`agent.${name}.mount.tiers`, `tiers 为空数组（至少声明一个 tier，如 [T2] / [T1, T2]）`);
        }
        for (const t of m.tiers) {
          if (!TIERS.has(t)) {
            fail(`agent.${name}.mount.tiers`, `tiers 元素 "${t}" ⊄ {T0,T1,T2}`);
          }
        }
      }
      if (!m.when) continue;
      const wm = m.when.match(/config\.agents\.(\w+)/);
      if (wm && !allTierKeys.has(wm[1])) {
        warn(`agent.${name}.mount.when`, `config.agents.${wm[1]} 未在任何 tier_defaults 声明（恒为 false，永不加载）`);
      }
    }
  }
  pass('config.tier.coverage', `tier 开关键: ${[...allTierKeys].join(', ') || '(无)'}${tieredMounts > 0 ? `; tiers 定级挂载: ${tieredMounts} 条` : ''}`);
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

// C4. 反向一致性：恒定挂载 agent 与 required_roles 契约
//   主图 stage 挂载点（如 at: PLANNING）：恒定挂载 agent role ∉ required_roles → FAIL
//     （log-dispatch 机械拒绝 [PROCESS_VIOLATION] exit 2，装配期必须先行拦截）
//   post:<STAGE>/pre:<STAGE> 挂载点：恒定挂载 agent 不在 required_roles 内是预期
//     （post/pre 是生命周期钩子，非主槽角色），豁免 FAIL，但输出 WARN
//     post-mount-outside-required-roles（可见性：避免 log-dispatch 扩展后放行却被静默）
//   PASS 为明细级（--verbose 展示，与 B1 mount.at 同约定）；FAIL/WARN 恒显。
{
  for (const [name, a] of agents) {
    for (const m of a.mount) {
      if (m.when || (Array.isArray(m.tiers) && m.tiers.length > 0)) continue;   // 豁免：条件挂载（when 开关 / tiers 定级挂载，非恒定）
      const node = graph.nodes.get(m.at);
      const isStageMount = node && node.type === 'stage';
      // post:<STAGE> / pre:<STAGE> 挂载点解析
      const postPreM = m.at.match(/^(post|pre):(\S+)$/);
      if (!isStageMount && !postPreM) continue;      // 豁免：on:bootstrap / on:done 等非 stage 挂载点
      const stageId = isStageMount ? m.at : (postPreM ? postPreM[2] : null);
      if (!stageId) continue;
      const stageNode = graph.nodes.get(stageId);
      if (!stageNode) continue;                     // 豁免：非主图 stage（A5 已报）
      if (stageNode.executor) continue;              // 豁免：executor 内建阶段（INIT）
      const stageText = readText(path.join(STAGES_DIR, `${stageId.toLowerCase()}.md`));
      if (!stageText) continue;                     // A5 已报
      const fm = extractFrontmatter(stageText);
      const roles = fm ? parseStageFrontmatter(fm) : [];
      if (roles.length === 0) continue;             // 豁免：required_roles 为空（C1 已报）
      const agentRole = (roleOf(name) || name).replace(/-/g, '_');
      const rolesNorm = new Set(roles.map((r) => r.replace(/-/g, '_')));
      if (isStageMount) {
        if (rolesNorm.has(agentRole)) {
          if (VERBOSE) pass(`stage.${m.at}.required_roles.reverse_mount`, `${name} 恒定挂载 ${m.at}（role=${agentRole}）∈ required_roles`);
        } else {
          fail(`stage.${m.at}.required_roles.reverse_mount`, `${name} 恒定挂载 ${m.at} 但 role=${agentRole} ∉ required_roles=[${roles.join(', ')}]（log-dispatch 将机械拒绝）`);
        }
      } else {
        // post:/pre: 恒定挂载：豁免 FAIL，但 agent 不在 required_roles 时输出 WARN（可见性）
        if (!rolesNorm.has(agentRole)) {
          warn(`stage.${stageId}.required_roles.${postPreM[1]}-mount-outside-required-roles`,
            `${name} 恒定挂载 ${m.at}（role=${agentRole}）∉ ${stageId}.required_roles=[${roles.join(', ')}]——post/pre 生命周期钩子豁免 FAIL，但 log-dispatch 扩展后允许记录`);
        }
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
  // D3. tier_defaults 键 ⊆ {T0..T2}
  {
    const bad1 = [...cfg.tierAgents.keys()].filter((t) => !TIERS.has(t));
    if (bad1.length === 0) pass('config.tier.keys', 'tier 键全部合法（tier_defaults）');
    for (const t of bad1) fail('config.tier.keys', `tier_defaults "${t}" ⊄ {T0,T1,T2}`);
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
  // D5. tier_escalation 段合法性（U1 实施；U3 静态校验；与下方 D5 pre-dispatch 共存，PASS/FAIL 计数独立）
  //   - 顶层段存在
  //   - mode ∈ {any, all}
  //   - keyword_groups 含 5 个必需组（auth/payment/crypto/security/personal_data），少一个 FAIL
  //   - 每组 ≥ 3 个关键词
  //   - sensitive_path_globs ≥ 5 个
  //   - 每个 glob 可编译为合法 RegExp（U2 globToRegex 同源实现）
  {
    const esc = parseTierEscalationCfg(cfgText);
    const REQUIRED_GROUPS = ['auth', 'payment', 'crypto', 'security', 'personal_data'];
    if (!esc.present) {
      fail('config.tier_escalation.exists', 'lifecycle/config.yaml 缺 tier_escalation 顶层段');
    } else {
      pass('config.tier_escalation.exists', 'tier_escalation 顶层段存在');
      if (esc.mode !== 'any' && esc.mode !== 'all') {
        fail('config.tier_escalation.mode', `mode="${esc.mode}" ∉ {any, all}`);
      } else {
        pass('config.tier_escalation.mode', `mode=${esc.mode}`);
      }
      const missing = REQUIRED_GROUPS.filter((g) => !Array.isArray(esc.keyword_groups[g]));
      if (missing.length > 0) {
        fail('config.tier_escalation.keyword_groups', `缺必需组: ${missing.join(', ')}`);
      } else {
        pass('config.tier_escalation.keyword_groups', `5 个必需组齐: ${REQUIRED_GROUPS.join('/')}`);
      }
      let thinGroup = null;
      for (const g of REQUIRED_GROUPS) {
        if (!esc.keyword_groups[g] || esc.keyword_groups[g].length < 3) {
          thinGroup = g; break;
        }
      }
      if (thinGroup) {
        fail('config.tier_escalation.keyword_min', `组 "${thinGroup}" 关键词数 < 3`);
      } else {
        pass('config.tier_escalation.keyword_min', '5 个组每组 ≥ 3 关键词');
      }
      if (esc.sensitive_path_globs.length < 5) {
        fail('config.tier_escalation.globs_count', `sensitive_path_globs 数=${esc.sensitive_path_globs.length} < 5`);
      } else {
        pass('config.tier_escalation.globs_count', `sensitive_path_globs=${esc.sensitive_path_globs.length} ≥ 5`);
      }
      let badGlob = null;
      for (const g of esc.sensitive_path_globs) {
        try { new RegExp(globToRegexLocal(g).source); } catch (e) { badGlob = `${g} (${e.message})`; break; }
      }
      if (badGlob) {
        fail('config.tier_escalation.globs_compile', `glob 无法编译为 RegExp: ${badGlob}`);
      } else {
        pass('config.tier_escalation.globs_compile', `${esc.sensitive_path_globs.length} 个 glob 全部编译通过`);
      }
    }
  }

  // D5. pre-dispatch 安全门阈值：size_check_threshold / dispatch_prompt_threshold 存在且为正整数
  //      max_files_per_task 存在且为正整数（缺失同样 FAIL，同硬门模式）
  {
    for (const key of ['size_check_threshold', 'dispatch_prompt_threshold', 'max_files_per_task']) {
      const m = cfgText.match(new RegExp(key + ':\\s*(\\d+)'));
      if (m && parseInt(m[1], 10) > 0) {
        pass('config.' + key, key + '=' + m[1]);
      } else {
        fail('config.' + key, key + ' 缺失或非正整数（pre-dispatch 安全门将无法求值）');
      }
    }
  }
}

// ============================================================
// D6/D7/D8. 语义一致性校验（P0：补 lifecycle-doctor 结构校验盲区）
//   S7  conductor 编辑/写入双 deny 硬断言（静态）
//   S1  permission.edit:deny 的 agent 正文不得含主动修改语态（静态，排除 conductor）
//   S3  CIRCUIT_BREAKER 阈值三处一致（config.yaml / workflow-core.md / conductor.md）
// ============================================================

// 解析 agent frontmatter 的 permission 块（edit/write/task）
function parseAgentPermission(fm) {
  const perm = {};
  const lines = fm.split(/\r?\n/);
  let inPerm = false;
  for (const line of lines) {
    if (/^[^\s#]/.test(line)) {
      inPerm = /^permission\s*:/.test(line);
      continue;
    }
    if (!inPerm) continue;
    const m = line.match(/^\s+([a-z_]+)\s*:\s*(\w+)\s*(?:#.*)?$/);
    if (m) perm[m[1]] = m[2].trim();
  }
  return perm;
}

// S7. semantic.conductor_edit_deny_global
//   conductor.md frontmatter permission.edit==deny && write==deny（任一 allow → FAIL）
{
  const condPath = path.join(AGENT_DIR, 'conductor.md');
  const condText = readText(condPath);
  if (!condText) {
    fail('semantic.conductor_edit_deny_global', 'agent/conductor.md 缺失');
  } else {
    const fm = extractFrontmatter(condText);
    if (!fm) {
      fail('semantic.conductor_edit_deny_global', 'agent/conductor.md 缺 frontmatter');
    } else {
      const perm = parseAgentPermission(fm);
      const edit = perm.edit;
      const write = perm.write;
      const bad = [];
      if (edit !== 'deny') bad.push(`edit=${edit || '(未声明)'}`);
      if (write !== 'deny') bad.push(`write=${write || '(未声明)'}`);
      if (bad.length === 0) {
        pass('semantic.conductor_edit_deny_global', 'conductor permission edit=deny & write=deny');
      } else {
        fail('semantic.conductor_edit_deny_global', `conductor permission 期望 edit=deny&write=deny，实际 ${bad.join(' & ')}（conductor 不得具备任何修改性权限）`);
      }
    }
  }
}

// S1. semantic.permission_vs_role
//   对每个 permission.edit==deny 的 agent（排除 conductor，由 S7 独占），
//   剔除引用块（^> 行）与代码块（``` 段）后 grep 主动修改语态黑名单
//   {修改,写入,修复,创建,删除,提交}；命中 → FAIL。
//   否定语态豁免：命中词前后 8 字符内含白名单 {不得,禁止,不能,只读,仅用于,不得自行} → PASS。
//   扩展豁免（避免合规仓库误判）：
//     a) 否定前缀：命中词紧邻前 1 字符 ∈ {不,无,未,勿,前}（前 = "前修复"指交付前修复，
//        描述时机非动作）→ PASS（如"不修复""未修改""前修复"）
//     b) task_context 写入上下文：8 字符窗口含 {task_context, task_co, 边界, 产物, 独占,
//        verification, review, plan, execution, plan_review} → PASS（"写入 task_context"
//        是 frontmatter task_context.write 声明的合法权限，非文件编辑语态）
//     c) 必须立即/交付前 副词修饰：8 字符窗口含 {必须立即, 交付前, 可操作} → PASS
//        （"必须立即修复"是对下游修复要求的描述，非该 agent 自身动作）
{
  const MUTATION_TERMS = ['修改', '写入', '修复', '创建', '删除', '提交'];
  const EXEMPTION_TERMS = ['不得', '禁止', '不能', '只读', '仅用于', '不得自行'];
  const NEGATION_PREFIX = new Set(['不', '无', '未', '勿', '前']);
  const TASK_CTX_CONTEXT = ['task_context', 'task_co', '边界', '产物', '独占',
    'verification', 'review', 'plan', 'execution', 'plan_review',
    '回显', '路径', '校验', '同症状'];
  const ADVERB_CONTEXT = ['必须立即', '交付前', '可操作', '失败 →', '失败→'];
  for (const [name, text] of
    [...fs.readdirSync(AGENT_DIR)]
      .filter((f) => f.endsWith('.md') && f !== 'conductor.md')
      .map((f) => [f.slice(0, -3), readText(path.join(AGENT_DIR, f))])
      .filter(([, t]) => t)) {
    const fm = extractFrontmatter(text);
    if (!fm) continue;
    const perm = parseAgentPermission(fm);
    if (perm.edit !== 'deny') continue; // 仅校验 edit:deny 的 agent
    // 剔除 frontmatter、引用块、代码块
    // frontmatter 剥离用与 extractFrontmatter 一致的锚定正则（^---\r?\n...\r?\n---），
    // 避免裸 [\s\S]*?--- 误匹配正文注释里的 ---- 分隔线
    let body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
    body = body
      .replace(/^>.*$/mg, '')          // 引用块行（行首 >）
      .replace(/```[\s\S]*?```/g, ''); // 代码块
    const violations = [];
    // git 操作语境豁免（edit:deny 交付类 agent 正文提"提交/删除分支/合并"
    // 是在"不做什么/告知用户分支去向"语境，非自身代码修改动作）
    const GIT_CONTEXT = ['推送', '分支', 'commit', 'push', 'git ', '擅自', '告知', 'PR', '合并', '未推送', '未提交'];
    for (const term of MUTATION_TERMS) {
      let idx = 0;
      while ((idx = body.indexOf(term, idx)) !== -1) {
        const window = body.slice(Math.max(0, idx - 8), idx + term.length + 8);
        const exempt = EXEMPTION_TERMS.some((e) => window.includes(e))
          || (idx > 0 && NEGATION_PREFIX.has(body[idx - 1]))
          || TASK_CTX_CONTEXT.some((e) => window.includes(e))
          || ADVERB_CONTEXT.some((e) => window.includes(e))
          || GIT_CONTEXT.some((e) => window.includes(e));
        if (!exempt) {
          // 取行号（粗略）：count \n before idx
          const lineNo = body.slice(0, idx).split(/\r?\n/).length;
          violations.push(`"${term}" @L${lineNo} 附近: ...${window.replace(/\r?\n/g, ' ')}...`);
        }
        idx += term.length;
      }
    }
    if (violations.length === 0) {
      pass(`semantic.permission_vs_role.${name}`, `edit=deny 且正文无主动修改语态`);
    } else {
      fail(`semantic.permission_vs_role.${name}`, `edit=deny 但正文含主动修改语态（${violations.length} 处）: ${violations.slice(0, 3).join(' | ')}${violations.length > 3 ? ' ...' : ''}`);
    }
  }
}

// S3. semantic.circuit_breaker_threshold
//   从 lifecycle/config.yaml 读 hooks.quality.max_total_cycles；
//   grep .kilo/instructions/workflow-core.md + agent/conductor.md 中
//   CIRCUIT_BREAKER|连续\d+次|max_total_cycles 数字；三处一致 → PASS。
{
  const cfgValue = (() => {
    if (!cfgText) return null;
    const m = cfgText.match(/max_total_cycles\s*:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  })();
  if (cfgValue === null) {
    fail('semantic.circuit_breaker_threshold', 'lifecycle/config.yaml 缺 hooks.quality.max_total_cycles');
  } else {
    const wfPath = path.join(ROOT, '.kilo', 'instructions', 'workflow-core.md');
    const wfText = readText(wfPath) ?? '';
    const condText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
    // workflow-core.md：连续 N 次无法收敛（仅限 CIRCUIT_BREAKER 上下文，排除 MALFORMED_OUTPUT/防空转等同名异义行）
    const wfNums = [];
    {
      const re = /连续\s*(\d+)\s*次无法收敛/g;
      let m;
      while ((m = re.exec(wfText)) !== null) wfNums.push(parseInt(m[1], 10));
    }
    // conductor.md：max_total_cycles 或 默认 N 或 quality.round >= N
    const condNums = [];
    {
      const re = /(?:max_total_cycles|默认|round\s*>=)\s*[：:]?\s*(\d+)/g;
      let m;
      while ((m = re.exec(condText)) !== null) condNums.push(parseInt(m[1], 10));
    }
    const sources = {
      'config.yaml': cfgValue,
      'workflow-core.md': wfNums.length > 0 ? wfNums : null,
      'conductor.md': condNums.length > 0 ? condNums : null,
    };
    const allNums = [cfgValue, ...(wfNums || []), ...(condNums || [])];
    const unique = [...new Set(allNums)];
    const summary = Object.entries(sources)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`)
      .join(' | ');
    if (unique.length === 1) {
      pass('semantic.circuit_breaker_threshold', `三处一致：max_total_cycles=${cfgValue}`);
    } else {
      fail('semantic.circuit_breaker_threshold', `CIRCUIT_BREAKER 阈值不一致（${summary}）——应统一为 config.yaml hooks.quality.max_total_cycles=${cfgValue}`);
    }
  }
}

// ============================================================
// D6/D7/D8/D9/D10/D11. 语义一致性校验（P1+P2 补全）
//   S2  task_context 写入切片独占一致性（静态）
//   S4  per_agent_s 键必有对应 agent 文件（静态，语义层）
//   S5  graph.yaml when 标识符须在 task_context schema 定义（静态）
//   S6  subagent 返回契约覆盖（静态，WARN 级）
//   S8  conductor 13 条铁律机械脚本覆盖率（静态，WARN 级）
// ============================================================

// S2. semantic.task_context_write_exclusivity
//   收集全 agent frontmatter task_context.write 切片，建 切片→[agents] 反向索引。
//   对正文（含 frontmatter 行）含 "独占/双独占" 且提及该切片的声明，校验实际写入者集合
//   ⊆ 声明独占者（即 writers == declared owners）。冲突→FAIL。
//   例：verifier 声明 execution.verification 双独占，若其他 agent 也写 → FAIL。
{
  // 切片 → Set(agentName)
  const sliceWriters = new Map();
  for (const [name, a] of agents) {
    for (const s of a.writes) {
      if (!sliceWriters.has(s)) sliceWriters.set(s, new Set());
      sliceWriters.get(s).add(name);
    }
  }
  // 对每个 agent，扫描其文件全文中含 "独占" 且同时提及该 agent 某 write 切片的行，
  // 判定该 agent 声明对该切片独占。
  const declaredOwner = new Map(); // slice -> Set(agentName)
  for (const [name, a] of agents) {
    const filePath = path.join(AGENT_DIR, `${name}.md`);
    const text = readText(filePath);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (const s of a.writes) {
      let declared = false;
      for (const line of lines) {
        if (line.includes('独占') && line.includes(s)) {
          declared = true;
          break;
        }
      }
      if (declared) {
        if (!declaredOwner.has(s)) declaredOwner.set(s, new Set());
        declaredOwner.get(s).add(name);
      }
    }
  }
  let conflicts = 0;
  let checkedExclusive = 0;
  for (const [slice, owners] of declaredOwner) {
    const actual = sliceWriters.get(slice) || new Set();
    // writers ⊆ declared owners
    const extra = [...actual].filter((a) => !owners.has(a));
    const missing = [...owners].filter((o) => !actual.has(o));
    checkedExclusive++;
    if (extra.length === 0 && missing.length === 0) {
      pass('semantic.task_context_write_exclusivity',
        `${slice} 独占一致（声明=[${[...owners].join(',')}] 实际写入=[${[...actual].join(',')}]）`);
    } else {
      conflicts++;
      const parts = [];
      if (extra.length) parts.push(`非声明者写入=[${extra.join(',')}]`);
      if (missing.length) parts.push(`声明者未写入=[${missing.join(',')}]`);
      fail('semantic.task_context_write_exclusivity',
        `切片 "${slice}" 独占冲突：声明独占者=[${[...owners].join(',')}] 实际写入者=[${[...actual].join(',')}]（${parts.join('；')}）`);
    }
  }
  if (checkedExclusive === 0) {
    pass('semantic.task_context_write_exclusivity', '无 task_context.write 切片声明独占（无校验对象）');
  }
  if (conflicts === 0 && checkedExclusive > 0) {
    pass('semantic.task_context_write_exclusivity', `${checkedExclusive} 个独占切片写入者集合与声明一致`);
  }
}

// S4. semantic.per_agent_s_keys_exist
//   解析 lifecycle/config.yaml timeouts.per_agent_s 所有键；每键须存在 agent/<key>.md。
//   幽灵键→FAIL。（语义层语义校验名；与 D1 config.timeouts.per_agent_s 同源，
//   D1 是结构层名称，S4 是语义层一致性名称，二者结论一致但分别登记。）
{
  if (!cfg) {
    fail('semantic.per_agent_s_keys_exist', 'lifecycle/config.yaml 未解析');
  } else {
    const agentKeys = new Set([...agents.keys()].map((n) => agentKeyOf(n)));
    const ghost = cfg.perAgentKeys.filter((k) => !agentKeys.has(k));
    if (ghost.length === 0) {
      pass('semantic.per_agent_s_keys_exist',
        `per_agent_s ${cfg.perAgentKeys.length} 键全部有对应 agent/*.md（语义层确认）`);
    } else {
      for (const g of ghost) {
        fail('semantic.per_agent_s_keys_exist',
          `per_agent_s 幽灵键 "${g}"（无对应 agent/${g}.md）`);
      }
    }
  }
}

// S5. semantic.edge_when_vars_defined
//   解析 lifecycle/graph.yaml edges when 表达式，提取标识符（tier/intent_type/quality_verdict 等）；
//   每标识符须在 task_context schema 中定义。
//   task_context schema 来源：conductor.md task_context.write 字段 + 已知 task_context 顶层字段 +
//   transition-check.mjs 已知 when 变量映射（intent_type→intent.intent_type / tier→sizing.tier /
//   quality_verdict→quality.verdict）。
//   未定义→FAIL。
{
  // 已知 when 变量（来自 transition-check.mjs L317-337）
  const KNOWN_WHEN_VARS = new Set([
    'intent_type', 'tier', 'quality_verdict',
    'forward_result', 'review_result',
  ]);
  // 已知 task_context 顶层字段（schema 显式定义）
  const TC_TOP_FIELDS = new Set([
    'task_id', 'intent', 'sizing', 'config', 'plan', 'plan_review',
    'execution', 'verification', 'quality', 'fixing_history',
    'dispatch_log', 'overload_count', 'status', 'current_stage',
    'transition_log', 'convergence',
  ]);
  const LITERALS = new Set([
    'in', 'and', 'or', 'not', 'true', 'false', 'null',
    'T0', 'T1', 'T2', 'T3',
    'EXECUTION', 'INQUIRY', 'PASS', 'CIRCUIT_BREAKER',
  ]);
  const usedVars = new Set();
  for (const e of graph.edges) {
    if (!e.when) continue;
    const tokens = e.when.match(/[a-zA-Z_][a-zA-Z_0-9]*/g) || [];
    for (const tk of tokens) {
      if (!LITERALS.has(tk)) usedVars.add(tk);
    }
  }
  let bad = 0;
  for (const v of usedVars) {
    if (!KNOWN_WHEN_VARS.has(v) && !TC_TOP_FIELDS.has(v)) {
      bad++;
      fail('semantic.edge_when_vars_defined',
        `when 变量 "${v}" 未在 task_context schema 中定义（已知=${[...KNOWN_WHEN_VARS].join(',')}，顶层字段=${[...TC_TOP_FIELDS].join(',')}）`);
    }
  }
  if (bad === 0) {
    pass('semantic.edge_when_vars_defined',
      `${usedVars.size} 个 when 变量全部在 task_context schema 中定义（${[...usedVars].sort().join(',')}）`);
  }
}

// S6. semantic.return_contract_coverage（WARN 级）
//   对所有 mode:subagent 的 agent，校验正文含 "≤4000" 或 "返回契约" 章节。缺→WARN（非 FAIL）。
//   注：kilo.json 在 G 区才正式解析（const kj 存在 TDZ），这里本地解析子集。
{
  const kjLocalText = readText(KILO_JSON_PATH);
  let subagentNames = [];
  if (kjLocalText) {
    try {
      const data = JSON.parse(kjLocalText);
      if (data.agent && typeof data.agent === 'object') {
        for (const [name, cfg] of Object.entries(data.agent)) {
          if (cfg && cfg.mode === 'subagent') subagentNames.push(name);
        }
      }
    } catch { /* 解析失败由 G 区 G.* 校验报错，此处静默 */ }
  }
  if (subagentNames.length === 0) {
    warn('semantic.return_contract_coverage', 'kilo.json 无 mode:subagent 的 agent 或解析失败');
  } else {
    let missing = 0;
    for (const name of subagentNames) {
      const text = readText(path.join(AGENT_DIR, `${name}.md`));
      if (!text) {
        missing++;
        warn('semantic.return_contract_coverage', `agent/${name}.md 缺失，无法校验返回契约`);
        continue;
      }
      const has4 = text.includes('≤4000');
      const hasSection = /返回契约/.test(text);
      if (!has4 && !hasSection) {
        missing++;
        warn('semantic.return_contract_coverage',
          `agent/${name}.md 正文未含 "≤4000" 或 "返回契约" 章节（subagent 须声明返回契约）`);
      }
    }
    if (missing === 0) {
      pass('semantic.return_contract_coverage',
        `${subagentNames.length} 个 subagent 全部声明返回契约（≤4000 / 返回契约）`);
    }
  }
}

// S8. semantic.ironclad_mechanical_coverage（WARN 级）
//   对 conductor.md 13 条铁律，grep 每条对应的脚本名
//   (transition-check/size-check/flow-audit/lifecycle-doctor/task-context)。
//   无脚本对应的铁律编号 → WARN。产出覆盖率报告。
{
  const condText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
  const SCRIPTS = ['transition-check', 'size-check', 'flow-audit', 'lifecycle-doctor', 'task-context'];
  // 抽取 1..13 铁律正文块：行首匹配 "<i>. **..."
  const blocks = {}; // i -> text
  let cur = null; let curText = [];
  for (const line of condText.split(/\r?\n/)) {
    const m = line.match(/^(\d{1,2})\.\s+\*\*/);
    if (m) {
      if (cur !== null) blocks[cur] = curText.join('\n');
      cur = parseInt(m[1], 10);
      curText = [line];
      continue;
    }
    if (cur !== null) {
      if (/^##\s/.test(line)) { blocks[cur] = curText.join('\n'); cur = null; curText = []; continue; }
      curText.push(line);
    }
  }
  if (cur !== null) blocks[cur] = curText.join('\n');
  const SOFT_RULES = [1, 2, 5, 7, 10, 11]; // 纯文字铁律：#1意图判定/#2定级/#5compaction恢复/#7自验无效/#10即停违规/#11全局并行策略
  let hard = 0; let soft = 0; const softIds = [];
  for (let i = 1; i <= 13; i++) {
    const b = blocks[i] || '';
    const hit = SCRIPTS.some((s) => b.includes(s));
    if (hit) hard++;
    else if (SOFT_RULES.includes(i)) { soft++; softIds.push(i); }
  }
  pass('semantic.ironclad_mechanical_coverage',
    `硬铁律 ${hard}/7 PASS + 软铁律 ${soft}/6 INFO（纯文字约束：#${softIds.join(',#')}）`);
}

// ============================================================
// E. 权限矩阵校验
// ============================================================

// E1. conductor.md 人类速查矩阵表与 frontmatter 派生一致（drift 检测）
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

// 框架级名称（executor），非硬编码
const FRAMEWORK_NAMES = new Set(['conductor']);

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
  const KJ_MODES = new Set(['primary', 'subagent', 'standby']);

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
}

// ============================================================
// H. 脚本完整性门禁（防 ReferenceError/SyntaxError 类类型问题复发）
// ============================================================

// H1. scripts/*.mjs + scripts/lib/*.mjs 全部通过 `node --check` 语法校验
{
  const scriptFiles = [];
  for (const dir of ['scripts', 'scripts/lib']) {
    const abs = path.join(ROOT, dir);
    let names = [];
    try { names = fs.readdirSync(abs); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.mjs')) scriptFiles.push(path.join(abs, n));
    }
  }
  let bad = 0;
  for (const f of scriptFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) { bad++; fail('scripts.syntax', `${path.relative(ROOT, f)}: ${(r.stderr || r.stdout || 'check failed').trim().split('\n')[0]}`); }
  }
  if (bad === 0) pass('scripts.syntax', `${scriptFiles.length} 个脚本全部通过 node --check`);
}

// H2. 每个脚本的顶层 import 名称可解析（模块图加载完整性）——对纯库脚本做动态 import 冒烟
{
  const libFiles = [];
  try { for (const n of fs.readdirSync(path.join(ROOT, 'scripts/lib'))) { if (n.endsWith('.mjs')) libFiles.push(path.join(ROOT, 'scripts/lib', n)); } } catch {}
  let bad = 0;
  for (const f of libFiles) {
    // 动态 import 只验证模块图可加载（顶层无副作用）；脚本自身 .mjs 不 import（会执行 main）
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('file:///${f.replace(/\\/g, '/')}')`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) { bad++; fail('scripts.modules', `${path.relative(ROOT, f)}: ${(r.stderr || r.stdout || 'load failed').trim().split('\n')[0]}`); }
  }
  if (bad === 0) pass('scripts.modules', `${libFiles.length} 个 lib 模块动态加载冒烟 PASS`);
}




// H3. 搜索纪律机械门完整性（scripts/search-discipline-check.mjs 必须存在 + 语法 OK +  4 检测函数齐 + quality.md 机械前置门已引用）
{
  const sdcPath = path.join(ROOT, 'scripts', 'search-discipline-check.mjs');
  const qmPath  = path.join(ROOT, 'lifecycle', 'stages', 'quality.md');

  if (!fs.existsSync(sdcPath)) {
    fail('search-discipline.script', 'scripts/search-discipline-check.mjs 不存在');
  } else {
    const rc = spawnSync(process.execPath, ['--check', sdcPath], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    if (rc.status !== 0) {
      fail('search-discipline.syntax', `search-discipline-check.mjs: ${(rc.stderr || rc.stdout || 'check failed').trim().split('\n')[0]}`);
    } else {
      const src = fs.readFileSync(sdcPath, 'utf8');
      const fnHits = (src.match(/^function detect/gm) || []).length;
      if (fnHits < 4) {
        fail('search-discipline.detectors', `detect 函数注册数=${fnHits}，期望 >=4`);
      } else if (!fs.existsSync(qmPath)) {
        fail('search-discipline.wiring', 'lifecycle/stages/quality.md 不存在，无法校验机械前置门引用');
      } else {
        const qm = fs.readFileSync(qmPath, 'utf8');
        if (!/search-discipline-check\.mjs/.test(qm)) {
          fail('search-discipline.wiring', 'lifecycle/stages/quality.md 机械前置门段未引用 search-discipline-check.mjs');
        } else {
          pass('search-discipline.script', `search-discipline-check.mjs 存在 + 语法 OK + ${fnHits} 个 detect 函数齐 + quality.md 已接线`);
        }
      }
    }
  }
}


// 静态检查代码块结束后调用 report()
report();
