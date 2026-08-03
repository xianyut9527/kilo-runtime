---
description: 生命周期阶段 PLANNING — 设计门。T1+ 编码前必须经过 planner 输出方案+验收点+DAG。
model_capability: deep-reasoning
token_budget: 12000
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 角色名 = 智能体文件名（去 .md）或其 frontmatter 显式 role 字段；
# bootstrap/doctor 校验：每个角色 ≥1 个智能体 mount 覆盖本阶段主槽，缺一 → [ASSEMBLY_FAIL]
required_roles: [planner]
---

# lifecycle/stages/planning

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 输入

- `INIT` 输出的 intent_type + tier + review_mode
- 用户请求（完整需求 + 约束）
- 项目技术栈上下文
- 相关代码文件（由智能体按需读取）

## 处理流程

1. **项目上下文确认**：读取 AGENTS.md / kilo.json / 入口目录，确认技术栈与约束。
2. **澄清问题**（T2 完整规划必做）：模糊术语（用户/账户/任务/会话）逐一精确定义。
3. **方案提议**：每个重要决策列 2-3 个可选方案，给出推荐。
4. **重复模式扫描**（UI 与非 UI 同等适用，必做）：全量扫描同类实现模式 → 组件化/共享抽象方案 → 无法组件化的例外理由。
5. **需求扩散评估**：识别同类入口、状态、校验、提交、回显路径 → 覆盖矩阵。
6. **任务 DAG**：按依赖排序，标注可并行/必须串行，每单元含目标+关键文件+验收标准。
7. **风险与应对**：列出已知风险及缓解策略。

## 输出信号

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"
transition_context:
  tier: "T1" | "T2"
  design_gate_type: "short" | "full"
  units: [{ unit_id, goal, key_files, dependencies, acceptance_criteria }]
scan_coverage: "full" | "partial" | "N/A"
componentization_plan: "yes" | "no" | "N/A"
extension_points:
  - domain: "string"
    mechanism: "string"
    rationale: "string"
forbidden_files: ["string"]
```

## 路由规则（边定义见 graph.yaml）

- `PLANNING → EXECUTING`：方案输出后无条件流转（执行类 T1/T2 必经）

## 硬规则

- ❌ "太简单不需要设计" — 简单任务正是未审视假设造成返工的高发区。
- ❌ 未包含重复模式扫描清单就放行（UI 与非 UI 同等要求）。
- ❌ 主槽智能体自验方案通过并自行进入下一阶段。

