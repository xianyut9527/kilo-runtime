# Dispatch Recorder 策略

> **模块位置**：`.kilo/memory/policy/dispatch_recorder.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`，健康度见 `../contracts/health_check.sql`
> **职责**：定义何时、如何写入 `dispatch_log` 表

## 触发条件

T1+ 任务交付后，**必须**执行 dispatch_log 写入。T0 可选（极速通道）。

## 写入流程

coderAgent 在任务结束时，通过 sqlite MCP 写入：

```sql
INSERT INTO dispatch_log (
    dispatch_id, thread_id, agent, task_summary,
    initial_tier, final_tier, tier, review_mode, tier_deviation,
    model, status, error_code, duration_ms,
    input_tokens, output_tokens, files_changed, findings_count,
    created_at
)
VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,    -- initial_tier / final_tier / tier(=final_tier) / review_mode / tier_deviation
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    datetime('now')
);
```

**必填字段**：
- `dispatch_id`: `disp-{thread_id}-{superstep}`
- `task_summary`: ≤100 字，描述任务核心（如"React 状态管理重构"）
- `initial_tier` / `final_tier` / `tier`: T0/T1/T2/T3；`tier` 兼容旧字段，值 = `final_tier`
- `review_mode`: `none` / `lightweight` / `full`（T0=none，其余按 review_mode 决策表确定）
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

## 相关策略

- `fact_dedup.md` — fact_store 写入
- `failure_recorder.md` — failure_db 写入
- `model_calibration.md` — 模型校准更新
- `../../instructions/workflow-core.md` §收尾自检 — 硬门禁入口