-- ============================================================
-- skill-usage.log → skill_usage_events 一次性迁移（v2.5）
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_skill_usage_log_to_sqlite.sql
-- 执行时机：v2.4 → v2.5 升级；sqlite 唯一记忆原则生效后
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_skill_usage_log_to_sqlite.sql
--
-- 前置条件：
--   1. schema/init.sql 已运行（含 skill_usage_events 表）
--   2. .kilo/memory/skill-usage.log 存在（可能为空）
--
-- 行格式解析（每行）：
--   [ISO8601] [session_id] [skill_name] [trigger] [outcome]
--   示例：[2026-07-19T05:20:00+08:00] [thread-20260719-0436] [kilo-config] [配置评估] [reviewer最终PASS]
--
-- 幂等性：先 DELETE 整个 skill_usage_events（保留 .log 副本），避免重复 INSERT
--          保留 .log 副本用于事后审计；DB 是单一真实源
-- 详见：policy/skill_usage_tracking.md
-- ============================================================

-- 1. 解析 .kilo/memory/skill-usage.log（如存在）
--    shell 端：先 cat .log 解析为 SQL INSERT 语句，喂给本脚本。
--    简化方案：使用 awk 解析后 INSERT（如下）

-- 步骤 A：清空目标表（保证幂等）
DELETE FROM skill_usage_events;

-- 步骤 B：用 sqlite 的 csv 扩展或 shell awk 导入（取决于 sqlite 是否编译了 CSV 扩展）
--   推荐：在 shell 层用 awk + sqlite3 命令行执行：
--
--   Linux/macOS bash:
--     awk -F'[][]' '/^\[/{printf "%s|%s|%s|%s|%s\n", $2, $4, $6, $8, $10}' \
--       .kilo/memory/skill-usage.log | \
--     sqlite3 memory.db ".import /dev/stdin skill_usage_events"
--
--   Windows PowerShell:
--     Get-Content .kilo/memory/skill-usage.log | ForEach-Object {
--       if ($_ -match '^\[(.+?)\] \[(.+?)\] \[(.+?)\] \[(.+?)\] \[(.+?)\]') {
--         $ts, $sid, $skill, $trig, $out = $Matches[1..5]
--         sqlite3 memory.db "INSERT INTO skill_usage_events (timestamp, session_id, skill_name, trigger, outcome, created_at) VALUES ('$ts', '$sid', '$skill', '$trig', '$out', datetime('now'));"
--       }
--     }
--
-- 步骤 C：验证迁移结果

-- 验证
.headers on
.mode column
SELECT
    (SELECT COUNT(*) FROM skill_usage_events) AS migrated_rows,
    (SELECT COUNT(*) FROM skill_usage_events WHERE outcome='success') AS success_count,
    (SELECT COUNT(*) FROM skill_usage_events WHERE outcome='fail') AS fail_count,
    (SELECT COUNT(*) FROM skill_usage_events WHERE outcome='partial') AS partial_count,
    (SELECT MIN(timestamp) FROM skill_usage_events) AS earliest,
    (SELECT MAX(timestamp) FROM skill_usage_events) AS latest;

-- 步骤 D：迁移成功后，删除 .kilo/memory/skill-usage.log（防止双写）
--   shell 端：
--     rm .kilo/memory/skill-usage.log
--   PowerShell：
--     Remove-Item .kilo/memory/skill-usage.log -ErrorAction SilentlyContinue
--
-- ⚠️ 警告：执行本脚本前请备份 .kilo/memory/skill-usage.log 到 .kilo/memory/skill-usage.log.bak
--         验证无误后再删除 .bak