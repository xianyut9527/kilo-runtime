// checks/__tests__/unit-tests.test.mjs — `unit.executed` 门禁的分支夹具
//
// 为什么门禁自己也要有测试：unit.executed 是「把跑单测变成机械保证」的那道门，
// 如果它自己的分支判定烂掉（比如把 FAIL 判成 PASS、或 --fast 忘了跳过），
// 我们又回到「网看着在、其实兜不住」。立项根因同 unit-tests.mjs 头注释。
//
// 纪律：只喂临时沙箱 ROOT，绝不回扫真实仓库——否则会与本夹具所属的扫描循环递归。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test, assert, makeSandbox } from '../../../lib/test-harness.mjs';
import { run } from '../unit-tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_SRC = path.join(HERE, '..', '..', '..', 'lib', 'test-harness.mjs');

// ---- 工具：沙箱 root + stub cf ----
function collect(ctx) {
  const rec = [];
  run({ cf: { pass: (n, d) => rec.push(['PASS', n, d || '']),
    fail: (n, d) => rec.push(['FAIL', n, d || '']),
    warn: (n, d) => rec.push(['WARN', n, d || '']) },
  ROOT: process.cwd(), FAST_MODE: false, ...ctx });
  return rec.find((x) => x[1] === 'unit.executed') || ['MISSING', 'unit.executed', ''];
}

/**
 * 造一个只含指定测试文件的沙箱根（带 harness 副本供测试文件 import）。
 * 沙箱本体与清理交给 harness 的 makeSandbox，本文件不再自己注册 exit 监听器。
 */
const HARNESS_SRC_TEXT = fs.readFileSync(HARNESS_SRC, 'utf8');
const TESTS_REL = 'lifecycle/runtime/__tests__/';
function sandbox(cases) {
  const files = { [TESTS_REL + 'h.mjs']: HARNESS_SRC_TEXT };
  for (const [name, body] of Object.entries(cases)) {
    files[TESTS_REL + name] = body.join('\n') + '\n';
  }
  return makeSandbox(files, 'unitgate');
}
const GREEN = ['// green case', "import { test, assert } from './h.mjs';", "test('a', () => assert.equal(1, 1));"];
const RED = ['// red case', "import { test, assert } from './h.mjs';", "test('a', () => assert.equal(1, 2));"];
// 不经 harness 的非 0 退出 → 没有 SUMMARY 行，必须走「无 SUMMARY」分支
const CRASH = ['// crash case', 'process.exit(3);'];
// 历史真实形态：harness 已注册 exit 监听器但模块体求值就报错 → 照旧打 `SUMMARY: 0 pass / 0 fail`。
// 只看 fail 计数会当成「全绿」，必须靠 exit 码拦下（当年 4 个测试就是这么躲过所有人的）。
const LOADCRASH = ['// load crash case', "import { test } from './h.mjs';", 'undefinedSymbolBoom();'];

// ---- 夹具 ----
test('--fast：热路径必须 skip（不 spawn 子进程）', () => {
  const r = collect({ FAST_MODE: true });
  assert.equal(r[0], 'PASS');
  assert.match(r[2], /skipped \(--fast\)/);
});

test('两处约定目录都不存在 → WARN（不是静默 PASS）', () => {
  const r = collect({ ROOT: path.join(os.tmpdir(), 'unitgate-sandbox', 'no-such-root-' + Date.now()) });
  assert.equal(r[0], 'WARN');
  assert.match(r[2], /行为回归网为空/);
});

test('目录存在但零测试 → WARN', () => {
  const r = collect({ ROOT: sandbox({}) });
  assert.equal(r[0], 'WARN');
  assert.match(r[2], /未找到任何 \*\.test\.mjs/);
});

test('沙箱全绿 → PASS 且用例数上报', () => {
  const r = collect({ ROOT: sandbox({ 'a.test.mjs': GREEN }) });
  assert.equal(r[0], 'PASS');
  assert.match(r[2], /1 个测试文件 \/ 1 用例全通过/);
});

test('沙箱有失败用例 → FAIL，且带 exit 码与 FAIL 明细', () => {
  const r = collect({ ROOT: sandbox({ 'a.test.mjs': RED }) });
  assert.equal(r[0], 'FAIL');
  assert.match(r[2], /a\.test\.mjs: exit=1 0 pass \/ 1 fail/);
  assert.match(r[2], /FAIL a:/);
});

test('测试文件非 0 退出且无 SUMMARY 行 → FAIL（不能因为 fail=0 就放过）', () => {
  const r = collect({ ROOT: sandbox({ 'a.test.mjs': CRASH }) });
  assert.equal(r[0], 'FAIL');
  assert.match(r[2], /无 SUMMARY 行（exit=3）/);
});

test('求值期崩溃（SUMMARY 依旧打 0/0）→ 靠 exit 码 FAIL', () => {
  const r = collect({ ROOT: sandbox({ 'a.test.mjs': LOADCRASH }) });
  assert.equal(r[0], 'FAIL');
  assert.match(r[2], /a\.test\.mjs: exit=1 0 pass \/ 0 fail/);
});

test('混合：一个绿一个红 → 红文件必须出现在 FAIL 清单里', () => {
  const r = collect({ ROOT: sandbox({ 'a.test.mjs': GREEN, 'b.test.mjs': RED }) });
  assert.equal(r[0], 'FAIL');
  assert.match(r[2], /b\.test\.mjs/);
  assert.ok(!/FAIL 单测未通过：a\./.test(r[2]), '绿文件不该被列进失败清单');
});
