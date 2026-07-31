-- ============================================================
-- project_context scope / project_name 列迁移（v2.7 — 跨项目隔离，对齐 fact_store v2.3 / #5）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_project_context_scope.sql
-- 执行时机：v2.6.x → v2.7 升级，project_context 表加 2 列实现跨项目隔离
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_project_context_scope.sql
--
-- 幂等性：ADD COLUMN 容忍 "duplicate column name"；CREATE INDEX IF NOT EXISTS 可重跑；
--        UPDATE 语句带 WHERE 条件，重复执行结果一致
--
-- 新增列语义（对齐 fact_store.scope / project_name）：
--   - scope TEXT：'global'（默认，任意项目注入）或 'project'（仅 project_name 匹配时注入）
--   - project_name TEXT：scope='global' 时 NULL；scope='project' 时为 KILO_PROJECT_NAME
-- 索引：idx_project_scope（复合索引，对齐 idx_fact_scope）
--
-- v2.7 现有 8 条种子的 scope 重新分类：
--   global（4 条）：PC-004 跳步即停 / PC-005 单元闭环 / PC-006 review_mode / PC-008 临时文件
--   project=kilo_config（4 条）：PC-001 七层架构 / PC-002 kilo.json 配置 / PC-003 sqlite 优先 / PC-007 三文件同步
--
-- 升级后必须重跑 api/seed_project_context.sql（其末尾 UPDATE 段回填 scope 值）
-- 业务规则：policy/query_strategy.md §1 query A 加 scope 过滤（对齐 query B/C）
-- ============================================================

-- Step 1: 加列（ALTER TABLE ADD COLUMN 无 IF NOT EXISTS，重复执行会报 "duplicate column name"，
--         shell 包装器必须容忍该错误；幂等性靠 schema 检查保证）
ALTER TABLE project_context ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project'));
ALTER TABLE project_context ADD COLUMN project_name TEXT;

-- Step 2: 复合索引（对齐 idx_fact_scope）
CREATE INDEX IF NOT EXISTS idx_project_scope ON project_context(scope, project_name);

-- Step 3: 回填现有 8 条种子的 scope 值（幂等 UPDATE）
-- v2.7 前 8 条种子全为默认 global；本段将 4 条 kilo_config 专属的改为 project
UPDATE project_context
SET scope='project', project_name='kilo_config'
WHERE context_id IN ('PC-001','PC-002','PC-003','PC-007')
  AND scope='global';

-- PC-004/005/006/008 保持 global（默认值，无需 UPDATE；显式确认 project_name 为 NULL）
UPDATE project_context
SET project_name=NULL
WHERE context_id IN ('PC-004','PC-005','PC-006','PC-008')
  AND project_name IS NOT NULL;

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM pragma_table_info('project_context') WHERE name = 'scope') AS scope_col,
    (SELECT COUNT(*) FROM pragma_table_info('project_context') WHERE name = 'project_name') AS project_name_col,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_project_scope') AS idx_present,
    (SELECT COUNT(*) FROM project_context WHERE scope='global') AS global_count,
    (SELECT COUNT(*) FROM project_context WHERE scope='project') AS project_count;
-- 期望：scope_col=1, project_name_col=1, idx_present=1, global_count=4, project_count=4

-- 分布明细
SELECT context_id, scope, project_name
FROM project_context
ORDER BY scope DESC, context_id;
-- 期望：project 4 行（PC-001/002/003/007 project_name=kilo_config）+ global 4 行（PC-004/005/006/008 project_name=NULL）