#!/usr/bin/env node
// kilo-memory-mcp: v3.0 standby channel for the memory module
// Main channel (v2.5) = bash + sqlite3 CLI
// This file is the MCP server; tools are exported for direct unit testing.
// Activation: set `mcp.memory.enabled = true` in kilo.json (manual, conservative).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(os.homedir(), '.config', 'kilo-data', 'memory.db');
const CONTRACT_PATH = path.resolve(__dirname, '..', '..', 'contracts', 'health_check.sql');

const SERVER_NAME = 'kilo-memory';
const SERVER_VERSION = '3.0.0';

// ============================================================
// Database (lazy singleton)
// ============================================================
let _db = null;

function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`memory.db not found at ${DB_PATH}`);
  }
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  return _db;
}

export function closeDb() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

// ============================================================
// Helpers
// ============================================================
const ISO = () => new Date().toISOString();

function nowIso() {
  return new Date().toISOString();
}

function asJsonString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;          // already a JSON string
  return JSON.stringify(v);
}

// ============================================================
// FTS5 query helper (node:sqlite in Node 22.14 has no FTS5 module;
// fall back to LIKE on fact_store/failure_db directly.)
// ============================================================
function runFtsOrLike({ ftsTable, sourceTable, matchCols, keywords, whereSql, whereParams, orderBy, limit }) {
  const db = getDb();
  // Build FTS attempt
  const ftsCols = matchCols.join(', ');
  const ftsSql = `
    SELECT s.fact_id AS _id, NULL AS _f
    FROM ${ftsTable} fts
    JOIN ${sourceTable} s ON s.fact_id = fts.fact_id OR s.failure_id = fts.failure_id
    WHERE ${ftsTable} MATCH ?
  `;
  try {
    const rows = db.prepare(ftsSql).all(keywords);
    if (rows.length === 0) {
      // FTS empty result is valid; return empty
      return { rows: [], _fallback: false };
    }
    // Re-select full columns
    const ids = rows.map(r => r._id);
    const placeholders = ids.map(() => '?').join(',');
    return { rows, _fallback: false };
  } catch (e) {
    // FTS5 unavailable / parse error → LIKE fallback
    const likeClauses = matchCols.map(c => `s.${c} LIKE ?`).join(' OR ');
    const likeParams = matchCols.map(() => `%${keywords}%`);
    const sql = `
      SELECT s.*, 1 AS _fallback
      FROM ${sourceTable} s
      WHERE (${likeClauses})
    `;
    return { rows: db.prepare(sql).all(...likeParams), _fallback: true };
  }
}

// ============================================================
// Tool 1: query_facts (M1 injection)
// ============================================================
export function queryFacts({ keywords, category, limit = 5 } = {}) {
  if (typeof keywords !== 'string' || keywords.length === 0) {
    throw new Error('keywords must be a non-empty string');
  }
  const db = getDb();
  const cap = Math.max(1, Math.min(50, Number(limit) || 5));

  // Sanitize: FTS5 MATCH has its own syntax; if keywords contain FTS5 operators
  // they can throw. We attempt MATCH first; on failure use LIKE.
  const params = [];
  let ftsSql, fallbackSql, fallbackParams;

  if (category) {
    ftsSql = `
      SELECT f.fact_id, f.category, f.trigger, f.action, f.confidence, f.hit_count, f.helpful_rate
      FROM fact_fts fts
      JOIN fact_store f ON f.fact_id = fts.fact_id
      WHERE fact_fts MATCH ?
        AND f.archived = 0
        AND f.category = ?
      ORDER BY f.confidence DESC, f.hit_count DESC
      LIMIT ?
    `;
    ftsSql = ftsSql;
    params.push(keywords, category, cap);
    fallbackSql = `
      SELECT fact_id, category, trigger, action, confidence, hit_count, helpful_rate
      FROM fact_store
      WHERE archived = 0
        AND category = ?
        AND (trigger LIKE ? OR action LIKE ? OR condition LIKE ? OR tags LIKE ?)
      ORDER BY confidence DESC, hit_count DESC
      LIMIT ?
    `;
    fallbackParams = [category, `%${keywords}%`, `%${keywords}%`, `%${keywords}%`, `%${keywords}%`, cap];
  } else {
    ftsSql = `
      SELECT f.fact_id, f.category, f.trigger, f.action, f.confidence, f.hit_count, f.helpful_rate
      FROM fact_fts fts
      JOIN fact_store f ON f.fact_id = fts.fact_id
      WHERE fact_fts MATCH ?
        AND f.archived = 0
      ORDER BY f.confidence DESC, f.hit_count DESC
      LIMIT ?
    `;
    params.push(keywords, cap);
    fallbackSql = `
      SELECT fact_id, category, trigger, action, confidence, hit_count, helpful_rate
      FROM fact_store
      WHERE archived = 0
        AND (trigger LIKE ? OR action LIKE ? OR condition LIKE ? OR tags LIKE ?)
      ORDER BY confidence DESC, hit_count DESC
      LIMIT ?
    `;
    fallbackParams = [`%${keywords}%`, `%${keywords}%`, `%${keywords}%`, `%${keywords}%`, cap];
  }

  try {
    const facts = db.prepare(ftsSql).all(...params);
    return { facts };
  } catch (e) {
    // FTS5 not available or MATCH syntax error → LIKE fallback
    const facts = db.prepare(fallbackSql).all(...fallbackParams);
    return { facts, _fallback: 'LIKE', _fallback_reason: e.message };
  }
}

