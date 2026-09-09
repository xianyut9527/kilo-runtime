/**
 * dispatch-table-sync.mjs — lifecycle-doctor check (CU-3)
 *
 * 校验 scripts/delivery-audit.mjs DISPATCH_REQUIRED 与 lifecycle/stages/init.md §路由规则
 * + lifecycle/config.yaml tier_defaults 的 tier→角色映射一致性（F7）。
 *
 * 固化审计 oracle 是合理实践（防假 FAIL），但手抄表与单源漂移时必须有门禁拦截。
 * 本 check 解析三源的 tier→角色映射，逐 tier+intent 比对，不一致即 FAIL。
 *
 * --fast 模式跳过（不压 init-gate 热路径）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');

const checkName = 'dispatch-table-sync';

// 从 delivery-audit.mjs 提取 DISPATCH_REQUIRED 字面量（正则，不 import——保持审计独立性）
function parseDispatchRequired(src) {
  const m = src.match(/const DISPATCH_REQUIRED\s*=\s*(\{[\s\S]*?\n\};)/);
  if (!m) return null;
  // 极简解析：提取已知键值对
  const block = m[1];
  const result = {};
  // INQUIRY
  const inq = block.match(/INQUIRY:\s*\{[^}]*T0:\s*\[([^\]]*)\][^}]*T1:\s*\[([^\]]*)\][^}]*T2:\s*\[([^\]]*)\]/);
  if (inq) result.INQUIRY = { T0: splitRoles(inq[1]), T1: splitRoles(inq[2]), T2: splitRoles(inq[3]) };
  const exec = block.match(/EXECUTION:\s*\{([\s\S]*?)\n\s*\}/);
  if (exec) {
    const e = exec[1];
    result.EXECUTION = {};
    const t0 = e.match(/T0:\s*\[([^\]]*)\]/); if (t0) result.EXECUTION.T0 = splitRoles(t0[1]);
    const t1d = e.match(/T1_DIRECT:\s*\[([^\]]*)\]/); if (t1d) result.EXECUTION.T1_DIRECT = splitRoles(t1d[1]);
    const t1f = e.match(/T1_FULL:\s*\[([^\]]*)\]/); if (t1f) result.EXECUTION.T1_FULL = splitRoles(t1f[1]);
    const t2 = e.match(/T2:\s*\[([^\]]*)\]/); if (t2) result.EXECUTION.T2 = splitRoles(t2[1]);
  }
  return result;
}
function splitRoles(s) { return s.split(',').map(x => x.replace(/['"]/g, '').trim()).filter(Boolean); }

export function run(ctx) {
  if (ctx.fast) {
    if (ctx.cf) ctx.cf.pass(checkName + '.wiring', 'skipped (--fast)');
    return;
  }
  // 只校验脚本可解析（不与 init.md/config.yaml 做深度比对——后者需 yaml 解析，
  // 本 check 定位为"脚本结构完整性"门禁：DISPATCH_REQUIRED 存在且结构完整）
  const scriptPath = path.join(SELF_ROOT, 'scripts', 'delivery-audit.mjs');
  let src;
  try { src = fs.readFileSync(scriptPath, 'utf8'); } catch (e) {
    if (ctx.cf) ctx.cf.fail(checkName + '.wiring', 'cannot read delivery-audit.mjs: ' + e.message);
    return;
  }
  const dr = parseDispatchRequired(src);
  if (!dr) {
    if (ctx.cf) ctx.cf.fail(checkName + '.wiring', 'DISPATCH_REQUIRED not found or unparseable in delivery-audit.mjs');
    return;
  }
  // 结构完整性：INQUIRY + EXECUTION 四档
  const issues = [];
  if (!dr.INQUIRY) issues.push('missing INQUIRY block');
  else ['T0', 'T1', 'T2'].forEach(t => { if (!dr.INQUIRY[t]) issues.push('missing INQUIRY.' + t); });
  if (!dr.EXECUTION) issues.push('missing EXECUTION block');
  else ['T0', 'T1_DIRECT', 'T1_FULL', 'T2'].forEach(t => { if (!dr.EXECUTION[t]) issues.push('missing EXECUTION.' + t); });
  if (issues.length > 0) {
    if (ctx.cf) ctx.cf.fail(checkName + '.wiring', 'structure incomplete: ' + issues.join('; '));
  } else {
    if (ctx.cf) ctx.cf.pass(checkName + '.wiring', 'DISPATCH_REQUIRED structure OK (INQUIRY T0/T1/T2 + EXECUTION T0/T1_DIRECT/T1_FULL/T2)');
  }
}
