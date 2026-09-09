/**
 * registry-sync.mjs — lifecycle-doctor check (CU-3)
 *
 * 接入 scripts/check-model-registry-sync.mjs（此前零自动化调用方，F8）。
 * spawnSync 调用该脚本，exit 0 = SYNC OK，exit 1 = 漂移明细。
 * --fast 模式跳过（不压 init-gate 热路径）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.resolve(SELF_ROOT, 'scripts', 'check-model-registry-sync.mjs');

const checkName = 'registry-sync';

export function run(ctx) {
  if (ctx.fast) {
    if (ctx.cf) ctx.cf.pass(checkName + '.wiring', 'skipped (--fast)');
    return;
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: SELF_ROOT, encoding: 'utf8', timeout: 30000 });
  if (r.error) {
    if (ctx.cf) ctx.cf.fail(checkName + '.wiring', 'spawn failed: ' + (r.error.message || r.error));
    return;
  }
  const out = (r.stdout || '').trim();
  const errOut = (r.stderr || '').trim();
  if (r.status === 0) {
    if (ctx.cf) ctx.cf.pass(checkName + '.wiring', out || 'SYNC OK');
  } else {
    if (ctx.cf) ctx.cf.fail(checkName + '.wiring', (out || errOut || ('exit ' + r.status)).split('\n').slice(0, 3).join(' | '));
  }
}
