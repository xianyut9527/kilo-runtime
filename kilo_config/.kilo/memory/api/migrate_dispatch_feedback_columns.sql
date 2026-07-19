-- ============================================================
-- dispatch_log 反馈结构化列迁移（v2.4 / #13）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_dispatch_feedback_columns.sql
-- 执行时机：v2.3 → v2.4 升级，dispatch_log 表加 3 列结构化 M6 反馈
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_dispatch_feedback_columns.sql
--
-- 幂等性：ADD COLUMN 容忍 "duplicate column name"
--
-- 新增列语义：
--   - trigger_fact_ids TEXT：本次 dispatch 涉及的 fact_id（JSON 数组；M3 注入引用收集）
--   - helpful_fact_ids TEXT：M6 [memory:helpful=A,B] 反馈收集
--   - misleading_fact_ids TEXT：M6 [memory:misleading=X] 反馈收集
-- 业务规则：policy/m6_validation.md §3；policy/dispatch_recorder.md §v2.4 M7 INSERT 模板
-- ============================================================

ALTER TABLE dispatch_log ADD COLUMN trigger_fact_ids TEXT;
ALTER TABLE dispatch_log ADD COLUMN helpful_fact_ids TEXT;
ALTER TABLE dispatch_log ADD COLUMN misleading_fact_ids TEXT;

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('dispatch_log') WHERE name = 'trigger_fact_ids') AS trigger_col,
    (SELECT COUNT(*) FROM pragma_table_info('dispatch_log') WHERE name = 'helpful_fact_ids') AS helpful_col,
    (SELECT COUNT(*) FROM pragma_table_info('dispatch_log') WHERE name = 'misleading_fact_ids') AS misleading_col;
-- 期望：3/3 = 1