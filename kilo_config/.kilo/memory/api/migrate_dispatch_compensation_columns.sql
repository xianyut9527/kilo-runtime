-- ============================================================
-- dispatch_log 补偿 prompt 消费记录（v2.3 / #8）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_dispatch_compensation_columns.sql
-- 执行时机：v2.2 → v2.3 升级，dispatch_log 表加 2 列记录本次 dispatch 是否消费补偿 prompt
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_dispatch_compensation_columns.sql
--
-- 幂等性：同 migrate_compensation_columns.sql（容忍 "duplicate column name" 错误）
--
-- 新增列语义：
--   - compensation_prompt_used INTEGER (0/1 CHECK)：本次 dispatch 是否实际消费了补偿 prompt
--   - compensation_calibration_id TEXT：消费的 calibration_id（用于反查 model_calibration）
-- 业务规则：policy/dispatch_recorder.md §写入流程；每次 M7 INSERT 必填这两个字段
-- ============================================================

ALTER TABLE dispatch_log ADD COLUMN compensation_prompt_used INTEGER NOT NULL DEFAULT 0 CHECK(compensation_prompt_used IN (0, 1));
ALTER TABLE dispatch_log ADD COLUMN compensation_calibration_id TEXT;

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('dispatch_log') WHERE name = 'compensation_prompt_used') AS used_col_present,
    (SELECT COUNT(*) FROM pragma_table_info('dispatch_log') WHERE name = 'compensation_calibration_id') AS cal_id_col_present;
-- 期望：used_col_present=1, cal_id_col_present=1