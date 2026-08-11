#!/usr/bin/env node
// quality-gate.mjs
// QUALITY 阶段机械前置门（H2 合并三门）：单进程顺序跑
//   acceptance-check + diff-boundary-check + search-discipline-check。
// 替代旧三连串行调用，省 2 次 node 进程启动 + 2 个 reasoning 回合/QUALITY 进入。
//
// 用法：node scripts/quality-gate.mjs <task_id>
// 退出码：
//   0 = 全部三门通过（含原 exit 1 的"建议性回退 LLM"，合并为通过）
//   1 = 参数错（缺 task_id / --help）
//   2 = 任一门机械 FAIL（列出哪门）
//
// 设计：import 三个 check 核心函数，单 node 进程完成；任一门 FAIL 不短路，全跑完收集所有 FAIL
// 便于一次修复角色介入。出口 exit = 是否任一 FAIL（2）否则 0。

import { checkAcceptance } from './acceptance-check.mjs';
import { checkDiffBoundary } from './diff-boundary-check.mjs';
import { checkSearchDiscipline } from './search-discipline-check.mjs';

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('Usage: node scripts/quality-gate.mjs <task_id>\n');
    process.stdout.write('Exit: 0=all 3 mechanical gates pass (incl. advisory exit 1 fallback to LLM), 2=any gate FAIL\n');
    process.exit(args.length !== 1 ? 1 : 0);
  }
  const taskId = args[0];

  const gates = [
    { name: 'acceptance-check',        fn: checkAcceptance },
    { name: 'diff-boundary-check',     fn: checkDiffBoundary },
    { name: 'search-discipline-check', fn: checkSearchDiscipline },
  ];

  const results = [];
  for (const g of gates) {
    process.stdout.write(`\n[quality-gate] === ${g.name} ===\n`);
    let r;
    try { r = g.fn(taskId); }
    catch (e) {
      process.stdout.write(`[quality-gate] ${g.name} threw: ${e.message}\n`);
      r = { exit: 1 };
    }
    results.push({ name: g.name, exit: r.exit });
  }

  // 聚合
  const failed = results.filter((x) => x.exit === 2);

  process.stdout.write(`\n[quality-gate] === SUMMARY ===\n`);
  for (const r of results) {
    const tag = r.exit === 2 ? 'FAIL' : (r.exit === 1 ? 'FALLBACK' : 'PASS');
    process.stdout.write(`  [${tag}] ${r.name} (exit=${r.exit})\n`);
  }

  if (failed.length > 0) {
    process.stdout.write(`\nFAIL quality-gate: ${failed.length}/${results.length} 机械门失败（${failed.map((f) => f.name).join(', ')}）→ 直接送修复角色\n`);
    process.exit(2);
  }
  process.stdout.write(`\nPASS quality-gate: 全部机械前置门通过 → 进入 LLM hooks\n`);
  process.exit(0);
}

main();