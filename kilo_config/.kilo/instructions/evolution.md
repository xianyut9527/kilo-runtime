# Evolution 自进化规则

> 目标：任务结束后自动提取 Pattern / AntiPattern，更新全局记忆，驱动系统自我进化。
> 对应 brain-architecture L7: 执行数据 → 反思 → 提炼 → 应用

## 四步闭环

```
① 执行 → 写入 dispatch_log（什么任务 + 什么策略 + 什么模型 + 什么结果）
② 反思 → 从 dispatch_log + checker 结果提取 Pattern / AntiPattern
③ 提炼 → 写入全局 sqlite（fact_store / failure_db / model_calibration）
④ 应用 → 生成 Strategy Proposal，经 Regression Test → 应用
```

## 触发条件

T1+ 任务交付后，**必须**执行进化步骤。T0 可选。

## 步骤 1：执行记录（dispatch_log）

coderAgent 在任务结束时，通过 sqlite MCP 写入：

```sql
INSERT INTO dispatch_log (dispatch_id, thread_id, agent, task_summary, tier, model, status, error_code, duration_ms, files_changed, findings_count, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));
```

**必填字段**：
- `dispatch_id`: `disp-{thread_id}-{superstep}`
- `task_summary`: ≤100 字，描述任务核心（如"React 状态管理重构"）
- `tier`: T0/T1/T2/T3
- `model`: 实际使用的模型名
- `status`: DONE / DONE_WITH_CONCERNS / FAILED / BLOCKED / TIMEOUT
- `findings_count`: checker 发现的问题数（0 表示一次通过）

## 步骤 2：Pattern 提取（fact_store）

### AntiPattern 提取条件（满足任一）

1. **checker 发现重复问题**：同一类问题（如"缺少边界检查"）在 2 次以上任务中出现
2. **fixer 连续修复**：fixer 轮数 ≥2
3. **用户反馈"还是有问题"**：用户要求返工
4. **reviewer 标记安全/架构风险**：`risk = HIGH`

### Pattern 提取条件（满足全部）

1. 任务一次通过（checker findings_count = 0）
2. 策略可复用（非项目特定代码）
3. reviewer 三视角全部通过

### 提取模板

```sql
INSERT INTO fact_store (fact_id, category, trigger, condition, action, confidence, evidence, tags, hit_count, created_at, updated_at)
VALUES (?, 'ANTIPATTERN', '触发场景', '触发条件', '推荐做法', 0.5, '["dispatch_id"]', '["tag1", "tag2"]', 1, datetime('now'), datetime('now'));
```

**confidence 初始值**：
- AntiPattern: 0.5（首次提取）
- Pattern: 0.6（首次提取）
- 经 3 次验证后上调至 0.8
- 经 5 次验证后上调至 0.9

### 去重规则

插入前检查：
```sql
SELECT fact_id FROM fact_store 
WHERE trigger = ? AND action = ? AND archived = 0;
```
- 已存在 → UPDATE hit_count + 1, confidence 上调, updated_at = now
- 不存在 → INSERT 新记录

## 步骤 3：Failure 分析（failure_db）

### 写入条件

满足任一：
- fixer 连续 2 轮同症状
- Circuit Breaker 触发
- 用户反馈"还是有问题/不对/遗漏"

### 写入模板

```sql
INSERT INTO failure_db (failure_id, dispatch_id, root_cause_level, symptom, fix_strategy, fix_location, verified, tags, created_at)
VALUES (?, ?, '执行层|方法层|需求层', '症状描述', '修复策略', '文件:行号', 0, '["tag1"]', datetime('now'));
```

**verified 更新时机**：fixer 修复后，checker 重新验证通过 → UPDATE verified = 1, resolved_at = now

**same_symptom_count 更新**：
```sql
UPDATE failure_db SET same_symptom_count = same_symptom_count + 1 
WHERE symptom = ? AND resolved_at IS NULL;
```

## 步骤 4：模型校准（model_calibration）

### 更新规则

每次 dispatch 后更新对应模型+角色+任务类型的记录：

```sql
UPDATE model_calibration SET
  success_rate = (success_rate * sample_count + ?) / (sample_count + 1),
  avg_findings = (avg_findings * sample_count + ?) / (sample_count + 1),
  sample_count = sample_count + 1,
  last_evaluated_at = datetime('now')
WHERE model = ? AND agent_role = ? AND task_type = ?;
```

- `success_rate` 输入：status = DONE 则 1.0，否则 0.0
- `avg_findings` 输入：checker findings_count
- `structure_adherence` 输入：reviewer 评分（如有）

### 校准触发补偿 prompt 更新

当 `success_rate < 0.7` 且 `sample_count >= 5`：
1. 查询该模型的失败模式
2. 提取共同偏差
3. 更新 `compensation_prompt`

## 进化优先级

| 优先级 | 动作 | 触发条件 |
|--------|------|----------|
| P0 | 写入 dispatch_log | 每次 T1+ 任务结束 |
| P1 | 写入 failure_db | 任务失败或 fixer 多轮 |
| P1 | 写入 fact_store | 发现可复用 Pattern/AntiPattern |
| P2 | 更新 model_calibration | 每次 dispatch 后 |
| P3 | Skill 升级提案 | fact_store.confidence >= 0.8 且 hit_count >= 3 |

## 禁止事项

- 不写入项目特定代码（如具体变量名、业务逻辑）
- 不写入敏感信息（API Key、密码、内部域名）
- 不重复写入相同 Pattern（先查后写）
- 不虚构未验证的经验（必须有 dispatch_id 作为 evidence）
