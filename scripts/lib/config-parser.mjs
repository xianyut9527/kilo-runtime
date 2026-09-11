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
// 共享守卫：仅接受非空字符串（truthy 非字符串如 123 会在 .split 抛 TypeError）
// ============================================================
function hasText(text) {
  return typeof text === 'string' && text.length > 0;
}

// ============================================================
// 共享子例程：逐行解析顶层 YAML 块（注释剥离 + 段进入/退出 + 逐行回调）
// 消除 parseTierEscalation / parseT1StrengthSignals 的状态机重复。
//   - text      : 原始 YAML 文本
//   - blockName : 顶层块名（如 tier_escalation），行匹配 ^<blockName>\s*:
//   - visit     : (line) => void，line 已剥离行内注释；块外/空行不回调
// 返回是否命中该块（未命中/空文本 → false）。
// ============================================================
function parseYamlBlock(text, blockName, visit) {
  if (!hasText(text)) return false;
  const enterRe = new RegExp('^' + blockName + '\\s*:');
  const exitRe = new RegExp('^' + blockName + '\\s*:');
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;
    if (!inBlock) {
      if (enterRe.test(line)) inBlock = true;
      continue;
    }
    // 顶层键（非缩进）出现且非本块名 → 块结束
    if (/^[^\s#]/.test(line) && !exitRe.test(line)) break;
    visit(line);
  }
  return inBlock;
}

// ============================================================
// 块内首个整数值子例程：限定顶层 YAML 块 + 指定缩进键，剥离注释
// 消除 parseHooks/parseConvergence/parseThresholds/parseRecovery 的裸 match 重复。
//   - text      : 原始 YAML 文本（null 安全）
//   - blockName : 顶层块名
//   - key       : 目标键名（YAML 路径最后一段）
//   - indent    : 该键相对顶层的空格缩进（顶层键 = 0）
// 返回 number 或 null（块/键缺失）。
// ============================================================
function firstIntInBlock(text, blockName, key, indent = 2) {
  let found = null;
  parseYamlBlock(text, blockName, (line) => {
    if (found !== null) return;
    const m = line.match(new RegExp('^ {' + indent + '}' + key + '\\s*:\\s*(\\d+)\\s*$'));
    if (m) found = parseInt(m[1], 10);
  });
  return found;
}

// ============================================================
// 顶层整数键子例程：全文件剥离行内注释后匹配非缩进 ^key:\s*(\d+)$
// 用于 config.yaml 顶层键（size_check_threshold / dispatch_prompt_threshold /
// max_files_per_task）。限定顶层（无前导空格）避免命中块内同名键。
// 返回 number 或 null。
// ============================================================
function firstIntTopLevel(text, key) {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const m = line.match(new RegExp("^" + key + "\\s*:\\s*(\\d+)\\s*$"));
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_escalation（定级自动升级触发器）
// 返回 { mode: 'any'|'all', keyword_groups: {auth: [...], ...}, sensitive_path_globs: [...] }
// ============================================================
export function parseTierEscalation(text) {
  const result = { mode: 'any', keyword_groups: {}, sensitive_path_globs: [] };
  let inKeywordGroups = false;
  let inGlobs = false;
  let curGroup = null;
  parseYamlBlock(text, 'tier_escalation', (line) => {
    const modeM = line.match(/^  mode\s*:\s*(\w+)\s*$/);
    if (modeM) { result.mode = modeM[1]; return; }
    if (/^  keyword_groups\s*:\s*$/.test(line)) { inKeywordGroups = true; inGlobs = false; curGroup = null; return; }
    if (/^  sensitive_path_globs\s*:\s*$/.test(line)) { inGlobs = true; inKeywordGroups = false; curGroup = null; return; }
    if (inKeywordGroups) {
      const gm = line.match(/^    ([a-z_]+)\s*:\s*$/);
      if (gm) { curGroup = gm[1]; if (!result.keyword_groups[curGroup]) result.keyword_groups[curGroup] = []; return; }
      if (curGroup) {
        const km = line.match(/^      -\s+(.+?)\s*$/);
        if (km) { result.keyword_groups[curGroup].push(km[1]); return; }
      }
    }
    if (inGlobs) {
      const gm = line.match(/^    -\s+"(.+?)"\s*$/);
      if (gm) { result.sensitive_path_globs.push(gm[1]); return; }
    }
  });
  return result;
}

// ============================================================
// 从 lifecycle/config.yaml 解析 t1_strength_signals.strength_escalation_words
// 返回 string[]；段缺失/词表为空 → null（调用方按不阻断处理）
// 与 parseTierEscalation 共用 parseYamlBlock 子例程，单一来源。
// ============================================================
export function parseT1StrengthSignals(text) {
  const words = [];
  let inWords = false;
  parseYamlBlock(text, 't1_strength_signals', (line) => {
    if (/^  strength_escalation_words\s*:\s*$/.test(line)) { inWords = true; return; }
    if (/^  [a-z_]+\s*:/.test(line) && !/^  strength_escalation_words/.test(line)) { inWords = false; return; }
    if (inWords) {
      const m = line.match(/^    -\s+(.+?)\s*$/);
      if (m) words.push(m[1]);
    }
  });
  return words.length > 0 ? words : null;
}
// ============================================================
// 从 lifecycle/config.yaml 解析 hooks.quality.max_total_cycles
// 返回 { max_total_cycles }；缺失回退 fallback（默认 3，响应式熔断总轮次上限）。
// 单一来源：task-context-runtime.mjs / build-derivations.mjs 共用。
// 限定 hooks 块内（缩进 4：hooks.quality）且已剥离注释，避免误配注释键/同名顶层键。
// ============================================================
export function parseHooks(text, fallback = 3) {
  if (!hasText(text)) return { max_total_cycles: fallback };
  const v = firstIntInBlock(text, 'hooks', 'max_total_cycles', 4);
  return { max_total_cycles: v === null ? fallback : v };
}

// ============================================================
// 从 lifecycle/config.yaml 解析 convergence.mm_fusion_max_rounds
// 返回 { mm_fusion_max_rounds }；缺失回退 3（子图融合最大轮次）。
// 限定 convergence 块内（缩进 2）且已剥离注释。
// ============================================================
export function parseConvergence(text) {
  if (!hasText(text)) return { mm_fusion_max_rounds: 3 };
  const v = firstIntInBlock(text, 'convergence', 'mm_fusion_max_rounds', 2);
  return { mm_fusion_max_rounds: v === null ? 3 : v };
}

// ============================================================
// 从 lifecycle/config.yaml 解析 pre-dispatch 安全门阈值（顶层键）
// 返回 { size_check_threshold, dispatch_prompt_threshold, max_files_per_task }
// 缺省 150000 / 4000 / null（不限制）。
// 三键均为 config.yaml 顶层键，限定非缩进 + 剥离注释，避免命中块内同名键。
// ============================================================
export function parseThresholds(text) {
  const defaults = {
    size_check_threshold: 150000,
    dispatch_prompt_threshold: 4000,
    max_files_per_task: null,
  };
  if (!hasText(text)) return { ...defaults };
  const sct = firstIntTopLevel(text, 'size_check_threshold');
  const dpt = firstIntTopLevel(text, 'dispatch_prompt_threshold');
  const mf = firstIntTopLevel(text, 'max_files_per_task');
  return {
    size_check_threshold: sct === null ? defaults.size_check_threshold : sct,
    dispatch_prompt_threshold: dpt === null ? defaults.dispatch_prompt_threshold : dpt,
    max_files_per_task: mf === null ? defaults.max_files_per_task : mf,
  };
}

// ============================================================
// 从 lifecycle/config.yaml 解析 recovery 自愈引擎阈值
// 返回 { max_write_retry, overload_threshold, circuit_breaker_overload }
// 缺省 1 / 3 / 5。限定 recovery 块内（缩进 2）且已剥离注释。
// ============================================================
export function parseRecovery(text) {
  const defaults = {
    max_write_retry: 1,
    overload_threshold: 3,
    circuit_breaker_overload: 5,
  };
  if (!hasText(text)) return { ...defaults };
  const mw = firstIntInBlock(text, 'recovery', 'max_write_retry', 2);
  const ot = firstIntInBlock(text, 'recovery', 'overload_threshold', 2);
  const cb = firstIntInBlock(text, 'recovery', 'circuit_breaker_overload', 2);
  return {
    max_write_retry: mw === null ? defaults.max_write_retry : mw,
    overload_threshold: ot === null ? defaults.overload_threshold : ot,
    circuit_breaker_overload: cb === null ? defaults.circuit_breaker_overload : cb,
  };
}
