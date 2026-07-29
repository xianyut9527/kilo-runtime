#!/usr/bin/env node
// e2e-smoke.mjs
// 生命周期流转机制 e2e 冒烟回归 — 框架自身改动的回归网。
//
// v2 响应式 Hooks 架构：主图 6 stage（INTENT/SIZING/PLANNING/EXECUTING/QUALITY/DELIVERING）
// CHECKING+REVIEWING+FIXING 合并为 QUALITY（hooks 内部自动循环）。
// 计数器从 convergence.round/total_rounds 迁移到 quality.round/max_rounds。
//
// 覆盖：task-context.mjs（init/set）+ transition-check.mjs（边校验/when 求值/
// gate 硬门/quality.round 递增/熔断）。静态装配校验由 lifecycle-doctor.mjs
// 负责，本脚本专注运行时流转机制。
//
// 用法：
//   node scripts/e2e-smoke.mjs
// 退出码：
//   0 = 全场景 PASS
//   1 = 任一场景 FAIL
//
// 仅使用 Node 内置模块（Node 14 兼容）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contextPath, readContext, writeContext } from './task-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TC = path.join(__dirname, 'task-context.mjs');
const TR = path.join(__dirname, 'transition-check.mjs');

const ID1 = `e2e${process.pid}`;
const ID2 = `e2eb${process.pid}`;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
}

// 黑盒执行被测脚本，返回 { code, out }（exit code 经 catch 捕获）
function run(script, args) {
  try {
    const out = execFileSync('node', [script].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: String(out).trim() };
  } catch (e) {
    const out = String((e.stdout || '').toString()) + String((e.stderr || '').toString());
    return { code: typeof e.status === 'number' ? e.status : 1, out: out.trim() };
  }
}

function tc(args) { return run(TC, args); }
function tr(id, from, to) { return run(TR, [id, '--from', from, '--to', to]); }

// 读取 quality 计数器（v2：quality.round/max_rounds）
function qualityOf(id) {
  const r = tc(['get', id, 'quality']);
  try { return JSON.parse(r.out); } catch { return {}; }
}

// e2e 特许通道：直写测试前置状态（绕过 WRITE_MATRIX，仅测试用）
function patchContext(id, mutator) {
  const { ctx } = readContext(id);
  mutator(ctx);
  writeContext(id, ctx);
}

function cleanup() {
  for (const id of [ID1, ID2]) {
    try { fs.unlinkSync(contextPath(id)); } catch { /* 不存在则忽略 */ }
  }
}