// ============================================================
// Tool 2: query_failures (M2 backtrack)
// ============================================================
export function queryFailures({ symptom, limit = 3 } = {}) {
  if (typeof symptom !== 'string' || symptom.length === 0) {
    throw new Error('symptom must be a non-empty string');
  }
  const db = getDb();
  const cap = Math.max(1, Math.min(20, Number(limit) || 3));

  let ftsSql, fallbackSql, params, fallbackParams;
  ftsSql = `
    SELECT f.failure_id, f.symptom, f.fix_strategy, f.same_symptom_count, f.verified
    FROM failure_fts fts
    JOIN failure_db f ON f.failure_id = fts.failure_id
    WHERE failure_fts MATCH ?
    ORDER BY f.same_symptom_count DESC, f.created_at DESC
    LIMIT ?
  `;
  params = [symptom, cap];
  fallbackSql = `
    SELECT failure_id, symptom, fix_strategy, same_symptom_count, verified
    FROM failure_db
    WHERE symptom LIKE ? OR fix_strategy LIKE ? OR tags LIKE ?
    ORDER BY same_symptom_count DESC, created_at DESC
    LIMIT ?
  `;
  fallbackParams = [`%${symptom}%`, `%${symptom}%`, `%${symptom}%`, cap];

  try {
    const failures = db.prepare(ftsSql).all(...params);
    return { failures };
  } catch (e) {
    const failures = db.prepare(fallbackSql).all(...fallbackParams);
    return { failures, _fallback: 'LIKE', _fallback_reason: e.message };
  }
}

// ============================================================
// Tool 3: insert_fact (M4 write — dedup + INSERT/UPDATE)
// node:sqlite in Node 22.14 lacks FTS5 module, so the AFTER INSERT/UPDATE
// triggers on fact_store (which write to fact_fts) will throw. We disable
// the FTS5 sync triggers inside a transaction, perform the write, then
// recreate them so the main channel (sqlite3 CLI) sees an unchanged schema.
// ============================================================
export function insertFact({
  fact_id,
  category,
  trigger,
  action,
  condition = null,
  evidence = null,
  tags = null,
  scope = 'global',
  project_name = null,
  confidence,
} = {}) {
  if (!fact_id || typeof fact_id !== 'string') throw new Error('fact_id required');
  if (!['PATTERN', 'ANTIPATTERN', 'RECIPE', 'WARNING'].includes(category)) {
    throw new Error(`category must be PATTERN|ANTIPATTERN|RECIPE|WARNING, got ${category}`);
  }
  if (typeof trigger !== 'string') throw new Error('trigger required');
  if (typeof action !== 'string') throw new Error('action required');
  if (!['global', 'project'].includes(scope)) throw new Error(`scope must be global|project, got ${scope}`);

  const db = getDb();
  const now = nowIso();
  const conf = confidence == null ? 0.5 : Number(confidence);
  if (Number.isNaN(conf) || conf < 0 || conf > 1) throw new Error('confidence must be in [0,1]');

  const tagsJson = asJsonString(tags);
  const evidenceJson = asJsonString(evidence);

  // Detect existence (for INSERT vs UPDATE)
  const existing = db.prepare('SELECT fact_id, confidence, hit_count FROM fact_store WHERE fact_id = ?').get(fact_id);

  // Wrap write in transaction with triggers temporarily dropped/recreated
  db.exec('BEGIN');
  let action_result = 'inserted';
  try {
    db.exec('DROP TRIGGER IF EXISTS fact_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS fact_fts_au');
    db.exec('DROP TRIGGER IF EXISTS fact_fts_ad');

    if (existing) {
      action_result = 'updated';
      db.prepare(`
        UPDATE fact_store
        SET category = ?, trigger = ?, action = ?, condition = ?, evidence = ?, tags = ?,
            scope = ?, project_name = ?, confidence = ?, updated_at = ?
        WHERE fact_id = ?
      `).run(category, trigger, action, condition, evidenceJson, tagsJson,
             scope, project_name, conf, now, fact_id);
    } else {
      db.prepare(`
        INSERT INTO fact_store
          (fact_id, category, trigger, action, condition, evidence, tags,
           confidence, hit_count, helpful_count, misleading_count, helpful_rate,
           scope, project_name, created_at, updated_at, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, ?, ?, 0)
      `).run(fact_id, category, trigger, action, condition, evidenceJson, tagsJson,
             conf, scope, project_name, now, now);
    }

    // Recreate triggers (idempotent; matches init.sql exactly)
    db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
      INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
      VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
      INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
      VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
      INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
      VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
      INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
      VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
    END`);

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    // Best-effort: re-add triggers even on rollback (so the CLI channel stays consistent)
    try {
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
        INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
        VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
        INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
        VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
        INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
        VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
        INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
        VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
      END`);
    } catch {}
    throw e;
  }

  return { fact_id, action: action_result, confidence: conf };
}

