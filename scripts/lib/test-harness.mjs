// scripts/lib/test-harness.mjs — 极简单测底座（Node 14.17 兼容）
//
// 服务对象：`lifecycle/runtime/__tests__/*.test.mjs`（runtime 纯函数单测）与
// `scripts/lifecycle-doctor/checks/__tests__/*.test.mjs`（门禁分支夹具）。单源一份，不得复制。
//
// 立项根因（2026-09 实测）：`lifecycle/runtime/__tests__` 下 4 个测试文件全部
// `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`，而本机
// runtime 要求是 Node 14.17——`node:test` 要 Node>=18，`node:assert/strict` 子路径也要更高版本。
// 结果 4 个测试文件一条都没跑过：`node capability-detector.test.mjs` 直接 ERR_UNKNOWN_BUILTIN_MODULE。
// 更糟的是**仓库里没有任何地方调用它们**（doctor / hook / CI / README 全无），
// 于是「有单测」变成了纯装饰：改 model-selector.mjs 的判定逻辑没有任何回归防线。
//
// 本底座让测试在 Node>=14 与 Node>=18 都能用同一种方式跑：
//   node <dir>/<name>.test.mjs          # 任何版本（由 checks/unit-tests.mjs 的 unit.executed 自动扫两处目录）
//   node --test <dir>/                  # Node>=18 亦兼容（文件自执行）
// 语义：`test()` 调用即同步执行该用例（保持声明顺序输出），失败不中断其余用例，
// 进程退出时打印 `SUMMARY: N pass / M fail` 并置 exitCode=1。
//
// 不提供子测试 / mock / 定时器——被测对象都是纯函数或文件沙箱，用不到；
// 但提供夹具共用的两样东西（否则每个夹具各抄一份、行为不一致）：
//   makeSandbox()      —— 临时目录沙箱（统一前缀 + 进程退出自清）
//   testAsync()/flushAsyncTests() —— 异步用例，忘了 flush 会被当成失败而不是静默假绿

import nodeAssert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Node 的 assert.strict 与 `require('assert/strict')` 等价（v9.10+ 提供），
// 但 `assert/strict` / `node:assert/strict` 这个 specifier 在 14.17 上解析不了，故走属性取。
export const assert = nodeAssert.strict;

let passCount = 0;
let failCount = 0;
const failures = [];

/**
 * 声明并立即执行一个用例。签名与 node:test 的 `test(name, fn)` 兼容（fn 无参）。
 * @param {string} name
 * @param {() => void} fn
 */
export function test(name, fn) {
  try {
    fn();
    passCount++;
    process.stdout.write(`PASS ${name}\n`);
  } catch (err) {
    failCount++;
    const msg = err && err.message ? err.message : String(err);
    failures.push({ name, msg });
    process.stdout.write(`FAIL ${name}: ${msg}\n`);
  }
}

process.on('exit', () => {
  if (pendingAsync.length > 0) {
    failCount++;
    failures.push({
      name: '(async-not-flushed)',
      msg: pendingAsync.length + ' 个 testAsync 未被 flushAsyncTests() 执行——异步夹具忘 flush 会静默假绿',
    });
    process.stderr.write('[TEST_FAIL] (async-not-flushed) 记得在文件末尾 await flushAsyncTests()\n');
  }
  for (const dir of _sandboxRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /*  best-effort */ }
  }
  process.stdout.write(`SUMMARY: ${passCount} pass / ${failCount} fail\n`);
  if (failCount > 0) {
    for (const f of failures) process.stderr.write(`[TEST_FAIL] ${f.name}\n`);
    process.exitCode = 1;
  }
});

// ============================================================
// 异步用例
// ============================================================
const pendingAsync = [];

/** 声明一个异步用例（须由 flushAsyncTests() 驱动；被 check 类 async run(ctx) 需要） */
export function testAsync(name, fn) {
  pendingAsync.push({ name, fn });
}

/** 顺序执行所有待跑异步用例；失败不中断其余 */
export async function flushAsyncTests() {
  while (pendingAsync.length > 0) {
    const t = pendingAsync.shift();
    try {
      await t.fn();
      passCount++;
      process.stdout.write(`PASS ${t.name}\n`);
    } catch (err) {
      failCount++;
      const msg = err && err.message ? err.message : String(err);
      failures.push({ name: t.name, msg });
      process.stdout.write(`FAIL ${t.name}: ${msg}\n`);
    }
  }
}

// ============================================================
// 沙箱
// ============================================================
const _sandboxRoots = [];
let _seq = 0;

function _writeRel(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

/**
 * 建一个临时沙箱根（不影响真实仓库）。
 * @param {Record<string,string>} [files] relPath -> 内容（内容可为数组，按行 join）
 * @param {string} [label] 用例名后缀，仅供人工到临时目录里辨认
 * @returns {string} 沙箱绝对路径（进程退出自动删除）
 */
export function makeSandbox(files, label) {
  const tag = label ? '-' + String(label).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) : '';
  const root = path.join(os.tmpdir(), 'kilo-gate-sandbox', `s${++_seq}${tag}`);
  fs.mkdirSync(root, { recursive: true });
  _sandboxRoots.push(root);
  if (files) for (const [rel, text] of Object.entries(files)) _writeRel(root, rel, asText(text));
  return root;
}

/** 沙箱里补写一个文件（用例中途造异常输入用） */
export function sandboxWrite(root, rel, text) {
  _writeRel(root, rel, asText(text));
}

function asText(text) {
  return Array.isArray(text) ? text.join('\n') : String(text);
}