function main() {
  // ---------- 场景 0：--help ----------
  {
    const r = run(TR, ['--help']);
    check('s0.help', r.code === 0 && /Usage:/.test(r.out), `exit=${r.code}`);
  }

  // ---------- T1 全链路（v2：EXECUTING→QUALITY→DELIVERING→DONE） ----------
  {
    // s1. init
    const r = tc(['init', ID1]);
    check('s1.init', r.code === 0, r.out);

    // s2. set intent（conductor 写 intent 合法）
    const r2 = tc(['set', ID1, 'intent.intent_type', '"EXECUTION"', '--agent', 'conductor']);
    check('s2.set-intent', r2.code === 0, r2.out);

    // s3. START -> INTENT（无 when）
    const r3 = tr(ID1, 'START', 'INTENT');
    check('s3.start-intent', r3.code === 0, r3.out);

    // s4. INTENT -> SIZING（when EXECUTION 满足）
    const r4 = tr(ID1, 'INTENT', 'SIZING');
    check('s4.intent-sizing', r4.code === 0, r4.out);

    // s5. INTENT -> DONE（负例：when INQUIRY 不满足 → exit 1）
    const r5 = tr(ID1, 'INTENT', 'DONE');
    check('s5.intent-done.reject', r5.code === 1 && /PROCESS_VIOLATION/.test(r5.out), `exit=${r5.code}`);

    // s6. 定级 T1；SIZING→PLANNING 放行；SIZING→EXECUTING（T0 边）拒绝
    tc(['set', ID1, 'sizing.tier', '"T1"', '--agent', 'conductor']);
    const r6a = tr(ID1, 'SIZING', 'PLANNING');
    check('s6a.sizing-planning', r6a.code === 0, r6a.out);
    const r6b = tr(ID1, 'SIZING', 'EXECUTING');
    check('s6b.sizing-executing.reject', r6b.code === 1, `exit=${r6b.code}`);

    // s7. PLANNING→EXECUTING；EXECUTING→DELIVERING（T0 边）拒绝；EXECUTING→QUALITY 放行 quality.round=1
    const r7a = tr(ID1, 'PLANNING', 'EXECUTING');
    check('s7a.planning-executing', r7a.code === 0, r7a.out);
    const r7b = tr(ID1, 'EXECUTING', 'DELIVERING');
    check('s7b.executing-delivering.reject', r7b.code === 1, `exit=${r7b.code}`);
    const r7c = tr(ID1, 'EXECUTING', 'QUALITY');
    check('s7c.executing-quality', r7c.code === 0 && qualityOf(ID1).round === 1, r7c.out);

    // s8. QUALITY→DELIVERING（负例：quality_verdict 未设置 → exit 1）
    const r8 = tr(ID1, 'QUALITY', 'DELIVERING');
    check('s8.quality-delivering.reject', r8.code === 1, `exit=${r8.code}`);

    // s9. 设 quality.verdict=PASS → QUALITY→DELIVERING 放行
    patchContext(ID1, (ctx) => {
      if (!ctx.quality) ctx.quality = {};
      ctx.quality.verdict = 'PASS';
    });
    const r9 = tr(ID1, 'QUALITY', 'DELIVERING');
    check('s9.quality-delivering', r9.code === 0, r9.out);

    // s10. DELIVERING→DONE（负例：gate MEMORY_WRITE_COMPLETE 未过 → exit 1）
    const r10 = tr(ID1, 'DELIVERING', 'DONE');
    check('s10.delivering-done.gate', r10.code === 1 && /MISSING_MEMORY_WRITE/.test(r10.out), `exit=${r10.code}`);

    // s11. 写入 memory_write_status=OK → DELIVERING→DONE 放行
    tc(['set', ID1, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r11 = tr(ID1, 'DELIVERING', 'DONE');
    check('s11.delivering-done', r11.code === 0, r11.out);
  }

  // ---------- 场景 12：QUALITY 熔断（quality.round >= max_total_cycles=7） ----------
  {
    tc(['init', ID2]);
    patchContext(ID2, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T1' };
    });
    // EXECUTING→QUALITY（quality.round=1）
    tr(ID2, 'EXECUTING', 'QUALITY');
    check('s12a.enter-quality', qualityOf(ID2).round === 1, JSON.stringify(qualityOf(ID2)));

    // 反复进入 QUALITY（quality.round 递增）
    // v2: QUALITY→DELIVERING 需 quality_verdict==PASS 或 CIRCUIT_BREAKER
    // 先设 verdict=PENDING 使 QUALITY→DELIVERING 拒绝，再重新进入 QUALITY
    // 但 graph.yaml 中 QUALITY 只有 →DELIVERING 边，无回 EXECUTING 边
    // 所以用多个独立 task_context 模拟反复进入
    // 实际熔断：直接 patch quality.round 接近阈值后触发
    patchContext(ID2, (ctx) => {
      if (!ctx.quality) ctx.quality = {};
      ctx.quality.round = 6; // 下次进入 QUALITY 时 +1 = 7 → 熔断
    });
    // 需要一条边进入 QUALITY——但当前在 DELIVERING（上次 EXECUTING→QUALITY 已走）
    // 重置 current_stage 到 EXECUTING 来模拟重新进入
    patchContext(ID2, (ctx) => {
      ctx.current_stage = 'EXECUTING';
    });
    const r12 = tr(ID2, 'EXECUTING', 'QUALITY');
    check('s12b.circuit-breaker', r12.code === 3 && /CIRCUIT_BREAKER/.test(r12.out), `exit=${r12.code} ${r12.out}`);
    // 熔断后计数已持久化：quality.round=7
    check('s12c.counter-persisted', qualityOf(ID2).round === 7, JSON.stringify(qualityOf(ID2)));
  }

  // ---------- 场景 13：T0 极速通道（无 PLANNING/QUALITY） ----------
  {
    const id = `e2ec${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T0' };
    });
    // SIZING -> EXECUTING
    const r13a = tr(id, 'SIZING', 'EXECUTING');
    check('s13a.sizing-executing', r13a.code === 0, r13a.out);
    // EXECUTING -> QUALITY 拒绝（T0 不走验证：when tier in ['T1','T2','T3'] 不满足）
    const r13b = tr(id, 'EXECUTING', 'QUALITY');
    check('s13b.executing-quality.reject', r13b.code === 1, `exit=${r13b.code}`);
    // EXECUTING -> DELIVERING 放行
    const r13c = tr(id, 'EXECUTING', 'DELIVERING');
    check('s13c.executing-delivering', r13c.code === 0, r13c.out);
    // DELIVERING -> DONE gate 未过（memory_write_status 缺失）
    const r13d = tr(id, 'DELIVERING', 'DONE');
    check('s13d.delivering-done.gate', r13d.code === 1 && /MISSING_MEMORY_WRITE/.test(r13d.out), `exit=${r13d.code}`);
    // 写入 memory_write_status -> DONE 放行
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r13e = tr(id, 'DELIVERING', 'DONE');
    check('s13e.delivering-done', r13e.code === 0, r13e.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 场景 14：T2 全链路（PLANNING→EXECUTING→QUALITY→DELIVERING→DONE） ----------
  {
    const id = `e2ee${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T2' };
    });
    // SIZING -> PLANNING（when: tier in ['T1','T2'] → T2 放行）
    const r14a = tr(id, 'SIZING', 'PLANNING');
    check('s14a.sizing-planning', r14a.code === 0, r14a.out);
    // SIZING -> EXECUTING 拒绝（T2 不走 T0 极速通道）
    const r14b = tr(id, 'SIZING', 'EXECUTING');
    check('s14b.sizing-executing.reject', r14b.code === 1, `exit=${r14b.code}`);
    // PLANNING -> EXECUTING
    const r14c = tr(id, 'PLANNING', 'EXECUTING');
    check('s14c.planning-executing', r14c.code === 0, r14c.out);
    // EXECUTING -> QUALITY（when: tier in ['T1','T2','T3'] → T2 放行）quality.round=1
    const r14d = tr(id, 'EXECUTING', 'QUALITY');
    check('s14d.executing-quality', r14d.code === 0 && qualityOf(id).round === 1, r14d.out);
    // QUALITY -> DELIVERING（负例：quality_verdict 未设 → exit 1）
    const r14e = tr(id, 'QUALITY', 'DELIVERING');
    check('s14e.quality-delivering.reject', r14e.code === 1, `exit=${r14e.code}`);
    // 设 quality.verdict=PASS → QUALITY -> DELIVERING 放行
    patchContext(id, (ctx) => {
      if (!ctx.quality) ctx.quality = {};
      ctx.quality.verdict = 'PASS';
    });
    const r14f = tr(id, 'QUALITY', 'DELIVERING');
    check('s14f.quality-delivering', r14f.code === 0, r14f.out);
    // DELIVERING -> DONE gate
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r14g = tr(id, 'DELIVERING', 'DONE');
    check('s14g.delivering-done', r14g.code === 0, r14g.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 场景 15：QUALITY CIRCUIT_BREAKER → DELIVERING ----------
  {
    const id = `e2ef${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T1' };
    });
    // EXECUTING → QUALITY（quality.round=1）
    tr(id, 'EXECUTING', 'QUALITY');
    // 设 quality.verdict=CIRCUIT_BREAKER → QUALITY→DELIVERING 放行（带降级标记）
    patchContext(id, (ctx) => {
      if (!ctx.quality) ctx.quality = {};
      ctx.quality.verdict = 'CIRCUIT_BREAKER';
    });
    const r15 = tr(id, 'QUALITY', 'DELIVERING');
    check('s15.quality-cb-delivering', r15.code === 0, r15.out);
    // DELIVERING -> DONE gate
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r15b = tr(id, 'DELIVERING', 'DONE');
    check('s15b.delivering-done', r15b.code === 0, r15b.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 场景 16：T3 子图入口 + 回流主图闭环 ----------
  {
    const id = `e2ed${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T3' };
    });
    // SIZING -> MM_SUBGRAPH
    const r16a = tr(id, 'SIZING', 'MM_SUBGRAPH');
    check('s16a.sizing-mm_subgraph', r16a.code === 0, r16a.out);
    // MM_SUBGRAPH -> EXECUTING（需要 subgraph_status）
    patchContext(id, (ctx) => {
      ctx.subgraph_status = 'ready_for_delivery';
    });
    const r16b = tr(id, 'MM_SUBGRAPH', 'EXECUTING');
    check('s16b.mm_subgraph-executing', r16b.code === 0, r16b.out);
    // EXECUTING -> QUALITY（T3 回主图后走标准 QUALITY hooks 验证）
    const r16c = tr(id, 'EXECUTING', 'QUALITY');
    check('s16c.executing-quality', r16c.code === 0 && qualityOf(id).round === 1, r16c.out);
    // QUALITY -> DELIVERING（设 verdict=PASS）
    patchContext(id, (ctx) => {
      if (!ctx.quality) ctx.quality = {};
      ctx.quality.verdict = 'PASS';
    });
    const r16d = tr(id, 'QUALITY', 'DELIVERING');
    check('s16d.quality-delivering', r16d.code === 0, r16d.out);
    // DELIVERING -> DONE gate 未过
    const r16e = tr(id, 'DELIVERING', 'DONE');
    check('s16e.delivering-done.gate', r16e.code === 1 && /MISSING_MEMORY_WRITE/.test(r16e.out), `exit=${r16e.code}`);
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r16f = tr(id, 'DELIVERING', 'DONE');
    check('s16f.delivering-done', r16f.code === 0, r16f.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 报告 ----------
  cleanup();
  let nPass = 0;
  let nFail = 0;
  for (const r of results) {
    if (r.pass) nPass++;
    else nFail++;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}\n`);
  }
  process.stdout.write(`\nSUMMARY: ${nPass} PASS / ${nFail} FAIL\n`);
  process.exit(nFail > 0 ? 1 : 0);
}

main();