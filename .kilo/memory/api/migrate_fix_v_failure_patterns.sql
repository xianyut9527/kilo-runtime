-- ============================================================
-- v_failure_patterns 视图修复（v2.6.1 — GROUP_CONCAT DISTINCT 语法错误）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_fix_v_failure_patterns.sql
-- 执行时机：v2.6 → v2.6.1 升级（v2.4 起部署的 DB 中该视图定义非法，查询必报错）
--
-- 背景：SQLite 中 DISTINCT 聚合函数只接受 1 个参数，
--       `GROUP_CONCAT(DISTINCT fix_strategy, ' | ')` 执行时报
--       "DISTINCT aggregates must have exactly one argument"。
--       因 failure_db 长期 0 行、REQUIRED_VIEWS_MISSING 仅检查存在性，该缺陷潜伏至 v2.6 终扫发现。
--       修复：去掉自定义分隔符（DISTINCT 与 separator 不可兼得）。
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_fix_v_failure_patterns.sql
--
-- 幂等性：DROP VIEW IF EXISTS + CREATE VIEW，可重复执行无副作用
-- 业务规则：policy/failure_recorder.md §关联查询（SELECT * FROM v_failure_patterns）
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS v_failure_patterns;

CREATE VIEW v_failure_patterns AS
SELECT
    symptom,
    root_cause_level,
    COUNT(*) as occurrence,
    AVG(same_symptom_count) as avg_recurrence,
    GROUP_CONCAT(DISTINCT fix_strategy) as strategies
FROM failure_db
WHERE verified = 1
GROUP BY symptom, root_cause_level
HAVING occurrence >= 2
ORDER BY occurrence DESC;

COMMIT;

-- 验证：视图可查询即修复成功（行数取决于 failure_db 数据量，0 亦正常）
.headers on
.mode column
SELECT COUNT(*) AS queryable_rows FROM v_failure_patterns;
