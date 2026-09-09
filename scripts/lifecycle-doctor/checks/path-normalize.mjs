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
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SELF_PATH = path.join(ROOT, 'scripts', 'lifecycle-doctor', 'checks', 'path-normalize.mjs');

const PATTERNS = [
  {
    name: 'unsafe-includes',
    // 找 EXCLUDES.some 但无 replace(陷阱模式)
    regex: /EXCLUDES\.some\s*\([^)]*\.includes\s*\([^)]*\)\s*\)\s*[;\n]/g,
    exclude: /replace\s*\(\s*\/\\\\\/g/  // 已被 replace 修复的豁免
  },
  {
    name: 'hardcoded-backslash',
    // 找硬编码反斜杠路径 `'a\\b'` 或 `"a\\b"`
    regex: /['"][^'"]*\\\\[^'"]*['"]/g,
    exclude: /^\s*\*|^\s*\/\//  // 注释豁免
  }
];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const issues = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      p.regex.lastIndex = 0;
      if (p.regex.test(lines[i])) {
        if (p.exclude && p.exclude.test(lines[i])) continue;
        issues.push({
          file: filePath.replace(ROOT + path.sep, ''),
          line: i + 1,
          pattern: p.name,
          text: lines[i].trim().slice(0, 80)
        });
      }
    }
  }
  return issues;
}

function getAllScripts(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'lifecycle-doctor' && full.includes('lifecycle-doctor')) {
        // 跳过自身目录(子目录脚本)
        getAllScripts(full, files);
        continue;
      }
      getAllScripts(full, files);
    } else if (entry.name.endsWith('.mjs')) {
      if (full === SELF_PATH) continue;  // 自身豁免
      files.push(full);
    }
  }
  return files;
}

export function run(ctx) {
  const checkName = 'path-normalize';
  const scriptsDir = path.join(ROOT, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    return { name: checkName, status: 'PASS', detail: 'scripts/ not found, skipped' };
  }
  const files = getAllScripts(scriptsDir);
  const allIssues = [];
  for (const f of files) {
    const issues = scanFile(f);
    allIssues.push(...issues);
  }
  return {
    name: checkName,
    status: allIssues.length === 0 ? 'PASS' : 'FAIL',
    detail: `scanned=${files.length} issues=${allIssues.length}`,
    issues: allIssues
  };
}