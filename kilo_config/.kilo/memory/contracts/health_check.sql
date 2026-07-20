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
--
-- 版本：v2.6.1（共 17 项检查）
--   v2.4：13 项（表/索引/视图/行数/CHECK 约束/种子/trial/bootstrap 完整性/scope 列/补偿 prompt 过期）
--   v2.5 新增：
--     14. SKILL_USAGE_EVENTS_TABLE_PRESENT（#T1）：skill_usage_events 表存在（替代 .log md 累积）
--         （LEGACY_SKILL_USAGE_LOG_ABSENT 为文件系统检查，SQL 无法表达，由 validate-config.mjs check14 实施）
--   v2.6 新增：
--     15. FEEDBACK_LOOP_IDLE：dispatch ≥5 但 fact_store 反馈事件（helpful+misleading）=0 → M6 Stage 3 未激活
--     16. CONTEXT_USE_COUNT_STALE：dispatch ≥5 但 project_context use_count 总和=0 → M1 query A' UPDATE 未执行
--   v2.6.1 新增：
--     17. VIEWS_QUERYABLE_OK：4 视图不仅存在且可实际查询（存在性检查 #3 无法发现视图体内 SQL 语法损坏，
--         如 v2.6 前 v_failure_patterns 的 GROUP_CONCAT DISTINCT 两参数缺陷）
-- soft-warn 语义：第 6-17 项 fail 映射到 check17 warnings[]，不阻断交付（依赖 validate-config.mjs
-- softWarnChecks 名单；仅 1-5 项结构性检查 fail 为硬 FAIL）

.headers off
.mode list
.separator '|'

-- ============================================================
-- 1. 7 表结构存在性校验（v2.5 / #T1 skill_usage_events）
-- ============================================================
SELECT 'REQUIRED_TABLES_MISSING' AS check_name,
       CASE WHEN COUNT(*) >= 7 THEN 'pass' ELSE 'fail' END AS status,
       'required_min=7 actual=' || COUNT(*) AS detail
FROM (
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('fact_store', 'failure_db', 'dispatch_log', 'project_context', 'model_calibration', 'skill_upgrade_log', 'skill_usage_events')
);

-- ============================================================
-- 2. 索引存在性校验（核心索引）
-- ============================================================
SELECT 'REQUIRED_INDEXES_MISSING' AS check_name,
       CASE WHEN COUNT(*) >= 21 THEN 'pass' ELSE 'fail' END AS status,
       'required_min=21 actual=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='index' AND name LIKE 'idx_%';

-- ============================================================
-- 3. 视图存在性校验（v2.4 含 4 个视图）
-- ============================================================
SELECT 'REQUIRED_VIEWS_MISSING' AS check_name,
       CASE WHEN COUNT(*) = 4 THEN 'pass' ELSE 'fail' END AS status,
       'required=[v_failure_patterns,v_high_confidence_facts,v_high_helpful_facts,v_active_project_context] actual=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='view' AND name IN ('v_failure_patterns', 'v_high_confidence_facts', 'v_high_helpful_facts', 'v_active_project_context');

-- ============================================================
-- 4. 行数统计（agent / validate-config 用于 [MEMORY_LAYER_HOLLOW] 告警）
-- ============================================================
SELECT 'ROW_COUNTS' AS check_name,
       'pass' AS status,
       'dispatch_log=' || (SELECT COUNT(*) FROM dispatch_log) ||
       ',fact_store=' || (SELECT COUNT(*) FROM fact_store) ||
       ',failure_db=' || (SELECT COUNT(*) FROM failure_db) ||
       ',project_context=' || (SELECT COUNT(*) FROM project_context) ||
       ',model_calibration=' || (SELECT COUNT(*) FROM model_calibration) ||
       ',skill_upgrade_log=' || (SELECT COUNT(*) FROM skill_upgrade_log) ||
       ',skill_usage_events=' || (SELECT COUNT(*) FROM skill_usage_events) ||
       ',fact_fts=' || (SELECT COUNT(*) FROM fact_fts) ||
       ',failure_fts=' || (SELECT COUNT(*) FROM failure_fts) AS detail;

-- ============================================================
-- 5. CHECK 约束健全性（6 表均应有至少 1 个 CHECK 约束）
-- ============================================================
SELECT 'CHECK_CONSTRAINTS_MISSING' AS check_name,
       CASE WHEN COUNT(*) >= 6 THEN 'pass' ELSE 'fail' END AS status,
       'required_min=6 actual=' || COUNT(*) AS detail
