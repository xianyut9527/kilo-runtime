// model-selector.test.mjs — U1: model-selector.mjs 单测（node --test，需 Node>=18）
// code 升级路径依赖仓库 kilo.json（读 provider.hx.models 找含 code/coder 的 id）——当前仓库
// 无 code 模型，故 code:true 会落穿 no-change（空模型防线，见 P2-1）。其余覆盖：economy/
// small_model 降级、passthrough 未知、vision 升级、no-change、缺省 fallback。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../model-selector.mjs';

// 构造预解析 merged map（capability-registry 内部 key = '<alias>/<id>'）。
// 默认 code-capable（inferCode 缺省 true）；显式 capabilities.code=false 标记非 code。
function makeMap(overrides = {}) {
  const base = {
    'hx/glm-5.2': { _alias: 'hx', _id: 'glm-5.2', reasoning: true, limit: { context: 200000 } },
    'hx/minimax-m3': { _alias: 'hx', _id: 'minimax-m3', reasoning: true, limit: { context: 200000 } },
    'hx/kimi-k2.6': { _alias: 'hx', _id: 'kimi-k2.6', reasoning: true, limit: { context: 200000 } },
  };
  for (const [k, v] of Object.entries(overrides)) base[k] = v;
  return base;
}

test('economy + smallModel 透传 → 降级到 smallModel（带 provider 前缀）', () => {
  const r = selectModel('glm-5.2', { vision: false, code: false, reasoning: true, long_context: false }, {
    costPriority: 'economy',
    smallModel: 'hx/minimax-m3',
    models: makeMap(),
  });
  assert.equal(r.selected_model, 'hx/minimax-m3');
  assert.equal(r.override_reason, 'economy-mode: small task');
  assert.equal(r.downgraded, true);
  assert.equal(r.upgraded, false);
});

test('economy + 裸 smallModel（无前缀）→ 仍拼回 provider 前缀', () => {
  const r = selectModel('glm-5.2', { vision: false, code: false, reasoning: true, long_context: false }, {
    costPriority: 'economy',
    smallModel: 'minimax-m3',
    models: makeMap(),
  });
  assert.equal(r.selected_model, 'hx/minimax-m3');
});

test('code 升级禁用：非 code 模型 + code:true 但仓库 kilo.json 无 code 模型 → no-change 空模型防线', () => {
  // 构造一个非 code 的默认模型，触发 code 升级路径；仓库 kilo.json 当前无 code/coder 模型，
  // readCodeOptimizedModel() 返回 null → 落穿 no-change（防 selected_model:null + upgraded:true）。
  const map = makeMap({ 'hx/glm-5.2': { _alias: 'hx', _id: 'glm-5.2', capabilities: { code: false }, reasoning: true, limit: { context: 200000 } } });
  const r = selectModel('glm-5.2', { vision: false, code: true, reasoning: true, long_context: false }, { models: map });
  assert.equal(r.selected_model, 'hx/glm-5.2');
  assert.equal(r.override_reason, 'no-change');
  assert.equal(r.upgraded, false);
  // 防双前缀：不得出现 hx/hx/（null 也不得拼出空 provider 前缀）
  assert.ok(!r.selected_model.includes('hx/hx/'), 'selected_model must not contain double prefix');
});

test('code 升级禁用 + 输入带前缀（hx/glm-5.2）→ 同落穿 no-change，不拼空模型', () => {
  const map = makeMap({ 'hx/glm-5.2': { _alias: 'hx', _id: 'glm-5.2', capabilities: { code: false }, reasoning: true, limit: { context: 200000 } } });
  const r = selectModel('hx/glm-5.2', { vision: false, code: true, reasoning: true, long_context: false }, { models: map });
  assert.equal(r.selected_model, 'hx/glm-5.2');
  assert.equal(r.override_reason, 'no-change');
  assert.equal(r.upgraded, false);
  assert.ok(!r.selected_model.includes('hx/hx/'), 'selected_model must not contain double prefix');
});

test('passthrough：未知模型 → 原样返回 + unknown-model: passthrough', () => {
  const r = selectModel('unknown-xyz', { vision: false, code: false, reasoning: true, long_context: false });
  assert.equal(r.selected_model, 'unknown-xyz');
  assert.equal(r.override_reason, 'unknown-model: passthrough');
  assert.equal(r.upgraded, false);
  assert.equal(r.downgraded, false);
});

test('vision 升级：非 vision 模型 + vision:true → 选 vision 模型（code 优先 + 前缀）', () => {
  const map = makeMap({
    'hx/glm-5.2': { _alias: 'hx', _id: 'glm-5.2', reasoning: true, limit: { context: 200000 } },
    'hx/kimi-k2.6': { _alias: 'hx', _id: 'kimi-k2.6', reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200000 } },
  });
  const r = selectModel('glm-5.2', { vision: true, code: false, reasoning: true, long_context: false }, { models: map });
  assert.equal(r.selected_model, 'hx/kimi-k2.6');
  assert.equal(r.override_reason, 'vision-required: glm-5.2 lacks vision');
  assert.equal(r.upgraded, true);
});

test('no-change：能力满足 → 原样返回 + no-change', () => {
  const r = selectModel('glm-5.2', { vision: false, code: false, reasoning: true, long_context: false }, { models: makeMap() });
  assert.equal(r.selected_model, 'hx/glm-5.2');
  assert.equal(r.override_reason, 'no-change');
  assert.equal(r.upgraded, false);
  assert.equal(r.downgraded, false);
});

test('缺省 fallback：economy 未传 smallModel → 从 kilo.json small_model 兜底', () => {
  const r = selectModel('glm-5.2', { vision: false, code: false, reasoning: true, long_context: false }, { costPriority: 'economy', models: makeMap() });
  assert.equal(r.selected_model, 'hx/minimax-m3');
  assert.equal(r.downgraded, true);
});