// ============================================================
// Tool 4: log_dispatch (M7 write)
// dispatch_log has no FTS5 triggers, so plain transaction is enough.
// ============================================================
export function logDispatch({
  dispatch_id,
  thread_id,
  agent,
  task_summary,
  initial_tier = null,
  final_tier = null,
  review_mode = null,
  model = null,
  status,
  duration_ms = null,
  files_changed = null,
  findings_count = null,
  trigger_fact_ids = null,
  helpful_fact_ids = null,
  misleading_fact_ids = null,
} = {}) {
  if (!dispatch_id) throw new Error('dispatch_id required');
  if (!thread_id) throw new Error('thread_id required');
  if (!agent) throw new Error('agent required');
  if (!task_summary) throw new Error('task_summary required');
  if (!['STARTED', 'DONE', 'DONE_WITH_CONCERNS', 'FAILED', 'BLOCKED', 'TIMEOUT'].includes(status)) {
    throw new Error(`status must be one of STARTED|DONE|DONE_WITH_CONCERNS|FAILED|BLOCKED|TIMEOUT, got ${status}`);
  }

  const db = getDb();
  const now = nowIso();

  const filesJson = asJsonString(files_changed);
  const triggerJson = asJsonString(trigger_fact_ids);
  const helpfulJson = asJsonString(helpful_fact_ids);
  const misleadingJson = asJsonString(misleading_fact_ids);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR REPLACE INTO dispatch_log
        (dispatch_id, thread_id, agent, task_summary, initial_tier, final_tier,
         tier, review_mode, model, status, duration_ms, files_changed, findings_count,
         trigger_fact_ids, helpful_fact_ids, misleading_fact_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dispatch_id, thread_id, agent, task_summary, initial_tier, final_tier,
      final_tier, review_mode, model, status, duration_ms, filesJson, findings_count,
      triggerJson, helpfulJson, misleadingJson, now
    );
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { dispatch_id, inserted: true };
}

