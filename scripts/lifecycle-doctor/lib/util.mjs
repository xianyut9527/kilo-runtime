// lib/util.mjs
// 共享工厂 + 指纹缓存 + 报告
// 拆分自 scripts/lifecycle-doctor.mjs L116-141 + L954-1070

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// ============================================================
// check/pass/fail/warn 工厂（封装全局 results 数组）
// ============================================================
export function createCheckFn() {
  const results = [];
  function check(level, name, detail = '') { results.push({ level, name, detail }); }
  function pass(name, detail = '') { check('PASS', name, detail); }
  function fail(name, detail = '') { check('FAIL', name, detail); }
  function warn(name, detail = '') { check('WARN', name, detail); }
  return { check, pass, fail, warn, getResults: () => results };
}

// ============================================================
// 报告
// ============================================================
export function report(cf, verbose, opts) { finalizeStaticRun(cf, opts);
  let nPass = 0, nFail = 0, nWarn = 0;
  for (const r of cf.getResults()) {
    if (r.level === 'PASS') { nPass++; if (!verbose && r.detail === '') continue; }
    if (r.level === 'FAIL') nFail++;
    if (r.level === 'WARN') nWarn++;
    if (r.level === 'PASS' && !verbose) continue;
    process.stdout.write(`${r.level} ${r.name}${r.detail ? ' — ' + r.detail : ''}\n`);
  }
  process.stdout.write(`\nSUMMARY: ${nPass} PASS / ${nFail} FAIL / ${nWarn} WARN\n`);
  if (nFail > 0) {
    process.stderr.write('[ASSEMBLY_FAIL] 装配校验未通过，修复上述 FAIL 后重跑\n');
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================
// 指纹缓存（静态装配缓存）
// ============================================================

export const CACHE_DIR = path.join(os.tmpdir(), 'kilo');
export const FINGERPRINT_PATH = path.join(CACHE_DIR, 'lifecycle-doctor.fingerprint.json');

export function getFingerprintScopes(root) {
  return [
    { type: 'dir', path: path.join(root, 'lifecycle') },
    { type: 'dir', path: path.join(root, 'agent') },
    { type: 'dir', path: path.join(root, '.kilo', 'instructions') },
    { type: 'dir', path: path.join(root, 'scripts') },
    { type: 'file', path: path.join(root, 'kilo.json') },
  ];
}

export function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); return true; } catch { return false; }
}

export function listFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function hashFile(filePath) {
  try { const data = fs.readFileSync(filePath); return createHash('sha256').update(data).digest('hex'); } catch { return null; }
}

export function computeFingerprint(root) {
  const parts = [];
  for (const scope of getFingerprintScopes(root)) {
    if (scope.type === 'file') {
      const hash = hashFile(scope.path);
      if (hash === null) return null;
      parts.push(`${path.relative(root, scope.path).replace(/\\/g, '/')}:${hash}`);
    } else {
      for (const rel of listFiles(scope.path)) {
        const hash = hashFile(path.join(scope.path, rel));
        if (hash === null) return null;
        parts.push(`${rel}:${hash}`);
      }
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function readFingerprintCache() {
  try {
    const data = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, 'utf8'));
    return data && typeof data.fingerprint === 'string' ? data.fingerprint : null;
  } catch { return null; }
}

export function writeFingerprintCache(fingerprint) {
  if (!ensureCacheDir()) return false;
  try {
    const tmp = FINGERPRINT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint, createdAt: Date.now(), version: 1 }, null, 2) + '\n', 'utf8');
    try { fs.unlinkSync(FINGERPRINT_PATH); } catch {}
    fs.renameSync(tmp, FINGERPRINT_PATH);
    return true;
  } catch { return false; }
}

export function checkFingerprint(root) {
  const current = computeFingerprint(root);
  if (current === null) return { match: false, reason: 'fingerprint computation failed' };
  const cached = readFingerprintCache();
  if (cached === null) return { match: false, reason: 'no cached fingerprint' };
  if (current === cached) return { match: true, fingerprint: current };
  return { match: false, reason: 'fingerprint mismatch' };
}

export function syncAgentPrompts(cf, scriptsDir, root) {
  const syncScript = path.join(scriptsDir, 'sync-agent-prompt.mjs');
  const result = spawnSync(process.execPath, [syncScript], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  if (result.error) { cf.fail('sync.prompt', `sync-agent-prompt.mjs 调用失败: ${result.error.message}`); return; }
  if (result.status !== 0) { cf.fail('sync.prompt', `sync-agent-prompt.mjs 退出码 ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`); return; }
  const summaryLine = (result.stdout || '').trim().split(/\r?\n/).find(l => l.startsWith('[SUMMARY]'));
  cf.pass('sync.prompt', summaryLine ? summaryLine.replace('[SUMMARY] ', 'prompt 同步 — ') : 'agent.prompt 已同步');
}

export function finalizeStaticRun(cf, opts) {
  const { fullMode, fastMode, syncPrompt, scriptsDir, root } = opts;
  if (fullMode || fastMode) {
    const fingerprint = computeFingerprint(root);
    if (fingerprint !== null) {
      if (writeFingerprintCache(fingerprint)) cf.pass('cache.fingerprint', `fingerprint updated: ${fingerprint.slice(0, 16)}...`);
      else cf.warn('cache.fingerprint', 'failed to write fingerprint cache (proceeding)');
    }
  }
  if (syncPrompt) syncAgentPrompts(cf, scriptsDir, root);
}
