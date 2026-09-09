// checks/__tests__/install-runtime-data.test.mjs — install 运行时清单解析与 EXTRA 分类夹具
//
// 这块逻辑决定「部署副本多出来的文件」是噪声还是信号：判错方向要么每次 install 刷三行误报
// （训练人去忽略门禁），要么把真残留/待回收项静默放过。两种错法都必须被夹具盯住。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, makeSandbox } from '../../../lib/test-harness.mjs';
import { parseRuntimeOwn, classifyExtra, parseInstallExcludes,
  resolveInstallExcludes, buildDriftExcludes, isRootOnlyExcluded,
  FALLBACK_RECURSIVE_EXCLUDE, FALLBACK_ROOT_ONLY_EXCLUDE, DRIFT_ONLY_NAMES } from '../../../lib/install-runtime-data.mjs';

// __tests__ 退 4 层 = 仓库根（三个 .. 到 scripts，四个到根）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// install.ps1 真实写法用反斜杠路径（docs\lessons）。拼而非直写：`'\\'` 形式不会被
// path-normalize 的「引号内路径串夹反斜杠」规则误判，而内嵌字面量会被（它不读 JS 转义语义）。
const BS = '\\';
const PS1 = [
  '$RecursiveExclude = @("skills", "docs")', // 干扰项：别的数组不得被当成运行时清单
  '$RuntimeDataDirs = @("knowledge-base", "docs' + BS + 'lessons")',
  '$RuntimeDataFiles = @(".bash-permission-migrated", "kilo.jsonc")',
  '',
].join('\n');
const SH = [
  'EXCLUDE=("skills" "docs")',
  'RUNTIME_DATA_DIRS=("knowledge-base" "docs/lessons")',
  'RUNTIME_DATA_FILES=(".bash-permission-migrated" "kilo.jsonc")',
  '',
].join('\n');

// 交叉校验：解析器（事实源）与回落副本必须一致——install 侧改了而 fallback 没改，
// 读不到脚本的那一侧就会静默用旧排除集。比对的是导出的常量而非源码文本，
// 写法怎么改都不会让夹具失灵。
//
// 但这三例的**前提是本树就是源仓库**：部署副本按设计不部署 install.ps1/install.sh，
// 在那侧根本没有事实源可比（实测：部署树里本夹具会 FAIL 一条、更阴的是「无交集」那条会
// 因 e.recursive=[] 而**假绿**——空清单永远不交叉，看着在守其实什么都没守）。
// 所以无事实源时必须显式早退，而不能让断言在空集上自得。
// 覆盖不失：install.ps1 L183 / install.sh L226 的**仓库侧完整 doctor**（非 --fast）先于拷贝跑，
// unit.executed 在其中——带腐化 fallback 部署出去这条路是被挡住的。
const SRC = fs.existsSync(path.join(REPO_ROOT, 'install.ps1'))
  || fs.existsSync(path.join(REPO_ROOT, 'install.sh')) ? REPO_ROOT : null;

test('真实仓库可解析到双端排除清单且无差异（部署副本侧无事实源→早退）', () => {
  if (!SRC) return;
  const e = parseInstallExcludes(SRC);
  assert.equal(e.via, 'install.ps1+install.sh', e.via);
  assert.deepEqual(e.mismatch, []);
  assert.ok(e.rootOnly.includes('README.md'), 'rootOnly 应含 README.md');
  assert.ok(e.recursive.includes('node_modules'), 'recursive 应含 node_modules');
});

test('回落副本与 install 真实清单一致（防 fallback 腐化；部署副本侧早退）', () => {
  if (!SRC) return;
  const e = parseInstallExcludes(SRC);
  assert.deepEqual(
    e.recursive.filter((v) => FALLBACK_RECURSIVE_EXCLUDE.indexOf(v) === -1),
    [], 'install 已新增但 fallback 未补');
  assert.deepEqual(
    FALLBACK_RECURSIVE_EXCLUDE.filter((v) => e.recursive.indexOf(v) === -1),
    [], 'fallback 多余项（install 已删）');
  assert.deepEqual(FALLBACK_ROOT_ONLY_EXCLUDE.slice().sort(), e.rootOnly.slice().sort());
});

test('DRIFT_ONLY_NAMES 与 install 清单无交集（职责边界；部署副本侧早退）', () => {
  if (!SRC) return;
  const e = parseInstallExcludes(SRC);
  assert.ok(e.recursive.length > 0, '事实源解析为空时本断言恒真，不得跑');
  assert.deepEqual(DRIFT_ONLY_NAMES.filter((v) => e.recursive.indexOf(v) >= 0), []);
});

