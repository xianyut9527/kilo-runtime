#!/usr/bin/env node
// 统一离线测试入口（2026-10-08 补）。
// 背景：此前没有「一键跑全套」，且各测试调用口径不一致——scripts/test-circuit-breaker.mjs
// 直接 import lib/hx-client.ts，必须 `node --experimental-strip-types`；其余 scripts 测试用
// esbuild 打包 .ts 所以裸 node 可跑；provider 的两个测试又要以 provider/hx-failover 为 cwd。
// naive「裸 node 循环跑全套」会对 circuit-breaker 假失败 → 误判套件损坏，或跳过它导致
// 断路器（可靠性关键件）覆盖静默消失。本 runner 统一编排，按各测试所需 flag/cwd 正确调用。
//
// 用法：node scripts/run-all-tests.mjs    （全绿退出 0；任一失败退出 1 并打印失败尾部）
// 约束：只编排、绝不改任何被测脚本；联网 e2e（provider/hx-failover/e2e-rescue.mjs）刻意排除
//       （只收 test-*.mjs）。Windows 上 test-db-maintain 内部 spawn bash，需在 bash 可用的
//       环境（Git Bash）里跑本 runner——与被测脚本自身的既有依赖一致，非本 runner 新增。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = path.dirname(HERE);                            // 仓库根
const NODE = process.execPath;                              // 用当前 node 二进制，避免 PATH 歧义

// ── 收集离线测试任务：{ label, cwd, args } ──────────────────────────────
const jobs = [];

// scripts/test-*.mjs：裸 node 从仓库根跑；唯 circuit-breaker 需原生类型剥离 flag。
for (const f of fs.readdirSync(HERE).filter((n) => /^test-.*\.mjs$/.test(n)).sort()) {
  const needsStrip = /circuit-breaker/.test(f);
  jobs.push({
    label: `scripts/${f}`,
    cwd: ROOT,
    args: [...(needsStrip ? ["--experimental-strip-types"] : []), path.join(HERE, f)],
  });
}

// provider/hx-failover/test-*.mjs：以该目录为 cwd（相对 import dist/src）。
const PROV = path.join(ROOT, "provider", "hx-failover");
if (fs.existsSync(PROV)) {
  for (const f of fs.readdirSync(PROV).filter((n) => /^test-.*\.mjs$/.test(n)).sort()) {
    jobs.push({ label: `provider/hx-failover/${f}`, cwd: PROV, args: [path.join(PROV, f)] });
  }
}

// ── 逐个跑 + 聚合 ──────────────────────────────────────────────────────
const nonEmptyLines = (s) => String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
// 摘要优先取「计数/结论」行（passed/通过/✅/PASS/N⁄M/false=N），避免误取到负向用例的
// 中途日志（如 test-memory-sync 会打印「FAIL: 未知 kind」这类**预期拒绝**行，测试实为通过）。
const summaryLine = (s) => {
  const lines = nonEmptyLines(s);
  const tally = [...lines].reverse().find((l) => /passed|通过|✅|\bPASS\b|\d+\s*\/\s*\d+|false=\d+/i.test(l));
  return tally ?? lines[lines.length - 1] ?? "";
};

let pass = 0;
const failed = [];
console.log(`== 统一离线测试：${jobs.length} 个（node ${process.versions.node}）==`);
for (const j of jobs) {
  const r = spawnSync(NODE, j.args, { cwd: j.cwd, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status === 0) {
    pass++;
    console.log(`  PASS  ${j.label.padEnd(40)} ${summaryLine(out).slice(0, 56)}`);
  } else {
    failed.push(j.label);
    console.log(`  FAIL  ${j.label.padEnd(40)} (exit ${r.status})`);
    nonEmptyLines(out).slice(-12).forEach((l) => console.log(`        ${l}`));
  }
}

console.log(`\n${pass}/${jobs.length} 通过${failed.length ? `；失败：${failed.join(", ")}` : "（全绿）"}`);
process.exit(failed.length ? 1 : 0);
