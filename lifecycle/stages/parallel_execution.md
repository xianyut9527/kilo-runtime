---
description: 生命周期阶段 PARALLEL_EXECUTION — T3 端到端副本竞赛。3 个不同厂商/架构模型在独立 worktree 中各执行完整 T2 流程（PLANNING→EXECUTING→QUALITY），主图在此汇聚等待全部完成。
model_capability: orchestration
required_roles: [conductor]
---

# lifecycle/stages/parallel_execution

> T3 核心并行阶段。3 个不同厂商/架构模型在独立 worktree 中各执行完整 T2 流程（端到端副本竞赛），产出 3 套实现，供下游 SYNTHESIZING 选优合并。

## 设计理念

T3 采用**端到端副本竞赛**——3 个模型各自独立完成完整任务闭环：

| 维度 | T3 |
|------|-----|
| 并行范围 | 端到端全阶段（PLAN→EXEC→QUALITY） |
| 物理隔离 | git worktree 独立工作区 |
| 代码实现 | 3 路各自执行（3 套实现） |
| 融合时机 | DELIVERING 前（结果选优） |
| 验证成本 | 3× QUALITY（各副本独立验证） |

## worktree 创建协议

**命名规范**：`wt-{task_id}-{model_key}`
- `task_id`：主图 task_context.task_id（如 `t2w-20260802`）
- `model_key`：模型简称（如 `kimi`、`deepseek`、`glm`），取自 `kilo.json agent.<name>.model` 前缀

**路径**：`{repo_root}/.kilo/worktrees/wt-{task_id}-{model_key}`

**创建命令**：
```bash
git worktree add -b wt-{task_id}-{model_key} .kilo/worktrees/wt-{task_id}-{model_key}
```

**初始化**：
- 复制主图 `task_context` 到 worktree 独立副本（各副本有独立的 task_context_<task_id>.json）
- 副本 sizing.tier 保持 T2（副本内按 T2 流程执行）
- 副本 intent_type = EXECUTION

## 调度协议

**启动方式**：conductor 通过 `agent_manager` **worktree mode** 启动 3 session：
- 每个 session 绑定一个 worktree 目录
- 每个 session 绑定一个不同模型（kimi-k2.6 / deepseek-v4-pro / glm-5.2）
- 各 session 独立执行完整生命周期（INTENT→SIZING→PLANNING→EXECUTING→QUALITY）

**多样性约束**：3 个模型必须不同厂商/不同架构（diversity_map 校验）
- 违反 → `[DIVERSITY_VIOLATION]` → 标记 `[T3_PARALLEL_DEGRADED]` → tier 降 T2 单路

## 监控与超时

**轮询间隔**：30s（检查各 worktree 的 `task_context.current_stage`）

**完成判定**：3 个 worktree 的 `current_stage` 均达到 `QUALITY` 且 `quality.verdict ∈ {PASS, CIRCUIT_BREAKER}`

**超时**：
- 单个 worktree 超时：`per_agent_s × per_tier_multiplier[T3]`（默认 600 × 2.0 = 1200s = 20min）
- 全局超时：3 个 worktree 全部启动后 90min（3× 单路预算 + 调度开销）
- 超时 → `[AGENT_TIMEOUT]` → 该 worktree 标 `TIMEOUT` → SYNTHESIZING 阶段仅评估已完成副本

## 降级路径

| 场景 | 处理 |
|------|------|
| 3 副本全 FAIL / 全 TIMEOUT | `[T3_PARALLEL_DEGRADED]` → conductor 将 tier 降 T2 → 单路重走 |
| 2 副本 FAIL + 1 PASS | SYNTHESIZING 直接选优 PASS 副本（无人工决策） |
| 3 副本 CONDITIONAL_PASS | SYNTHESIZING confidence < HIGH → `on_fail: pause` 等人决策 |

## 回收协议

**时机**：SYNTHESIZING 完成后（无论成败）

**步骤**：
1. `agent_manager stop <session_id>` 停止全部 3 session
2. `git worktree remove .kilo/worktrees/wt-{task_id}-{model_key}` 移除 worktree 目录
3. `git branch -D wt-{task_id}-{model_key}` 删除分支（git 历史保留在 reflog 供审计）

**异常**：worktree 移除失败 → 标 `[WORKTREE_LEAK]` → conductor 告警但不阻塞交付

## 与主图的数据流

```
主图 SIZING(T3) → PARALLEL_EXECUTION
  ├─ 创建 worktree-A + 启动 model-A session → 副本 A 执行 T2 → 产出 result-A
  ├─ 创建 worktree-B + 启动 model-B session → 副本 B 执行 T2 → 产出 result-B
  └─ 创建 worktree-C + 启动 model-C session → 副本 C 执行 T2 → 产出 result-C
  → 全部完成后 conductor 汇总：
     task_context.parallel_execution.results = [
       {model:'kimi', verdict:'PASS', score:0.92, worktree_path:'...', branch:'...'},
       {model:'deepseek', verdict:'PASS', score:0.88, ...},
       {model:'glm', verdict:'CONDITIONAL_PASS', score:0.71, ...}
     ]
  → 写入 task_context.parallel_execution.all_done = true
  → 流转 SYNTHESIZING
```

## 隔离原则

- **git 隔离**：各 worktree 独立 git index，不同分支，互不干扰
- **文件系统隔离**：各 worktree 独立目录，无共享文件
- **task_context 隔离**：各副本有独立的 task_context_<task_id>.json，主图不读副本内部字段
- **provider 隔离**：各 session 可独立指定 provider，429 互不影响（但受并发上限约束）
