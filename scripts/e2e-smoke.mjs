#!/usr/bin/env node
// e2e-smoke.mjs
// 生命周期流转机制 e2e 冒烟回归 — 框架自身改动的回归网。
//
// 覆盖：task-context.mjs（init/set）+ transition-check.mjs（边校验/when 求值/
// gate 硬门/计数器递增/round 重置/单点熔断）。静态装配校验由 lifecycle-doctor.mjs
// 负责，本脚本专注运行时流转机制。
//
// 用法：
//   node scripts/e2e-smoke.mjs
// 退出码：
//   0 = 全场景 PASS
//   1 = 任一场景 FAIL
//
// 实现说明：
//   - 经 child_process.execFileSync 驱动两个被测脚本（黑盒，断言 exit code）
//   - task_id 用 e2e<pid> / e2eb<pid>（合法字符集），结束清理临时文件
//   - verification.review 写入走 readContext/writeContext 直写——e2e 测试特许
//     通道（绕过 WRITE_MATRIX 仅用于构造测试前置状态，不代表生产写入路径）
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

function counterOf(id) {
  const r = tc(['get', id, 'convergence']);
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

  // ---------- T1 全链路（含负例） ----------
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

    // s7. PLANNING→EXECUTING；EXECUTING→DELIVERING（T0 边）拒绝；EXECUTING→CHECKING 放行 total=1
    const r7a = tr(ID1, 'PLANNING', 'EXECUTING');
    check('s7a.planning-executing', r7a.code === 0, r7a.out);
    const r7b = tr(ID1, 'EXECUTING', 'DELIVERING');
    check('s7b.executing-delivering.reject', r7b.code === 1, `exit=${r7b.code}`);
    const r7c = tr(ID1, 'EXECUTING', 'CHECKING');
    check('s7c.executing-checking', r7c.code === 0 && counterOf(ID1).total_rounds === 1, r7c.out);

    // s8. forward=FAIL（verifier 写 verification.forward 合法）→ CHECKING→FIXING round=1
    const r8a = tc(['set', ID1, 'verification.forward', '{"forward_result":"FAIL"}', '--agent', 'verifier']);
    check('s8a.set-forward-fail', r8a.code === 0, r8a.out);
    const r8b = tr(ID1, 'CHECKING', 'FIXING');
    check('s8b.checking-fixing', r8b.code === 0 && counterOf(ID1).round === 1, r8b.out);

    // s9. FIXING→CHECKING → total=2
    const r9 = tr(ID1, 'FIXING', 'CHECKING');
    check('s9.fixing-checking', r9.code === 0 && counterOf(ID1).total_rounds === 2, r9.out);

    // s10. forward=PASS → CHECKING→REVIEWING → total=3 且 round 重置 0
    tc(['set', ID1, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    const r10 = tr(ID1, 'CHECKING', 'REVIEWING');
    const c10 = counterOf(ID1);
    check('s10.checking-reviewing', r10.code === 0 && c10.total_rounds === 3 && c10.round === 0, `${r10.out} | ${JSON.stringify(c10)}`);

    // s11. review=PASS（e2e 特许直写）→ REVIEWING→DELIVERING
    patchContext(ID1, (ctx) => {
      if (!ctx.verification) ctx.verification = {};
      ctx.verification.review = { review_result: 'PASS' };
    });
    const r11 = tr(ID1, 'REVIEWING', 'DELIVERING');
    check('s11.reviewing-delivering', r11.code === 0, r11.out);

    // s12. DELIVERING→DONE（负例：gate MEMORY_WRITE_COMPLETE 未过 → exit 1）
    const r12 = tr(ID1, 'DELIVERING', 'DONE');
    check('s12.delivering-done.gate', r12.code === 1 && /MISSING_MEMORY_WRITE/.test(r12.out), `exit=${r12.code}`);

    // s13. 写入 memory_write_status=OK → DELIVERING→DONE 放行
    tc(['set', ID1, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r13 = tr(ID1, 'DELIVERING', 'DONE');
    check('s13.delivering-done', r13.code === 0, r13.out);
  }

  // ---------- 场景 14：单点熔断 ----------
  {
    tc(['init', ID2]);
    patchContext(ID2, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T1' };
      ctx.verification = { forward: { forward_result: 'FAIL' } };
    });
    // EXECUTING→CHECKING（total=1）
    const r0 = tr(ID2, 'EXECUTING', 'CHECKING');
    check('s14.0.enter-checking', r0.code === 0, r0.out);
    // 循环：CHECKING→FIXING（round++）/ FIXING→CHECKING（total++）
    // round 1..4 放行；round=5 触发 [CIRCUIT_BREAKER] exit 3（max_rounds=5）
    let breakerCode = -1;
    let breakerOut = '';
    let roundsOk = true;
    for (let i = 1; i <= 5; i++) {
      const cf = tr(ID2, 'CHECKING', 'FIXING');
      if (i < 5) {
        if (cf.code !== 0) { roundsOk = false; breakerOut = cf.out; break; }
        const fc = tr(ID2, 'FIXING', 'CHECKING');
        if (fc.code !== 0) { roundsOk = false; breakerOut = fc.out; break; }
      } else {
        breakerCode = cf.code;
        breakerOut = cf.out;
      }
    }
    check('s14a.rounds-1-4', roundsOk, breakerOut);
    check('s14b.circuit-breaker', breakerCode === 3 && /CIRCUIT_BREAKER/.test(breakerOut), `exit=${breakerCode} ${breakerOut}`);
    // 熔断后计数已持久化：round=5
    check('s14c.counter-persisted', counterOf(ID2).round === 5, JSON.stringify(counterOf(ID2)));
  }

  // ---------- 场景 15：T0 极速通道（无 PLANNING/CHECKING/REVIEWING） ----------
  {
    const id = `e2ec${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T0' };
    });
    // SIZING -> EXECUTING
    const r15a = tr(id, 'SIZING', 'EXECUTING');
    check('s15a.sizing-executing', r15a.code === 0, r15a.out);
    // EXECUTING -> CHECKING 拒绝（T0 不走验证）
    const r15b = tr(id, 'EXECUTING', 'CHECKING');
    check('s15b.executing-checking.reject', r15b.code === 1, `exit=${r15b.code}`);
    // EXECUTING -> DELIVERING 放行
    const r15c = tr(id, 'EXECUTING', 'DELIVERING');
    check('s15c.executing-delivering', r15c.code === 0, r15c.out);
    // DELIVERING -> DONE gate 未过（memory_write_status 缺失）
    const r15d = tr(id, 'DELIVERING', 'DONE');
    check('s15d.delivering-done.gate', r15d.code === 1 && /MISSING_MEMORY_WRITE/.test(r15d.out), `exit=${r15d.code}`);
    // 写入 memory_write_status -> DONE 放行
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r15e = tr(id, 'DELIVERING', 'DONE');
    check('s15e.delivering-done', r15e.code === 0, r15e.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 场景 17：T2 全链路（PLANNING→…→DONE，验证 tier=T2 放行） ----------
  {
    const id = `e2ee${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T2' };
    });
    // SIZING -> PLANNING（when: tier in ['T1','T2'] → T2 放行）
    const r17a = tr(id, 'SIZING', 'PLANNING');
    check('s17a.sizing-planning', r17a.code === 0, r17a.out);
    // SIZING -> EXECUTING 拒绝（T2 不走 T0 极速通道）
    const r17b = tr(id, 'SIZING', 'EXECUTING');
    check('s17b.sizing-executing.reject', r17b.code === 1, `exit=${r17b.code}`);
    // PLANNING -> EXECUTING
    const r17c = tr(id, 'PLANNING', 'EXECUTING');
    check('s17c.planning-executing', r17c.code === 0, r17c.out);
    // EXECUTING -> CHECKING（when: tier in ['T1','T2','T3'] → T2 放行）total=1
    const r17d = tr(id, 'EXECUTING', 'CHECKING');
    check('s17d.executing-checking', r17d.code === 0 && counterOf(id).total_rounds === 1, r17d.out);
    // forward=FAIL → CHECKING -> FIXING round=1
    tc(['set', id, 'verification.forward', '{"forward_result":"FAIL"}', '--agent', 'verifier']);
    const r17e = tr(id, 'CHECKING', 'FIXING');
    check('s17e.checking-fixing', r17e.code === 0 && counterOf(id).round === 1, r17e.out);
    // FIXING -> CHECKING total=2
    const r17f = tr(id, 'FIXING', 'CHECKING');
    check('s17f.fixing-checking', r17f.code === 0 && counterOf(id).total_rounds === 2, r17f.out);
    // forward=PASS + reverse=PASS（T2 反向审计挂载）→ CHECKING -> REVIEWING total=3 round=0
    tc(['set', id, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    tc(['set', id, 'verification.reverse', '{"reverse_result":"PASS"}', '--agent', 'reverse-auditor']);
    const r17g = tr(id, 'CHECKING', 'REVIEWING');
    const c17 = counterOf(id);
    check('s17g.checking-reviewing', r17g.code === 0 && c17.total_rounds === 3 && c17.round === 0, `${r17g.out} | ${JSON.stringify(c17)}`);
    // side=PASS + review=PASS（T2 侧向验证挂载）→ REVIEWING -> DELIVERING
    patchContext(id, (ctx) => {
      ctx.verification.side = { side_result: 'PASS' };
      ctx.verification.review = { review_result: 'PASS' };
    });
    const r17h = tr(id, 'REVIEWING', 'DELIVERING');
    check('s17h.reviewing-delivering', r17h.code === 0, r17h.out);
    // DELIVERING -> DONE gate
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r17i = tr(id, 'DELIVERING', 'DONE');
    check('s17i.delivering-done', r17i.code === 0, r17i.out);
    try { fs.unlinkSync(contextPath(id)); } catch {}
  }

  // ---------- 场景 18：全局熔断（total_rounds >= max_total_rounds=7） ----------
  // 构造交替进入 CHECKING/REVIEWING 的序列，使 total_rounds 持续递增而 round 不超 5：
  //   CHECKING(1) → FIXING(r1) → CHECKING(2) → REVIEWING(3,r0) → FIXING(r1) → CHECKING(4) → REVIEWING(5,r0)
  //   → FIXING(r1) → CHECKING(6) → REVIEWING(7,r0) — REVIEWING 入口 total=7 → 全局熔断
  {
    const id = `e2ef${process.pid}`;
    tc(['init', id]);
    patchContext(id, (ctx) => {
      ctx.intent = { intent_type: 'EXECUTION' };
      ctx.sizing = { tier: 'T1' };
    });
    // EXECUTING → CHECKING (total=1)
    tr(id, 'EXECUTING', 'CHECKING');
    // 1) CHECKING → FIXING (round=1)
    tc(['set', id, 'verification.forward', '{"forward_result":"FAIL"}', '--agent', 'verifier']);
    tr(id, 'CHECKING', 'FIXING');
    // 2) FIXING → CHECKING (total=2, round=1)
    tr(id, 'FIXING', 'CHECKING');
    // 3) CHECKING → REVIEWING (total=3, round 重置 0) — 需 forward=PASS
    tc(['set', id, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    tr(id, 'CHECKING', 'REVIEWING');
    // 4) REVIEWING → FIXING (round=1) — 需 side=FAIL 或 review=FAIL
    patchContext(id, (ctx) => { ctx.verification.review = { review_result: 'FAIL' }; });
    tr(id, 'REVIEWING', 'FIXING');
    // 5) FIXING → CHECKING (total=4, round=1)
    tr(id, 'FIXING', 'CHECKING');
    // 6) CHECKING → REVIEWING (total=5, round 重置 0)
    tc(['set', id, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    tr(id, 'CHECKING', 'REVIEWING');
    // 7) REVIEWING → FIXING (round=1)
    tr(id, 'REVIEWING', 'FIXING');
    // 8) FIXING → CHECKING (total=6, round=1)
    tr(id, 'FIXING', 'CHECKING');
    // 9) CHECKING → REVIEWING (total=7, round 重置 0) — 全局熔断入口
    tc(['set', id, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    const r18 = tr(id, 'CHECKING', 'REVIEWING');
    check('s18.global-circuit-breaker', r18.code === 3 && /CIRCUIT_BREAKER/.test(r18.out) && /total_rounds=7/.test(r18.out), `exit=${r18.code} | ${r18.out}`);
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
    // EXECUTING -> CHECKING（T3 回主图后走标准验证审查）
    const r16c = tr(id, 'EXECUTING', 'CHECKING');
    check('s16c.executing-checking', r16c.code === 0 && counterOf(id).total_rounds === 1, r16c.out);
    // CHECKING -> REVIEWING（forward PASS）
    tc(['set', id, 'verification.forward', '{"forward_result":"PASS"}', '--agent', 'verifier']);
    const r16d = tr(id, 'CHECKING', 'REVIEWING');
    check('s16d.checking-reviewing', r16d.code === 0 && counterOf(id).total_rounds === 2 && counterOf(id).round === 0, `${r16d.out} | ${JSON.stringify(counterOf(id))}`);
    // REVIEWING -> DELIVERING（review PASS）
    patchContext(id, (ctx) => {
      if (!ctx.verification) ctx.verification = {};
      ctx.verification.review = { review_result: 'PASS' };
    });
    const r16e = tr(id, 'REVIEWING', 'DELIVERING');
    check('s16e.reviewing-delivering', r16e.code === 0, r16e.out);
    // DELIVERING -> DONE gate 未过
    const r16f = tr(id, 'DELIVERING', 'DONE');
    check('s16f.delivering-done.gate', r16f.code === 1 && /MISSING_MEMORY_WRITE/.test(r16f.out), `exit=${r16f.code}`);
    tc(['set', id, 'memory_write_status', '"OK"', '--agent', 'conductor']);
    const r16g = tr(id, 'DELIVERING', 'DONE');
    check('s16g.delivering-done', r16g.code === 0, r16g.out);
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
