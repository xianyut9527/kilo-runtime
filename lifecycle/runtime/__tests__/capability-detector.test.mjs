// capability-detector.test.mjs — U4: capability-detector.mjs 单测（node --test，零源码改动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCapabilities } from '../capability-detector.mjs';

test('空意图 + 空文件 → 默认能力集', () => {
  assert.deepEqual(detectCapabilities('', []), {
    vision: false,
    code: false,
    reasoning: true,
    long_context: false,
  });
});

test('"看图片" → vision=true', () => {
  const r = detectCapabilities('看图片', []);
  assert.equal(r.vision, true);
  assert.equal(r.code, false);
  assert.equal(r.reasoning, true);
  assert.equal(r.long_context, false);
});

test('"修复bug" → code=true', () => {
  const r = detectCapabilities('修复bug', []);
  assert.equal(r.code, true);
  assert.equal(r.vision, false);
  assert.equal(r.reasoning, true);
  assert.equal(r.long_context, false);
});

test('短文本（无关键词）→ 全 false（reasoning 恒 true）', () => {
  const r = detectCapabilities('你好，今天天气不错', []);
  assert.deepEqual(r, {
    vision: false,
    code: false,
    reasoning: true,
    long_context: false,
  });
});

test('文本 >5000 字符 → long_context=true', () => {
  const longText = 'a'.repeat(5001);
  const r = detectCapabilities(longText, []);
  assert.equal(r.long_context, true);
  assert.equal(r.vision, false);
  assert.equal(r.code, false);
});

test('文件数 >3 → long_context=true', () => {
  const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  const r = detectCapabilities('', files);
  assert.equal(r.long_context, true);
});

test('图片附件（.png）→ vision=true', () => {
  const r = detectCapabilities('', ['photo.png']);
  assert.equal(r.vision, true);
});

test('恰好 5000 字符 → long_context=false（边界）', () => {
  const r = detectCapabilities('a'.repeat(5000), []);
  assert.equal(r.long_context, false);
});

test('恰好 3 个文件 → long_context=false（边界）', () => {
  const r = detectCapabilities('', ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(r.long_context, false);
});
