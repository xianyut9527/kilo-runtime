-- Memory Module 健康度 SQL（contracts 层）
-- 模块位置: .kilo/memory/contracts/health_check.sql
-- 消费方: validate-config.mjs check17
-- 职责: 标准化 memory.db 健康度查询，被 check17 与模块自身复用
--
-- 使用方式（CLI）:
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/contracts/health_check.sql
--
-- 使用方式（编程）:
--   better-sqlite3 等只需按行解析本文件输出（行格式: <check_name>|<pass|fail>|<detail>）

.headers off
.mode list
.separator '|'

-- ============================================================
-- 1. 5 表结构存在性校验
-- ============================================================
SELECT 'REQUIRED_TABLES_MISSING' AS check_name,
       CASE WHEN COUNT(*) = 5 THEN 'pass' ELSE 'fail' END AS status,
       'required=[' || GROUP_CONCAT(name) || '] actual_count=' || COUNT(*) AS detail
FROM (
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('fact_store', 'failure_db', 'dispatch_log', 'project_context', 'model_calibration')
);

-- ============================================================
-- 2. 索引存在性校验（核心索引）
-- ============================================================
SELECT 'REQUIRED_INDEXES_MISSING' AS check_name,
       CASE WHEN COUNT(*) >= 15 THEN 'pass' ELSE 'fail' END AS status,
       'required_count=15 actual_count=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='index' AND name LIKE 'idx_%';

-- ============================================================
-- 3. 视图存在性校验
-- ============================================================
SELECT 'REQUIRED_VIEWS_MISSING' AS check_name,
       CASE WHEN COUNT(*) = 2 THEN 'pass' ELSE 'fail' END AS status,
       'required=[v_failure_patterns,v_high_confidence_facts] actual_count=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='view' AND name IN ('v_failure_patterns', 'v_high_confidence_facts');

-- ============================================================
-- 4. 行数统计（agent / validate-config 用于 [MEMORY_LAYER_HOLLOW] 告警）
-- ============================================================
SELECT 'ROW_COUNTS' AS check_name,
       'pass' AS status,
       'dispatch_log=' || (SELECT COUNT(*) FROM dispatch_log) ||
       ',fact_store=' || (SELECT COUNT(*) FROM fact_store) ||
       ',failure_db=' || (SELECT COUNT(*) FROM failure_db) ||
       ',project_context=' || (SELECT COUNT(*) FROM project_context) ||
       ',model_calibration=' || (SELECT COUNT(*) FROM model_calibration) AS detail;

-- ============================================================
-- 5. CHECK 约束健全性（5 表均应有至少 1 个 CHECK 约束）
-- ============================================================
SELECT 'CHECK_CONSTRAINTS_MISSING' AS check_name,
       CASE WHEN COUNT(*) >= 5 THEN 'pass' ELSE 'fail' END AS status,
       'required_min=5 actual_count=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='table'
  AND name IN ('fact_store', 'failure_db', 'dispatch_log', 'project_context', 'model_calibration')
  AND sql LIKE '%CHECK%';