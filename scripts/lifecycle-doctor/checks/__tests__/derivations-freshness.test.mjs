// checks/__tests__/derivations-freshness.test.mjs — 预生成快路新鲜度门禁分支夹具
//
// 这条门禁的语义必须与运行时**完全一致**（镜像 task-context.mjs 的解析规则），
// 一旦两边分叉，就会出现「门禁说新鲜、运行时走慢路径」或反向的假象。
// 更关键的是它的保守分支：读不到 / MISSING / 旧格式一律**不判 stale**——
// 判 stale 是 WARN 尚可，误判方向反了（把新鲜说成过期）会让人反复重建，
// 把过期说成新鲜则整包预生成优化静默失效。两侧都要钉住。
import { createHash } from 'node:crypto';
import { test, assert, makeSandbox, sandboxWrite } from '../../../lib/test-harness.mjs';
import { createCheckFn } from '../../lib/util.mjs';
import { run as runFreshness } from '../derivations-freshness.mjs';

const GEN_REL = 'scripts/lib/.generated/derivations.json';

function hex(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// 条目格式由 build-derivations.mjs 的 sourceFingerprint 定义：`${path.basename(f)}@${digest}`，
// 即**不带目录前缀**的basename（scope 由读取侧根据名字推断，不在名字里写目录）。
const AGENT_A = '---\nname: a\ndescription: agent a\n---\n\n# a\n';
const GRAPH = '# graph\nnodes: []\n';

function genFile(opts) {
  const o = opts || {};
  return JSON.stringify({
    fingerprint: 'fingerprint' in o ? o.fingerprint : o.fp,
    writeMatrix: o.writeMatrix || { a: { files: ['src/a.java'] } },
  }, null, 2);
}

function probe(root) {
  const cf = createCheckFn();
  const r = runFreshness({ ROOT: root, cf });
  return { r, results: cf.getResults() };
}

test('指纹全匹配 → PASS', () => {
  const fp = 'a.md@' + hex(AGENT_A);
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    [GEN_REL]: genFile({ fp }),
  });
  const { r, results } = probe(root);
  assert.equal(r.status, 'PASS', r.detail);
  assert.equal(r.detail, 'agents=1');
  assert.ok(results[0].detail.indexOf('checked=1') >= 0, results[0].detail);
});

test('源文件内容变了 → WARN stale 且指名是哪个文件', () => {
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    [GEN_REL]: genFile({ fp: 'a.md@' + hex('旧版本内容') }),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.equal(r.detail, 'stale');
  assert.deepEqual(r.issues, ['a.md']);
});

test('产物不存在 → WARN missing（快路未启用要显式说）', () => {
  const root = makeSandbox({ 'agent/a.md': AGENT_A });
  const { r, results } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.equal(r.detail, 'missing');
  assert.ok(results[0].detail.indexOf('慢路径') >= 0, results[0].detail);
});

test('产物 JSON 语法坏 → WARN unparsable（不抛异常打断 doctor）', () => {
  const root = makeSandbox({ [GEN_REL]: '{ "fingerprint": ' });
  const { r } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.equal(r.detail, 'unparsable');
});

test('缺 writeMatrix → WARN no-writeMatrix（不能因为指纹对就报新鲜）', () => {
  const root = makeSandbox({ [GEN_REL]: JSON.stringify({ fingerprint: '' }) });
  const { r } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.equal(r.detail, 'no-writeMatrix');
});

test('无 fingerprint 字段 → 判 stale 并要求重建（不可当成新鲜）', () => {
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    [GEN_REL]: genFile({ fingerprint: undefined }),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.deepEqual(r.issues, ['(无 fingerprint 字段)']);
});

// 保守分支：以下三种都**不该**判 stale（判了就是误报，会逼人无意义重建）
test('@MISSING / 旧格式 / 源文件缺失 一律保守不判 stale', () => {
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    [GEN_REL]: genFile({
      fp: ['gone.md@' + hex('x'), 'legacy.md@1700000000000', 'absent.md@MISSING'].join('|'),
    }),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', r.detail);      // 没有一条可比 → checked=0 也不算 stale
});

test('混合场景：可比项匹配 + 不可比项存在 → 仍 PASS 且 checked 只计可比项', () => {
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    [GEN_REL]: genFile({ fp: ['a.md@' + hex(AGENT_A), 'absent.md@MISSING'].join('|') }),
  });
  const { results } = probe(root);
  assert.ok(results[0].detail.indexOf('checked=1') >= 0, results[0].detail);
});

// scope 镜像：graph.yaml/config.yaml 取 lifecycle/，其余取 agent/。
// 若有人把规则改成「都从 agent/ 找」，本例会立刻变红——同名的 agent/graph.yaml 是诱饵。
test('graph.yaml 的指纹只对照 lifecycle/ 版本（scope 镜像运行时）', () => {
  const root = makeSandbox({
    'lifecycle/graph.yaml': GRAPH,
    'agent/graph.yaml': '诱饵：内容完全不同的一行\n',
    [GEN_REL]: genFile({ fp: 'graph.yaml@' + hex(GRAPH) }),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues));

  sandboxWrite(root, 'lifecycle/graph.yaml', GRAPH + 'stale_after_edit\n');
  const r2 = probe(root).r;
  assert.equal(r2.status, 'WARN');
  assert.deepEqual(r2.issues, ['graph.yaml']);
});

test('多个条目只报不匹配的那几条（detail 有 n/m 计数）', () => {
  const root = makeSandbox({
    'agent/a.md': AGENT_A,
    'agent/b.md': '# b\n',
    'agent/c.md': '# c-real\n',
    [GEN_REL]: genFile({
      writeMatrix: { a: {}, b: {}, c: {} },
      fp: ['a.md@' + hex(AGENT_A), 'b.md@' + hex('# changed\n'), 'c.md@' + hex('# c\n')].join('|'),
    }),
  });
  const { r, results } = probe(root);
  assert.equal(r.status, 'WARN');
  assert.deepEqual(r.issues.sort(), ['b.md', 'c.md']);
  assert.ok(results[0].detail.indexOf('2/3') >= 0, results[0].detail);
});
