// model-selector.mjs — Kilo runtime model selector
// Inputs (defaultModel, requiredCaps) → scored model + override_reason.
// Routes by capability gaps: vision → first vision model, code → code-optimized
// model, economy-mode + small task → smallModel down-grade. Pure function; reads
// capability registry only; no third-party deps, no kilo.json mutation.
//
// v2 (Fix #4/#5): 支持 `options.models` 预解析的 merged map（避免在 selectModel
// 内部重复 readFileSync kilo.json）；vision 选择改为确定性排序（code 能力
// 优先 + 字典序兜底），不再依赖 Object.keys 遍历顺序。
import {
  getCapabilities,
  listVisionModels,
  listAllModels,
  getCapabilitiesFromMap,
  listVisionModelIdsFromMap,
  listAllModelIdsFromMap,
} from './capability-registry.mjs';

const CODE_OPTIMIZED_MODEL = 'kimi-k2.7-code';
const DEFAULT_SMALL_MODEL = 'kimi-k2.6';

// 与 capability-registry.inferCode 保持一致的轻量判断（避免在 sort 比较器里
// 调 getCapabilities 触发额外 readFileSync）。
function codeOfId(id) {
  const lower = String(id).toLowerCase();
  return lower.includes('code') || lower.includes('coder');
}

function hasPreloaded(options) {
  return !!(options.models && typeof options.models === 'object' && Object.keys(options.models).length > 0);
}
// Fix #7: kilo.json writes models as provider/modelId (e.g. hx/glm-5.2),
// but capability-registry stores plain modelId (e.g. glm-5.2). Strip the
// provider prefix at the entry of selectModel so caller-supplied ids match
// the registry. Public API is backward compatible: callers that already
// pass plain modelId are unaffected (no "/" -> returned as-is).
function normalizeModelId(id) {
  if (typeof id !== "string") return id;
  const idx = id.indexOf("/");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

export function selectModel(defaultModel, requiredCaps = {}, options = {}) {
  // hx/glm-5.2 -> glm-5.2
  const normalizedDefault = normalizeModelId(defaultModel);
  const normalizedSmall = normalizeModelId(options.smallModel);
  const useMap = hasPreloaded(options);
  const knownModels = useMap ? listAllModelIdsFromMap(options.models) : listAllModels();
  if (!knownModels.includes(normalizedDefault)) {
    return {
      selected_model: normalizedDefault,
      override_reason: "unknown-model: passthrough",
      upgraded: false,
      downgraded: false,
    };
  }

  const defaultCaps = useMap
    ? getCapabilitiesFromMap(normalizedDefault, options.models)
    : getCapabilities(normalizedDefault);

  if (requiredCaps.vision === true && defaultCaps.vision !== true) {
    const visionIds = useMap ? listVisionModelIdsFromMap(options.models) : listVisionModels();
    // Fix #5 deterministic sort: code 能力优先 (desc), then 字典序 asc,
    // 保证多 provider / 多 model 下选 vision 时输出稳定。
    const sorted = [...visionIds].sort((a, b) => {
      const cb = codeOfId(b) ? 1 : 0;
      const ca = codeOfId(a) ? 1 : 0;
      if (cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });
    const target = sorted[0];
    return {
      selected_model: target,
      override_reason: "vision-required: " + defaultModel + " lacks vision",
      upgraded: true,
      downgraded: false,
    };
  }

  if (requiredCaps.code === true && defaultCaps.code !== true) {
    return {
      selected_model: CODE_OPTIMIZED_MODEL,
      override_reason: "code-required: " + defaultModel + " lacks code",
      upgraded: true,
      downgraded: false,
    };
  }

  if (
    options.costPriority === "economy" &&
    requiredCaps.code !== true &&
    requiredCaps.long_context !== true &&
    requiredCaps.vision !== true
  ) {
    const smallModel = normalizedSmall ?? DEFAULT_SMALL_MODEL;
    return {
      selected_model: smallModel,
      override_reason: "economy-mode: small task",
      upgraded: false,
      downgraded: true,
    };
  }

  return {
    selected_model: normalizedDefault,
    override_reason: "no-change",
    upgraded: false,
    downgraded: false,
  };
}