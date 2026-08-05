---
description: 生命周期阶段 DELIVERING — 交付。闭环确认、变更回顾、分支收尾。
# executor 内建主槽已移除（v6 wire-up 修复）；现在走 mount agent=delivery 路线
model_capability: fast-reasoning
token_budget: 6000
required_roles: [delivery]
---

# lifecycle/stages/delivering

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（DELIVERING → DONE 无 gate）。

## 输入

- `task_context.intent_type`（EXECUTION / INQUIRY，决定交付内容）
- EXECUTION：所有已完成单元的变更摘要 + 验收映射表 + 验证报告
- INQUIRY：完整分析结论 + 证据清单 + 引用来源 + 维度覆盖说明 + 局限声明
- 正向验证报告 + 审查报告（T1+ 统一 full）
- 强制流程日志（完整生命周期节点）
- task_context.json（完整任务上下文）

## 交付内容（按 intent_type 分支）

### EXECUTION 模式交付

#### 1. 闭环确认（验收 → 实现位置 → 验证证据 → 状态）

```
| 验收标准 | 实现位置 | 验证证据 | 状态 |
|----------|----------|----------|------|
```

#### 2. 变更回顾
- **改了什么**：文件列表 + 函数/模块变更摘要
- **为什么改**：根因或需求来源
- **影响范围**：调用方、下游模块、API 消费者
- **清理调试代码**：确认无 console.log / debugger / 临时文件残留

### INQUIRY 模式交付

#### 1. 分析闭环确认（结论 → 证据 → 来源 → 质量）

```
| 结论要点 | 证据/推理 | 引用来源 | 验证状态 |
|----------|-----------|----------|----------|
```

#### 2. 分析回顾
- **核心结论**：用 ≤3 句话概括回答用户原始问题的核心结论
- **维度覆盖**：按预设维度逐项确认是否覆盖
- **证据清单**：所有引用的文件、代码片段、配置项、外部资料的完整清单
- **引用来源可信度**：标注每个来源的时效性
- **分析局限**：诚实声明分析的边界
- **偏见自检**：是否考虑了反面证据？是否存在确认偏误？

### 通用交付（两种模式均适用）

#### 3. 分支收尾协议（仅 EXECUTION）
1. git status 清理（无未 staged 调试代码）
2. 单提交对应单定级单元
3. 告知用户分支去向，不擅自 push 合并
4. worktree 隔离清理（如适用）

> **T0 直达前置**：T0 任务绕过 QUALITY 直达 DELIVERING，须在 EXECUTING 阶段完成轻量验证（`scan-encoding.mjs` 通过 + `encoding_clean: true` + `no_debug_leftovers: true`，见 `executing.md` 路由规则）。DELIVERING 接收 T0 产物时默认信任前置已通过；若 EXECUTING 输出 `DONE_WITH_CONCERNS` 则已回流 QUALITY 兜底，不会直达。

## 输出信号

```yaml
status_signal: "DONE"
transition_context:
  intent_type: "EXECUTION" | "INQUIRY"
  units_completed: int
quality_gate:
  acceptance_map_verified: true | false    # EXECUTION
  analysis_summary_complete: true | false  # INQUIRY
  evidence_list_complete: true | false     # INQUIRY
  branch_cleanup_done: true | false       # EXECUTION
```

## 路由规则（边定义见 graph.yaml）

- `status_signal: DONE` + 所有 quality_gate 通过 → 终态节点 `DONE`（生命周期结束）
- INQUIRY 模式下不执行分支收尾协议（无代码变更）

