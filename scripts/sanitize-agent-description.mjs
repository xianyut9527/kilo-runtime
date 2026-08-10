#!/usr/bin/env node
// sanitize-agent-description.mjs
// 对 agent/*.md frontmatter description 做清洗，让其可安全写入 kilo.json agent.<name>.prompt
//
// 清洗规则（按顺序执行）：
//   1. 去控制字符（C0 \u0000-\u0008, \u000B-\u000C, \u000E-\u001F, DEL \u007F；
//      C1 \u0080-\u009F）。保留 \t \n \r 视为合法空白。
//   2. 长度截断到 PROMPT_MAX_LEN=4096（超长 push warning "length truncated: {old}->{new}"）。
//   3. 未配对 XML 标签检测（<tool> / <dispatch> / <agent>）：不等则 push warning。
//   4. GBK 误码特征黑名单检测（U+3000 全角空格 / U+FFFD 替换符 / U+FFFE-U+FFFF 非字符）：命中 push warning。
//   5. 空字符串 / 全控制字符 / 全空白：sanitized="" + warning "empty after sanitization"。
//
// 退出码：0=成功（含/不含 warning），2=路径不存在或 frontmatter 解析失败
// 用法：
//   node scripts/sanitize-agent-description.mjs <agent-md-or-mjs-path>
//   node scripts/sanitize-agent-description.mjs --test
//
// 跨平台：仅 Node 内置模块，stderr 消息仅 ASCII（防 PS5.1 GBK 乱码）
/* ---
description: sanitize agent description utility for sync-agent-prompt.mjs
--- */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ============================================================
// 常量（导出，供 sync-agent-prompt.mjs 通过 ESM import 复用）
// ============================================================
// prompt 字符串长度上限：与 validate-agent-prompt.mjs 保持一致
export const PROMPT_MAX_LEN = 4096;

// 需配对的 XML 标签名（与 validate-agent-prompt.mjs 保持一致）
export const XML_TAGS = ['tool', 'dispatch', 'agent'];

// 控制字符检测范围（参考 validate-agent-prompt.mjs L46-49）
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const C1_CONTROL_RE = /[\u0080-\u009F]/;
const ALLOWED_CONTROLS = new Set(['\t', '\n', '\r']);

// GBK 误码黑名单：仅收录真正可疑的 GBK 解码失败/非字符特征。
// 注意：U+FF1A(:全角冒号) / U+FF0C(,全角逗号) 虽是常见 GBK 双字节头被错误解码特征,
// 但在中文 description 中是合法标点(8 个 agent 均大量使用), 纳入会引入误报, 故排除。
// U+00A7(§) 是合法 Latin-1 标点, 原范围误报, 不纳入。
const GBK_BLACKLIST_RE = /[\u3000\uFFFD\uFFFE\uFFFF]/g;

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 去掉非法控制字符，保留 \t \n \r。
 * @param {string} str
 * @returns {string}
 */
function stripControlChars(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ALLOWED_CONTROLS.has(ch)) { out += ch; continue; }
    const code = str.charCodeAt(i);
    if (CONTROL_RE.test(ch) || C1_CONTROL_RE.test(ch)) continue;
    out += ch;
  }
  return out;
}

/**
 * 检测未配对 XML 标签（参考 validate-agent-prompt.mjs checkXmlBalance）
 * @param {string} str
 * @returns {string[]} 违规标签名列表（无则空数组）
 */
function checkXmlBalance(str) {
  const warnings = [];
  for (const tag of XML_TAGS) {
    const openRe = new RegExp(`<${tag}(\\s|>)`, 'g');
    const closeRe = new RegExp(`</${tag}>`, 'g');
    let openCount = 0;
    let closeCount = 0;
    let m;
    while ((m = openRe.exec(str)) !== null) openCount++;
    while ((m = closeRe.exec(str)) !== null) closeCount++;
    if (openCount !== closeCount) {
      warnings.push(
        `unbalanced XML tag <${tag}>: open=${openCount} close=${closeCount}`
      );
    }
  }
  return warnings;
}

/**
 * 检测 GBK 边界字符。每个唯一 code 只报一次（去重）。
 * @param {string} str
 * @returns {string[]}
 */
