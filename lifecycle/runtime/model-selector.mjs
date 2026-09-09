// model-selector.mjs — Kilo runtime model selector
// Inputs (defaultModel, requiredCaps) → scored model + override_reason.
// Routes by capability gaps: vision → first vision model, code → code-optimized
// model, economy-mode + small task → smallModel down-grade. Pure function; reads
// capability registry + kilo.json config anchors only; no third-party deps, no kilo.json mutation.
//
// v2 (Fix #4/#5): 支持 `options.models` 预解析的 merged map（避免在 selectModel
// 内部重复 readFileSync kilo.json）；vision 选择改为确定性排序（code 能力
// 优先 + 字典序兜底），不再依赖 Object.keys 遍历顺序。
// v3 (U1): code 升级目标从 provider.hx.models 扫含 code/coder 的 id 读取（cachedDerive
// mtime 缓存，对齐 index.mjs L184-189 模式），替换原硬编码 CODE_OPTIMIZED_MODEL；
// 读取后经 normalizeModelId 剥离 provider 前缀再 withProviderPrefix 拼回（与
// smallModel 路径 L57 对齐，防双前缀 hx/hx/...）。DEFAULT_SMALL_MODEL 移除（本就被
// options.smallModel 透传覆盖），economy 保留 kilo.json small_model 兜底。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedDerive } from '../../scripts/lib/derived-cache.mjs';
import {
  getCapabilities,
  listVisionModels,
  listAllModels,
  getCapabilitiesFromMap,
  listVisionModelIdsFromMap,
  listAllModelIdsFromMap,
  getProviderPrefixForModelId,
} from './capability-registry.mjs';

const _REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // lifecycle/runtime/ -> repo root
const KILO_JSON_PATH = resolve(_REPO_ROOT, 'kilo.json');

// U1: 实际机制是扫 provider.hx.models 找含 code/coder 的 id（见下方 U4 实现），
// 非顶层 code_optimized_model 字段。无命中 → 返回 null = code 升级路径禁用
// （优雅降级，非错误；normalizeModelId(null) 原样返回，withProviderPrefix 未找到
// alias → 原样返回，不抛错）。
function readCodeOptimizedModel() {
  // U4: 从 provider.hx.models 中找第一个 modelId 含 code/coder 的模型（与 codeOfId 逻辑一致），
  // 不再依赖非官方顶层 code_optimized_model 字段（违反 kilo.json schema additionalProperties:false）。
  try {
    return cachedDerive("kiloCodeOptimizedModel", [KILO_JSON_PATH], () => {
      const raw = readFileSync(KILO_JSON_PATH, "utf8");
      const cfg = JSON.parse(raw);
      const models = cfg?.provider?.hx?.models ?? {};
      const codeModelId = Object.keys(models).find(id => {
        const lower = String(id).toLowerCase();
        return lower.includes("code") || lower.includes("coder");
      });
      return codeModelId ? ("hx/" + codeModelId) : null;
    });
  } catch (err) {
    console.warn(`[model-selector] failed to find code-optimized model: ${err?.message ?? err}`);
    return null;
  }
}

// U1: 从 kilo.json 顶层 small_model 兜底读取（selectForDispatch 已透传 smallModel，
// 仅在直接调用 selectModel + economy 且未传 smallModel 时兜底，避免回归 undefined）。
function readSmallModelFromKiloJson() {
  try {
    return cachedDerive('kiloSmallModel', [KILO_JSON_PATH], () => {
      const raw = readFileSync(KILO_JSON_PATH, 'utf8');
      const cfg = JSON.parse(raw);
      return cfg?.small_model ?? null;
    });
  } catch (err) {
    console.warn(`[model-selector] failed to load small_model: ${err?.message ?? err}`);
    return null;
  }
}

// 与 capability-registry.inferCode 保持一致的轻量判断（避免在 sort 比较器里
// 调 getCapabilities 触发额外 readFileSync）。
function codeOfId(id) {
  const lower = String(id).toLowerCase();
  return lower.includes('code') || lower.includes('coder');
}

// Fix P0-1: 把裸 modelId 拼回 '<alias>/<modelId>' 格式（kilo.json agent.model 期望格式）。
// conductor 铁律 6a 把 selected_model 传给 task 工具 model 参数，裸 modelId 无 provider
// 上下文无法解析。未找到 alias -> 原样返回（向后兼容，passthrough 场景）。
function withProviderPrefix(modelId, options) {
  const prefix = hasPreloaded(options)
    ? getProviderPrefixForModelId(modelId, options.models)
    : getProviderPrefixForModelId(modelId);
  return prefix ? prefix + modelId : modelId;
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
      selected_model: defaultModel,
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
      selected_model: withProviderPrefix(target, options),
      override_reason: "vision-required: " + defaultModel + " lacks vision",
      upgraded: true,
      downgraded: false,
    };
  }

  if (requiredCaps.code === true && defaultCaps.code !== true) {
    // U1: 严格对齐 smallModel 路径 —— normalize 剥离可能的前缀后再 withProviderPrefix
    // 拼回，禁止直接传裸字符串（否则若传入带前缀字符串会双前缀 hx/hx/...）。
    // P2-1 fix: readCodeOptimizedModel 返回 null（仓库 kilo.json 无 code/coder 模型）时，
    // 不再硬拼 selected_model:null + upgraded:true；改为落穿 no-change，避免空模型传 dispatch。
    const codeModel = normalizeModelId(readCodeOptimizedModel());
    if (codeModel) {
      return {
        selected_model: withProviderPrefix(codeModel, options),
        override_reason: "code-required: " + defaultModel + " lacks code",
        upgraded: true,
        downgraded: false,
      };
    }
  }

  if (
    options.costPriority === "economy" &&
    requiredCaps.code !== true &&
    requiredCaps.long_context !== true &&
    requiredCaps.vision !== true
  ) {
    const smallModel = normalizedSmall ?? readSmallModelFromKiloJson();
    return {
      selected_model: withProviderPrefix(smallModel, options),
      override_reason: "economy-mode: small task",
      upgraded: false,
      downgraded: true,
    };
  }

  return {
    selected_model: withProviderPrefix(normalizedDefault, options),
    override_reason: "no-change",
    upgraded: false,
    downgraded: false,
  };
}