test('本树无安装脚本 → via=none 且回落副本非空（否则排除集会静默变成「什么都不排除」）', () => {
  const e = parseInstallExcludes(makeSandbox({ 'README.md': 'x' }, 'no-installer'));
  assert.equal(e.via, 'none');
  assert.deepEqual(e.recursive, []);
  assert.ok(FALLBACK_RECURSIVE_EXCLUDE.length >= 10, 'fallback 太短 = 部署侧会把运行时产物当漂移');
});

// ---- 候选根优先级（install 从部署副本传 --repo 时的关键行为）----
// 沙箱文本里的项故意与 FALLBACK 完全不重叠，这样「误把 fallback 并进来」会被当场抓到。
const EX_PS1 = ['$RecursiveExclude = @("custom-a")', '$RootOnlyExclude = @("root-a.md")', ''].join('\n');
const EX_SH = ['RECURSIVE_EXCLUDE=("custom-b")', 'ROOT_ONLY_EXCLUDE=("root-a.md")', ''].join('\n');

function exRoot(extra) {
  return makeSandbox({ 'install.ps1': EX_PS1, 'install.sh': EX_SH, ...extra }, 'excludes');
}

test('候选根首个可解析即胜（--repo 优先于脚本所在树）', () => {
  const a = exRoot();
  const b = exRoot();
  const r = resolveInstallExcludes([a, b]);
  assert.equal(r.root, a);
  assert.equal(r.via, 'install.ps1+install.sh');
  assert.equal(r.usingFallback, false);
});

test('首候选根无脚本→回退到次候选根（而不是直接上 fallback 清单）', () => {
  const empty = makeSandbox({ 'README.md': 'x' }, 'no-script');
  const real = exRoot();
  const r = resolveInstallExcludes([empty, real]);
  assert.equal(r.root, real, '必须用可解析的那个根');
  assert.equal(r.usingFallback, false);
  assert.ok(r.recursive.includes('custom-a'));
});

test('两候选均无脚本→usingFallback 且清单等于回落副本（非空）', () => {
  const r = resolveInstallExcludes([
    makeSandbox({ 'README.md': 'x' }, 'fb-1'),
    makeSandbox({ 'x.md': 'y' }, 'fb-2'),
  ]);
  assert.equal(r.usingFallback, true);
  assert.equal(r.via, 'fallback');
  assert.equal(r.root, null);
  assert.deepEqual(r.recursive.slice().sort(), FALLBACK_RECURSIVE_EXCLUDE.slice().sort());
  assert.ok(r.rootOnlySet.has('reports'), 'rootOnlySet 应含 reports');
});

test('可解析时绝不掺入回落副本（防止“并集”把旧项阴险地带回来）', () => {
  const r = resolveInstallExcludes([exRoot()]);
  // 沙箱清单只有 custom-a/custom-b；若实现写成「解析集 ∪ fallback」这里会多出 .git 等
  assert.deepEqual(r.recursive.slice().sort(), ['custom-a', 'custom-b']);
  assert.ok(!r.recursive.includes('.git'));
  // 双端 recursive 不一致（故意）→ mismatch 必须记账，不能取并集了事
  assert.deepEqual(r.mismatch.slice().sort(), ['custom-a@only-in-install.ps1', 'custom-b@only-in-install.sh']);
});

test('buildDriftExcludes：excludeNames = install 集 + DRIFT_ONLY，rootOnly 没有多并', () => {
  const b = buildDriftExcludes([exRoot()]);
  assert.equal(b.excludeNames.has('custom-a'), true);
  assert.equal(b.excludeNames.has('custom-b'), true);
  for (const n of DRIFT_ONLY_NAMES) assert.equal(b.excludeNames.has(n), true, `漏了 DRIFT_ONLY: ${n}`);
  assert.equal(b.excludeNames.has('.git'), false, '可解析时不得引入回落项');
  assert.deepEqual([...b.rootOnly], ['root-a.md']);
});

test('buildDriftExcludes：fallback 路径同样带 DRIFT_ONLY（两分支行为一致）', () => {
  const b = buildDriftExcludes([makeSandbox({ 'a.md': 'x' }, 'fb-drift')]);
  assert.equal(b.usingFallback, true);
  assert.equal(b.excludeNames.has('skills'), true);
  assert.equal(b.excludeNames.has('.git'), true);
});

test('只给 install.ps1 → 解析出 2 目录 + 2 文件，反斜杠归一为正斜杠', () => {
  const own = parseRuntimeOwn(makeSandbox({ 'install.ps1': PS1 }, 'ps1-only'));
  assert.deepEqual(own.dirs.sort(), ['docs/lessons', 'knowledge-base']);
  assert.deepEqual(own.files.sort(), ['.bash-permission-migrated', 'kilo.jsonc']);
  assert.equal(own.via, 'install.ps1');
});

