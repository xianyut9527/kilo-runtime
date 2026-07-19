-- ============================================================
-- 试用期归档 SOP（v2.3 / #2 — 14 天 trial 过期归档）
-- ============================================================
-- 模块位置：.kilo/memory/api/trial_archive.sql
-- 业务规则：.kilo/memory/policy/trial_archive.md
--
-- 执行时机：
--   (a) 周期触发：每周 cron 一次（推荐：周日凌晨 03:00）
--   (b) 启动钩子：Kilo 启动时检查（N 分钟内只跑一次，防频次爆炸）
--   (c) M7 dispatch 收尾后：advisory 触发（policy/dispatch_recorder.md §5）
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/trial_archive.sql
--
-- 副作用：将满足 trial 条件但 14 天未升入正式门槛的 fact_store 行 archived=1
--       并在 evidence JSON 追加 'archived-trial-expiry-YYYYMMDD' 标记
-- 幂等性：UPDATE WHERE archived=0 + trial 条件；已归档的行不再命中；可重跑
-- 不可逆：归档后的 trial 行不再复活（即使后续 hit_count 上升），evidence 保留过期痕迹
-- ============================================================

BEGIN TRANSACTION;

-- 归档 14 天前创建 + confidence < 0.7 + hit_count < 2 + archived=0 的 trial 行
UPDATE fact_store
SET archived = 1,
    evidence = json_insert(
        COALESCE(evidence, '[]'),
        '$[#]',
        'archived-trial-expiry-' || strftime('%Y%m%d', 'now')
    ),
    updated_at = datetime('now')
WHERE archived = 0
  AND confidence >= 0.5
  AND confidence < 0.7
  AND hit_count < 2
  AND created_at < datetime('now', '-14 days');

-- 输出本次归档数量（供 cron 日志 / check17 消费）
SELECT 'TRIAL_ARCHIVED' AS check_name,
       CASE WHEN changes() = 0 THEN 'pass' ELSE 'pass' END AS status,
       'archived_count=' || changes() AS detail;

COMMIT;