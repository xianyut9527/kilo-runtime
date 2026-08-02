# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类、安全约束、资源与生命周期管理；`workflow-core.md` — 执行类任务定级（T0–T3）、单元闭环、门禁、交付、强制流程日志；`reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 智能体行为 + frontmatter 生命周期声明（v6 单源，丢文件即注册）；`lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯拓扑）+ 阶段执行逻辑
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）；`docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考）
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

## 强制编排锚点（每个项目启动时自动加载）

> **核心理念**：**编写智能体就是编写代码**——智能体 prompt 可含代码也可含白话指令（对话式编程），每个智能体是可独立测试、迭代、强化的工程单元。质量提升靠工程化手段（生命周期 DAG、视角物理隔离、响应式 hooks 循环、独立验证、记忆自进化），不靠习惯说教。

1. **意图判定优先** → 见 `core.md` §意图分类
2. **两阶段定级** → 见 `workflow-core.md` §任务定级
3. **单元闭环** → 见 `workflow-core.md` §单元化编排
4. **验收必附映射表** → 见 `workflow-core.md` §质量门禁
5. **SCOPE_CREEP** → 见 `workflow-core.md` §质量门禁
6. **自验无效** → 见 `core.md` §流程强制基线
7. **memory/skills/自进化合规** → 见 `core.md` §记忆探测 + `.kilo/memory/AGENTS.md`
8. **流程违规即停** → 见 `core.md` §流程强制基线
9. **临时文件** → 见 `core.md` §资源生命周期管理
10. **组件化与重复模式治理** → 见 `workflow-core.md` §重复模式修复
11. **生命周期驱动** → 见 `workflow-core.md` §默认路由
12. **委派稳定性硬门** → 见 `.kilo/instructions/guardrails.md` #44-#45
13. **委派包体积硬门** → 见 `.kilo/instructions/guardrails.md` #46-#47
14. **agent.prompt 非手动维护** → 见 `.kilo/instructions/guardrails.md` #3
15. **生命周期架构+hooks不可变** → 见 `.kilo/instructions/guardrails.md` #4

## Guardrails（负面约束速查）见 `.kilo/instructions/guardrails.md`（仅 Kilo 专属硬约束）。
