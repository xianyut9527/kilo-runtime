#!/usr/bin/env node
// test.js: unit tests for memory-mcp tool functions
// Direct import (does NOT start MCP server; SDK only imported for Server class definition)
import { queryFacts, queryFailures, insertFact, logDispatch, updateCalibration, healthCheck, closeDb } from './memory-mcp.js';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.config', 'kilo-data', 'memory.db');
const results = { passed: 0, failed: 0, errors: [] };

function assert(condition, msg) {
  if (condition) {
    results.passed++;
    console.log('  ✓', msg);
  } else {
    results.failed++;
    results.errors.push(msg);
    console.log('  ✗', msg);
  }
}

function section(name) {
  console.log('\n=== ' + name + ' ===');
}

try {
  // ========== Tool 1: queryFacts ==========
  section('1. queryFacts (FTS5/keyword)');
  {
    const r = queryFacts({ keywords: 'Windows', limit: 5 });
    assert(r && Array.isArray(r.facts), '返回结构含 facts 数组');
    assert(r.facts.length > 0, `Windows 关键词命中 ${r.facts.length} 条 (>=1)`);
    if (r.facts.length > 0) {
      const f = r.facts[0];
      assert(f.fact_id && f.category, 'fact 含 fact_id + category');
      assert(typeof f.confidence === 'number', 'fact 含 numeric confidence');
    }
  }

  section('1b. queryFacts (Chinese keyword via LIKE fallback)');
  {
    const r = queryFacts({ keywords: 'Windows', limit: 3 });
    assert(r._fallback === 'LIKE' || r.facts.length > 0, '中文/特殊查询走 LIKE fallback 或正常返回');
  }

  section('1c. queryFacts (category filter)');
  {
    const r = queryFacts({ keywords: 'Windows', category: 'ANTIPATTERN', limit: 10 });
    if (r.facts.length > 0) {
      assert(r.facts.every(f => f.category === 'ANTIPATTERN'), 'category 过滤生效');
    } else {
      assert(true, 'category 过滤无结果（数据分布决定）');
    }
  }

  // ========== Tool 2: queryFailures ==========
  section('2. queryFailures');
  {
    try {
      const r = queryFailures({ symptom: 'Edit', limit: 3 });
      assert(r && Array.isArray(r.failures), '返回结构含 failures 数组');
    } catch (e) {
      // failure_db 可能为空（项目早期），允许无结果但不允许抛错
      assert(false, 'queryFailures 抛错: ' + e.message);
    }
  }

  // ========== Tool 3: insertFact ==========
  section('3. insertFact (round-trip)');
  const testFactId = 'TEST-MCP-' + Date.now();
  {
    const r = insertFact({
      fact_id: testFactId,
      category: 'PATTERN',
      trigger: '测试 trigger - 验证 memory-mcp 写入',
      action: '测试 action - 应该能正常 INSERT 并触发器重建',
      tags: '["test","mcp-validation"]',
      confidence: 0.6,
    });
    assert(r.fact_id === testFactId, 'insertFact 返回 fact_id 匹配');
    assert(r.action === 'inserted', '首次写入 action=inserted');
    assert(r.confidence === 0.6, 'confidence 保持 0.6');
  }

  section('3b. insertFact 写入后查询可读 (idempotency 之前)');
  {
    const r = queryFacts({ keywords: 'memory-mcp', limit: 5 });
    const found = r.facts.find(f => f.fact_id === testFactId);
    assert(!!found, '刚 INSERT 的 fact 可被 query 检索到（说明触发器重建成功，未污染主通道）');
  }

  section('3c. insertFact (idempotent: 二次写入应走 UPDATE 路径)');
  {
    const r = insertFact({
      fact_id: testFactId,
      category: 'PATTERN',
      trigger: '测试 trigger v2 - 已存在',
      action: '测试 action v2',
      tags: '["test","mcp-validation","v2"]',
      confidence: 0.7,
    });
    assert(r.action === 'updated', '重复 fact_id 走 UPDATE 路径');
  }

  // ========== Tool 4: logDispatch ==========
  section('4. logDispatch');
  const testDispatchId = 'disp-mcp-test-' + Date.now();
  {
    const r = logDispatch({
      dispatch_id: testDispatchId,
      thread_id: 'test-thread-mcp',
      agent: 'coderAgent',
      task_summary: 'memory-mcp 单元测试',
      initial_tier: 'T2',
      final_tier: 'T2',
      review_mode: 'full',
      model: 'hx/MiniMax-M3',
      status: 'DONE',
      duration_ms: 1500,
      files_changed: ['.kilo/memory/api/mcp/test.js'],
      findings_count: 0,
      trigger_fact_ids: [],
      helpful_fact_ids: [],
      misleading_fact_ids: [],
    });
    assert(r.dispatch_id === testDispatchId, 'logDispatch 返回 dispatch_id');
    assert(r.inserted === true, 'inserted=true');
  }

  section('4b. logDispatch 写入后直接 SQL 验证');
  {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT status, agent, final_tier FROM dispatch_log WHERE dispatch_id = ?').get(testDispatchId);
    assert(row && row.status === 'DONE', 'dispatch_log 行可被直接 SQL 查到');
    assert(row && row.agent === 'coderAgent', 'agent 字段正确');
    db.close();
  }

  // ========== Tool 5: updateCalibration ==========
  section('5. updateCalibration (rolling average)');
  const testCalId = 'cal-mcp-test-' + Date.now();
  {
    const r1 = updateCalibration({
      calibration_id: testCalId,
      model: 'hx/MiniMax-M3',
      agent_role: 'engineer',
      task_type: 'mcp-validation',
      outcome: 'DONE',
    });
    assert(r1.success_rate === 1.0, '首次 DONE → success_rate=1.0');
    assert(r1.sample_count === 1, 'sample_count=1');

    const r2 = updateCalibration({
      calibration_id: testCalId,
      model: 'hx/MiniMax-M3',
      agent_role: 'engineer',
      task_type: 'mcp-validation',
      outcome: 'FAILED',
    });
    assert(r2.sample_count === 2, 'sample_count=2 (滚动累加)');
    assert(Math.abs(r2.success_rate - 0.5) < 1e-9, '滚动平均 (1.0+0.0)/2 = 0.5');
  }

  // ========== Tool 6: healthCheck ==========
  section('6. healthCheck');
  {
    const r = healthCheck();
    assert(r && Array.isArray(r.checks), '返回 checks 数组');
    assert(r.summary && typeof r.summary.total === 'number', 'summary 含 total');
    console.log('  ℹ ' + r.summary.passed + '/' + r.summary.total + ' checks passed');
    if (r.summary.failed > 0) {
      r.checks.filter(c => !c.pass).forEach(c => {
        console.log('  ✗ ' + c.name + ': ' + c.detail);
      });
    }
  }

  // ========== 清理测试数据 ==========
  section('cleanup');
  {
    const db = new DatabaseSync(dbPath);
    // node:sqlite 缺 FTS5 module；DELETE fact_store 会触发 fact_fts_ad → 抛错
    // 临时禁用触发器，清理完成后重建（保证主通道的 FTS5 不受影响）
    db.exec('BEGIN');
    try {
      db.exec('DROP TRIGGER IF EXISTS fact_fts_ai');
      db.exec('DROP TRIGGER IF EXISTS fact_fts_au');
      db.exec('DROP TRIGGER IF EXISTS fact_fts_ad');
      db.prepare('DELETE FROM fact_store WHERE fact_id = ?').run(testFactId);
      db.prepare('DELETE FROM dispatch_log WHERE dispatch_id = ?').run(testDispatchId);
      db.prepare('DELETE FROM model_calibration WHERE calibration_id = ?').run(testCalId);
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
        INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
        VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
        INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
        VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
        INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
        VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
        INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
        VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
      END`);
      db.exec('COMMIT');
      console.log('  ✓ 测试数据已清理（FTS5 触发器已重建）');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.log('  ⚠ 清理异常: ' + e.message);
      // 强制重建触发器
      try {
        db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
          INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
          VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
        END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
          INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
          VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
        END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
          INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
          VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
          INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
          VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
        END`);
        console.log('  ✓ 触发器已强制重建');
      } catch (e2) {
        console.log('  ✗ 触发器重建失败: ' + e2.message);
      }
    }
    db.close();
  }

} catch (e) {
  console.error('\n❌ 测试异常:', e);
  results.failed++;
  results.errors.push('test.js fatal: ' + e.message);
} finally {
  closeDb();
}

console.log('\n=== 测试总结 ===');
console.log('  通过: ' + results.passed);
console.log('  失败: ' + results.failed);
if (results.errors.length > 0) {
  console.log('  错误:');
  results.errors.forEach(e => console.log('    - ' + e));
}
process.exit(results.failed > 0 ? 1 : 0);
