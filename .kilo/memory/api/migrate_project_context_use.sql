-- ============================================================
-- project_context use_count / last_used_at 列迁移（v2.4 / #2 动态化）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_project_context_use.sql
-- 执行时机：v2.3 → v2.4 升级，project_context 表加 2 列追踪使用频次
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_project_context_use.sql
--
-- 幂等性：ADD COLUMN 容忍 "duplicate column name"；CREATE INDEX IF NOT EXISTS 可重跑
--
-- 新增列语义：
--   - use_count INTEGER：累计被 M1 query A 注入的次数
--   - last_used_at TEXT：最近一次注入时间；NULL = 从未注入
-- 索引：idx_project_use_count（按 use_count DESC 排序的动态化视图入口）
-- 业务规则：policy/query_strategy.md §1 query A 排序变化（v2.4 加入 use_count）
-- ============================================================

ALTER TABLE project_context ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_context ADD COLUMN last_used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_project_use_count ON project_context(use_count DESC);

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('project_context') WHERE name = 'use_count') AS use_count_col,
    (SELECT COUNT(*) FROM pragma_table_info('project_context') WHERE name = 'last_used_at') AS last_used_col,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_project_use_count') AS idx_present;
-- 期望：3/3 = 1