---
name: skill-usage-tracking
description: 6 主流程 agent（coder / coder / planner / verifier / fixer / reviewer）使用 skill 时的频次自动记录协议。v2.5 起强制写入 SQLite `skill_usage_events` 表（替代 .log md 累积）；sqlite 唯一记忆原则：禁止 md 文件累积时序数据。
keywords: skill-usage, tracking, sqlite, telemetry, 频次, 记录, sqlite-唯一记忆
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.5"
  category: knowledge
---

# Skill 使用频次记录协议（v2.5 — SQLite 唯一记忆）

> **v2.5 强制变更**：所有 skill 使用频次数据必须写入 SQLite `skill_usage_events` 表（schema/init.sql）。**禁止** md append（`.kilo/memory/skill-usage.log` 已被废弃，v2.5 一次性迁移至 SQLite 后该 .log 文件及对应迁移脚本已在 v2.6.2 精简中删除）。
>
> **sqlite 唯一记忆原则**：md 文件只存静态规则（policy）和指针（index），不累积时序数据。时序数据全部入 SQLite（`dispatch_log` / `skill_usage_events` / `fact_store.hit_count` 等），通过 FTS5 / 索引 / 视图高效查询。
>
> **历史**：v2.4 之前 `.kilo/memory/skill-usage.log` 是 append-only 文件，每条 dispatch 写一行 → 长期累积占磁盘 + git diff 噪声 + 不可 SQL 查询。v2.5 起改为 SQLite。

## 1. 何时记录

- **完成触发**：`.kilo/memory/` 目录存在且包含有效记忆文件时，agent 单元完成 / 整体任务交付后，向 SQLite `skill_usage_events` 表 INSERT 一行。目录为空或不存在时跳过追加，不报错、不删除规则。
- **反思触发**：`.kilo/memory/` 目录存在且包含有效记忆文件时，且触发 reflection.md 的"强制跨会话根因回溯"或 Circuit Breaker 时，记录反思中涉及的 skill。目录为空或不存在时跳过。

## 2. 记录什么

每行一个事件，包含 8 字段：

| 字段 | 说明 |
|------|------|
| `timestamp` | ISO8601（`Get-Date -Format 'o'` 或 `date -Iseconds`） |
| `session_id` | 当前会话 ID（Kilo 注入或随机） |
| `skill_name` | skill 目录名（如 `verification-before-completion`） |
| `trigger` | 短描述（≤40 字符，如 `U1 前置加载` / `反思触发`） |
| `outcome` | `success` / `fail` / `partial` |
| `agent` | 哪个智能体触发（conductor / planner / coder / verifier / reverse-auditor / side-checker / reviewer / fixer / multiModel） |
| `task_tier` | T0/T1/T2/T3 |
| `created_at` | 写入 SQLite 的时间（默认 `datetime('now')`） |

## 3. 如何写入

### SQL 模板

```sql
INSERT INTO skill_usage_events (timestamp, session_id, skill_name, trigger, outcome, agent, task_tier, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'));
```

### 写入路径

- **写入位置**：`.kilo/memory/` 模块的 `skill_usage_events` 表（全局共享，跨项目）
- **方式**：通过 bash 调用 sqlite3 CLI 执行 INSERT（命令模板见 `docs/memory-ops-reference.md` §skill_usage_events）；不允许用 append 文件
- **隐私**：禁止记录 prompt 正文、密钥、用户隐私

## 4. 反作弊与最小化

- 仅记录 skill 元数据（skill_name / trigger / outcome），不记录内容
- 失败重试算 1 次 `partial`，不重复写多行
- 同会话同 skill 连续 3 次同 outcome 合并为 1 行（trigger 标注 `merged`）
- coder-A / B / C（multiModel 模式下）、multiModel 自身、verifier、reverse-auditor、side-checker 不参与本协议（仅主流程 conductor + planner + coder + fixer + reviewer 记录）

## 5. 统计消费（v2.5 推荐 SQL 查询）

### 按频次排序（核心 skill 验证）

```sql
SELECT skill_name, COUNT(*) AS uses,
       SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS success_count,
       ROUND(100.0 * SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_pct
FROM skill_usage_events
WHERE created_at > datetime('now', '-30 days')
GROUP BY skill_name
ORDER BY uses DESC
LIMIT 20;
```

### 冷门 skill 淘汰候选（30 天内使用 < 3 次）

```sql
SELECT skill_name, COUNT(*) AS uses, MAX(created_at) AS last_used
FROM skill_usage_events
WHERE created_at > datetime('now', '-30 days')
GROUP BY skill_name
HAVING uses < 3
ORDER BY uses ASC, last_used ASC;
```

### 按 agent 维度分析

```sql
SELECT agent, skill_name, COUNT(*) AS uses,
       SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS success_count
FROM skill_usage_events
WHERE created_at > datetime('now', '-7 days')
GROUP BY agent, skill_name
ORDER BY uses DESC
LIMIT 30;
```

## 6. check17 健康度

v2.5 起 `contracts/health_check.sql` 不直接验证 `skill_usage_events`（无硬性要求），仅通过 `ROW_COUNTS` 间接统计。理由：skill_usage_events 是 telemetry 数据，可选；agent 必须确保记录但不强制最低行数。

## 7. 相关文件

- `schema/init.sql`（`.kilo/memory/schema/init.sql`） — skill_usage_events 表 DDL 唯一源
- `.kilo/instructions/skills-lifecycle.md` — SKILL.md 分类与生命周期
- `.kilo/memory/README.md` §v2.5 — sqlite 唯一记忆原则说明
- `docs/memory-ops-reference.md` — skill_usage_events 写入 SQL 模板
