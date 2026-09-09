// early-exit.test.mjs — U4: early-exit.mjs 边界单测（零源码改动）
// 跑法：node lifecycle/runtime/__tests__/early-exit.test.mjs（底座 scripts/lib/test-harness.mjs）
import { test, assert } from '../../../scripts/lib/test-harness.mjs';
import { detectEarlyExit } from '../early-exit.mjs';

test('空字符串 → early_exit=false', () => {
  assert.deepEqual(detectEarlyExit(''), { early_exit: false, signal_matched: null });
});

test('仅空白 → early_exit=false', () => {
  assert.deepEqual(detectEarlyExit('   '), { early_exit: false, signal_matched: null });
});

test('"好不好？" → early_exit=false（"不" 紧跟否定形）', () => {
  assert.deepEqual(detectEarlyExit('好不好？'), { early_exit: false, signal_matched: null });
});

test('"对不起" → early_exit=false（"不" 紧跟否定形）', () => {
  assert.deepEqual(detectEarlyExit('对不起'), { early_exit: false, signal_matched: null });
});

test('"好看" → early_exit=false（单字复合词前缀表拦截）', () => {
  assert.deepEqual(detectEarlyExit('好看'), { early_exit: false, signal_matched: null });
});

test('"对比" → early_exit=false（"对" 复合词前缀表拦截）', () => {
  assert.deepEqual(detectEarlyExit('对比'), { early_exit: false, signal_matched: null });
});

test('"好" → early_exit=true, signal_matched="好"', () => {
  assert.deepEqual(detectEarlyExit('好'), { early_exit: true, signal_matched: '好' });
});

test('"好！" → 去尾标点后精确命中', () => {
  assert.deepEqual(detectEarlyExit('好！'), { early_exit: true, signal_matched: '好' });
});

test('"继续" → 多字信号命中', () => {
  assert.deepEqual(detectEarlyExit('继续'), { early_exit: true, signal_matched: '继续' });
});

test('大小写不敏感：OK / ok / Ok 均命中', () => {
  for (const input of ['OK', 'ok', 'Ok']) {
    const r = detectEarlyExit(input);
    assert.equal(r.early_exit, true, `${input} 应命中`);
    assert.equal(r.signal_matched, 'OK');
  }
});

test('非字符串输入 → early_exit=false', () => {
  assert.deepEqual(detectEarlyExit(123), { early_exit: false, signal_matched: null });
});
