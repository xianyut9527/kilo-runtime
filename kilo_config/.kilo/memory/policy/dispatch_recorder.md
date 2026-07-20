# Dispatch Recorder 策略

> **模块位置**：`.kilo/memory/policy/dispatch_recorder.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`，健康度见 `../contracts/health_check.sql`
> **职责**：定义何时、如何写入 `dispatch_log` 表

## 触发条件

T1+ 任务交付后，**必须**执行 dispatch_log 写入。T0 可选（极速通道）。

## 写入流程

coderAgent 在任务结束时，通过 bash 调用 sqlite3 CLI 写入（v2.5-过渡版主通道，PowerShell 示例）：

```powershell
# 简单 SQL 单行执行
sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" "INSERT INTO dispatch_log (...) VALUES (...);"

# 复杂 SQL（含多层引号）推荐写入临时文件后 .read
$sql = @"
INSERT INTO dispatch_log (...) VALUES (...);
"@
$tmp = Join-Path $env:TEMP "disp_$(New-Guid).sql"
$sql | Set-Content -Path $tmp -Encoding UTF8
sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" ".read $tmp"
Remove-Item $tmp
```

SQL 模板（参数由 agent 替换占位符后拼入上述命令）：

```sql
INSERT INTO dispatch_log (
    dispatch_id, thread_id, agent, task_summary,
    initial_tier, final_tier, tier, review_mode, tier_deviation,
    model, status, error_code, duration_ms,
    input_tokens, output_tokens, files_changed, findings_count,
    compensation_prompt_used, compensation_calibration_id,  -- v2.3 / #8
    trigger_fact_ids, helpful_fact_ids, misleading_fact_ids,  -- v2.4 / #13 反馈列
    created_at
)
VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,    -- initial_tier / final_tier / tier(=final_tier) / review_mode / tier_deviation
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,             -- compensation_prompt_used / compensation_calibration_id（v2.3 / #8）
    ?, ?, ?,          -- trigger_fact_ids / helpful_fact_ids / misleading_fact_ids（v2.4 / #13 JSON 数组）
    datetime('now')
);
```

**必填字段**：
- `dispatch_id`: `disp-{thread_id}-{superstep}`
- `task_summary`: ≤100 字，描述任务核心（如"React 状态管理重构"）
- `initial_tier` / `final_tier` / `tier`: T0/T1/T2/T3；`tier` 兼容旧字段，值 = `final_tier`
- `review_mode`: `none` / `lightweight` / `full`（T0=none，其余按 review_mode 决策表确定）
- `compensation_prompt_used` / `compensation_calibration_id`：v2.3 / #8；本次 dispatch 是否消费补偿 prompt + 对应 calibration_id
- **`trigger_fact_ids` / `helpful_fact_ids` / `misleading_fact_ids`**：v2.4 / #13 反馈结构化列；M7 写入时必须从 M3/M6 节点日志提取并 JSON 化（详见 §v2.4 M7 反馈字段写入规则）
- `tier_deviation`: `maintain` / `upgrade` / `downgrade`（阶段 A→B 偏差方向）
- `model`: 实际使用的模型名
- `status`: DONE / DONE_WITH_CONCERNS / FAILED / BLOCKED / TIMEOUT
- `findings_count`: checker 发现的问题数（0 表示一次通过）

> **路径口径**：sqlite 数据库统一为 `${HOME}/.config/kilo-data/memory.db`，由 Kilo 运行时解析 install 阶段不替换。

## fixer 修复后 error_code 强制回写（P1 强化）

即使 fixer 1 轮修复成功（`verified = 1`），也必须把修复工作量写回 dispatch_log，便于事后统计 fixer 单轮修复率：

```sql
UPDATE dispatch_log
SET error_code = CASE
  WHEN ? = 1 THEN 'FIXED_BY_FIXER_ROUND_1'
  WHEN ? = 2 THEN 'FIXED_BY_FIXER_ROUND_2'
  WHEN ? >= 3 THEN 'FIXED_BY_FIXER_ROUND_N_ESCALATED'
END
WHERE dispatch_id = ?;
```

**回写触发条件**（fixer 完成后**强制执行**，缺则 `[MISSING_FIXER_WRITE]`）：
- fixer 返回 `DONE` 且后续 checker 验证通过 → 写入 `FIXED_BY_FIXER_ROUND_N`
- fixer 连续 2 轮同症状升级 reviewer → 写入 `FIXED_BY_FIXER_ROUND_N_ESCALATED`
- 不分失败成功，只要 fixer 被触发就必须写

**统计价值**：
- `dispatch_log` 按 `error_code LIKE 'FIXED_BY_FIXER%'` 过滤 → 计算 model_calibration 中的 fixer 单轮修复率
- 单轮修复率 < 70% 的 model → 触发 compensation_prompt 更新（联动 `model_calibration.md`）

## 事后分析（建议执行）

### tier 偏差分布（喂给 model_calibration）

```sql
SELECT
    initial_tier,
    final_tier,
    tier_deviation,
    COUNT(*) as cnt,
    AVG(duration_ms) as avg_duration
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY initial_tier, final_tier, tier_deviation
ORDER BY cnt DESC;
```

### review_mode 命中分布

```sql
SELECT
    final_tier,
    review_mode,
    COUNT(*) as cnt,
    AVG(findings_count) as avg_findings
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY final_tier, review_mode
ORDER BY cnt DESC;
```

## 门禁

未执行本策略 → `[MISSING_MEMORY_WRITE]`（详见 `../../instructions/workflow-core.md` §收尾自检）。

## v2.3 trial 归档 advisory（#2）

M7 dispatch_log INSERT 完成后，**advisory 触发** `api/trial_archive.sql` 清理 14 天过期 trial 行：

