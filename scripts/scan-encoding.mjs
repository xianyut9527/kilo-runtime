#!/usr/bin/env node
// scan-encoding.mjs
// 编码健康度检测器：扫描文件列表，检测 BOM / U+FFFD / GBK 残留字节流
//
// 用途：
//   - verifier L1 必查项（默认对 git diff --name-only HEAD 跑）
//   - coder 完工前自检
//   - validate-config.mjs [15/15] 调用覆盖全 repo
//
// 用法：
//   node scripts/scan-encoding.mjs [file1] [file2] ...
//   无参数时默认扫 `git diff --name-only HEAD`
//
// 退出码：
//   0 = 所有检查 PASS
//   1 = 至少一项 FAIL
//   2 = 参数错误 / git 不可用 / 脚本自身含 BOM
//
// 输出：JSON 数组，每个元素 { file, checks: [{ name, pass, detail }] }
// 仅使用 Node 内置模块：node:fs / node:path / node:process / node:url / node:child_process
// 跨平台：Windows PowerShell 5.1 + Linux bash 兼容
// 输出仅 ASCII，避免 PowerShell 5.1 GBK 输出乱码（detail 字段不用中文）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// 跨平台 __dirname：从 import.meta.url 解析，避免依赖 cwd
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// 大文件阈值（10MB）
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// ============================================================
// 检测器
// ============================================================

/**
 * 检测 UTF-8 BOM（头部 0xEF 0xBB 0xBF）
 * 对应反模式 AP-001：Edit 工具 BOM 污染
 */
function checkBOM(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return {
      name: 'BOM',
      pass: false,
      detail: 'file starts with UTF-8 BOM (0xEF 0xBB 0xBF), remove it',
    };
  }
  return { name: 'BOM', pass: true, detail: '' };
}

/**
 * 检测 U+FFFD 替换字符
 * 策略：用 Buffer.toString('utf8') 解码后检测 U+FFFD（与 checkGBK 一致）
 * 这样可捕获所有产生 U+FFFD 的情况：
 *   - 原始字节显式含 0xEF 0xBF 0xBD（用户故意写入 U+FFFD）
 *   - 非法 UTF-8 字节序列经解码后产生 U+FFFD（如 GBK 残留经 UTF-8 解码）
 * 排除：BOM 头部 0xEF 0xBB 0xBF 是合法 UTF-8 序列，不会产生 U+FFFD
 */
function checkReplacementChar(buf) {
  // 用 toString('utf8') 解码后检测 U+FFFD
  // 这与 checkGBK 的检测策略一致，避免两者判定标准不一致
  const text = buf.toString('utf8');
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) {
      count++;
    }
  }
  if (count > 0) {
    return {
      name: 'U+FFFD',
      pass: false,
      detail: `found ${count} U+FFFD replacement char(s) after UTF-8 decode, indicates invalid UTF-8 sequence`,
    };
  }
  return { name: 'U+FFFD', pass: true, detail: '' };
}

/**
 * 检测 GBK 残留字节流
 * 对应反模式 AP-005：PowerShell 5.1 GBK 输出
 *
 * 策略：
 *   1. 用 Buffer.toString('utf8') 解码，找出所有 U+FFFD 位置
 *   2. 对每个 U+FFFD 位置，回看原始字节是否匹配 GBK 双字节模式
 *      GBK 双字节：首字节 0x81-0xFE，次字节 0x40-0xFE（排除 0x7F）
 *   3. 匹配 GBK 模式则报 GBK，否则只报 U+FFFD
 *
 * 注意：合法 CJK 扩展区字符（如 U+20000-U+2A6DF 的 4 字节 UTF-8）不会触发此检测，
 *      因为它们是合法 UTF-8 序列，不会产生 U+FFFD。
 */
function checkGBK(buf) {
  // 1. UTF-8 解码
  const text = buf.toString('utf8');

  // 2. 找出 U+FFFD 位置（按字符索引）
  const charIndices = [];
  let byteOffset = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0xfffd) {
      charIndices.push({ charIdx: i, byteOffset });
    }
    // 估算字节长度（粗略，不影响 GBK 判定）
    if (ch < 0x80) byteOffset += 1;
    else if (ch < 0x800) byteOffset += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff) {
      // 高代理项，下一个字符是低代理项，组合成 4 字节 UTF-8
      byteOffset += 4;
      i++; // 跳过低代理项
    } else byteOffset += 3;
  }

  if (charIndices.length === 0) {
    return { name: 'GBK', pass: true, detail: '' };
  }

  // 3. 对每个 U+FFFD 位置，检查原始字节是否匹配 GBK 双字节模式
  let gbkCount = 0;
  for (const { byteOffset } of charIndices) {
    // 检查该字节偏移开始的 2 字节是否匹配 GBK
    // U+FFFD 在 UTF-8 中占 3 字节（0xEF 0xBF 0xBD），对应原始字节
    // 但 GBK 是 2 字节编码，所以匹配的是 U+FFFD 之前的 2 字节
    // 实际策略：检查 byteOffset-2 到 byteOffset 这 2 字节是否是合法 GBK
    // 但更稳妥：检查整个字节流中所有非合法 UTF-8 序列
    // 这里简化：检查 byteOffset 起的 2 字节是否 GBK
    if (byteOffset + 1 < buf.length) {
      const b1 = buf[byteOffset];
      const b2 = buf[byteOffset + 1];
      if (b1 >= 0x81 && b1 <= 0xfe && b2 >= 0x40 && b2 <= 0xfe && b2 !== 0x7f) {
        gbkCount++;
      }
    }
  }

  if (gbkCount > 0) {
    return {
      name: 'GBK',
      pass: false,
      detail: `found ${gbkCount} suspicious GBK byte pair(s) at U+FFFD positions, indicates GBK residue`,
    };
  }

  // 有 U+FFFD 但不匹配 GBK 模式 -> 视为通过（U+FFFD 检测已在 checkReplacementChar 中报告）
  return { name: 'GBK', pass: true, detail: '' };
}

