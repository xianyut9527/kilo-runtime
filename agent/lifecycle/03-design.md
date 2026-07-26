---
description: 生命周期阶段 03 — 设计门。T1+ 编码前必须经过 planner 设计门，输出方案+验收点+DAG。
stage_id: S05_PLANNING
agents:
  - planner
previous_stage: S03_SIZING
next_stage: S07_EXECUTING
---

# lifecycle/03-design

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S05_PLANNING` |
| **上一阶段** | `S03_SIZING` |
| **下一阶段** | `S06_PLAN_APPROVED` → `S07_EXECUTING` |
| **加载智能体** | `planner`（`agent/planner.md`，T1+ 加载） |
| **模型偏好** | `registry:deep-reasoning`（架构分析、长上下文） |
| **token 预算** | ≤ 12000 |

## 输入

- `S03` 输出的 task_type + review_mode
- 用户请求（完整需求 + 约束）
- 项目技术栈上下文
- 相关代码文件（由 capability 按需读取）

## 处理流程

1. **项目上下文确认**：读取 AGENTS.md / kilo.json / 入口目录，确认技术栈与约束。
2. **澄清问题**（T2 完整规划必做）：模糊术语（用户/账户/任务/会话）逐一精确定义。
3. **方案提议**：每个重要决策列 2-3 个可选方案，给出推荐。
4. **重复模式扫描**（UI/样式/行为任务必做）：全量扫描同类症状 → 组件化/共享抽象方案 → 无法组件化的例外理由。
5. **需求扩散评估**：识别同类入口、状态、校验、提交、回显路径 → 覆盖矩阵。
6. **任务 DAG**：按依赖排序，标注可并行/必须串行，每单元含目标+关键文件+验收标准。
7. **风险与应对**：列出已知风险及缓解策略。

## 输出信号

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"
transition_context:
  task_type: "T1" | "T2" | "T3"
  design_gate_type: "short" | "full"
  units: [{ unit_id, goal, key_files, dependencies, acceptance_criteria }]
quality_gate:
  design_gate_pass: true | false   # 必须显式输出 [DESIGN_GATE_PASS]
  scan_coverage: "full" | "partial" | "N/A"
  componentization_plan: "yes" | "no" | "N/A"
```

## 路由规则

- `design_gate_pass: true` → 进入 `S07_EXECUTING`
- `design_gate_pass: false` 或 `NEEDS_CONTEXT` → 返回 `S05_PLANNING` 重走，或升级人工决策
- 跳过/未过设计门 → `[DESIGN_GATE_MISS]`（下游 verifier 会 FAIL）

## 反模式

- ❌ "太简单不需要设计" — 简单任务正是未审视假设造成返工的高发区。
- ❌ 未包含重复模式扫描清单就放行 coder。
- ❌ 自行进入执行阶段，未经 `[DESIGN_GATE_PASS]` 标记。