function checkGbkBoundary(str) {
  const warnings = [];
  const seen = new Set();
  for (const m of str.matchAll(GBK_BLACKLIST_RE)) {
    const code = m[0].codePointAt(0);
    if (!seen.has(code)) {
      seen.add(code);
      warnings.push(
        `GBK mojibake char detected: U+${code.toString(16).padStart(4, '0').toUpperCase()}`
      );
    }
  }
  return warnings;
}

// ============================================================
// 纯函数：清洗单个 description
// ============================================================

/**
 * 清洗 agent description 字符串。
 * @param {string} desc 待清洗的 description
 * @param {string} agentName 所属 agent 名（仅供调用方日志用，不参与清洗逻辑）
 * @returns {{ sanitized: string, warnings: string[] }}
 */
export function sanitizeDescription(desc, agentName) {
  const warnings = [];
  void agentName; // 显式忽略：纯函数，不依赖外部状态

  // 输入类型保护
  if (typeof desc !== 'string') {
    return { sanitized: '', warnings: ['empty after sanitization'] };
  }

  // 1. 去控制字符
  let sanitized = stripControlChars(desc);

  // 2. 长度截断
  if (sanitized.length > PROMPT_MAX_LEN) {
    const oldLen = sanitized.length;
    sanitized = sanitized.slice(0, PROMPT_MAX_LEN);
    warnings.push(`length truncated: ${oldLen}->${sanitized.length}`);
  }

  // 3. XML 配对
  warnings.push(...checkXmlBalance(sanitized));

  // 4. GBK 边界
  warnings.push(...checkGbkBoundary(sanitized));

  // 5. 空 / 全空白：返回空 + warning
  if (sanitized.trim().length === 0) {
    sanitized = '';
    warnings.push('empty after sanitization');
  }

  return { sanitized, warnings };
}

// ============================================================
// Frontmatter 解析（支持 .md YAML 和 .mjs JS 注释块）
// ============================================================

/**
 * 提取 frontmatter 块。
 *   .md：标准 YAML frontmatter（首行 `---` 起，至下一个 `---` 止）
 *   .mjs：JS 注释块 frontmatter（shebang 后 `/* --- ... --- *\/`，让 Node 仍可解析文件）
 * @param {string} text 文件全文
 * @returns {string|null} frontmatter 块内容（不含 --- 标记）
 */
export function extractFrontmatter(text) {
  // .md YAML
  let m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) return m[1];
  // .mjs JS 注释块（在文件头部 10KB 内搜索 /* --- ... --- */）
  const _head = text.slice(0, 10000);
  m = _head.match(/\/\* ---\r?\n([\s\S]*?)\r?\n--- \*\//);
  if (m) return m[1];
  return null;
}

/**
 * 从 frontmatter 块提取 description 字段（单行或多行）。
 * @param {string} frontmatter
 * @returns {string|null}
 */
export function extractDescription(frontmatter) {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 单行：description: xxx
    const single = line.match(/^description:\s*(.+)$/);
    if (single) {
      let val = single[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
    // 多行：description: > 或 description: |
    const multiStart = line.match(/^description:\s*[>|]/);
    if (multiStart) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j];
        if (/^\S/.test(sub)) break;
        parts.push(sub.replace(/^\s+/, ''));
      }
      return parts.join(' ').trim();
    }
  }
  return null;
}

// ============================================================
// CLI 入口
// ============================================================

