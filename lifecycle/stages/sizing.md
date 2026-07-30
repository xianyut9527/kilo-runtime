---
description: 生命周期阶段 SIZING — 任务定级。按决策树预估 T0/T1/T2/T3，写入 config.agents，决定后续生命周期路径。
executor: conductor        # conductor 内建主槽，不经 mount 挂载
model_capability: fast-reasoning
token_budget: 4000
---

# lifecycle/stages/sizing

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`，定级默认组合见 `lifecycle/config.yaml`。

## 输入

- `INTENT` 输出的 intent_type（EXECUTION 或 INQUIRY）
- 用户请求的具体内容
- 项目上下文（技术栈、已有架构、最近 commit）

## 处理流程（阶段 A·预估）

按 `workflow-core.md` 决策树执行，**按 intent_type 分支**。

### EXECUTION 类定级

```
T0: ≤2 行改动 / 单一文件 / 无跨模块影响 / 无测试/类型检查需求
     → 直达执行，无设计门，无审查

T1: 多文件但单一目标 / 有测试需求 / 需简单验证
     → 短设计门（1-3 句）→ 设计门角色 → 编码角色 → 验证角色 → 审查角色(full)

T2: 多模块影响 / 需架构决策 / 有需求扩散风险 / 需完整 DAG
     → 完整设计门 → 单元 DAG → 设计门角色 → 编码角色 → 验证角色 → 审查角色(full)

T3: 核心逻辑 / 安全敏感 / 用户明确要求多模型并行生命周期
     → multiModel 并行生命周期（子图 lifecycle/multimodel-graph.yaml）
```

### INQUIRY 类定级

```
T0: 简单问答 / 已明确的知识点 / 单一事实确认
     → SIZING 后直接交付（DELIVERING），无分析门，无审查
     → conductor 内建快答，执行轻量 M4-M8 记忆写入

T1: 项目特定问题 / 需要阅读当前项目文件 / 单一视角分析
     → 短分析门（1-3 句分析框架）→ 分析角色 → 验证结论准确性 → 审查角色(full)

T2: 多维度分析 / 需要跨文件/跨模块调研 / 需要对比/评估/建议
     → 完整分析门 → 研究 DAG（按信息来源拆分单元）→ 分析角色 → 验证结论准确性 → 审查角色(full)

T3: 深度调研 / 架构级评估 / 需要多模型并行分析对比
     → multiModel 并行分析生命周期（复用 multiModel 子图，模式=analysis）
     → 3 个不同模型并行分析同一问题，synthesizer-fusion 独立融合最优结论
```

### 定级输出

定级完成后，conductor 按 `lifecycle/config.yaml` 的 `tier_defaults`（EXECUTION）或 `inquiry_tier_defaults`（INQUIRY）+ 用户覆盖（prompt 显式声明）写入 `task_context.config.agents` + `review_mode` + `custom_overrides`。

## 输出信号

```yaml
status_signal: "DONE" | "NEEDS_CONTEXT"
transition_context:
  intent_type: "EXECUTION" | "INQUIRY"
  task_type: "T0" | "T1" | "T2" | "T3"
  estimated_units: int           # 预估单元数（INQUIRY 为研究单元数）
  design_gate_required: true | false   # analysis_gate_required 别名
  review_mode: "full" | "none"
quality_gate:
  sizing_rationale: "string"     # 定级理由（强制输出，含 intent_type 分支说明）
  confidence: "high" | "medium" | "low"
```

## 路由规则（边定义见 graph.yaml）

| intent_type | task_type | 下一节点 | 设计门/分析门 | 审查 |
|-------------|-----------|----------|---------------|------|
| EXECUTION | T0 | `EXECUTING` | 否 | N/A |
| EXECUTION | T1 | `PLANNING`（短）→ `EXECUTING` | 短设计门 | full |
| EXECUTION | T2 | `PLANNING`（完整）→ `EXECUTING` | 完整设计门 | full |
| EXECUTION | T3 | `MM_SUBGRAPH`（多模型子图） | 完整设计门 | full |
| INQUIRY | T0 | `DELIVERING` | 否 | N/A |
| INQUIRY | T1 | `PLANNING`（短）→ `QUALITY` | 短分析门 | full |
| INQUIRY | T2 | `PLANNING`（完整）→ `QUALITY` | 完整分析门 | full |
| INQUIRY | T3 | `MM_SUBGRAPH`（多模型子图）→ `QUALITY` | 完整分析门 | full |

## 阶段 B·校准（后置）

在 `QUALITY` 阶段，基于实际执行的 unit DAG 和变更范围，复核实际等级：
- 若实际单元数 > 预估 50% → 升级 task_type 并标注 `[LEVEL_UP]`
- 若实际未触发需求扩散 → 降级并标注 `[LEVEL_DOWN]`（极少发生）

## 硬规则

- **分析门硬门**：INQUIRY T1+ 回答前必须过分析门角色。"太简单不需要分析"是反模式——即使是咨询，未经结构化的分析也易产生偏见和遗漏。
- **重复模式硬门**：涉及跨文件/模块重复实现模式时（UI 与非 UI 同等适用），定级必须包含「全量扫描清单 + 组件化/共享抽象方案」评估。
- **多模型配额降级硬门**：触发多模型子图前必扫 `dispatch_log` 查过去 24h T3 失败率（≥30% → 跳过多模型子图降级为单路编码/单路分析）。
- **INQUIRY 禁止编码**：INQUIRY 全生命周期中，智能体**禁止调用修改性工具**（edit/write/create/delete）。若分析过程中发现需要修改代码才能回答 → 转为 EXECUTION 重新定级。
- **流转必裁判**：SIZING → 下一节点前必须执行 `node scripts/transition-check.mjs <task_id> --from SIZING --to <NEXT>`。未执行 transition-check 直接推进 → `[PROCESS_VIOLATION]`。
- **task_context 写回**：定级完成后必须 `task-context.mjs set <task_id> sizing.tier <TIER> --agent conductor`。
