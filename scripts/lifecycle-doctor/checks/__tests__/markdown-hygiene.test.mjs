// checks/__tests__/markdown-hygiene.test.mjs — 坏 markdown 门禁分支夹具
//
// 立项事故：自动注入的 core.md 里累积 16 处「反斜杠 + 反引号」，模型每轮读到会照着模仿。
// 本门禁只有一条判据 + 一条豁免通道，但**豁免通道被写宽就等于没有门禁**（archive 整目录、
// 同行 hygiene-ignore、点目录例外），所以逐条钉住。
import { test, assert, makeSandbox } from '../../../lib/test-harness.mjs';
import { createCheckFn } from '../../lib/util.mjs';
import { run as runHygiene } from '../markdown-hygiene.mjs';

function probe(root) {
  const cf = createCheckFn();
  const r = runHygiene({ ROOT: root, cf });
  return { r, results: cf.getResults() };
}

// 门禁要拦的就是这个字面形态，夹具里必须真写出来。用拼接构造，避免本文件自身被拦。
const BT = '`';
const BS = '\\';
const BAD_LINE = '示例：' + BS + BT + 'x' + BS + BT + ' 这样写';
const IGNORE = 'hygiene-ignore';

test('干净文档 → PASS 且 occurrences=0', () => {
  const root = makeSandbox({
    'agent/a.md': ['# A', '', '正常行内码：' + BT + 'x' + BT + '，无转义反引号。', ''].join('\n'),
  });
  const { r, results } = probe(root);
  assert.equal(r.status, 'PASS');
  assert.equal(results[0].name, 'md-hygiene.escaped-backtick');
  assert.ok(results[0].detail.indexOf('occurrences=0') >= 0, results[0].detail);
});

// 返回契约：{ status, detail, issues: [{ kind, file, lines(逗号串), count(总数) }] }
function first(r) {
  assert.ok(r.issues && r.issues.length === 1, 'issues=' + JSON.stringify(r.issues));
  return r.issues[0];
}

test('字面「反斜杠+反引号」→ FAIL，带文件/行号/出现次数', () => {
  const root = makeSandbox({
    'agent/a.md': ['# A', '', '干净', BAD_LINE, ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL', r.detail);
  const i = first(r);
  assert.equal(i.kind, 'escaped-backtick');
  assert.equal(i.file, 'agent/a.md');
  assert.equal(i.lines, '4');
  assert.equal(i.count, 2);   // 一行两处 → 聚合为 count=2
});

test('同行 hygiene-ignore 显式豁免（要展示坏形态本身时必须能豁免）', () => {
  const root = makeSandbox({
    'agent/a.md': ['# A', '', BAD_LINE + ' ' + IGNORE, ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS');
});

test('豁免只在同行生效，不跨行传染', () => {
  const root = makeSandbox({
    'agent/a.md': ['# A', '', '说明 ' + IGNORE, BAD_LINE, ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL', r.detail);
  assert.equal(first(r).lines, '4');
});

test('docs/archive/ 是历史档案，整目录豁免', () => {
  const root = makeSandbox({
    'docs/archive/old.md': ['# Old', '', BAD_LINE, ''].join('\n'),
  });
  const { r } = probe(root);
  // archive 被跳过后没有任何目标文件 → 走「no target」分支，同样不该把档案当缺陷
  assert.ok(r.status === 'PASS' || r.detail === 'no target files', r.status + ' ' + r.detail);
  assert.ok(!JSON.stringify(r.issues || []).includes('archive'), JSON.stringify(r.issues));
});

test('.kilo 承载自动注入的 instructions，必须扫（点目录例外）', () => {
  const root = makeSandbox({
    '.kilo/instructions/core.md': ['# core', '', BAD_LINE, ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL', r.detail);
  assert.equal(first(r).file, '.kilo/instructions/core.md');
});

test('node_modules 与其它点目录不扫（防几百份第三方 README 误报）', () => {
  const root = makeSandbox({
    'agent/a.md': ['# A', '', '干净', ''].join('\n'),
    'node_modules/pkg/README.md': ['# pkg', '', BAD_LINE, ''].join('\n'),
    '.other/tool.md': ['# t', '', BAD_LINE, ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
});

test('根下无 markdown 目标 → FAIL（空扫描不能静默绿）', () => {
  const root = makeSandbox({ 'notes.txt': 'x' });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'no target files');
});
