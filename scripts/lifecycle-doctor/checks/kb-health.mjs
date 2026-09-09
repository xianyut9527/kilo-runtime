/**
 * kb-health.mjs — lifecycle-doctor check
 *
 * 调 scripts/kb.mjs doctor 校验 knowledge-base 经验库健康度:
 *   - fixes/FX-*.md 七字段/唯一性/类别/日期
 *   - 索引双向一致性
 *   - 归档候选
 *
 * exit 0  -> cf.pass('kb.health', 'doctor all green')
 * exit 非0 -> cf.fail('kb.health', stdout 摘要)
 * 子进程崩溃(缺文件/spawn 失败)同样判 FAIL
 *
 * 跨平台: 解析 UTF-8 字符串, cf.* detail 仅含 ASCII/可打印字符
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const KB = path.join(ROOT, 'scripts', 'kb.mjs');
const SPAWN_TIMEOUT_MS = 30000;
const MAX_BUFFER = 4 * 1024 * 1024;

export function run(ctx) {
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || ROOT;
  const checkName = 'kb.health';

  const result = spawnSync('node', [KB, 'doctor'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error) {
    const msg = 'spawn failed: ' + result.error.message;
    if (cf) cf.fail(checkName, msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }
  if (result.signal) {
    const msg = 'killed by signal: ' + result.signal;
    if (cf) cf.fail(checkName, msg);
    return { name: checkName, status: 'FAIL', detail: msg };
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status === 0) {
    const detail = stdout || 'doctor all green';
    if (cf) cf.pass(checkName, detail);
    return { name: checkName, status: 'PASS', detail, spawnStatus: result.status };
  }

  // exit 非0: 取 stdout 摘要(优先), 无则回退 stderr 摘要
  const summary = stdout || stderr || '(no output)';
  const head = summary.split(/\r?\n/).slice(0, 5).join(' | ');
  const detail = 'doctor exit ' + result.status + ': ' + head;
  if (cf) cf.fail(checkName, detail);
  return { name: checkName, status: 'FAIL', detail, spawnStatus: result.status };
}
