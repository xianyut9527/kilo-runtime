// checks/__tests__/command-path-hygiene.test.mjs — `cmd-path.*` 四规则分支夹具
//
// 与 .tmp 一次性探针的区别：这里跑在 `unit.executed` 网内，门禁改坏判定逻辑会被立刻抓到。
// 只喂临时沙箱 ROOT，不依赖本仓库真实 install 脚本（那属于「现状快照」而非行为契约）。
import { test, assert, makeSandbox } from '../../../lib/test-harness.mjs';
import { run } from '../command-path-hygiene.mjs';

// ---- 夹具文本构造：一律数组 join，不用嵌套模板字面量（解析器歧义 + 可读性）----
function ps1(items) {
  const lines = items.map((p) => '    (Join-Path $Target "' + p.replace(/\//g, '\\') + '\\*.md")');
  return ['# install.ps1', '$MdFilePatterns = @('].concat(lines, [')',
    '# 下面这些 Join-Path 不该被当成替换清单（回归用例）',
    '$src = Join-Path $Target "scripts"',
    '$k = Join-Path $Target ".kilo"', '']).join('\n');
}
function sh(items) {
  const dirs = items.map((p) => '"' + '${TARGET_DIR}/' + p + '"').join(' ');
  return ['# install.sh', 'for md_dir in ' + dirs + '; do', '    echo x', 'done', ''].join('\n');
}

const SUBST = ['agent', '.kilo/instructions', 'lifecycle/stages'];
const GOOD = {
  'install.ps1': ps1(SUBST),
  'install.sh': sh(SUBST),
  'agent/a.md': 'run `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" init x` here\n',
  'lifecycle/stages/init.md': '```bash\nnode "${KILO_CONFIG_DIR}/scripts/transition-check.mjs" t --from INIT\n```\n',
  'scripts/task-context.mjs': '',
  'scripts/transition-check.mjs': '',
  'scripts/lifecycle-doctor/index.mjs': '',
  'lifecycle/stages/README.md': '维护者：跑 `node scripts/lifecycle-doctor/index.mjs`\n',
  'lifecycle/graph.yaml': 'nodes: []\n',
};

/** 跑一遍 check，返回 { fail: ['name :: detail'], levels: {name: level} } */
function evaluate(name, files) {
  const rec = [];
  run({ cf: { pass: (n, d) => rec.push(['PASS', n, d || '']),
    fail: (n, d) => rec.push(['FAIL', n, d || '']),
    warn: (n, d) => rec.push(['WARN', n, d || '']) },
  ROOT: makeSandbox(files, name) });
  return {
    levels: rec.reduce((a, x) => { a[x[1]] = x[0]; return a; }, {}),
    detail: (n) => (rec.find((x) => x[1] === n) || [, , ''])[2],
    anyFail: rec.filter((x) => x[0] !== 'PASS').map((x) => x[1] + ' :: ' + x[2]),
  };
}

const merge = (over) => ({ ...GOOD, ...over });

test('全合规夹具 → 零 FAIL（不误伤）', () => {
  assert.deepEqual(evaluate('good', GOOD).anyFail, []);
});

test('A：阶段文档写相对命令 → 必拦', () => {
  const r = evaluate('rel', merge({ 'lifecycle/stages/init.md': 'node scripts/task-context.mjs init x\n' }));
  assert.equal(r.levels['cmd-path.no-relative-command'], 'FAIL');
});

test('A：无路径命令（node task-context.mjs）→ 必拦', () => {
  const r = evaluate('bare', merge({ 'agent/a.md': '跑 `node task-context.mjs init x`\n' }));
  assert.equal(r.levels['cmd-path.no-relative-command'], 'FAIL');
});

test('C：命令指向不存在的脚本 → 必拦', () => {
  const r = evaluate('dead', merge({ 'lifecycle/stages/init.md': 'node "${KILO_CONFIG_DIR}/scripts/nope.mjs" x\n' }));
  assert.equal(r.levels['cmd-path.targets-exist'], 'FAIL');
  assert.match(r.detail('cmd-path.targets-exist'), /nope\.mjs/);
});

test('D：双端替换清单不一致 → 必拦，且指明只在某一侧的项', () => {
  const r = evaluate('drift', merge({ 'install.sh': sh(['agent', '.kilo/instructions']) }));
  assert.equal(r.levels['cmd-path.installer-consistent'], 'FAIL');
  assert.match(r.detail('cmd-path.installer-consistent'), /lifecycle\/stages\//);
});

test('B：占位符写在不被替换的文件里 → 必拦（否则占位符原样进运行时）', () => {
  const r = evaluate('survive', merge({ 'AGENTS.md': '装配自检 `node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs"`\n' }));
  assert.equal(r.levels['cmd-path.placeholder-covered'], 'FAIL');
});

test('README.md 豁免：维护者文档里的相对命令不算违规', () => {
  const r = evaluate('readme', merge({ 'lifecycle/README.md': '跑 `node scripts/lifecycle-doctor/index.mjs`\n' }));
  assert.equal(r.levels['cmd-path.no-relative-command'], 'PASS');
  assert.deepEqual(r.anyFail, []);
});

test('部署副本（无 install 脚本）→ 回落兜底清单，D 跳过但 A/C 仍生效', () => {
  const deployed = { ...GOOD };
  delete deployed['install.ps1'];
  delete deployed['install.sh'];
  const ok = evaluate('deployed', deployed);
  assert.deepEqual(ok.anyFail, []);
  assert.match(ok.detail('cmd-path.installer-consistent'), /跳过 D 规则/);
  const bad = evaluate('deployed-bad', { ...deployed, 'agent/a.md': 'node scripts/x.mjs\n' });
  assert.equal(bad.levels['cmd-path.no-relative-command'], 'FAIL');
});

test('ps1 解析必须先切 $MdFilePatterns 块（回归：全文匹配会把 scripts/ .kilo/ 当替换清单）', () => {
  // GOOD 的 ps1 夹具里特意放了两条块外 Join-Path；若解析过宽，scripts/ 会被当成替换目录，
  // 于是 scripts/README.md 这类文件会被拉进候选并判 A → 这里用「块外目录里的相对命令不该报」验证。
  const r = evaluate('ps1scope', merge({ 'scripts/README.md': '跑 `node nope-anywhere.mjs`\n' }));
  assert.deepEqual(r.anyFail, []);
});

// ---- 下面两例守住「无脚本 / 有脚本但解析不出 / 仅单侧」三种回落形态的区分 ----
// 归为一类会把门禁降级成静默回落：install 被改写（解析不出）与部署副本裸跑（本来就无脚本）
// 是两种完全不同的修法，前者必须 FAIL。
test('D：两侧脚本都在但解析不出清单 → FAIL（不得静默用回落清单伪装全绿）', () => {
  const r = evaluate('unparsable', merge({
    'install.ps1': '# install.ps1\n$SomethingElse = @("agent")\n',
    'install.sh': '# install.sh\necho no md_dir loop here\n',
  }));
  assert.equal(r.levels['cmd-path.installer-consistent'], 'FAIL');
  assert.match(r.detail('cmd-path.installer-consistent'), /MdFilePatterns/);
});

test('D：只有一侧脚本 → PASS 但文案不得声称「双端一致」', () => {
  const r = evaluate('one-side', merge({ 'install.sh': '# install.sh\necho nothing\n' }));
  const d = r.detail('cmd-path.installer-consistent');
  assert.equal(r.levels['cmd-path.installer-consistent'], 'PASS');
  assert.match(d, /无法双端比对/);
  assert.ok(!/双端替换清单一致/.test(d), '单侧存在时不得输出「双端一致」这种假陈述');
});
