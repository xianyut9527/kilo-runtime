-- ============================================================
-- 跨项目隔离：fact_store 表新增 scope / project_name 列（v2.3 / #5）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_add_scope_column.sql
-- 执行时机：v2.2 → v2.3 升级，schema/init.sql 已直接为新 DB 加列，但旧 DB 需手动 ALTER
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_add_scope_column.sql
--
-- 幂等性：SQLite 没有 ADD COLUMN IF NOT EXISTS；shell 包装器必须容忍 "duplicate column name" 错误
-- 推荐包装（Linux/macOS bash）：
--   sqlite3 memory.db < migrate_add_scope_column.sql 2>&1 | grep -v 'duplicate column name' || true
-- 推荐包装（Windows PowerShell）：
--   sqlite3 memory.db < migrate_add_scope_column.sql 2>&1 | Where-Object { $_ -notmatch 'duplicate column name' }
--
-- 副作用：
--   - 已有 fact_store 行 scope 自动填充 'global'（列 DEFAULT）
--   - project_name 列允许 NULL（scope='global' 时为 NULL 是合法状态）
--   - idx_fact_scope 复合索引 (scope, project_name) 创建（CREATE INDEX IF NOT EXISTS 可重跑）
-- 详见 policy/query_strategy.md §1 query B scope 过滤规则 + policy/fact_dedup.md §提取模板
-- ============================================================

-- 1. 加 scope 列（含 CHECK 约束）
ALTER TABLE fact_store ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project'));

-- 2. 加 project_name 列（scope='global' 时 NULL；scope='project' 时为稳定项目标识）
ALTER TABLE fact_store ADD COLUMN project_name TEXT;

-- 3. 加复合索引（query_strategy.md §1 query B scope 过滤加速）
CREATE INDEX IF NOT EXISTS idx_fact_scope ON fact_store(scope, project_name);

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'scope') AS scope_col_present,
    (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'project_name') AS project_name_col_present,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_fact_scope') AS idx_present,
    (SELECT COUNT(*) FROM fact_store WHERE scope = 'global') AS global_rows,
    (SELECT COUNT(*) FROM fact_store WHERE scope = 'project') AS project_rows;
-- 期望：scope_col_present=1, project_name_col_present=1, idx_present=1, global_rows>=14, project_rows=0