test('只给 install.sh → 与 ps1 同结果（双端清单必须等价的读法侧保障）', () => {
  const own = parseRuntimeOwn(makeSandbox({ 'install.sh': SH }, 'sh-only'));
  assert.deepEqual(own.dirs.sort(), ['docs/lessons', 'knowledge-base']);
  assert.deepEqual(own.files.sort(), ['.bash-permission-migrated', 'kilo.jsonc']);
  assert.equal(own.via, 'install.sh');
});

test('两端都给 → via 记两侧且并集不引入第三方数组的内容', () => {
  const own = parseRuntimeOwn(makeSandbox({ 'install.ps1': PS1, 'install.sh': SH }, 'both'));
  assert.equal(own.via, 'install.ps1+install.sh');
  assert.equal(own.dirs.length, 2);
  assert.ok(!own.dirs.includes('skills') && !own.dirs.includes('docs'), 'EXCLUDE 数组不得污染清单');
});

test('读不到安装脚本 → 空清单 + via=none（调用侧回落为「全按残留」，不静默放过）', () => {
  const own = parseRuntimeOwn(makeSandbox({ 'README.md': 'x' }, 'none'));
  assert.deepEqual(own.dirs, []);
  assert.equal(own.via, 'none');
});

// ---- 分类四规则 ----
const OWN = { dirs: ['knowledge-base', 'docs/lessons'], files: ['kilo.jsonc'] };
const repoOwnsKb = (p) => p === 'knowledge-base'; // 仓库拥有 knowledge-base/，不拥有 docs/lessons/

test('规则1：精确命中 RuntimeDataFiles → runtime', () => {
  assert.equal(classifyExtra('kilo.jsonc', OWN, repoOwnsKb), 'runtime');
});

test('规则2：声明目录下且仓库完全不拥有该目录 → runtime', () => {
  assert.equal(classifyExtra('docs/lessons/2026-09.md', OWN, repoOwnsKb), 'runtime');
});

test('规则3：声明目录下但仓库拥有该目录 → stale（运行时新增待回收，必须继续报）', () => {
  assert.equal(classifyExtra('knowledge-base/fixes/FX-999.md', OWN, repoOwnsKb), 'stale');
});

test('规则4：未声明路径 → stale；且目录匹配必须是路径段而非字符串前缀', () => {
  assert.equal(classifyExtra('agent/zzz.md', OWN, repoOwnsKb), 'stale');
  assert.equal(classifyExtra('docs/lessons-x/a.md', OWN, repoOwnsKb), 'stale');
  assert.equal(classifyExtra('knowledge-base', OWN, repoOwnsKb), 'stale');
});

test('空清单（via=none）时一切按 stale', () => {
  assert.equal(classifyExtra('docs/lessons/2026-09.md', { dirs: [], files: [] }, () => false), 'stale');
});

// ---- 根级排除：必须是**首段**语义 ----
// 回归用例：RootOnly 清单加入 `reports`（目录）后，旧写法 `set.has(rel)` 对
// `reports/2026-08-12/x.md` 不命中，而 install 侧根本不拷这个目录 → drift 报假 MISSING。
const RO = new Set(['README.md', 'reports']);

test('rootOnly：根级文件精确命中', () => {
  assert.equal(isRootOnlyExcluded('README.md', RO), true);
});

test('rootOnly：根级目录的整棵子树都要命中（回归：精确匹配漏子树）', () => {
  assert.equal(isRootOnlyExcluded('reports', RO), true);
  assert.equal(isRootOnlyExcluded('reports/2026-08-12/cold-start-benchmark.md', RO), true);
  assert.equal(isRootOnlyExcluded('reports/a/b/c.md', RO), true);
});

test('rootOnly：只看首段——深层同名目录不得误伤（那是仓库拥有的路径）', () => {
  assert.equal(isRootOnlyExcluded('docs/reports/2026-08.md', RO), false);
  assert.equal(isRootOnlyExcluded('agent/reports.md', RO), false);
});

test('rootOnly：反斜杠输入归一后仍命中 + 空集一律 false', () => {
  // 同样用 BS 拼：直写 `'a\b'` 会被 path-normalize 的「引号内路径串夹反斜杠」拦下
  assert.equal(isRootOnlyExcluded('reports' + BS + '2026-08-12' + BS + 'x.md', RO), true);
  assert.equal(isRootOnlyExcluded('reports/x.md', new Set()), false);
});