FROM sqlite_master
WHERE type='table'
  AND name IN ('fact_store', 'failure_db', 'dispatch_log', 'project_context', 'model_calibration', 'skill_upgrade_log')
  AND sql LIKE '%CHECK%';

-- ============================================================
-- 6. project_context 种子完整性（v2.3 / #1）
-- ============================================================
SELECT 'PROJECT_CONTEXT_SEEDED' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM project_context) >= 5 THEN 'pass' ELSE 'fail' END AS status,
       'required_min=5 actual=' || (SELECT COUNT(*) FROM project_context) AS detail;

-- ============================================================
-- 7. trial 过期归档检查（v2.3 / #2）
-- ============================================================
SELECT 'TRIAL_EXPIRED_PENDING' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM fact_store
                  WHERE archived = 0
                    AND confidence >= 0.5 AND confidence < 0.7
                    AND hit_count < 2
                    AND created_at < datetime('now', '-14 days')) = 0
            THEN 'pass' ELSE 'fail' END AS status,
       'expired_count=' || (SELECT COUNT(*) FROM fact_store
                  WHERE archived = 0
                    AND confidence >= 0.5 AND confidence < 0.7
                    AND hit_count < 2
                    AND created_at < datetime('now', '-14 days')) AS detail;

-- ============================================================
-- 8. 16 条 AP/PAT 迁移完整性（v2.3 / #4 — 防意外删除/归档 bootstrap facts）
-- ============================================================
SELECT 'FACT_ID_REFERENCED_INTACT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM fact_store
                  WHERE fact_id IN ('AP-001','AP-002','AP-003','AP-004','AP-005',
                                    'AP-006','AP-007','AP-008','AP-009','AP-010',
                                    'AP-011','AP-012','AP-013','AP-014',
                                    'PAT-001','PAT-002')) = 16
            THEN 'pass' ELSE 'fail' END AS status,
       'expected=16 actual=' || (SELECT COUNT(*) FROM fact_store
                                  WHERE fact_id IN ('AP-001','AP-002','AP-003','AP-004','AP-005',
                                                    'AP-006','AP-007','AP-008','AP-009','AP-010',
                                                    'AP-011','AP-012','AP-013','AP-014',
                                                    'PAT-001','PAT-002')) AS detail;

-- ============================================================
-- 9. fact_store scope 列存在性（v2.3 / #5 — 跨项目隔离前置）
-- ============================================================
SELECT 'FACT_STORE_SCOPE_COLUMN_PRESENT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name IN ('scope','project_name')) = 2
            THEN 'pass' ELSE 'fail' END AS status,
       'present_count=' || (SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name IN ('scope','project_name')) || '/2' AS detail;

-- ============================================================
-- 10. 补偿 prompt 过期告警（v2.3 / #8）
-- ============================================================
SELECT 'COMPENSATION_PROMPT_STALE' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM model_calibration
                  WHERE compensation_prompt IS NOT NULL
                    AND compensation_prompt_set_at IS NOT NULL
                    AND compensation_prompt_set_at < datetime('now', '-30 days')
                    AND compensation_prompt_consumed_count = 0) = 0
            THEN 'pass' ELSE 'fail' END AS status,
       'stale_count=' || (SELECT COUNT(*) FROM model_calibration
                  WHERE compensation_prompt IS NOT NULL
                    AND compensation_prompt_set_at IS NOT NULL
                    AND compensation_prompt_set_at < datetime('now', '-30 days')
                    AND compensation_prompt_consumed_count = 0) AS detail;

-- ============================================================
-- 11. FTS5 虚表存在性（v2.4 / #5 — 全文检索效率 +++）
-- ============================================================
SELECT 'FTS5_VIRTUAL_TABLES_PRESENT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM sqlite_master
                  WHERE type='table' AND name IN ('fact_fts','failure_fts')) = 2
            THEN 'pass' ELSE 'fail' END AS status,
       'present_count=' || (SELECT COUNT(*) FROM sqlite_master
                  WHERE type='table' AND name IN ('fact_fts','failure_fts')) || '/2' AS detail;

