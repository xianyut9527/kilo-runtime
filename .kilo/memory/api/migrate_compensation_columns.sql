-- ============================================================
-- model_calibration 补偿 prompt 消费追踪（v2.3 / #8）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_compensation_columns.sql
-- 执行时机：v2.2 → v2.3 升级，model_calibration 表加 2 列追踪补偿 prompt 消费
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_compensation_columns.sql
--
-- 幂等性：SQLite 没有 ADD COLUMN IF NOT EXISTS；shell 包装器必须容忍 "duplicate column name" 错误
-- 推荐包装（同 migrate_add_scope_column.sql）
--
-- 新增列语义：
--   - compensation_prompt_set_at TEXT：补偿 prompt 写入时间；NULL = 从未设置
--   - compensation_prompt_consumed_count INTEGER：累计被 dispatch 消费的次数（每次 M7 dispatch 收尾 +1）
-- 业务规则：policy/model_calibration.md §校准效果验证；check17 COMPENSATION_PROMPT_STALE 校验
-- ============================================================

ALTER TABLE model_calibration ADD COLUMN compensation_prompt_set_at TEXT;
ALTER TABLE model_calibration ADD COLUMN compensation_prompt_consumed_count INTEGER NOT NULL DEFAULT 0;

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('model_calibration') WHERE name = 'compensation_prompt_set_at') AS set_at_col_present,
    (SELECT COUNT(*) FROM pragma_table_info('model_calibration') WHERE name = 'compensation_prompt_consumed_count') AS consumed_col_present;
-- 期望：set_at_col_present=1, consumed_col_present=1