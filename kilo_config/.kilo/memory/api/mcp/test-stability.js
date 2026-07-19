#!/usr/bin/env node
// test-stability.js: memory stability test
// Runs 200 iterations of queryFacts and asserts heapUsed growth < 50MB
// Usage: node --expose-gc test-stability.js
import { queryFacts, closeDb } from './memory-mcp.js';

const ITERATIONS = 200;
const MAX_GROWTH_MB = 50;

if (global.gc) {
  global.gc();
} else {
  console.warn('⚠ --expose-gc 未启用；建议用 `node --expose-gc test-stability.js` 获得更准确结果');
}

const startMem = process.memoryUsage().heapUsed;
console.log(`起始 heapUsed: ${(startMem / 1024 / 1024).toFixed(2)} MB`);
console.log(`运行 ${ITERATIONS} 次 queryFacts ...`);

const samples = [];
for (let i = 0; i < ITERATIONS; i++) {
  queryFacts({ keywords: 'Windows', limit: 5 });
  queryFacts({ keywords: 'BOM', limit: 3 });
  if (i % 50 === 0) {
    if (global.gc) global.gc();
    const current = process.memoryUsage().heapUsed;
    const delta = (current - startMem) / 1024 / 1024;
    samples.push({ iter: i, heapMB: current / 1024 / 1024, deltaMB: delta });
    console.log(`  迭代 ${String(i).padStart(3)}: heap=${(current/1024/1024).toFixed(2)}MB, 增长=${delta.toFixed(2)}MB`);
  }
}

if (global.gc) global.gc();
const endMem = process.memoryUsage().heapUsed;
const totalDelta = (endMem - startMem) / 1024 / 1024;
console.log(`\n最终 heapUsed: ${(endMem / 1024 / 1024).toFixed(2)} MB`);
console.log(`200 次查询（实际 ${ITERATIONS * 2} 次调用）后增长: ${totalDelta.toFixed(2)} MB`);

if (totalDelta > MAX_GROWTH_MB) {
  console.error(`\n❌ 内存泄漏嫌疑: 增长 ${totalDelta.toFixed(2)}MB > 阈值 ${MAX_GROWTH_MB}MB`);
  process.exit(1);
} else {
  console.log(`✓ 内存稳定: 增长 ${totalDelta.toFixed(2)}MB < 阈值 ${MAX_GROWTH_MB}MB`);
  process.exit(0);
}
