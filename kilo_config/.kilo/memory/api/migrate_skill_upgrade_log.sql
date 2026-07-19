-- ============================================================
-- skill_upgrade_log 表回填（v2.3 / #3 — V2 自动化前置）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_skill_upgrade_log.sql
-- 执行时机：升级到 v2.3 后，对历史满足晋升条件但未追踪的 fact_store 行补 DRAFT 记录
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_skill_upgrade_log.sql
--
-- 幂等性：INSERT OR IGNORE（PK = upgrade_id = fact_id + '-DRAFT'），可重复执行
-- 业务规则：V1 阶段（默认）DRAFT 行仅作审计；V2 阶段（env KILO_SKILL_UPGRADE_V2=true）下连续 3 次 DONE 自动 AUTO_PROMOTED
-- 详见 policy/skill_upgrade.md §自动化程度 + policy/skill_upgrade.md §V2 算法
-- ============================================================

INSERT OR IGNORE INTO skill_upgrade_log (upgrade_id, fact_id, consecutive_successes, promotion_status, evidence_dispatch_ids)
SELECT
    fact_id || '-DRAFT' AS upgrade_id,
    fact_id,
    0 AS consecutive_successes,
    'DRAFT' AS promotion_status,
    json_array('backfill-v2.3-migration') AS evidence_dispatch_ids
FROM fact_store
WHERE category IN ('PATTERN', 'ANTIPATTERN')
  AND confidence >= 0.8
  AND hit_count >= 3
  AND archived = 0;

-- 验证回填结果
SELECT promotion_status, COUNT(*) AS cnt
FROM skill_upgrade_log
GROUP BY promotion_status
ORDER BY promotion_status;
-- 期望返回至少 1 行 status='DRAFT'