function cliMain() {
  const args = process.argv.slice(2);

  // --test 自检模式
  if (args.includes('--test')) {
    return runSelfTest();
  }

  if (args.length === 0) {
    process.stderr.write('sanitize-agent-description: missing <agent-path> argument\n');
    process.stderr.write('usage: node scripts/sanitize-agent-description.mjs <agent-path>\n');
    process.stderr.write('       node scripts/sanitize-agent-description.mjs --test\n');
    process.exit(2);
  }

  const targetArg = args[0];
  const target = path.resolve(process.cwd(), targetArg);

  // path traversal 防护：拒绝越过 kilo_config 根目录
  const rel = path.relative(ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write('sanitize-agent-description: path traversal blocked: ' + targetArg + '\n');
    process.exit(2);
  }

  // 大文件预检：>1MB 直接拒绝, 避免 readFileSync OOM
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    process.stderr.write(`sanitize-agent-description: cannot stat ${targetArg}: ${e.message}\n`);
    process.exit(2);
  }
  if (st.size > 1024 * 1024) {
    process.stderr.write(`sanitize-agent-description: file too large (${st.size} > 1048576): ${targetArg}\n`);
    process.exit(2);
  }

  if (!fs.existsSync(target)) {
    process.stderr.write(`sanitize-agent-description: file not found: ${targetArg}\n`);
    process.exit(2);
  }

  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (e) {
    process.stderr.write(`sanitize-agent-description: cannot read ${targetArg}: ${e.message}\n`);
    process.exit(2);
  }

  const fm = extractFrontmatter(text);
  if (!fm) {
    process.stderr.write(`sanitize-agent-description: no frontmatter in ${targetArg}\n`);
    process.exit(2);
  }

  const desc = extractDescription(fm);
  if (desc === null) {
    process.stderr.write(`sanitize-agent-description: no description in frontmatter of ${targetArg}\n`);
    process.exit(2);
  }

  const agentName = path.basename(targetArg, path.extname(targetArg));
  const result = sanitizeDescription(desc, agentName);

  // stdout: sanitized 字符串（末尾加换行）
  process.stdout.write(result.sanitized + '\n');
  // stderr: warnings JSON 数组（JSON.stringify 默认 \uXXXX 转义非 ASCII，跨平台 ASCII 安全）
  process.stderr.write(JSON.stringify(result.warnings) + '\n');
  process.exit(0);
}

// ============================================================
// 自检（8 个用例）
// ============================================================

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function runSelfTest() {
  const cases = [
    {
      name: 'ctrl-chars-strip',
      input: '正常\u0001描述\u0007控制符',
      expected: { sanitized: '正常描述控制符', warnings: [] },
    },
    {
      name: 'length-truncate',
      input: 'A'.repeat(5000),
      expected: { sanitized: 'A'.repeat(4096), warnings: ['length truncated: 5000->4096'] },
    },
    {
      name: 'unbalanced-xml-warn',
      input: '使用<tool>执行操作',
      expected: { sanitized: '使用<tool>执行操作', warnings: ['unbalanced XML tag <tool>: open=1 close=0'] },
    },
    {
      name: 'clean-ascii-noop',
      input: 'Clean ASCII description',
      expected: { sanitized: 'Clean ASCII description', warnings: [] },
    },
    {
      name: 'cjk-preserve',
      input: '中英混合desc，含中文标点。',
      expected: { sanitized: '中英混合desc，含中文标点。', warnings: [] },
    },
    {
      name: 'empty-description',
      input: '',
      expected: { sanitized: '', warnings: ['empty after sanitization'] },
    },
    {
      name: 'whitespace-only',
      input: '   \t  \n  ',
      expected: { sanitized: '', warnings: ['empty after sanitization'] },
    },
    {
      name: 'all-control-chars',
      input: '\u0001\u0002\u0003',
      expected: { sanitized: '', warnings: ['empty after sanitization'] },
    },
  ];

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const tc of cases) {
    const actual = sanitizeDescription(tc.input, tc.name);
    if (deepEqual(actual, tc.expected)) {
      pass++;
      process.stderr.write(`[PASS] ${tc.name}\n`);
    } else {
      fail++;
      failures.push(tc.name);
      process.stderr.write(`[FAIL] ${tc.name}\n`);
      process.stderr.write(`  expected: ${JSON.stringify(tc.expected)}\n`);
      process.stderr.write(`  actual:   ${JSON.stringify(actual)}\n`);
    }
  }

  process.stderr.write(`\n[SUMMARY] ${pass}/${cases.length} pass, ${fail} fail\n`);

  if (fail > 0) {
    process.stderr.write(`[FAIL] failed cases: ${failures.join(', ')}\n`);
    process.exit(2);
  }

  process.exit(0);
}

// ============================================================
// 模块入口守卫
// ============================================================
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  cliMain();
}