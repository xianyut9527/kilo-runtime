# Query Strategy 策略

> **模块位置**：`.kilo/memory/policy/query_strategy.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义任务开始与失败回溯时的 sqlite 查询规则

## Token Budget

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）

## 1. 任务开始时（Context 构建阶段）

coderAgent 必须按以下顺序查询：

```sql
-- A. 项目上下文（最高优先级，≤5 条）
SELECT title, content, priority FROM project_context
WHERE category IN ('ARCHITECTURE', 'CONSTRAINT')
ORDER BY priority ASC, updated_at DESC
LIMIT 5;

-- B. 相关经验教训（按 tag 匹配）
SELECT trigger, condition, action, confidence FROM fact_store
WHERE tags LIKE '%当前任务关键词%' AND archived = 0
ORDER BY confidence DESC, hit_count DESC
LIMIT 5;

-- C. 历史失败模式（按 tag 匹配）
SELECT symptom, root_cause_level, fix_strategy FROM failure_db
WHERE tags LIKE '%当前任务关键词%' AND resolved_at IS NOT NULL
ORDER BY same_symptom_count DESC
LIMIT 3;

-- D. 模型校准建议（当前 agent + 任务类型）
SELECT compensation_prompt, success_rate FROM model_calibration
WHERE agent_role = '当前agent角色' AND task_type LIKE '%当前任务类型%'
ORDER BY sample_count DESC
LIMIT 1;
```

**查询后必须**：将 sqlite 返回结果格式化为文本，注入当前上下文。

## 2. 失败/回溯时（reflection.md 强制触发）

当命中以下条件时，**必须**查询 sqlite 而非仅依赖 `kilo_local_recall`：

```sql
-- 查找同类失败
SELECT symptom, fix_strategy, fix_location FROM failure_db
WHERE symptom LIKE '%当前错误关键词%' AND verified = 1
ORDER BY created_at DESC
LIMIT 3;

-- 查找相关反模式
SELECT trigger, action FROM fact_store
WHERE category = 'ANTIPATTERN' AND tags LIKE '%当前任务关键词%'
ORDER BY confidence DESC
LIMIT 3;
```

## 3. 任务结束时（经验沉淀）

详见 `dispatch_recorder.md` / `fact_dedup.md` / `failure_recorder.md` / `model_calibration.md`。

## md 文件保留范围（仅以下场景）

| 内容 | 存储位置 | 原因 |
|------|----------|------|
| 用户偏好 | USER.md | 用户直接编辑，不需要结构化查询 |
| 安全约束 | USER.md | 静态规则，不需要版本追踪 |
| 归档索引 | MEMORY.md | 指向 sqlite 或 archive/ 的索引 |
| 通用约定 | MEMORY.md | 低频变更，md 可读性更好 |

## 相关策略

- `dispatch_recorder.md` — 任务结束写入
- `fact_dedup.md` — fact_store 去重写入
- `failure_recorder.md` — failure_db 写入
- `model_calibration.md` — 模型校准更新