-- ============================================================
-- 12. fact_store helpful 列存在性（v2.4 / #13 — 反馈质量量化）
-- ============================================================
SELECT 'FACT_STORE_HELPFUL_COLUMNS_PRESENT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM pragma_table_info('fact_store')
                  WHERE name IN ('helpful_count','misleading_count','helpful_rate')) = 3
            THEN 'pass' ELSE 'fail' END AS status,
       'present_count=' || (SELECT COUNT(*) FROM pragma_table_info('fact_store')
                  WHERE name IN ('helpful_count','misleading_count','helpful_rate')) || '/3' AS detail;

-- ============================================================
-- 13. project_context use_count 列存在性（v2.4 / #2 — 上下文动态化）
-- ============================================================
SELECT 'PROJECT_CONTEXT_USE_COLUMNS_PRESENT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM pragma_table_info('project_context')
                  WHERE name IN ('use_count','last_used_at')) = 2
            THEN 'pass' ELSE 'fail' END AS status,
       'present_count=' || (SELECT COUNT(*) FROM pragma_table_info('project_context')
                  WHERE name IN ('use_count','last_used_at')) || '/2' AS detail;

-- ============================================================
-- 14. v2.5 / #T1 skill_usage_events 表存在性（sqlite 唯一记忆：替代 .log md 累积）
-- ============================================================
SELECT 'SKILL_USAGE_EVENTS_TABLE_PRESENT' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM sqlite_master
                  WHERE type='table' AND name='skill_usage_events') = 1
            THEN 'pass' ELSE 'fail' END AS status,
       'present=' || (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='skill_usage_events') || '/1' AS detail;

-- ============================================================
-- 15. v2.6 / R1：M6 helpful/misleading 反馈回路空转告警（soft-warn）
--     dispatch_log ≥5（已有足够任务量）但反馈事件总数 = 0 → M6 Stage 3 从未执行
-- ============================================================
SELECT 'FEEDBACK_LOOP_IDLE' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM dispatch_log) < 5
              OR (SELECT COALESCE(SUM(helpful_count),0) + COALESCE(SUM(misleading_count),0) FROM fact_store) > 0
            THEN 'pass' ELSE 'fail' END AS status,
       'dispatch_log=' || (SELECT COUNT(*) FROM dispatch_log) ||
       ',feedback_events=' || (SELECT COALESCE(SUM(helpful_count),0) + COALESCE(SUM(misleading_count),0) FROM fact_store) ||
       '（>0 或 dispatch<5 即 pass）' AS detail;

-- ============================================================
-- 16. v2.6 / R2：project_context use_count 回路空转告警（soft-warn）
--     dispatch_log ≥5 但 use_count 总和 = 0 → M1 query A' UPDATE 从未执行
-- ============================================================
SELECT 'CONTEXT_USE_COUNT_STALE' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM dispatch_log) < 5
              OR (SELECT COALESCE(SUM(use_count),0) FROM project_context) > 0
            THEN 'pass' ELSE 'fail' END AS status,
       'dispatch_log=' || (SELECT COUNT(*) FROM dispatch_log) ||
       ',context_use_total=' || (SELECT COALESCE(SUM(use_count),0) FROM project_context) ||
       '（>0 或 dispatch<5 即 pass）' AS detail;

-- ============================================================
-- 17. v2.6.1：4 视图可查询性（soft-warn）
--     检查 #3 仅验证视图名存在；本项实际执行 SELECT，捕捉视图体内 SQL 损坏
-- ============================================================
SELECT 'VIEWS_QUERYABLE_OK' AS check_name,
       CASE WHEN (SELECT COUNT(*) FROM v_failure_patterns) >= 0
             AND (SELECT COUNT(*) FROM v_high_confidence_facts) >= 0
             AND (SELECT COUNT(*) FROM v_high_helpful_facts) >= 0
             AND (SELECT COUNT(*) FROM v_active_project_context) >= 0
            THEN 'pass' ELSE 'fail' END AS status,
       'v_failure_patterns=' || (SELECT COUNT(*) FROM v_failure_patterns) ||
       ',v_high_confidence_facts=' || (SELECT COUNT(*) FROM v_high_confidence_facts) ||
       ',v_high_helpful_facts=' || (SELECT COUNT(*) FROM v_high_helpful_facts) ||
       ',v_active_project_context=' || (SELECT COUNT(*) FROM v_active_project_context) AS detail;