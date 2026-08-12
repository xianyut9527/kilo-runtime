// index.mjs — Kilo runtime unified entry (U5)
// Aggregates 4 submodules (capability-registry / capability-detector /
// model-selector / early-exit) and exposes two orchestration functions:
//   select(snapshot)        → 完整聚合：detect caps → select model → early-exit
//   selectForDispatch(d,i,f,o) → 简化版：默认 costPriority='balanced'，从 kilo.json 读 smallModel
// Pure aggregation layer; no business logic of its own. Used by conductor
// to make one-shot model-selection decisions before dispatching EXECUTING units.
// Typical: const r = selectForDispatch(cfg.model, intentRaw, attachedFiles, options);
// Zero third-party deps. ESM static imports — submodules MUST exist (DAG guarantee).
//
// v2 (Fix #2/#4): 模块初始化时一次性从 lifecycle/config.yaml 读取
// `runtime.early_exit_signals` 并 setSignals 覆盖（regex 解析，避免引入
// yaml 库；空数组跳过 → 保留默认）；selectForDispatch 改为顶部只读 1 次
// kilo.json（同时拿 smallModel 和预解析 models 透传给 select/selectModel），
// 消除 readSmallModelFromKiloJson 与 selectModel 内部 loadModels 的重复 read。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedDerive } from '../../scripts/lib/derived-cache.mjs';
import { detectCapabilities } from './capability-detector.mjs';
import { selectModel } from './model-selector.mjs';
import { detectEarlyExit, setSignals, getSignals } from './early-exit.mjs';
import { loadModelsFromCfg, getCapabilities, getCapabilitiesFromMap } from './capability-registry.mjs';

// Re-export all submodule surface for downstream consumers that prefer
// a single import root. (e.g. `import { getCapabilities } from './runtime/index.mjs'`)
export { getCapabilities, listVisionModels, listAllModels, getProviderPrefixForModelId } from './capability-registry.mjs';
export { detectCapabilities } from './capability-detector.mjs';
export { selectModel } from './model-selector.mjs';
export { detectEarlyExit, setSignals, getSignals, addSignals } from './early-exit.mjs';

const _REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // lifecycle/runtime/ -> repo root
const KILO_JSON_PATH = resolve(_REPO_ROOT, 'kilo.json');
const CONFIG_YAML_PATH = resolve(_REPO_ROOT, 'lifecycle', 'config.yaml');

// ——— Fix #2: lifecycle/config.yaml `runtime.early_exit_signals` 落地 ———
// 简化解：纯正则匹配 `early_exit_signals: [a, b, c]`，不引入 yaml 解析库；
// 空数组 / 缺失 / 解析失败 → 静默回退 early-exit.mjs 内置默认。
function loadEarlyExitSignalsFromConfig() {
  try {
    const raw = readFileSync(CONFIG_YAML_PATH, 'utf8');
    const m = raw.match(/early_exit_signals:\s*\[([^\]]*)\]/);
    if (!m) return null;
    const inner = m[1].trim();
    if (!inner) return null; // 空数组 = 用默认
    const items = inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : null;
  } catch (err) {
    // 配置缺失/损坏 → 静默回退默认；不向上抛
    console.warn(`[index.mjs] failed to load early_exit_signals: ${err?.message ?? err}`);
    return null;
  }
}

// 模块初始化时一次性 setSignals（避免每次 selectForDispatch 都读 config）
const _configSignals = loadEarlyExitSignalsFromConfig();
if (_configSignals && _configSignals.length > 0) {
  setSignals(_configSignals);
}

// ——— Fix D1: lifecycle/config.yaml `runtime.capability_strict` 落地 ———
// 简化解：纯正则匹配 `capability_strict: true/false`，不引入 yaml 解析库；
// 缺失 / 解析失败 / 未声明 → 默认 false（向后兼容现有调用方）。
let _capabilityStrict = false;
function loadCapabilityStrictFromConfig() {
  try {
    const raw = readFileSync(CONFIG_YAML_PATH, 'utf8');
    const m = raw.match(/capability_strict:\s*(true|false)/);
    if (!m) return false;
    return m[1] === 'true';
  } catch (err) {
    console.warn(`[index.mjs] failed to load capability_strict: ${err?.message ?? err}`);
    return false;
  }
}
export function getCapabilityStrict() { return _capabilityStrict; }
_capabilityStrict = loadCapabilityStrictFromConfig();

