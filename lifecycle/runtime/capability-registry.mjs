// capability-registry.mjs — Kilo runtime capability index
// Reads kilo.json via cachedDerive mtime cache (static after install) to build a model capability lookup
// from `provider.<alias>.models`. Exposes vision/code/reasoning/long_context
// flags derived from model `modalities`, id heuristics, and `limit.context`.
// Used by lifecycle routing decisions (e.g. vision-aware model selection).
//
// v2 (Fix #3): 多 provider namespace —— 内部以 `<alias>/<modelId>` 复合 key 存表，
// 公共 API（getCapabilities/listVisionModels/listAllModels）仍以 modelId
// 暴露，跨 provider 同名 model 不再静默 first wins。
// 同步新增 `loadModelsFromCfg` / `getCapabilitiesFromMap` /
// `listVisionModelIdsFromMap` / `listAllModelIdsFromMap` / `getLoadedModels`
// 用于 Fix #4 去重 readFileSync（callers 拿到 parsed cfg 后可一次性复用）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cachedDerive } from '../../scripts/lib/derived-cache.mjs';

const KILO_JSON_PATH = resolve(process.cwd(), 'kilo.json');

/**
 * 加载模型表（自带 readFileSync）。内部 key = `<alias>/<modelId>`，
 * value = 原始 model 字段 + `_alias` / `_id` 标记。
 */
export function getLoadedModels() {
  return loadModels();
}

/**
 * Fix #4 旁路：接受已解析的 kilo.json cfg 对象，避免在同一次 dispatch
 * 流程里既 readFileSync 拿 smallModel 又再 readFileSync 拿 models。
 * 解析逻辑与 loadModels 完全一致，仅输入从文件改为内存对象。
 */
export function loadModelsFromCfg(cfg) {
  const providers = cfg?.provider ?? {};
  return _mergeProviderModels(providers);
}

function _mergeProviderModels(providers) {
  const merged = {};
  for (const alias of Object.keys(providers)) {
    const models = providers[alias]?.models ?? {};
    for (const id of Object.keys(models)) {
      // 内部命名空间：'<alias>/<id>' 复合 key，避免跨 provider 同名 model 静默合并
      const key = `${alias}/${id}`;
      if (!merged[key]) {
        merged[key] = { ...models[id], _alias: alias, _id: id };
      }
    }
  }
  return merged;
}

function loadModels() {
  // mtime 失效缓存（对齐 transition-check / task-context 既有模式）；
  // kilo.json 装配后静态，跨 dispatch 命中缓存（<10ms），改 kilo.json 自动失效。
  return cachedDerive('kiloModels', [KILO_JSON_PATH], () => {
    try {
      const raw = readFileSync(KILO_JSON_PATH, 'utf8');
      const cfg = JSON.parse(raw);
      return _mergeProviderModels(cfg?.provider ?? {});
    } catch (err) {
      // 防御：kilo.json 缺失 / 损坏时返回空对象，不向上抛
      // 下游 getCapabilities / listVisionModels / listAllModels 会基于空集合走 safe defaults
      console.warn(`[capability-registry] failed to load ${KILO_JSON_PATH}: ${err?.message ?? err}`);
      return {};
    }
  });
}

function inferVision(model) {
  const input = model?.modalities?.input;
  if (!Array.isArray(input)) return false;
  return input.includes('image');
}

// Fix P0-2: 默认 code-capable（对齐 inferReasoning 的 `!== false` 保守语义）。
// 旧逻辑按名字含 'code'/'coder' 判定 -> glm-5.2/deepseek 等被误判"缺 code"而触发
// 不必要的升级到 kimi-k2.7-code，与 model-registry 人工评级（glm-5.2 编码 ★★★★☆）
// 矛盾，且遮蔽 economy 降级路径。新逻辑：显式 model.capabilities.code === false
// 才判非 code（纯视觉/纯对话模型），缺省 true。如需标记某模型非 code，在 kilo.json
// provider.hx.models.<id> 加 `capabilities: { code: false }`（可选字段，不破坏现有结构）。
function inferCode(model) {
  if (model && model.capabilities && model.capabilities.code === false) return false;
  return true;
}

function inferReasoning(model) {
  // No modalities-based restriction; preserve per-model reasoning flag
  // (defaults to true when absent so every model remains reasoning-capable).
  return model?.reasoning !== false;
}

function inferLongContext(model) {
  return Number(model?.limit?.context ?? 0) >= 100000;
}

// v3 (Fix D2): 多 provider 同 id 能力聚合 —— 找到所有 _id 匹配 modelId 的
// entries，对 vision/code/long_context 用 OR (some)，对 reasoning 用 AND (every，
// 保守：任一 provider 标记 false 则 false，避免过于乐观地放行 critical 任务)。
// 保留 _findKeyById 给历史 first-wins 调用路径兼容使用。
function _findKeysById(merged, modelId) {
  const out = [];
  for (const k of Object.keys(merged)) {
    if (merged[k]._id === modelId) out.push(k);
  }
  return out;
}

function _findKeyById(merged, modelId) {
  const keys = _findKeysById(merged, modelId);
  return keys[0];
}

// —— 内部辅助：merged（复合 key map）→ modelId 列表 / 视觉 modelId 列表
function _idsOf(merged) {
  const out = [];
  for (const k of Object.keys(merged)) out.push(merged[k]._id);
  return out;
}

function _visionIdsOf(merged) {
  const out = [];
  for (const k of Object.keys(merged)) {
    if (inferVision(merged[k])) out.push(merged[k]._id);
  }
  return out;
}

// —— 公共 API（行为不变：仍以 modelId 为外部契约）——

export function getCapabilities(modelId) {
  return getCapabilitiesFromMap(modelId, loadModels());
}

export function listVisionModels() {
  return _visionIdsOf(loadModels());
}

export function listAllModels() {
  return _idsOf(loadModels());
}

// —— Fix #4 旁路 API：使用预解析的 merged map，避免内部再读 kilo.json ——

export function getCapabilitiesFromMap(modelId, preloaded) {
  // Fix D2: 聚合所有 _id 匹配 modelId 的 entries（多 provider 同 id 场景）
  const matches = _findKeysById(preloaded, modelId);
  if (matches.length === 0) {
    return { vision: false, code: false, reasoning: true, long_context: false };
  }
  const models = matches.map((k) => preloaded[k]);
  return {
    vision: models.some(inferVision),
    code: models.some((m) => inferCode(m)),
    reasoning: models.every(inferReasoning),
    long_context: models.some(inferLongContext),
  };
}

export function listVisionModelIdsFromMap(preloaded) {
  return _visionIdsOf(preloaded);
}

export function listAllModelIdsFromMap(preloaded) {
  return _idsOf(preloaded);
}

// Fix P0-1: 按 modelId 反查 provider alias 前缀（如 'glm-5.2' -> 'hx/'）。
// 用于 model-selector 把 selected_model 拼回 kilo.json 期望的 '<alias>/<modelId>' 格式，
// 避免 conductor 把裸 modelId 传给 task 工具的 model 参数无法解析 provider。
// 多 provider 同 id 取首个 alias；未找到返回 ''（调用方原样返回，向后兼容）。
export function getProviderPrefixForModelId(modelId, preloaded) {
  const merged = preloaded || loadModels();
  const keys = _findKeysById(merged, modelId);
  if (keys.length === 0) return '';
  return merged[keys[0]]._alias + '/';
}
