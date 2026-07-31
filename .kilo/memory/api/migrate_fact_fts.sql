-- ============================================================
-- fact_store FTS5 虚表迁移（v2.4 / #5 全文检索）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_fact_fts.sql
-- 执行时机：v2.3 → v2.4 升级，fact_store 已有数据但 fact_fts 虚表缺失
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_fact_fts.sql
--
-- 幂等性：CREATE VIRTUAL TABLE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS 可重跑
--
-- 内容：
--   1. fact_fts 虚表（FTS5 全文索引；v2.6 起 tokenize='trigram'，修复中文 MATCH；
--      已部署 unicode61 的 DB 请改用 api/migrate_fts_trigram.sql 重建）
--   2. 3 个触发器（ai / ad / au）维持虚表与源表同步
--   3. 回填：INSERT 已有 fact 到 fact_fts（触发器只对新 INSERT 生效）
-- 业务规则：policy/query_strategy.md §1 query B MATCH 语法
-- ============================================================

-- 1. FTS5 虚表
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(
    fact_id UNINDEXED,
    trigger,
    action,
    condition,
    tags,
    content='fact_store',
    tokenize='trigram'
);

-- 2. FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;

-- 3. 回填：把已有 fact_store 行同步到 fact_fts（一次性）
INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
SELECT rowid, fact_id, trigger, action, COALESCE(condition, ''), COALESCE(tags, '')
FROM fact_store
WHERE NOT EXISTS (SELECT 1 FROM fact_fts WHERE fact_fts.rowid = fact_store.rowid);

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fact_fts') AS fts_present,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'fact_fts_%') AS trigger_count,
    (SELECT COUNT(*) FROM fact_fts) AS fts_rows,
    (SELECT COUNT(*) FROM fact_store) AS source_rows;
-- 期望：fts_present=1, trigger_count=3, fts_rows == source_rows（每次回填幂等）