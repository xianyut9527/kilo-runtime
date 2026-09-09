/**
 * derivations-freshness.mjs — lifecycle-doctor check
 *
 * 预生成快路新鲜度：scripts/lib/.generated/derivations.json 是 build-derivations.mjs
 * 编译期产出的 WRITE_MATRIX/graph/config 快照，供 task-context.mjs 用 readFileSync +
 * JSON.parse 直接加载，省掉每次进程启动全量扫描 agent/*.md + 解析两个 YAML。
 *
 * 立项根因：该文件被 .gitignore 忽略（运行时产物），install 双脚本会在部署时生成，
 * 但**仓库侧改完 agent/*.md 后没有任何门禁提醒重建**。实测后果：指纹不匹配时
 * task-context.mjs 每次调用都往 stderr 打一行 [DERIVATIONS_STALE] 并回退 cachedDerive
 * 慢路径——U3 那整包预生成优化在仓库侧静默失效，且没人看得见（回退是透明的）。
 *
 * severity 取 WARN 不取 FAIL：回退路径语义完全正确（fail-closed 未破坏），
 * 这是性能退化不是装配错误；FAIL 会让 install L180 的仓库侧自检被纯性能问题卡住。
 *
 * 判定语义必须与运行时一致，故本 check 镜像 task-context.mjs
 * #loadWriteMatrixFromGenerated 的解析规则，而不是自己发明一套：
 *   - 条目格式 `basename@<12位hex>`；`@MISSING` 与无法解析的条目一律保守判「不 stale」
 *   - scope：graph.yaml / config.yaml 在 lifecycle/，其余默认 agent/
 * 为什么不 import build-derivations.mjs 复用 sourceFingerprint：该脚本被 import 时
 * 会无条件执行 build() 并以 process.exit(0) 结束（见其 CLI 入口段），会把 doctor 一起带走。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const GEN_REL = path.join('scripts', 'lib', '.generated', 'derivations.json');
const ENTRY_RE = /^(.+?)@([0-9a-f]{12}|MISSING)$/;

function digestOf(absFile) {
  try {
    return createHash('sha256').update(fs.readFileSync(absFile)).digest('hex').slice(0, 12);
  } catch {
    return null; // 读取失败：与运行时一致，保守不判 stale
  }
}

/**
 * 逐条比对存储指纹与当前内容指纹。
 * @returns {{stale: string[], checked: number, skipped: number}} stale = 不匹配的 basename 列表
 */
function compareFingerprint(fp, root) {
  const stale = [];
  let checked = 0;
  let skipped = 0;
  if (typeof fp !== 'string' || fp === '') return { stale: ['(无 fingerprint 字段)'], checked, skipped };
  for (const entry of fp.split('|')) {
    const m = entry.match(ENTRY_RE);
    if (!m) { skipped++; continue; }              // 旧 mtime 格式等：保守不判 stale
    if (m[2] === 'MISSING') { skipped++; continue; } // 生成时源文件缺失：保守不判 stale
    const dir = (m[1] === 'graph.yaml' || m[1] === 'config.yaml')
      ? path.join(root, 'lifecycle')
      : path.join(root, 'agent');
    const cur = digestOf(path.join(dir, m[1]));
    if (cur === null) { skipped++; continue; }
    checked++;
    if (cur !== m[2]) stale.push(m[1]);
  }
  return { stale, checked, skipped };
}

export function run(ctx) {
  const { cf, ROOT } = ctx;
  const genPath = path.join(ROOT, GEN_REL);
  const remediation = 'node scripts/build-derivations.mjs';

  if (!fs.existsSync(genPath)) {
    cf.warn(
      'derivations.freshness',
      `未生成（快路未启用，task-context 每次走 cachedDerive 慢路径）——跑 ${remediation}`
    );
    return { name: 'derivations.freshness', status: 'WARN', detail: 'missing', issues: [GEN_REL] };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(genPath, 'utf8'));
  } catch (e) {
    cf.warn('derivations.freshness', `解析失败（回退慢路径）：${e.message}——跑 ${remediation}`);
    return { name: 'derivations.freshness', status: 'WARN', detail: 'unparsable', issues: [e.message] };
  }

  if (!data || typeof data !== 'object' || !data.writeMatrix || typeof data.writeMatrix !== 'object') {
    cf.warn('derivations.freshness', `缺 writeMatrix（回退慢路径）——跑 ${remediation}`);
    return { name: 'derivations.freshness', status: 'WARN', detail: 'no-writeMatrix', issues: [] };
  }

  const r = compareFingerprint(data.fingerprint, ROOT);
  const agents = Object.keys(data.writeMatrix).length;
  if (r.stale.length > 0) {
    cf.warn(
      'derivations.freshness',
      `${r.stale.length}/${r.checked} 个源文件指纹不匹配（${r.stale.slice(0, 5).join(', ')}${r.stale.length > 5 ? ' …' : ''}）→ task-context 走慢路径，跑 ${remediation}`
    );
    return { name: 'derivations.freshness', status: 'WARN', detail: 'stale', issues: r.stale };
  }

  cf.pass('derivations.freshness', `writeMatrix=${agents} 指纹匹配（checked=${r.checked}）`);
  return { name: 'derivations.freshness', status: 'PASS', detail: `agents=${agents}`, issues: [] };
}
