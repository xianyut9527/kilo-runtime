---
description: 生命周期阶段 02 — 任务定级。按决策树预估 T0/T1/T2/T3，决定后续生命周期路径。
stage_id: S03_SIZING
agents:
  - orchestrator
previous_stage: S02_INTENT_DONE
next_stage: S07_EXECUTING
---

# lifecycle/02-sizing

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S03_SIZING`（跳 S02 内部过渡） |
| **上一阶段** | `S02_INTENT_DONE` |
| **下一阶段** | `S07_EXECUTING`（T0 直达）或 `S05_PLANNING`（T1+） |
| **加载智能体** | `orchestrator`（内建，无需 task 启动） |
| **模型偏好** | `registry:fast-reasoning` |
| **token 预算** | ≤ 4000 |

## 输入

- `S01` 输出的 intent_type（必须为 EXECUTION）
- 用户请求的具体内容
- 项目上下文（技术栈、已有架构、最近 commit）

## 处理流程（阶段 A·预估）

按 `workflow-core.md` 决策树执行：

```
T0: ≤2 行改动 / 单一文件 / 无跨模块影响 / 无测试/类型检查需求
     → 直达执行，无设计门，无 reviewer

T1: 多文件但单一目标 / 有测试需求 / 需简单验证
     → 短设计门（1-3 句）→ planner → coder → verifier → reviewer(full)

T2: 多模块影响 / 需架构决策 / 有需求扩散风险 / 需完整 DAG
     → 完整设计门 → 单元 DAG → planner → coder → verifier → reviewer(full)

T3: 核心逻辑 / 安全敏感 / 用户明确要求 multiModel
     → multiModel 并行生命周期（见 `agent/multiModel.md`）
```

## 输出信号

```yaml
status_signal: "DONE" | "NEEDS_CONTEXT"
transition_context:
  task_type: "T0" | "T1" | "T2" | "T3"
  estimated_units: int           # 预估单元数
  design_gate_required: true | false
  review_mode: "full" | "N/A"
quality_gate:
  sizing_rationale: "string"     # 定级理由（强制输出）
  confidence: "high" | "medium" | "low"
```

## 路由规则

| task_type | 下一状态 | 设计门 | reviewer |
|-----------|----------|--------|----------|
| T0 | `S07_EXECUTING` | 否 | N/A |
| T1 | `S05_PLANNING`（短）→ `S07_EXECUTING` | 短设计门 | full |
| T2 | `S05_PLANNING`（完整）→ `S07_EXECUTING` | 完整设计门 | full |
| T3 | `MM_INIT`（multiModel 生命周期） | 完整设计门 | full |

## 阶段 B·校准（后置）

在 `S13_REVIEWING` 阶段，基于实际执行的 unit DAG 和变更范围，复核实际等级：
- 若实际单元数 > 预估 50% → 升级 task_type 并标注 `[LEVEL_UP]`
- 若实际未触发需求扩散 → 降级并标注 `[LEVEL_DOWN]`（极少发生）

## 硬规则

- **设计门硬门**：T1+ 编码前必须过 planner 设计门。"太简单不需要设计"是反模式。
- **重复模式硬门**：涉及 UI/样式/行为且症状可能跨页面/组件时，定级必须包含「全量扫描清单 + 组件化/共享抽象方案」评估。
- **multiModel 配额降级硬门**：触发 multiModel 前必扫 `dispatch_log` 查过去 24h T3 失败率（≥30% → 跳过 multiModel 降级 single-coder）。
