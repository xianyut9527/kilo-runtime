// capability-registry.test.mjs — U2: capability-registry.mjs getCapabilitiesFromMap 单测
// 覆盖：显式 code:true / 显式 code:false / 缺省默认 true / unknown safe default / vision 推导
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilitiesFromMap } from '../capability-registry.mjs';

test('显式 code:true → code=true', () => {
  const preload = { 'hx/kimi-k2.7-code': { capabilities: { code: true }, _alias: 'hx', _id: 'kimi-k2.7-code' } };
  const c = getCapabilitiesFromMap('kimi-k2.7-code', preload);
  assert.equal(c.code, true);
});

test('显式 code:false → code=false（可覆盖缺省 true）', () => {
  const preload = { 'hx/x': { capabilities: { code: false }, _alias: 'hx', _id: 'x' } };
  const c = getCapabilitiesFromMap('x', preload);
  assert.equal(c.code, false);
});

test('缺省（无 capabilities 字段）→ code=true', () => {
  const preload = { 'hx/plain': { reasoning: true, _alias: 'hx', _id: 'plain' } };
  const c = getCapabilitiesFromMap('plain', preload);
  assert.equal(c.code, true);
});

test('unknown model → safe default（code=false）', () => {
  const preload = {};
  const c = getCapabilitiesFromMap('nonexistent', preload);
  assert.deepEqual(c, { vision: false, code: false, reasoning: true, long_context: false });
});

test('vision 按 modalities.input 推导，与 code 字段独立', () => {
  const preload = { 'hx/v': { modalities: { input: ['text', 'image'], output: ['text'] }, _alias: 'hx', _id: 'v' } };
  const c = getCapabilitiesFromMap('v', preload);
  assert.equal(c.vision, true);
  assert.equal(c.code, true); // 缺省 code 不受 modalities 影响
});

test('显式 code:true + vision 共存（kimi-k2.7-code 真实形态）', () => {
  const preload = {
    'hx/kimi-k2.7-code': {
      capabilities: { code: true },
      modalities: { input: ['text', 'image'], output: ['text'] },
      _alias: 'hx', _id: 'kimi-k2.7-code'
    }
  };
  const c = getCapabilitiesFromMap('kimi-k2.7-code', preload);
  assert.equal(c.code, true);
  assert.equal(c.vision, true);
});
