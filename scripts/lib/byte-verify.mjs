// byte-verify.mjs
// Byte-level 产物验证函数库（反虚报门禁）
// 供 U2/U3/U5 import 使用，对 task_context 字段做"是否真有产物"判定。
// present 严格 = 非 null/undefined/空串/空对象/空数组
// byte_size = JSON.stringify(v).length（反"写空壳充量"）
// 仅 Node 内置模块 + task-context-runtime.mjs 的 getByPath。

import { getByPath } from '../task-context-runtime.mjs';

// 判定"无产物"：null / undefined / 空串 / 空对象 / 空数组
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// JSON.stringify(null) === "null"（长度 4），无意义；undefined -> throw
function safeByteSize(v) {
  if (v === undefined) return 0;
  if (v === null) return 0;
  return JSON.stringify(v).length;
}

// 单字段验证
export function verifyField(ctx, dotPath) {
  const v = getByPath(ctx, dotPath);
  return {
    field: dotPath,
    present: !isEmptyValue(v),
    byte_size: safeByteSize(v),
  };
}

// 批量验证（保持输入顺序）
export function verifyFields(ctx, dotPaths) {
  if (!Array.isArray(dotPaths)) {
    throw new TypeError('verifyFields: dotPaths must be an array');
  }
  return dotPaths.map((p) => verifyField(ctx, p));
}

// 自检：仅在显式 --self-check 时跑，避免 dynamic import 时污染输出
async function runSelfCheck() {
  const assertEq = (label, got, want) => {
    if (got !== want) {
      console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS ${label}`);
    }
  };

  // present 边界
  assertEq('empty string',     verifyField({ a: '' }, 'a').present, false);
  assertEq('empty array',      verifyField({ a: [] }, 'a').present, false);
  assertEq('empty object',     verifyField({ a: {} }, 'a').present, false);
  assertEq('null',             verifyField({ a: null }, 'a').present, false);
  assertEq('undefined',        verifyField({ a: undefined }, 'a').present, false);
  assertEq('non-empty string', verifyField({ a: 'x' }, 'a').present, true);
  assertEq('non-empty array',  verifyField({ a: [1] }, 'a').present, true);
  assertEq('non-empty object', verifyField({ a: { k: 1 } }, 'a').present, true);
  assertEq('missing path',     verifyField({}, 'a').present, false);
  assertEq('nested present',   verifyField({ a: { b: 'v' } }, 'a.b').present, true);
  assertEq('nested empty',     verifyField({ a: { b: '' } }, 'a.b').present, false);

  // byte_size
  assertEq('byte_size "x"',       verifyField({ a: 'x' }, 'a').byte_size, 3);
  assertEq('byte_size {k:1}',     verifyField({ a: { k: 1 } }, 'a').byte_size, 7);
  assertEq('byte_size null=0',    verifyField({ a: null }, 'a').byte_size, 0);
  assertEq('byte_size missing=0', verifyField({}, 'a').byte_size, 0);

  // verifyFields 批量
  const batch = verifyFields({ a: 'x', b: [], c: 0 }, ['a', 'b', 'c', 'd']);
  assertEq('batch length', batch.length, 4);
  assertEq('batch a', batch[0].present, true);
  assertEq('batch b', batch[1].present, false);
  assertEq('batch c', batch[2].present, true);
  assertEq('batch d', batch[3].present, false);

  // 仓库级编码健康度 + bash-guard 委托
  const { execSync } = await import('node:child_process');
  const scanOut = execSync('node scripts/scan-encoding.mjs scripts/lib/byte-verify.mjs', { encoding: 'utf8' });
  const scanJson = JSON.parse(scanOut);
  const scanFail = scanJson.some((f) => f.checks.some((c) => !c.pass));
  assertEq('scan-encoding self', scanFail, false);

  const guardOut = execSync('node scripts/bash-guard.mjs ""', { encoding: 'utf8' });
  assertEq('bash-guard self', guardOut.includes('PASS'), true);

  console.log(process.exitCode ? 'SELF-CHECK FAILED' : 'ALL SELF-CHECK PASS');
}

if (process.argv.includes('--self-check')) {
  runSelfCheck();
}