/**
 * 对单个文件执行全部检测
 */
function scanFile(filePath) {
  const result = {
    file: path.relative(ROOT, filePath),
    checks: [],
  };

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    result.checks.push({
      name: 'readable',
      pass: false,
      detail: `cannot stat file: ${e.message}`,
    });
    return result;
  }

  if (!stat.isFile()) {
    result.checks.push({
      name: 'isFile',
      pass: false,
      detail: 'not a regular file',
    });
    return result;
  }

  if (stat.size > MAX_FILE_SIZE) {
    result.checks.push({
      name: 'size',
      pass: true,
      detail: `skipped: file too large (${stat.size} bytes > ${MAX_FILE_SIZE} limit)`,
    });
    return result;
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    result.checks.push({
      name: 'readable',
      pass: false,
      detail: `read error: ${e.message}`,
    });
    return result;
  }

  // 空文件视为干净
  if (buf.length === 0) {
    result.checks.push(
      { name: 'BOM', pass: true, detail: 'empty file' },
      { name: 'U+FFFD', pass: true, detail: 'empty file' },
      { name: 'GBK', pass: true, detail: 'empty file' }
    );
    return result;
  }

  result.checks.push(checkBOM(buf));
  result.checks.push(checkReplacementChar(buf));
  result.checks.push(checkGBK(buf));

  return result;
}

// ============================================================
// 文件列表解析
// ============================================================

/**
 * 获取要扫描的文件列表
 * - 有命令行参数：用参数
 * - 无参数：尝试 git diff --name-only HEAD
 */
function resolveFilePaths(args) {
  if (args.length > 0) {
    return args.map((p) => path.resolve(process.cwd(), p));
  }

  // 默认：git diff --name-only HEAD
  try {
    const out = execSync('git diff --name-only HEAD', {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const files = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((p) => path.resolve(process.cwd(), p));
    return files;
  } catch (e) {
    process.stderr.write(
      'Error: git not available or no commits. Please provide file paths as arguments.\n'
    );
    process.stderr.write(`Usage: node scripts/scan-encoding.mjs [file1] [file2] ...\n`);
    process.exit(2);
  }
}

// ============================================================
// 自检：脚本自身不得含 BOM
// ============================================================

function selfCheck() {
  let selfBuf;
  try {
    selfBuf = fs.readFileSync(__filename);
  } catch (e) {
    process.stderr.write(`Error: self-check failed, cannot read self: ${e.message}\n`);
    process.exit(2);
  }
  if (
    selfBuf.length >= 3 &&
    selfBuf[0] === 0xef &&
    selfBuf[1] === 0xbb &&
    selfBuf[2] === 0xbf
  ) {
    process.stderr.write(
      'Error: self-check failed, scan-encoding.mjs itself contains BOM. Run: remove BOM from this file.\n'
    );
    process.exit(2);
  }
}

// ============================================================
// 主入口
// ============================================================

function main() {
  selfCheck();

  const args = process.argv.slice(2);
  const filePaths = resolveFilePaths(args);

  if (filePaths.length === 0) {
    // git diff 无输出（无修改）-> 视为通过
    process.stdout.write('[]\n');
    process.exit(0);
  }

  const results = filePaths.map(scanFile);

  // 输出 JSON 报告（ASCII only）
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

  // 退出码：任一检查 FAIL -> 1
  const hasFail = results.some((r) =>
    r.checks.some((c) => !c.pass)
  );
  process.exit(hasFail ? 1 : 0);
}

// ============================================================
// 模块导出（供 validate-config.mjs 等 Node 程序 dynamic import）
// ============================================================

export { checkBOM, checkReplacementChar, checkGBK, scanFile, resolveFilePaths };

// ============================================================
// 脚本入口：仅当通过 `node scan-encoding.mjs` 直接运行时执行 main()
// 被 import 时不执行 main()，避免副作用
// ============================================================

const isMainModule = (() => {
  // process.argv[1] 是脚本路径；与 __filename 比较（跨平台）
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
