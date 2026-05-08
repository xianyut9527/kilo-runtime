---
description: 多模型并行执行命令。委托 ensemble agent 驱动完整流水线。
agent: ensemble
subtask: true
---

启动 Ensemble Workflow。

**行为**：将 `$ARGUMENTS` 作为任务包委托给 `@agent/ensemble.md`。

**参数语义**：
- 若来自用户直接调用：`$ARGUMENTS` = 需求原文
- 若来自 coderAgent 升级：`$ARGUMENTS` = 结构化 EscalationPackage

**职责边界**：本文件仅做命令路由，不定义流程步骤、不处理 worktree、不执行验证。所有执行逻辑下沉至 `@agent/ensemble.md`。
