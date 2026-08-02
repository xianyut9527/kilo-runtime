# AGENTS.md

> Kilo 启动时通过 `findUp` 定位本文件，并将 `.kilo/instructions/core.md` + `.kilo/instructions/workflow-core.md` + `.kilo/instructions/reflection.md` 作为通用基线注入。
> 本文件只保留入口说明；具体规则见下表文件，不在此展开。

| 规则域 | 文件 |
|--------|------|
| 通用基线、安全、资源、意图分类 | `.kilo/instructions/core.md` |
| 任务定级、单元闭环、质量门禁、交付 | `.kilo/instructions/workflow-core.md` |
| 反思与错误恢复 | `.kilo/instructions/reflection.md` |
| Kilo 专属硬约束速查 | `.kilo/instructions/guardrails.md` |
| 智能体行为 + 生命周期挂载声明 | `agent/*.md` |
| 生命周期 DAG | `lifecycle/graph.yaml` |
| 阶段执行逻辑 + `required_roles` | `lifecycle/stages/*.md` |
| 定级默认组合 + 熔断阈值 | `lifecycle/config.yaml` |
| 模型能力倾向参考 | `docs/model-registry.md` |
| 记忆模块入口 | `.kilo/memory/README.md` |

## 核心理念

- **编写智能体就是编写代码**：智能体 prompt 可含代码或白话指令，每个智能体是可独立测试、迭代、强化的工程单元。
- 质量提升靠工程化手段：**生命周期 DAG、视角物理隔离、响应式 hooks 循环、独立验证、记忆自进化**。

## 配置仓库治理

- 配置仓库（kilo_config）中的 `.md`、`.yaml`、`.json`、`agent/`、`lifecycle/` 改动必须经由编排流程（task_context + dispatch_log）完成；未提交的改动会被 `orchestration-guard --strict` 拦截（含 git pre-commit hook）。直接手工修改绕过编排是合规违规。

## 禁止事项

- 禁止手工维护 `kilo.json` 中的 `agent.*.prompt`（源 = `agent/*.md` frontmatter `description`，由 `scripts/sync-agent-prompt.mjs` 自动生成）。
- 禁止删除/重命名 `lifecycle/graph.yaml` 节点、绕过 `required_roles`、绕过 QUALITY hooks 循环。
