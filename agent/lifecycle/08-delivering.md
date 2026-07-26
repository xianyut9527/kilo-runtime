---
description: 生命周期阶段 08 — 交付。闭环确认、变更回顾、记忆沉淀、task_context 归档、分支收尾。
stage_id: S16_DELIVERING
agents:
  - orchestrator
previous_stage: S14_REVIEW_PASSED
next_stage: S17_DONE
---

# lifecycle/08-delivering

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S16_DELIVERING` |
| **上一阶段** | `S10_CHECK_PASSED`（T0/T1）或 `S14_REVIEW_PASSED`（T2+） |
| **下一阶段** | `S17_DONE`（归档） |
| **加载智能体** | `orchestrator`（内建，直接调用 memory.db + 归档 task_context） |
| **模型偏好** | `registry:fast-reasoning`（轻量整理） |
| **token 预算** | ≤ 6000 |

## 输入

- 所有已完成单元的变更摘要 + 验收映射表
- verifier 正向验证报告 + reverse-auditor 反向审计报告（T2+）
- side-checker 侧向验证报告（T2+）+ reviewer 审查报告（T1+ 统一 full）
- 强制流程日志（完整生命周期节点）
- 本次任务中引用的 fact_id / failure_id 列表
- task_context.json（完整任务上下文）

## 交付内容

### 1. 闭环确认（验收 → 实现位置 → 验证证据 → 状态）

```
| 验收标准 | 实现位置 | 验证证据 | 状态 |
|----------|----------|----------|------|
```

### 2. 变更回顾
- **改了什么**：文件列表 + 函数/模块变更摘要
- **为什么改**：根因或需求来源
- **影响范围**：调用方、下游模块、API 消费者
- **清理调试代码**：确认无 console.log / debugger / 临时文件残留

### 3. 经验沉淀（sqlite 优先，md 仅作索引兜底）

**T1+ 必走「收尾自检」硬门**：
- M4：去重 — 查询 `fact_store` 是否已有同类记录
- M5：新经验写入 — INSERT `fact_store`（Pattern confidence=0.6，AntiPattern=0.5）
- M6：反馈 — `[memory:helpful=...]` / `[memory:misleading=...]`（无反馈显式 `[memory:helpful=none]`）
- M7：`failure_db` 写入（如有失败案例）
- M8：`dispatch_log` 写入 + `model_calibration` 更新

> 未执行 → `[MISSING_MEMORY_WRITE]` 阻塞交付。

### 4. 分支收尾协议
1. git status 清理（无未 staged 调试代码）
2. 单提交对应单定级单元
3. 告知用户分支去向，不擅自 push 合并
4. worktree 隔离清理（如适用）

## 输出信号

```yaml
status_signal: "DONE"
transition_context:
  units_completed: int
  memory_write_status: "OK" | "DEGRADED" | "MISSING"
quality_gate:
  acceptance_map_verified: true | false
  memory_write_complete: true | false
  branch_cleanup_done: true | false
```

## 路由规则

- `DONE` + 所有 quality_gate 通过 → `S17_DONE`（生命周期结束）
- `memory_write_status: MISSING` → `[MISSING_MEMORY_WRITE]` 阻塞，回到 `S16_DELIVERING` 补充
- `memory_write_status: DEGRADED`（memory.db 不存在）→ 不阻塞，输出提示后继续

## 记忆提示即时输出

- 召回：`🧠 [memory:recall] 注入 fact=X + context=Y | ~Nk tokens`
- 写入：`💾 [memory:write] fact_store AP-XXX hit N→N+1 | dispatch_log +1`
- ID 必带：fact_id / failure_id / dispatch_id 不可省略