// ============================================================
// Tool 5: update_calibration (M8 write — UPSERT with rolling avg)
// ============================================================
export function updateCalibration({
  calibration_id,
  model,
  agent_role,
  task_type,
  outcome,
} = {}) {
  if (!calibration_id) throw new Error('calibration_id required');
  if (!model) throw new Error('model required');
  if (!agent_role) throw new Error('agent_role required');
  if (!task_type) throw new Error('task_type required');
  if (!['DONE', 'DONE_WITH_CONCERNS', 'FAILED'].includes(outcome)) {
    throw new Error(`outcome must be DONE|DONE_WITH_CONCERNS|FAILED, got ${outcome}`);
  }

  const db = getDb();
  const now = nowIso();
  // Treat DONE and DONE_WITH_CONCERNS as success (1.0); FAILED as 0.0
  const score = (outcome === 'DONE' || outcome === 'DONE_WITH_CONCERNS') ? 1.0 : 0.0;

  const existing = db.prepare(
    'SELECT calibration_id, success_rate, sample_count FROM model_calibration WHERE calibration_id = ?'
  ).get(calibration_id);

  let newRate, newCount;
  if (existing) {
    const oldRate = existing.success_rate == null ? score : Number(existing.success_rate);
    const oldCount = Number(existing.sample_count) || 0;
    newCount = oldCount + 1;
    newRate = (oldRate * oldCount + score) / newCount;
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE model_calibration
        SET success_rate = ?, sample_count = ?, last_evaluated_at = ?
        WHERE calibration_id = ?
      `).run(newRate, newCount, now, calibration_id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } else {
    newCount = 1;
    newRate = score;
    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO model_calibration
          (calibration_id, model, agent_role, task_type, success_rate, sample_count, last_evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(calibration_id, model, agent_role, task_type, newRate, newCount, now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  return { calibration_id, success_rate: newRate, sample_count: newCount };
}

// ============================================================
// Tool 6: health_check — execute .kilo/memory/contracts/health_check.sql
// Parses the SQL file (strips CLI directives / comments) and runs each
// SELECT statement. Each statement returns columns:
//   check_name, status ('pass'|'fail'), detail
// ============================================================
export function healthCheck() {
  if (!fs.existsSync(CONTRACT_PATH)) {
    throw new Error(`health_check.sql not found at ${CONTRACT_PATH}`);
  }

  // v3.0.1 修复：node:sqlite 内置不带 FTS5 模块（在 Windows / Node 22.14 上确认），
  // 直接 db.prepare(...).all() 执行 ROW_COUNTS（包含 SELECT COUNT(*) FROM fact_fts）会抛
  // "no such module: fts5"。改为通过 bash + sqlite3 CLI 执行整份 contract —
  // 既符合 .kilo/memory/contracts/health_check.sql §使用方式（CLI）的文档约定，
  // 又避免 node:sqlite FTS5 缺失问题（CLI 端是完整 FTS5 build）。
  // Fallback: 若 sqlite3 CLI 不在 PATH，退回 node:sqlite 但跳过 FTS5 相关语句。
  const checks = [];
  let useCli = true;
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    useCli = false;
  }

  if (useCli) {
    // 执行整份 contract，sqlite3 CLI 按 .headers/.mode/.separator 指令输出
    // 行格式: <check_name>|<pass|fail>|<detail>
    let stdout;
    try {
      // .read 让 sqlite3 CLI 顺序执行整份 contract（含 .headers/.mode/.separator 指令）
      stdout = execFileSync('sqlite3', [DB_PATH, `.read ${CONTRACT_PATH}`], {
        encoding: 'utf8',
        timeout: 10000,
      });
    } catch (e) {
      throw new Error(`sqlite3 CLI 执行 health_check.sql 失败: ${e.message}`);
    }

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--') || line.startsWith('.')) continue;
      // contract 输出格式: <check_name>|<pass|fail>|<detail>
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const [name, status, ...detailParts] = parts;
      const detail = detailParts.join('|'); // detail 本身可能含 |（如 fact_store 列拼接）
      checks.push({ name: name.trim(), pass: status.trim() === 'pass', detail: detail.trim() });
    }
  } else {
    // Fallback: node:sqlite 路径，剥离 FTS5 相关语句以避免 "no such module: fts5"
    const raw = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const statements = raw
      .split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        if (t.startsWith('.')) return false;
        if (t.startsWith('--')) return false;
        if (t.length === 0) return false;
        return true;
      })
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .filter(s => !/FROM\s+fact_fts|FROM\s+failure_fts/i.test(s)); // 跳过 FTS5 语句

    const db = getDb();
    for (const stmt of statements) {
      let name = 'UNKNOWN', status = 'fail', detail = '';
      try {
        const rows = db.prepare(stmt).all();
        if (rows.length === 0) {
          checks.push({ name: 'EMPTY_RESULT', pass: false, detail: 'no rows' });
          continue;
        }
        const row = rows[0];
        if ('check_name' in row) name = row.check_name;
        else if (row[0]) name = String(row[0]);
        if ('status' in row) status = String(row.status);
        else status = String(row[1] || 'fail');
        if ('detail' in row) detail = String(row.detail);
        else detail = String(row[2] || '');
        checks.push({ name, pass: status === 'pass', detail });
      } catch (e) {
        checks.push({ name, pass: false, detail: `query error: ${e.message}` });
      }
    }
  }

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  return {
    checks,
    summary: { total: checks.length, passed, failed },
    _transport: useCli ? 'cli' : 'node:sqlite (FTS5 statements skipped)',
  };
}

// ============================================================
// Tool registry (MCP protocol)
// ============================================================
const TOOL_DEFS = [
  {
    name: 'query_facts',
    description: 'M1 injection: search fact_store by keywords (+optional category). Uses FTS5 MATCH; falls back to LIKE on FTS5 failure (e.g. when node:sqlite lacks FTS5).',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'FTS5 MATCH keywords (e.g. "Windows", "BOM")' },
        category: { type: 'string', enum: ['PATTERN', 'ANTIPATTERN', 'RECIPE', 'WARNING'] },
        limit: { type: 'number', default: 5, description: 'Max facts to return (1-50)' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'query_failures',
    description: 'M2 backtrack: search failure_db by symptom. FTS5 MATCH with LIKE fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        symptom: { type: 'string', description: 'Failure symptom / keyword' },
        limit: { type: 'number', default: 3, description: 'Max failures to return (1-20)' },
      },
      required: ['symptom'],
    },
  },
  {
    name: 'insert_fact',
    description: 'M4 write: dedup INSERT/UPDATE on fact_store. Temporarily disables FTS5 sync triggers (node:sqlite lacks FTS5 in Node 22.14) and recreates them on commit, so the main sqlite3 CLI channel sees unchanged schema.',
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: { type: 'string' },
        category: { type: 'string', enum: ['PATTERN', 'ANTIPATTERN', 'RECIPE', 'WARNING'] },
        trigger: { type: 'string' },
        action: { type: 'string' },
        condition: { type: 'string' },
        evidence: { description: 'JSON array string or array' },
        tags: { description: 'JSON array string or array' },
        scope: { type: 'string', enum: ['global', 'project'], default: 'global' },
        project_name: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      },
      required: ['fact_id', 'category', 'trigger', 'action'],
    },
  },
  {
    name: 'log_dispatch',
    description: 'M7 write: INSERT OR REPLACE into dispatch_log.',
    inputSchema: {
      type: 'object',
      properties: {
        dispatch_id: { type: 'string' },
        thread_id: { type: 'string' },
        agent: { type: 'string' },
        task_summary: { type: 'string' },
        initial_tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
        final_tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
        review_mode: { type: 'string', enum: ['none', 'lightweight', 'full'] },
        model: { type: 'string' },
        status: { type: 'string', enum: ['STARTED', 'DONE', 'DONE_WITH_CONCERNS', 'FAILED', 'BLOCKED', 'TIMEOUT'] },
        duration_ms: { type: 'number' },
        files_changed: { description: 'JSON array string or array' },
        findings_count: { type: 'number' },
        trigger_fact_ids: { description: 'JSON array string or array' },
        helpful_fact_ids: { description: 'JSON array string or array' },
        misleading_fact_ids: { description: 'JSON array string or array' },
      },
      required: ['dispatch_id', 'thread_id', 'agent', 'task_summary', 'status'],
    },
  },
  {
    name: 'update_calibration',
    description: 'M8 write: UPSERT model_calibration with rolling-average success_rate.',
    inputSchema: {
      type: 'object',
      properties: {
        calibration_id: { type: 'string' },
        model: { type: 'string' },
        agent_role: { type: 'string' },
        task_type: { type: 'string' },
        outcome: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'FAILED'] },
      },
      required: ['calibration_id', 'model', 'agent_role', 'task_type', 'outcome'],
    },
  },
  {
    name: 'health_check',
    description: 'Execute .kilo/memory/contracts/health_check.sql and return per-check pass/fail with summary.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'query_facts': return queryFacts(args || {});
    case 'query_failures': return queryFailures(args || {});
    case 'insert_fact': return insertFact(args || {});
    case 'log_dispatch': return logDispatch(args || {});
    case 'update_calibration': return updateCalibration(args || {});
    case 'health_check': return healthCheck();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// MCP server entrypoint (only when run as main module)
// ============================================================
async function startServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler('tools/call', async (req) => {
    const { name, arguments: args } = req.params || {};
    try {
      const result = await handleToolCall(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(e.message || e) }) }],
        isError: true,
      };
    }
  });

  // Graceful shutdown
  const shutdown = (sig) => {
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  // Keep process alive
  process.stdin.resume();
}

const isMainModule = process.argv[1] && (
  process.argv[1] === __filename ||
  path.resolve(process.argv[1]) === path.resolve(__filename) ||
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

if (isMainModule) {
  startServer().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('memory-mcp fatal:', e);
    closeDb();
    process.exit(1);
  });
}
