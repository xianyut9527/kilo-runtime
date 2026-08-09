/**
 * encoding-safety.mjs — lifecycle-doctor check
 *
 * 调 scripts/scan-encoding.mjs 扫全仓 .md/.mjs/.json/.yaml/.yml
 * 解析 JSON 数组,按 file/check 逐条 cf.pass 或 cf.fail
 *
 * 防反模式:
 *   AP-001  UTF-8 BOM 污染 (Edit 工具残留)
 *   AP-005  PowerShell 5.1 GBK 输出乱码
 *   U+FFFD  非法 UTF-8 序列经解码后产生替换字符
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const SCAN_EXTENSIONS = new Set(['.md', '.mjs', '.json', '.yaml', '.yml']);
// 排除目录(不参与扫描) — Windows 兼容,统一用正斜杠比对
const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  'out',
  'build',
  '.next',
  '.vite',
]);
// 排除自身(同 path-normalize 习惯)
const SELF_PATH = path.join(ROOT, 'scripts', 'lifecycle-doctor', 'checks', 'encoding-safety.mjs');

const SCAN_ENCODING = path.join(ROOT, 'scripts', 'scan-encoding.mjs');
const MAX_BUFFER = 50 * 1024 * 1024;
const MAX_FILES = 2000;  // 防止仓库过大时 spawnSync 爆 stdout
const SPAWN_TIMEOUT_MS = 60000;

/**
 * 递归列出 ROOT 下匹配扩展名的文件,排除 EXCLUDE_DIRS 与自身
 * 路径归一化:Windows 反斜杠 -> 正斜杠,便于与 EXCLUDE_DIRS 集合比对
 */
function listTargetFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const norm = full.replace(/\\/g, '/');
        let excluded = false;
        for (const ex of EXCLUDE_DIRS) {
          if (norm === path.join(root, ex).replace(/\\/g, '/') ||
              norm.includes('/' + ex + '/') ||
              norm.endsWith('/' + ex)) {
            excluded = true;
            break;
          }
        }
        if (excluded) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      if (path.resolve(full) === path.resolve(SELF_PATH)) continue;
      out.push(full);
      if (out.length >= MAX_FILES) return out;
    }
  }
  return out;
}

export function run(ctx) {
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || ROOT;
  const checkName = 'encoding';

  const files = listTargetFiles(root);
  if (files.length === 0) {
    if (cf) cf.fail(checkName + '.targets', 'no target files found under ROOT');
    return { name: checkName, status: 'FAIL', detail: 'no target files' };
  }

  const result = spawnSync('node', [SCAN_ENCODING, ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error) {
    const msg = 'spawn failed: ' + result.error.message;
    if (cf) cf.fail(checkName + '.spawn', msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }
  if (result.signal) {
    const msg = 'killed by signal: ' + result.signal;
    if (cf) cf.fail(checkName + '.spawn', msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }
  if (result.status === 2) {
    const msg = 'scan-encoding.mjs self-check failed or args error: ' + (result.stderr || '').trim();
    if (cf) cf.fail(checkName + '.spawn', msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }

  let data;
  try {
    data = JSON.parse(result.stdout || '[]');
  } catch (e) {
    const msg = 'parse JSON failed: ' + e.message;
    if (cf) cf.fail(checkName + '.parse', msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }

  const fileResults = Array.isArray(data) ? data : (Array.isArray(data.files) ? data.files : []);

  if (fileResults.length === 0) {
    if (cf) cf.fail(checkName + '.empty', 'scan-encoding returned 0 file results');
    return { name: checkName, status: 'FAIL', detail: 'empty result' };
  }

  let nPass = 0;
  let nFail = 0;
  for (const fr of fileResults) {
    const file = fr.file || 'unknown';
    const fileTag = file.replace(/[\\/]/g, '.');
    if (!Array.isArray(fr.checks)) continue;
    for (const c of fr.checks) {
      const cname = c.name || 'unknown';
      const id = checkName + '.' + cname + '.' + fileTag;
      const detail = c.detail || '';
      if (c.pass === true) {
        if (cf) cf.pass(id, detail);
        nPass++;
      } else {
        if (cf) cf.fail(id, detail);
        nFail++;
      }
    }
  }

  const status = nFail === 0 ? 'PASS' : 'FAIL';
  return {
    name: checkName,
    status,
    detail: `scanned ${fileResults.length} files, ${nPass} pass / ${nFail} fail`,
    spawnStatus: result.status,
  };
}
