/**
 * decouple-audit.mjs — lifecycle-doctor check
 *
 * 调 scripts/decouple-check.mjs 扫全仓第三方 MCP 工具名
 * 输出 doctor 报告格式
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');

export function run(ctx) {
  const checkName = 'decouple-audit';
  const cf = ctx.cf;
  const root = (ctx && ctx.ROOT) || SELF_ROOT;
  const decoupleScript = path.join(root, 'scripts', 'decouple-check.mjs');
  // process.execPath 而非 'node'：保证子进程用与 doctor 相同的解释器
  // （本机 PATH node 为 v14，IDE 内置为 v22，混用会产生不可复现结果）
  const result = spawnSync(process.execPath, [decoupleScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
  });
  let data;
  try {
    data = JSON.parse(result.stdout || '{}');
  } catch (e) {
    if (cf && cf.fail) cf.fail(checkName, 'parse error: ' + e.message);
    return { name: checkName, status: 'FAIL', detail: 'parse error: ' + e.message };
  }
  const critical = data.critical_count || 0;
  const total = data.total_hits || 0;
  const status = critical === 0 ? 'PASS' : 'FAIL';
  const detail = `total_files=${data.total_files} critical=${critical} warning=${data.warning_count} hits=${total}`;
  if (cf) {
    if (critical === 0) cf.pass(checkName, detail);
    else cf.fail(checkName, detail);
  }
  return {
    name: checkName,
    status,
    detail,
    hits: data.hits || []
  };
}
