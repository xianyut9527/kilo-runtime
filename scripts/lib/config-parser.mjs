// config-parser.mjs
// 纯解析器层，零副作用——只做文本→结构解析，不读盘、不缓存。
// 从 lifecycle/config.yaml 解析 tier_defaults / timeouts / tier_escalation。
//
// 单一来源：task-context-runtime.mjs 的解析语义（含 curModelOverrides 分支）。
// build-derivations.mjs 与 task-context-runtime.mjs 共用本实现，消除双份复制。
//
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_defaults
// 返回 { execution: { T0: {agents, provider?, model_overrides?}, ... } }
// 含 model_overrides 分支（修复 build 派生数据中静默丢失）。
// ============================================================
export function parseTierDefaults(text) {
  const result = { execution: {} };
  const lines = text.split(/\r?\n/);
  let section = null;      // 'execution' | null
  let curTier = null;
  let inAgents = false;
  let curAgents = null;
  let curProvider = null;
  let curModelOverrides = null;

  function flush() {
    if (curTier && section) {
      const entry = { agents: curAgents || {} };
      if (curProvider) entry.provider = curProvider;
      if (curModelOverrides) entry.model_overrides = curModelOverrides;
      result[section][curTier] = entry;
    }
    curAgents = null;
    curProvider = null;
    curModelOverrides = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // strip inline comment (preserve # inside quotes — none expected here)
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;

    // top-level keys we care about
    if (/^tier_defaults\s*:/.test(line)) { flush(); section = 'execution'; curTier = null; inAgents = false; continue; }
    if (/^(overrides|convergence|hooks|timeouts|tier_escalation)\s*:/.test(line)) { flush(); section = null; curTier = null; inAgents = false; continue; }

    if (!section) continue;

    // tier key: "  T0:" / "  T1:" (2-space indent under tier_defaults)
    const tierM = line.match(/^  (T[0-3])\s*:\s*$/);
    if (tierM) {
      flush();
      curTier = tierM[1];
      inAgents = false;
      curModelOverrides = null;
      continue;
    }

    if (!curTier) continue;

    // agents: (key under tier, 4-space indent)
    const agentsStart = line.match(/^    agents\s*:\s*$/);
    if (agentsStart) {
      inAgents = true;
      curAgents = {};
      continue;
    }
    const agentsInline = line.match(/^    agents\s*:\s*\{(.*)\}\s*$/);
    if (agentsInline) {
      inAgents = false;
      curAgents = {};
      // inline empty {} → keep empty; inline {} with content not expected in this file
      continue;
    }

    if (inAgents) {
      // agent entry: "      key: true" (6-space indent)
      const agentM = line.match(/^      ([a-z_]+)\s*:\s*(true|false)\s*$/);
      if (agentM) {
        curAgents[agentM[1]] = agentM[2] === 'true';
        continue;
      }
      // leaving agents block (indent < 6)
      if (!/^ {6,}/.test(line) && line.trim()) {
        inAgents = false;
      }
    }

    // model_overrides (4-space indent, sibling of agents)
    const moStart = line.match(/^    model_overrides\s*:\s*$/);
    if (moStart) {
      inAgents = false;
      curModelOverrides = {};
      continue;
    }
    if (curModelOverrides) {
      // entry: "      verifier: \"hx/deepseek-v4-flash\"" (6-space indent)
      const moM = line.match(/^      ([a-z_]+)\s*:\s*["'']?([^"'']+)["'']?\s*$/);
      if (moM) { curModelOverrides[moM[1]] = moM[2]; continue; }
      // leaving model_overrides block (indent < 6)
      if (!/^ {6,}/.test(line) && line.trim()) { curModelOverrides = null; }
    }

    // provider (T3 only, 4-space indent)
    const provM = line.match(/^    provider\s*:\s*(\w+)\s*$/);
    if (provM) {
      curProvider = provM[1];
      continue;
    }
  }
  flush();
  return result;
}

// ============================================================
// 从 lifecycle/config.yaml 解析 timeouts
// 返回 { agent_startup_s, stage_default_s, per_agent_s, per_tier_multiplier, agent_timeout_max_retries }
// ============================================================
export function parseTimeouts(text) {
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
    // strip inline comment（保留值内 #，timeouts 段无引号值）
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;

    // 顶层键切换
    if (/^timeouts\s*:/.test(line)) { inTimeouts = true; inPerAgent = false; inPerTier = false; inRetry = false; continue; }
    if (/^[a-z_]+\s*:/.test(line) && !/^\s/.test(line)) {
      inTimeouts = false; inPerAgent = false; inPerTier = false; inRetry = false;
      continue;
    }
    if (!inTimeouts) continue;

    // 2-space keys under timeouts
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

    // per_agent_s: 4-space indent key -> integer
    if (inPerAgent) {
      const m = line.match(/^    ([a-z_]+)\s*:\s*(\d+)\s*$/);
      if (m) { t.per_agent_s[m[1]] = parseInt(m[2], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inPerAgent = false; }
    }
    // per_tier_multiplier: 4-space indent T0/T1/T2 -> float
    if (inPerTier) {
      const m = line.match(/^    (T[0-3])\s*:\s*([\d.]+)\s*$/);
      if (m) { t.per_tier_multiplier[m[1]] = parseFloat(m[2]); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inPerTier = false; }
    }
    // retry.agent_timeout_max_retries: 4-space indent
    if (inRetry) {
      const m = line.match(/^    agent_timeout_max_retries\s*:\s*(\d+)\s*$/);
      if (m) { t.agent_timeout_max_retries = parseInt(m[1], 10); continue; }
      if (/^\S/.test(line) || !/^\s{4}/.test(line)) { inRetry = false; }
    }
  }

  return t;
}

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_escalation（定级自动升级触发器）
// 返回 { mode: 'any'|'all', keyword_groups: {auth: [...], ...}, sensitive_path_globs: [...] }
// ============================================================
export function parseTierEscalation(text) {
  const result = { mode: 'any', keyword_groups: {}, sensitive_path_globs: [] };
  let inEscalation = false;
  let inKeywordGroups = false;
  let inGlobs = false;
  let curGroup = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;
    if (/^tier_escalation\s*:/.test(line)) {
      inEscalation = true; inKeywordGroups = false; inGlobs = false; curGroup = null; continue;
    }
    if (!inEscalation) continue;
    if (/^[^\s#]/.test(line) && !/^tier_escalation/.test(line)) { inEscalation = false; break; }
    const modeM = line.match(/^  mode\s*:\s*(\w+)\s*$/);
    if (modeM) { result.mode = modeM[1]; continue; }
    if (/^  keyword_groups\s*:\s*$/.test(line)) { inKeywordGroups = true; inGlobs = false; curGroup = null; continue; }
    if (/^  sensitive_path_globs\s*:\s*$/.test(line)) { inGlobs = true; inKeywordGroups = false; curGroup = null; continue; }
    if (inKeywordGroups) {
      const gm = line.match(/^    ([a-z_]+)\s*:\s*$/);
      if (gm) { curGroup = gm[1]; if (!result.keyword_groups[curGroup]) result.keyword_groups[curGroup] = []; continue; }
      if (curGroup) {
        const km = line.match(/^      -\s+(.+?)\s*$/);
        if (km) { result.keyword_groups[curGroup].push(km[1]); continue; }
      }
    }
    if (inGlobs) {
      const gm = line.match(/^    -\s+"(.+?)"\s*$/);
      if (gm) { result.sensitive_path_globs.push(gm[1]); continue; }
    }
  }
  return result;
}
