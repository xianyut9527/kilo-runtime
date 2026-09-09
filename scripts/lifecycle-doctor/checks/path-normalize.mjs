/**
 * path-normalize.mjs — lifecycle-doctor check
 *
 * 扫 scripts/ 下的 *.mjs 文件,检测硬编码 `\` 或 `/` 路径陷阱
 * 防路径陷阱:`full.includes(e)` 在 Windows 对正斜杠 e 永 false
 *
 * 检查规则:
 * 1. 扫所有 scripts/ 下的 *.mjs 文件(EXCLUDES 自身)
 * 2. 找 `EXCLUDES.some(e => full.includes(e))` 模式(无 replace)
 * 3. 找 `path.join` 调用缺 replace
 * 4. 找硬编码反斜杠 `'a\\b'` 模式
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');
const SELF_REL = path.join('scripts', 'lifecycle-doctor', 'checks', 'path-normalize.mjs');

const PATTERNS = [
  {
    name: 'unsafe-includes',
    // 找 EXCLUDES.some 但无 replace(陷阱模式)
    regex: /EXCLUDES\.some\s*\([^)]*\.includes\s*\([^)]*\)\s*\)\s*[;\n]/g,
    exclude: /replace\s*\(\s*\/\\\\\/g/  // 已被 replace 修复的豁免
  },
  {
    name: 'hardcoded-backslash',
    // 真陷阱形态：引号内路径串把 `\\` 夹在两个路径字符之间（'scripts\\lib'、'C:\\Users'）。
    // 必须要求反斜杠前后都是路径字符才匹配——否则正则转义（'\\n' / '\\s*' / /\\/g /
    // c === '\\' / '.+^$()|{}[]\\'）全部误报：旧写法在 55 个脚本上报 13 处，13/13 均为假阳性，
    // 零信号（这也是它长期被当成噪声断开的原因）。
    regex: /['"][^'"\n]*[A-Za-z0-9_.]\\\\[A-Za-z0-9_.][^'"\n]*['"]/g,
    exclude: /^\s*\*|^\s*\/\//  // 注释豁免
  }
];

function scanFile(filePath, root) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const issues = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      p.regex.lastIndex = 0;
      if (p.regex.test(lines[i])) {
        if (p.exclude && p.exclude.test(lines[i])) continue;
        issues.push({
          file: path.relative(root, filePath).replace(/\\/g, '/'),
          line: i + 1,
          pattern: p.name,
          text: lines[i].trim().slice(0, 80)
        });
      }
    }
  }
  return issues;
}

function getAllScripts(dir, selfPath, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllScripts(full, selfPath, files);
    } else if (entry.name.endsWith('.mjs')) {
      if (full === selfPath) continue;  // 自身豁免（本文件的 PATTERNS 定义会被自己的正则命中）
      files.push(full);
    }
  }
  return files;
}

export function run(ctx) {
  const checkName = 'path-normalize';
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || SELF_ROOT;
  const scriptsDir = path.join(root, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    if (cf) cf.pass(checkName, 'scripts/ not found, skipped');
    return { name: checkName, status: 'PASS', detail: 'scripts/ not found, skipped' };
  }
  const files = getAllScripts(scriptsDir, path.join(root, SELF_REL));
  const allIssues = [];
  for (const f of files) {
    const issues = scanFile(f, root);
    allIssues.push(...issues);
  }
  // 历史缺陷：本 check 只 return 结果、从不调 cf.*，而 index.mjs 又丢弃返回值
  // → 扫描照跑、判定永远不进 SUMMARY（静默 no-op 门禁，等于没有这道门）。
  // 现按其它 check 的契约落 cf，使其真正可阻断。
  const detail = `scanned=${files.length} issues=${allIssues.length}`;
  if (allIssues.length === 0) {
    if (cf) cf.pass(checkName, detail);
  } else {
    const head = allIssues.slice(0, 6).map((i) => `${i.file}:L${i.line} ${i.pattern}`).join(' | ');
    if (cf) cf.fail(checkName, `${detail} -> ${head}`);
  }
  return {
    name: checkName,
    status: allIssues.length === 0 ? 'PASS' : 'FAIL',
    detail,
    issues: allIssues
  };
}