- 非阻塞：归档失败不影响 dispatch_log 写入
- 频次节流：建议 24h 内只跑一次（由调用方控制）
- 失败处理：归档失败仅记录 warn，不阻塞交付
- 详见 `policy/trial_archive.md` §3 触发时机

## v2.3 skill_upgrade V2 自增（#3，opt-in）

仅当环境变量 `KILO_SKILL_UPGRADE_V2=true` 时启用。V1 阶段默认关闭，行为不变。

**V2 启用时**：M7 dispatch_log INSERT 完成后，对满足晋升条件的 fact_id 进行连续成功计数：

```sql
-- 仅对 status = DONE 的 dispatch 累加
UPDATE skill_upgrade_log
SET consecutive_successes = consecutive_successes + 1,
    last_success_at = datetime('now'),
    last_evaluated_dispatch_id = :dispatch_id
WHERE promotion_status = 'DRAFT'
  AND fact_id IN (
    SELECT fact_id FROM fact_store
    WHERE category IN ('PATTERN','ANTIPATTERN')
      AND confidence >= 0.8
      AND hit_count >= 3
      AND archived = 0
  );

-- status = FAILED 或 DONE_WITH_CONCERNS 时重置
UPDATE skill_upgrade_log
SET consecutive_successes = 0
WHERE promotion_status = 'DRAFT'
  AND fact_id IN (...);  -- 本次 dispatch 涉及的 fact_id

-- 连续成功 ≥ 3 → AUTO_PROMOTED + fact_store 行归档
UPDATE skill_upgrade_log
SET promotion_status = 'AUTO_PROMOTED',
    promoted_at = datetime('now')
WHERE promotion_status = 'DRAFT'
  AND consecutive_successes >= 3;

UPDATE fact_store
SET archived = 1, updated_at = datetime('now')
WHERE fact_id IN (
  SELECT fact_id FROM skill_upgrade_log
  WHERE promotion_status = 'AUTO_PROMOTED' AND archived = 0
);
```

详见 `policy/skill_upgrade.md` §V2 算法。

## v2.4 M7 反馈字段写入规则（#13）

M7 dispatch_log INSERT 时必须从 M3 节点日志（注入引用）和 M6 节点日志（helpful/misleading 反馈）提取 fact_id 列表，**JSON 化后写入 3 个反馈列**：

```sql
-- M7 INSERT 时（典型 T1+ 任务）
INSERT INTO dispatch_log (
  ..., trigger_fact_ids, helpful_fact_ids, misleading_fact_ids, ...
) VALUES (
  ..., :trigger_fact_ids_json, :helpful_fact_ids_json, :misleading_fact_ids_json, ...
);

-- JSON 化示例（agent 提取节点日志后调用）：
-- trigger_fact_ids_json = '["AP-001","AP-005","PAT-001"]'（M3 注入引用收集）
-- helpful_fact_ids_json = '["AP-001","PAT-001"]'（M6 [memory:helpful=...] 收集）
-- misleading_fact_ids_json = '["AP-005"]'（M6 [memory:misleading=...] 收集）
```

**字段语义**：

| 字段 | 来源 | 写入时机 |
|---|---|---|
| `trigger_fact_ids` | M3 节点日志中的 `[memory:fact_id=...]` 标记 | M7 INSERT 时 |
| `helpful_fact_ids` | M6 节点日志中的 `[memory:helpful=...]` 标记 | M7 INSERT 时（与 trigger 可重叠） |
| `misleading_fact_ids` | M6 节点日志中的 `[memory:misleading=...]` 标记 | M7 INSERT 时 |

**门禁**：3 个字段必须填 `[]`（空数组）或实际 JSON 数组；NULL 视为缺失 → `[MISSING_MEMORY_WRITE]`。

**与 fact_store 的联动**（在 M6 Stage 3 完成，本节为 M7 持久化）：
- helpful/misleading 的 fact_store UPDATE（helpful_count / misleading_count / helpful_rate / confidence±）由 M6 Stage 3 执行，详见 `policy/m6_validation.md` §3 Stage 3（v2.6 起强制，无反馈显式 `[memory:helpful=none]`）
- M7 仅负责把 M6 已处理的结果**结构化记录**到 dispatch_log（用于事后分析 / 校准 / 统计）

**事后分析查询**（v2.4 新增）：

```sql
-- 最有价值的 fact（按 helpful_count DESC）
SELECT fact_id, helpful_count, misleading_count, helpful_rate
FROM fact_store
WHERE helpful_count >= 3
ORDER BY helpful_count DESC, helpful_rate DESC
LIMIT 20;

-- 误导率最高的 fact（按 misleading_count DESC，需降权）
SELECT fact_id, helpful_count, misleading_count, helpful_rate
FROM fact_store
WHERE misleading_count >= 2 AND helpful_rate < 0.5
ORDER BY misleading_count DESC, helpful_rate ASC;

-- 近期 dispatch 的 fact 引用密度
SELECT
  DATE(created_at) AS day,
  COUNT(*) AS dispatches,
  AVG(json_array_length(trigger_fact_ids)) AS avg_trigger_facts
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY DATE(created_at)
ORDER BY day DESC;
```

## 相关策略

- `fact_dedup.md` — fact_store 写入（含 v2.4 helpful_rate 初始化）
- `failure_recorder.md` — failure_db 写入
- `model_calibration.md` — 模型校准更新
- `m6_validation.md` §3 Stage 3 — M6 helpful/misleading 处理（前置）
- `query_strategy.md` §M6 helpful_rate 反馈流程 — 综合规范
- `../../instructions/workflow-core.md` §收尾自检 — 硬门禁入口