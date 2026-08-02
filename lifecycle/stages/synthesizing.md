---
description: 生命周期阶段 SYNTHESIZING — T3 选优合并。汇总 3 worktree 副本结果，按多维度评分选优，合并 champion 实现到主线，产出最终交付物。
model_capability: synthesis
token_budget: 8000
required_roles: [conductor]
---

# lifecycle/stages/synthesizing

> T3 汇聚阶段。3 worktree 并行执行完成后，SYNTHESIZING 负责：1) 评分选优；2) 合并 champion diff；3) 降级/熔断决策。

## 输入

`task_context.parallel_execution.results[]`（由 PARALLEL_EXECUTION 阶段写入）：

| 字段 | 类型 | 说明 |
|------|------|------|
| model | string | 模型简称（kimi/deepseek/glm） |
| verdict | string | PASS / CONDITIONAL_PASS / FAIL / TIMEOUT |
| score | number | 综合评分（0-1，由 worktree 内 QUALITY 阶段汇总产出） |
| test_pass_rate | number | 0-1 |
| code_coverage | number | 0-1 |
| complexity_score | number | 越低越好（原始值，SYNTHESIZING 内归一化） |
| worktree_path | string | worktree 绝对路径 |
| branch | string | git 分支名 |

## 选优公式

```
synthesis_score =
  0.40 × test_pass_rate
+ 0.25 × code_coverage
+ 0.15 × complexity_score_inv    # 越低越好 → 归一化后取 1 - normalized
+ 0.20 × quality_verdict_weight   # PASS=1, CONDITIONAL_PASS=0.5, FAIL/TIMEOUT=0
```

**复杂度归一化**：`complexity_score_inv = 1 - (complexity - min) / (max - min + 1e-6)`
- 若全部 complexity 相同 → 均分 0.15 权重（避免除零）

**champion**：`max(synthesis_score)` 对应的副本

## 自动选优 vs 人工决策

**自动选优**（无需人工干预）：
- 恰好 1 个副本 PASS + 其余 FAIL/TIMEOUT → 自动选优 PASS 副本
- champion score ≥ 0.85 且 (champion_score - 2nd_score) ≥ 0.15 → 自动选优

**人工决策**（`on_fail: pause`）：
- champion score < 0.70 → confidence 不足
- (champion_score - 2nd_score) < 0.10 → 差异不显著
- 3 副本 CONDITIONAL_PASS（无 PASS）→ 无 champion
- 用户显式要求人工复核（`task_context.synthesizing.manual_review == true`）

**人工决策界面**：conductor 输出 3 副本对比表（model/verdict/score/diff 摘要），等用户确认 champion。

## 合并协议

**champion 策略**（默认）：只取 champion 副本的完整 diff，放弃其余副本。
- 优点：无冲突、语义一致
- 缺点：可能丢失非 champion 的独到改进

**补丁吸收策略**（可选，需用户显式启用）：
- champion 为主，检查非 champion 副本是否有 champion 未覆盖的独到点
- 独到点不矛盾 → 吸收追加（标记 `[补充点] 来源:<model>`）
- 独到点矛盾 → 保留冲突标注（标记 `[冲突] 来源:<model>|champion:<内容>|alt:<内容>`），不自动合并，等 QUALITY_FINAL 审查

**合并执行**：
1. `git checkout {main_branch}`（回到主线）
2. `git merge --squash {champion_branch}`（合并 champion 副本）
3. 若冲突 → 标 `[MERGE_CONFLICT]` → `on_fail: pause` 等人解决
4. 合并后运行 `lifecycle-doctor.mjs` 回归验证

## 降级路径

| 场景 | 处理 |
|------|------|
| 3 副本全 FAIL / 全 TIMEOUT | `[T3_SYNTH_DEGRADED]` → conductor 将 tier 降 T2 → 单路重走（复用原 task_context，设 `t3_degrade_flag: true`） |
| 3 副本 CONDITIONAL_PASS 且无 PASS | 同左（降级） |
| champion merge 后 doctor FAIL | `[MERGE_REGRESSION]` → 回滚 merge → `git reset --hard HEAD` → 标 DEGRADED → 等人决策 |
| merge 冲突无法自动解决 | `[MERGE_CONFLICT]` → `on_fail: pause` → 等人手动解决 |

## 输出

写入 `task_context.synthesizing`：

```json
{
  "champion": "kimi",
  "champion_score": 0.92,
  "scores": {
    "kimi": 0.92,
    "deepseek": 0.88,
    "glm": 0.71
  },
  "strategy": "champion-only",    // 或 "champion-with-patches"
  "merged_branch": "main",
  "synth_verdict": "PASS",         // PASS / CIRCUIT_BREAKER / DEGRADED
  "annotations": ["[补充点] 来源:deepseek|补充内容:..."]   // 补丁吸收时填充
}
```

## 流转条件

- `synth_verdict == 'PASS'` → `SYNTHESIZING → DELIVERING`
- `synth_verdict == 'CIRCUIT_BREAKER'` → `SYNTHESIZING → DELIVERING`（带降级标记 `[QUALITY_CB]`）
- `synth_verdict == 'DEGRADED'` → conductor 降级 tier 为 T2，重走单路

## 与 QUALITY 的关系

SYNTHESIZING 本身不做验证——它是**选优合并**阶段。合并后的最终 diff 在 DELIVERING 前可选经过轻量 QUALITY_FINAL（正向验证 + 静态审查双视角，非 hooks 循环），确保 champion 合并无 regression。

QUALITY_FINAL 是可选的（T3 默认启用，config.yaml 可关闭以节省成本）。
