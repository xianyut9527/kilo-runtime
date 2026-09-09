// checks/unit-tests.mjs
// 真跑行为回归单测 —— 静态装配维度的"用例真的执行过"兜底。
//
// 立项根因（2026-09 实测）：lifecycle/runtime/__tests__ 下那 4 个测试文件历史上
// import `node:test` + `node:assert/strict`，而本仓库 runtime 要求 Node 14.17（两者分别要
// Node>=18 / 更高版本），`node xxx.test.mjs` 直接 ERR_UNKNOWN_BUILTIN_MODULE；同时**仓库没有
// 任何地方调用它们**（doctor / hook / CI / README 全无）。两条独立失效叠加 = 「有单测」是纯装饰，
// 改 model-selector.mjs 的模型路由判定没有任何回归防线。本 check 把"有人跑一遍"变成机械保证。
//
// 扫描两处目录（新增门禁的反向自测夹具也必须在网内跑，否则「用夹具证明门禁有效」这件事
// 本身只做一次就过期）：
//   lifecycle/runtime/__tests__              runtime 纯函数单测
//   scripts/lifecycle-doctor/checks/__tests__ 门禁自身分支夹具（只喂沙箱 ROOT，不回扫本仓库）
//
// 只在 full/normal 模式跑（--fast 跳过）：init-gate 每次会话首个任务都调 doctor --fast，
// 子进程开销不该压在每个任务的启动路径上；install 的 post-sync doctor 走默认模式，部署时会真跑一遍。
//
// 底座 _harness.mjs 让同一份测试文件在 Node>=14 与 Node>=18（node --test）下都能执行；
// 被测对象都是纯函数，无外部依赖，因此在任意 cwd 都可跑（本 check 显式传 ROOT 作为 cwd）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const TEST_DIRS_REL = [
  path.join('lifecycle', 'runtime', '__tests__'),
  path.join('scripts', 'lifecycle-doctor', 'checks', '__tests__'),
];
// 报告统一用正斜杠（Windows 下 path.join 会带反斜杠，与其余 check 的输出风格不一致）
const TEST_DIRS_DISP = TEST_DIRS_REL.map((d) => d.split(path.sep).join('/'));
// SUMMARY 行由 _harness.mjs 输出：`SUMMARY: 9 pass / 0 fail`
const SUMMARY_RE = /SUMMARY:\s*(\d+)\s*pass\s*\/\s*(\d+)\s*fail/;

export function run(ctx) {
  const { cf, ROOT, FAST_MODE } = ctx;
  if (FAST_MODE) {
    cf.pass('unit.executed', 'skipped (--fast)：full 模式与 install post-sync 才跑单测');
    return;
  }

  // 收集待跑文件：目录缺失是允许的（部署副本可能只带其中一处），只要一处有测试就跑
  const queue = [];
  for (const rel of TEST_DIRS_REL) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(ROOT, rel)).filter((n) => n.endsWith('.test.mjs')).sort();
    } catch {
      continue;
    }
    for (const n of names) queue.push({ rel, file: path.join(ROOT, rel, n), name: n });
  }
  if (queue.length === 0) {
    cf.warn('unit.executed', `未找到任何 *.test.mjs（${TEST_DIRS_DISP.join(' / ')}）——行为回归网为空`);
    return;
  }

  let totalPass = 0;
  let totalFail = 0;
  const failedFiles = [];
  const details = [];

  for (const item of queue) {
    const r = spawnSync(process.execPath, [item.file], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) {
      failedFiles.push(item.name);
      details.push(`${item.name}: 调用失败 ${r.error.message}`);
      continue;
    }
    const out = (r.stdout || '') + (r.stderr || '');
    const m = SUMMARY_RE.exec(out);
    if (!m) {
      failedFiles.push(item.name);
      const errTail = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0] || '';
      details.push(`${item.name}: 无 SUMMARY 行（exit=${r.status}）${errTail ? ' | stderr: ' + errTail.slice(0, 120) : ''}`);
      continue;
    }
    const p = Number(m[1]);
    const f = Number(m[2]);
    totalPass += p;
    totalFail += f;
    if (r.status !== 0 || f > 0) {
      const failLines = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL ')).slice(0, 3);
      // 加载期崩溃时 _harness 的 exit 监听器仍会输出 `SUMMARY: 0 pass / 0 fail`，
      // 光看 fail 计数看不出「这个文件根本没跑成」，故 exit 码 + stderr 尾行必须一起上报告。
      const errTail = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0] || '';
      failedFiles.push(item.name);
      details.push(`${item.name}: exit=${r.status} ${p} pass / ${f} fail`
        + (failLines.length ? ' — ' + failLines.join(' | ') : '')
        + (errTail ? ' | stderr: ' + errTail.slice(0, 120) : ''));
    }
  }

  if (failedFiles.length === 0) {
    cf.pass('unit.executed', `${queue.length} 个测试文件 / ${totalPass} 用例全通过（${TEST_DIRS_DISP.join(' + ')}）`);
  } else {
    cf.fail('unit.executed',
      `单测未通过：${failedFiles.join(', ')}（${totalPass} pass / ${totalFail} fail）— ${details.slice(0, 4).join(' ;; ').slice(0, 400)}`);
  }
}
