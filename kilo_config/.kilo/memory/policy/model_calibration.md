# Model Calibration 策略

> **模块位置**：`.kilo/memory/policy/model_calibration.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义 model_calibration 表的更新规则与补偿 prompt 触发逻辑

## 更新规则（每次 dispatch 后）

每次 dispatch 后更新对应模型+角色+任务类型的记录：

```sql
UPDATE model_calibration SET
  success_rate = (success_rate * sample_count + ?) / (sample_count + 1),
  avg_findings = (avg_findings * sample_count + ?) / (sample_count + 1),
  sample_count = sample_count + 1,
  last_evaluated_at = datetime('now')
WHERE model = ? AND agent_role = ? AND task_type = ?;
```

**输入语义**：
- `success_rate` 输入：status = DONE 则 1.0，否则 0.0
- `avg_findings` 输入：checker findings_count
- `structure_adherence` 输入：reviewer 评分（如有）

## UPSERT 形式（推荐）

```sql
INSERT INTO model_calibration (calibration_id, model, agent_role, task_type, success_rate, avg_findings, sample_count, last_evaluated_at)
VALUES (
  'cal-' || ? || '-' || ? || '-' || ?,
  ?, ?, ?,
  ?, -- success_rate: DONE=1.0, DONE_WITH_CONCERNS=0.7, FAILED=0.0
  ?, -- avg_findings: checker findings_count
  1,
  datetime('now')
)
ON CONFLICT(calibration_id) DO UPDATE SET
  success_rate = (model_calibration.success_rate * model_calibration.sample_count + excluded.success_rate) / (model_calibration.sample_count + 1),
  avg_findings = (model_calibration.avg_findings * model_calibration.sample_count + excluded.avg_findings) / (model_calibration.sample_count + 1),
  sample_count = model_calibration.sample_count + 1,
  last_evaluated_at = datetime('now');
```

## 回写触发时机

- **正常交付**（status = DONE）：任务完成后立即回写，`success_rate` 输入 = 1.0
- **降级交付**（status = DONE_WITH_CONCERNS）：任务完成后回写，`success_rate` 输入 = 0.7
- **失败交付**（status = FAILED / BLOCKED / TIMEOUT）：任务终止后回写，`success_rate` 输入 = 0.0

## 校准触发补偿 prompt 更新

当 `success_rate < 0.7` 且 `sample_count >= 5` 时：

```sql
SELECT model, agent_role, task_type, success_rate, sample_count
FROM model_calibration
WHERE success_rate < 0.7 AND sample_count >= 5;
```

**触发后动作**：
1. 查询该模型+角色+任务类型的历史失败模式（`failure_db` JOIN `dispatch_log`）
2. 提取共同偏差（如「跳过依赖分析」「过度自信」）
3. 生成新的 `compensation_prompt`
4. 更新 `model_calibration.compensation_prompt`
5. 在下次委派同类型任务时自动注入新补偿 prompt

## 校准效果验证

每次更新 `compensation_prompt` 后，必须连续跟踪 3 次同类型任务的成功率：

- 3 次中 ≥2 次成功 → 校准有效，保留新 prompt
- 3 次中 <2 次成功 → 校准无效，回退到上一个有效 prompt，并标记「该偏差模式需人工分析」

## 基线初始化（首次部署）

首次部署后，可插入各 agent 的初始占位记录，避免首次动态校准时 `sample_count = 0` 导致的除零或空值问题：

```sql
INSERT INTO model_calibration (
    calibration_id, model, agent_role, task_type,
    success_rate, avg_findings, sample_count, last_evaluated_at
) VALUES (
    'cal-glm-reviewer-config', 'hx/glm-5.2', 'reviewer', 'config-review',
    1.0, 0, 1, datetime('now')
)
ON CONFLICT(calibration_id) DO NOTHING;
```

> 基线记录仅用于避免除零；真实成功率会随 `dispatch_log` 写入被覆盖。

## 相关策略

- `dispatch_recorder.md` — dispatch_log 写入（calibration 的输入数据）
- `failure_recorder.md` — failure_db 写入（calibration 的失败模式来源）