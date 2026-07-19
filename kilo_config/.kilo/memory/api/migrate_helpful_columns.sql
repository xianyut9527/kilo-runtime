-- ============================================================
-- helpful_rate 反馈字段迁移（v2.4 / #13）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_helpful_columns.sql
-- 执行时机：v2.3 → v2.4 升级，fact_store 表加 3 列（helpful_count / misleading_count / helpful_rate）
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_helpful_columns.sql
--
-- 幂等性：SQLite 没有 ADD COLUMN IF NOT EXISTS；shell 包装器必须容忍 "duplicate column name" 错误
-- 推荐包装（Linux/macOS bash）：
--   sqlite3 memory.db < migrate_helpful_columns.sql 2>&1 | grep -v 'duplicate column name' || true
--
-- 新增列语义：
--   - helpful_count INTEGER：累计 [memory:helpful=X] 反馈次数
--   - misleading_count INTEGER：累计 [memory:misleading=X] 反馈次数
--   - helpful_rate REAL：helpful / (helpful+misleading)；NULL = 暂无反馈
-- 业务规则：policy/m6_validation.md §3；check17 无对应硬检查（运行时聚合）
-- ============================================================

ALTER TABLE fact_store ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fact_store ADD COLUMN misleading_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fact_store ADD COLUMN helpful_rate REAL;

CREATE INDEX IF NOT EXISTS idx_fact_helpful_rate ON fact_store(helpful_rate DESC);

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'helpful_count') AS helpful_col_present,
    (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'misleading_count') AS misleading_col_present,
    (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'helpful_rate') AS rate_col_present;
-- 期望：3/3 = 1