-- ============================================================
-- failure_db scope 列 + FTS5 虚表迁移（v2.4 / #15 + / #5 镜像）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_failure_scope_and_fts.sql
-- 执行时机：v2.3 → v2.4 升级，failure_db 表加 2 列 + 1 FTS5 虚表 + 3 触发器
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_failure_scope_and_fts.sql
--
-- 幂等性：ALTER TABLE 部分容忍 "duplicate column name"；CREATE VIRTUAL TABLE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS 可重跑
--
-- 新增列语义：
--   - scope TEXT（'global'/'project'）：镜像 fact_store，跨项目隔离
--   - project_name TEXT：scope='global' 时 NULL
-- FTS5 虚表：failure_fts（与 fact_fts 同构，tokenize='unicode61'）
-- 触发器：failure_fts_ai / ad / au（自动维护 FTS 索引）
-- 业务规则：policy/failure_recorder.md §v2.4；policy/query_strategy.md §3 MATCH 语法
-- ============================================================

-- 1. scope / project_name 列
ALTER TABLE failure_db ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project'));
ALTER TABLE failure_db ADD COLUMN project_name TEXT;

CREATE INDEX IF NOT EXISTS idx_failure_scope ON failure_db(scope, project_name);

-- 2. FTS5 虚表
CREATE VIRTUAL TABLE IF NOT EXISTS failure_fts USING fts5(
    failure_id UNINDEXED,
    symptom,
    fix_strategy,
    fix_location,
    tags,
    content='failure_db',
    tokenize='unicode61'
);

-- 3. FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS failure_fts_ai AFTER INSERT ON failure_db BEGIN
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS failure_fts_ad AFTER DELETE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS failure_fts_au AFTER UPDATE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('failure_db') WHERE name = 'scope') AS scope_col,
    (SELECT COUNT(*) FROM pragma_table_info('failure_db') WHERE name = 'project_name') AS project_col,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='failure_fts') AS fts_present,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'failure_fts_%') AS trigger_count;
-- 期望：scope_col=1, project_col=1, fts_present=1, trigger_count=3