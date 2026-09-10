// lib/parse.mjs
// 纯函数解析层（无副作用、无 IO 上下文依赖）
// 拆分自 scripts/lifecycle-doctor.mjs L44-501 + L1513-1527

import fs from 'node:fs';

// ============================================================
// 解析 kilo.json（标准 JSON，Node 内置）
// ============================================================
export function parseKiloJson(text) {
  const data = JSON.parse(text);
  const agents = new Map();
  if (data.agent && typeof data.agent === 'object') {
    for (const [name, cfg] of Object.entries(data.agent)) {
      if (cfg && typeof cfg === 'object') {
        agents.set(name, { model: cfg.model || null, mode: cfg.mode || null });
      }
    }
  }
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
  return { defaultAgent: data.default_agent || null, agents, models };
}

export function parseDiversityMap(fmText) {
  const map = {};
  const lines = fmText.split(/\r?\n/);
  let currentModel = null;
  let inMap = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^diversity_map\s*:/.test(line)) { inMap = true; continue; }
    if (!inMap) continue;
    const modelMatch = line.match(/^  "?([^":\s]+)"?\s*:\s*$/);
    if (modelMatch) { currentModel = modelMatch[1]; map[currentModel] = {}; continue; }
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

export function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function stripComment(line) {
  const idx = line.search(/\s#/);
  if (idx >= 0) return line.slice(0, idx);
  if (/^\s*#/.test(line)) return '';
  return line;
}

export function parseGraphFile(text) {
  const nodes = new Map();
  const edges = [];
  const top = {};
  let section = null;
  let curNode = null;
  let curEdge = null;
  let inDiversity = false;
  let divRule = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    if (inDiversity) {
      const indent = line.match(/^\s*/)[0].length;
      if (indent === 0) {
        top.diversity_rule = divRule;
        inDiversity = false;
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
    if (/^[^\s-]/.test(line)) {
      const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (key === 'nodes') { section = 'nodes'; curNode = null; continue; }
        if (key === 'edges') { section = 'edges'; curEdge = null; continue; }
        if (val) top[key] = val.trim();
        if (key === 'diversity_rule') { inDiversity = true; divRule = {}; section = null; }
        continue;
      }
      continue;
    }
    if (section === 'nodes') {
      const idm = line.match(/^\s*-\s*id\s*:\s*(\S+)\s*$/);
      if (idm) { curNode = { id: idm[1] }; nodes.set(curNode.id, curNode); continue; }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curNode) { const [, key, val] = fm; curNode[key] = val.trim(); }
      continue;
    }
    if (section === 'edges') {
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
      const fromM = line.match(/^\s*-\s*from\s*:\s*(\S+)\s*$/);
      if (fromM) { curEdge = { from: fromM[1] }; edges.push(curEdge); continue; }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curEdge) { const [, key, val] = fm; curEdge[key] = val.trim().replace(/^["']|["']$/g, ''); }
      continue;
    }
  }
  if (inDiversity && divRule) top.diversity_rule = divRule;
  return { nodes, edges, top };
}

export function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

export function parseAgentFrontmatter(fm) {
  const agent = { mount: [], role: null, writes: [], type: null, mode: null, subagent_type: null };
  const lines = fm.split(/\r?\n/);
  let section = null;
  let curMount = null;
  let inWrite = false;
  for (const line of lines) {
    if (/^[^\s#]/.test(line)) {
      if (section === 'task_context' && inWrite) inWrite = false;
      section = null;
      const km = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (km) {
        const [, key, val] = km;
        if (key === 'mount') { section = 'mount'; continue; }
        if (key === 'task_context') { section = 'task_context'; continue; }
        if (key === 'role' && val) { agent.role = val.trim(); continue; }
        if (key === 'mode' && val) { agent.mode = val.trim().replace(/\s+#.*$/, ''); continue; }
        if (key === 'subagent_type' && val) { agent.subagent_type = val.trim().replace(/\s+#.*$/, ''); continue; }
        if (key === 'type' && val) { agent.type = val.trim().replace(/\s+#.*$/, ''); continue; }
      }
      continue;
    }
    if (section === 'mount') {
      const atm = line.match(/^\s*-\s*at\s*:\s*(\S+)\s*(?:#.*)?$/);
      if (atm) { curMount = { at: atm[1] }; agent.mount.push(curMount); continue; }
      const fm2 = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm2 && curMount) {
        const [, key, rawVal] = fm2;
        const val = rawVal.trim().replace(/\s+#.*$/, '');
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
        for (const part of inline[1].split(',')) { const v = part.trim(); if (v) agent.writes.push(v); }
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

export function parseStageFrontmatter(fm) {
  const m = fm.match(/^required_roles\s*:\s*\[(.*)\]\s*(?:#.*)?$/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseConfig(text) {
  const cfg = {
    tierAgents: new Map(),
    disabledAgents: [],
    perAgentKeys: [],
    multiplierEntries: [],
  };
  const lines = text.split(/\r?\n/);
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
      const targetMap = cfg.tierAgents;
      if (indent === 2) {
        const m = line.match(/^\s+(\w+)\s*:/);
        l2 = m ? m[1] : null; l3 = null;
        if (l2 && !targetMap.has(l2)) targetMap.set(l2, new Set());
        continue;
      }
      if (indent === 4) { const m = line.match(/^\s+(\w+)\s*:/); l3 = m ? m[1] : null; continue; }
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
        if (m) { cfg.disabledAgents = m[1].split(',').map((s) => s.trim()).filter(Boolean); l2 = 'disabled_agents'; continue; }
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
      if (indent === 2) { const m = line.match(/^\s+(\w+)\s*:/); l2 = m ? m[1] : null; continue; }
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

export function parseTierEscalationCfg(text) {
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

export function globToRegexLocal(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') { re += '[^/]*'; }
    else if (c === '?') { re += '[^/]'; }
    else if ('.+^$()|{}[]\\'.indexOf(c) !== -1) { re += '\\' + c; }
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function parseAgentPermission(fm) {
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
