// checks/__tests__/anchor-refs.test.mjs — 死引用门禁分支夹具
//
// 为什么必须有：anchor-refs 是本轮门禁里逻辑最重、也最容易被"改好一点的精度"改坏的一个
// （围栏剥离、双向 prefix、近窗口文件绑定、stem 无扩展名、YAML 字面命中）。它的立项事故
// 是「6 处引用不存在的锚点而全绿」，反过来同样危险的是**误报**：path-normalize 的教训是
// 13/13 假阳性直接把门禁变成噪声被断开。所以正反两向都要被钉住，只靠"在真仓库跑一次 0 FP"
// 不构成防线——那一次之后没人再验证过。
import { test, assert, makeSandbox, sandboxWrite } from '../../../lib/test-harness.mjs';
import { createCheckFn } from '../../lib/util.mjs';
import { run as runAnchorRefs } from '../anchor-refs.mjs';

function probe(root) {
  const cf = createCheckFn();
  const r = runAnchorRefs({ ROOT: root, cf });
  return { r, results: cf.getResults() };
}

const CONDUCTOR = [
  '# conductor',
  '',
  '1. **委派不亲为**：细节见 §委派包 SOP',
  '2. **超时守卫**：按 §返回超限约束',
  '3. **并行优先**',
  '',
  '## 委派包 SOP',
  '正文',
  '',
  '### 10.1 等级判定',
  '正文',
  '',
  '## 返回超限约束（分档）',
  '正文',
  '',
];

test('合法引用全绿：编号铁律 / 粗体锚点 / 截断 prefix / 自文件锚点', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': [
      '# agents',
      '按铁律 #2 执行，细则见 conductor.md §委派包 SOP。',
      '超限分档见 conductor.md §返回超限约束。',   // 标题带括注，引用截断 → 应命中
      '本文件锚点：见 §本节标题。',
      '## 本节标题',
      '',
    ].join('\n'),
  });
  const { r, results } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues || []));
  assert.equal(r.issues.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].level, 'PASS');
});

test('悬空锚点 → dangling-anchor（FAIL + 定位到行）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': '看 conductor.md §根本不存在的小节\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].kind, 'dangling-anchor');
  assert.ok(r.issues[0].text.indexOf('根本不存在的小节') >= 0);
  assert.equal(r.issues[0].line, 1);
});

test('铁律 #N 越界 → dangling-ironlaw（唯一归属文件 = conductor.md）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,          // 只定义了 1/2/3 与 10.1
    'AGENTS.md': '按铁律 #11 执行\n按铁律 #10.1 执行\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  const kinds = r.issues.map((i) => i.kind + ':' + i.line);
  assert.deepEqual(kinds, ['dangling-ironlaw:1']);   // 第二行 #10.1 有定义，不该报
});

test('引用不存在的文件 → dangling-file，且不再对其锚点二次误报', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': '见 gone.md §任意内容\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  assert.deepEqual(r.issues.map((i) => i.kind), ['dangling-file']);
});

// 精度防线：docs 里大量 `## xxx` 写在 ```markdown 模板内，若不剥离围栏就会成片假标题 + 假引用
test('围栏代码块内的标题与 §引用一律不采信（防假阳性）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR.concat([
      '```markdown',
      '## 模板里的假标题',
      '引 用：见 §模板内的假锚点',
      '```',
      '',
    ]),
    'AGENTS.md': [
      '模板示例：',
      '',
      '```markdown',
      '见 conductor.md §模板内的假锚点',
      '```',
      '',
    ].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
});

test('单字 §引用是正则截断产物，不报（如标题里的 §防 abort）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': '参见 §A 与 §防 abort 的说明\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
});

test('无扩展名 stem 引用可解析（`conductor §委派包 SOP`）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': '见 conductor §委派包 SOP\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
});

test('同文件重复标题 → duplicate-heading（会让 §引用绑定到错误目标）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'AGENTS.md': ['## 重名', 'x', '', '## 重名', 'y', ''].join('\n'),
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.issues[0].kind, 'duplicate-heading');
  assert.equal(r.issues[0].line, 4);
});

test('YAML 目标按字面文本命中（锚点是注释段标题）', () => {
  const root = makeSandbox({
    'agent/conductor.md': CONDUCTOR,
    'lifecycle/config.yaml': ['# 配置', '# on_fail 默认值规则：warn', ''],
    'AGENTS.md': '见 config.yaml §on_fail 默认值规则\n见 config.yaml §这段文本真没有\n',
  });
  const { r } = probe(root);
  assert.equal(r.status, 'FAIL');
  assert.deepEqual(r.issues.map((i) => i.line), [2]);   // 第一行字面命中，第二行才报
  assert.equal(r.issues[0].kind, 'dangling-anchor');
});

test('沙箱内无任何目标文档 → PASS skipped（不假 FAIL）', () => {
  const root = makeSandbox({ 'README-only-else.txt': 'x' });
  sandboxWrite(root, 'other/notes.txt', 'nothing');
  const { r } = probe(root);
  assert.equal(r.status, 'PASS');
  assert.equal(r.detail, 'no docs found, skipped');
});
