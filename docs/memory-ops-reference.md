---
description: 记忆操作 SQL 模板参考。sqlite 优先，md 仅作索引兜底。conductor 在 DELIVERING 阶段查阅。
---

# docs/memory-ops-reference

> **定位**：本文件是从原 `agent/capabilities/memory-ops.md` 迁移而来的 SQL 模板参考文档。记忆写入是 conductor 在 `DELIVERING` 阶段的内建职责（调用 sqlite3 CLI），不需要独立智能体。本文件保留作为 SQL 模板参考。

## 能力定位

**生命周期阶段**：`DELIVERING`（conductor 内建）+ `INTENT` / `EXECUTING` 按需注入

**做什么**：通过 bash + `sqlite3` CLI 操作 `~/.config/kilo-data/memory.db`。

**不做什么**：不替代主流程、不阻塞执行、不直接执行主任务。

## 记忆节点（M 系列）

| 节点 | 时机 | 操作 | SQL 表 |
|------|------|------|--------|
| M1 | 任务定级后、实现前 | 注入 project_context + fact_store + failure_db | SELECT |
| M3 | 实现中（失败回溯） | 查询同类失败模式 | failure_db MATCH |
| M4 | 交付前 | 去重查询 | fact_store SELECT |
| M5 | 交付前 | 新经验写入 | fact_store INSERT |
| M6 | 交付前 | 反馈标记（helpful/misleading） | UPDATE fact_store |
| M7 | 交付前 / 修复失败时 | 失败案例写入 | failure_db INSERT |
| M8 | 交付前 | dispatch_log 写入 + model_calibration 更新 | INSERT/UPDATE |

## 输入接口

### M1 注入
```yaml
operation: "recall"
node: "M1"
task_context:
  task_summary: "string"
  task_type: "T0" | "T1" | "T2" | "T3"
  keywords: ["string"]
  current_project: "string"
```

### M4-M8 写入
```yaml
operation: "write"
node: "M4" | "M5" | "M6" | "M7" | "M8"
task_context:
  dispatch_id: "string"
  task_summary: "string"
  task_type: "string"
  agent_role: "string"
# M5/M6 专用
memory_write:
  referenced_fact_ids: ["string"]
  helpful_facts: ["string"]
  misleading_facts: ["string"]
# M7 专用
failure_record:
  symptom: "string"
  root_cause_level: "string"
  fix_strategy: "string"
  fix_location: "string"
# M8 专用
dispatch_record:
  status: "string"
  duration_ms: int
  token_usage: int
```

## SQL 模板（bash + sqlite3 CLI）

### M1 查询
```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" "
SELECT context_id, title, content FROM project_context WHERE scope='global' OR (scope='project' AND project_name='PROJECT_NAME') ORDER BY priority ASC, use_count DESC LIMIT 5;
SELECT f.fact_id, f.trigger, f.action, f.confidence FROM fact_store f JOIN fact_fts ft ON f.rowid=ft.rowid WHERE ft.fact_fts MATCH 'keyword1 OR keyword2' AND f.archived=0 ORDER BY f.confidence DESC LIMIT 10;
SELECT fd.failure_id, fd.symptom, fd.fix_strategy FROM failure_db fd JOIN failure_fts ft ON fd.rowid=ft.rowid WHERE ft.failure_fts MATCH 'keyword1' ORDER BY fd.created_at DESC LIMIT 5;
"
```

### M5 写入
```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" "
INSERT INTO fact_store (fact_id, category, trigger, action, confidence, hit_count, tags, scope, project_name, created_at, updated_at)
VALUES ('AP-' || hex(randomblob(4)), 'ANTIPATTERN', 'trigger text', 'action text', 0.6, 1, '[\"kw1\",\"kw2\"]', 'project', 'PROJECT_NAME', datetime('now'), datetime('now'));
"
```

### M8 写入
```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" "
INSERT INTO dispatch_log (dispatch_id, thread_id, agent, task_summary, tier, status, duration_ms, input_tokens, output_tokens, created_at)
VALUES ('disp-YYYYMMDD-NNN', 'thread-id', 'coder', 'summary', 'T1', 'DONE', 120000, 5000, 3000, datetime('now'));
"
```

## 输出接口

```yaml
status: "OK" | "DEGRADED" | "ERROR"
prompt_line: "string"           # 🧠 [memory:recall] 或 💾 [memory:write] 提示行
records_affected: int
memory_context_injected: "string"  # 注入的上下文摘要（≤ 2000 tokens）
```

## 降级处理

- `memory.db` 不存在 → `DEGRADED`，首次输出提示，后续静默，不阻塞主流程
- SQL 失败 → `ERROR`，输出警告行，继续执行
- sqlite3 CLI 未安装 → `DEGRADED`，提示用户运行 install 脚本

## 硬规则

- **sqlite 唯一记忆**：禁止 `.kilo/memory/skill-usage.log` 存在；skill 使用频次写入 `skill_usage_events` 表
- **md 仅作静态兜底**：用户偏好/安全约束由 `project_context` 表承载（v2.6.2 精简后不再维护 `MEMORY.md` / `USER.md`）
- **helpful_rate 强制**：M6 必须输出 `[memory:helpful=...]` / `[memory:misleading=...]`，无反馈显式 `[memory:helpful=none]`
- **Token 预算**：sqlite 查询结果注入总量 ≤ 2000 tokens；超出时按优先级截断