// 内部 helper：strict 模式下，selected_model 不满足必需能力时抛 [RUNTIME_STRICT]。
// 注意：当前实现将检测放在 select 聚合层而非 selectModel 内部，原因是
// selectModel 不知道 strict 开关（避免改动 selectModel 公共签名）。
// _assertCapabilitySatisfiable 接受已计算好的 modelResult + required_caps + 预解析 models。
function _assertCapabilitySatisfiable(modelResult, required_caps, models, strictFlag) {
  const strict = strictFlag !== undefined ? strictFlag : _capabilityStrict;
  if (!strict) return;
  const missing = [];
  if (required_caps && required_caps.vision === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.vision !== true) missing.push('vision');
  }
  if (required_caps && required_caps.code === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.code !== true) missing.push('code');
  }
  if (required_caps && required_caps.long_context === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.long_context !== true) missing.push('long_context');
  }
  if (missing.length > 0) {
    throw new Error(
      `[RUNTIME_STRICT] capability gap not satisfiable: ${missing.join('/')}=required but no matching model available (selected=${modelResult.selected_model})`
    );
  }
}

/**
 * Full model-selection pipeline: detect capabilities → select model → early-exit.
 * @param {{
 *   intentRaw: string,
 *   attachedFiles?: string[],
 *   defaultModel: string,
 *   userMessage?: string,
 *   costPriority?: 'balanced'|'quality'|'economy',
 *   smallModel?: string,
 *   models?: object,        // Fix #4 预解析 merged map（capability-registry 内部 key 格式）
 * }} snapshot
 * @returns {{
 *   selected_model: string,
 *   override_reason: string,
 *   upgraded: boolean,
 *   downgraded: boolean,
 *   early_exit: boolean,
 *   signal_matched: string | null,
 *   required_caps: { vision: boolean, code: boolean, reasoning: boolean, long_context: boolean },
 * }}
 */
export function select(snapshot) {
  const {
    intentRaw = '',
    attachedFiles = [],
    defaultModel,
    userMessage = '',
    costPriority = 'balanced',
    smallModel,
    models,
    capabilityStrict, // Fix D1: snapshot override; default = getCapabilityStrict()
  } = snapshot ?? {};

  // 1) detect required capabilities from intent + attachments
  const required_caps = detectCapabilities(intentRaw, attachedFiles);

  // Fix D1: 先计算 strict flag（snapshot > config），后续 selectModel + post-check 共用
  const _strict = capabilityStrict !== undefined ? capabilityStrict : getCapabilityStrict();

  // 2) select model honoring capability gaps + cost priority
  //    Fix #4 透传预解析 models（避免 selectModel 内部再 loadModels → 再读 kilo.json）
  const modelResult = selectModel(defaultModel, required_caps, { costPriority, smallModel, models, capabilityStrict: _strict });

  // 2.5) Fix D1: strict 模式下，若升级后 selected_model 仍不满足必需能力 → 抛 [RUNTIME_STRICT]
  _assertCapabilitySatisfiable(modelResult, required_caps, models, _strict);

  // 3) detect early-exit signal from user message (independent of model choice)
  const earlyExitResult = detectEarlyExit(userMessage);

  // 4) aggregate into a single decision object
  return {
    selected_model: modelResult.selected_model,
    override_reason: modelResult.override_reason,
    upgraded: modelResult.upgraded,
    downgraded: modelResult.downgraded,
    early_exit: earlyExitResult.early_exit,
    signal_matched: earlyExitResult.signal_matched,
    required_caps,
  };
}

/**
 * Simplified dispatch helper: defaults costPriority='balanced' and reads
 * smallModel from kilo.json (root: kilo_config/kilo.json).
 * Fix #4: 单次调用只读 1 次 kilo.json，解析出 smallModel + 预加载 models。
 * @param {string} defaultModel
 * @param {string} intentRaw
 * @param {string[]} [attachedFiles]
 * @param {{costPriority?: 'balanced'|'quality'|'economy', userMessage?: string, smallModel?: string, models?: object}} [options]
 */
export function selectForDispatch(defaultModel, intentRaw, attachedFiles = [], options = {}) {
  // kilo.json 读取经 cachedDerive mtime 缓存（装配后静态，跨 dispatch 命中）；
  // 同时拿 smallModel + 预解析 models（用 cfg 复用 loadModelsFromCfg）
  let { smallModel, models } = options;
  if (smallModel === undefined || models === undefined) {
    const cfg = cachedDerive('kiloCfg', [KILO_JSON_PATH], () => {
      const raw = readFileSync(KILO_JSON_PATH, 'utf8');
      return JSON.parse(raw);
    });
    if (smallModel === undefined) smallModel = cfg?.small_model;
    if (models === undefined) models = loadModelsFromCfg(cfg);
  }
  return select({
    defaultModel,
    intentRaw,
    attachedFiles,
    costPriority: options.costPriority ?? 'balanced',
    userMessage: options.userMessage ?? '',
    smallModel,
    models,
  });
}
