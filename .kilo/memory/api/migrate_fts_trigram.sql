-- ============================================================
-- FTS5 分词器迁移：unicode61 → trigram（v2.6 / 中文检索修复）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_fts_trigram.sql
-- 执行时机：v2.4/v2.5 → v2.6 升级，fact_fts / failure_fts 已存在且为 unicode61 分词
--
-- 背景：unicode61 把连续 CJK 字符视为单一 token，中文关键词（如「编码」）MATCH 0 命中，
--       检索实际只能靠英文 tags 支撑。trigram 分词支持任意 ≥3 字符子串匹配（含 CJK）。
--       约束：MATCH 查询词必须 ≥3 字符；2 字中文词需扩展为 ≥3 字词组或退化 LIKE。
--       （详见 policy/query_strategy.md §1 query B 注释）
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_fts_trigram.sql
--
-- 幂等性：DROP IF EXISTS + CREATE + rebuild，可重复执行无副作用
-- 前置：无需备份源表（fact_fts / failure_fts 为镜像表，rebuild 自源表重建）
-- 业务规则：policy/query_strategy.md §1 query B MATCH 语法
-- ============================================================

-- 1. 先删触发器（引用旧虚表，不先删会阻止 DROP）
DROP TRIGGER IF EXISTS fact_fts_ai;
DROP TRIGGER IF EXISTS fact_fts_ad;
DROP TRIGGER IF EXISTS fact_fts_au;
DROP TRIGGER IF EXISTS failure_fts_ai;
DROP TRIGGER IF EXISTS failure_fts_ad;
DROP TRIGGER IF EXISTS failure_fts_au;

-- 2. 删旧虚表（unicode61）
DROP TABLE IF EXISTS fact_fts;
DROP TABLE IF EXISTS failure_fts;

-- 3. 建新虚表（trigram）
CREATE VIRTUAL TABLE fact_fts USING fts5(
    fact_id UNINDEXED,
    trigger,
    action,
    condition,
    tags,
    content='fact_store',
    tokenize='trigram'
);
CREATE VIRTUAL TABLE failure_fts USING fts5(
    failure_id UNINDEXED,
    symptom,
    fix_strategy,
    fix_location,
    tags,
    content='failure_db',
    tokenize='trigram'
);

-- 4. 重建触发器（与 schema/init.sql §10 保持一致）
CREATE TRIGGER fact_fts_ai AFTER INSERT ON fact_store BEGIN
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;
CREATE TRIGGER fact_fts_ad AFTER DELETE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
END;
CREATE TRIGGER fact_fts_au AFTER UPDATE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;
CREATE TRIGGER failure_fts_ai AFTER INSERT ON failure_db BEGIN
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;
CREATE TRIGGER failure_fts_ad AFTER DELETE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
END;
CREATE TRIGGER failure_fts_au AFTER UPDATE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;

-- 5. 全量重建索引（FTS5 外部内容表 rebuild 命令，自源表重填）
INSERT INTO fact_fts(fact_fts) VALUES('rebuild');
INSERT INTO failure_fts(failure_fts) VALUES('rebuild');

-- 6. 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('fact_fts','failure_fts')) AS fts_present,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'fact_fts_%') AS fact_triggers,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'failure_fts_%') AS failure_triggers,
    (SELECT COUNT(*) FROM fact_fts) AS fts_rows,
    (SELECT COUNT(*) FROM fact_store) AS source_rows,
    (SELECT COUNT(*) FROM fact_fts WHERE fact_fts MATCH '"解析失败"') AS cjk_match_probe;
-- 期望：fts_present=2, fact_triggers=3, failure_triggers=3, fts_rows == source_rows
-- cjk_match_probe：trigram 生效后 ≥1（AP-001 trigger 含「解析失败」）；unicode61 下为 0
-- 注：trigram 查询词需 ≥3 字符，故用 4 字词「解析失败」做探针
