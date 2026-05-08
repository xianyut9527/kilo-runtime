---
description: 以 ensemble 高级编排模式启动。支持单模型降级与多模型并行，自动根据任务复杂度选择最优执行路径。
agent: ensemble
subtask: true
---

启动 Ensemble Workflow（高级编排模式）。

**行为**：将 `$ARGUMENTS` 作为任务包以 ensemble 模式执行。ensemble 是 coderAgent 的超集，内置自动路由，无需手动选择入口。

**参数语义**：
- 若来自用户直接调用：`$ARGUMENTS` = 需求原文
- 若来自 coderAgent 升级：`$ARGUMENTS` = 结构化 EscalationPackage

**路径选择**：
- 简单任务（单文件小改、已知修复、子任务 ≤2）→ 自动走单模型路径，直接 `Task @engineer`，高效等价于 coderAgent
- 复杂/高价值任务（核心算法、资金安全、用户明确要求多模型）→ 自动启动多模型并行，fork worktree，多版本对比选取

**职责边界**：本命令激活 ensemble 高级编排模式，不定义具体流程。所有执行逻辑由 `agent/ensemble.md` 统一状态机调度。ensemble 是唯一的顶层编排入口，coderAgent 作为其可编入成员，既可独立响应日常任务，也可在 ensemble 的并行池中作为标准基线参与多版本对比。
