---
description: 生命周期阶段 PLANNING — 设计门/分析门。T1+ 编码或分析前必须经过 planner 输出方案+验收点+DAG。
model_capability: deep-reasoning
token_budget: 12000
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 角色名 = 智能体文件名（去 .md）或其 frontmatter 显式 role 字段；
# bootstrap/doctor 校验：每个角色 ≥1 个智能体 mount 覆盖本阶段主槽，缺一 → [ASSEMBLY_FAIL]
required_roles: [planner]
---

# lifecycle/stages/planning

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。
> 
> **v2.1 模式切换**：PLANNING 阶段根据 `task_context.intent_type` 在「设计门（design）」与「分析门（analysis）」之间自动切换。两种模式共享同一阶段入口和 `post:PLANNING` 审查挂载点，但处理流程和输出结构不同。

## 输入

- `SIZING` 输出的 intent_type + task_type + review_mode
- 用户请求（完整需求 + 约束）
- 项目技术栈上下文
- 相关代码文件（由智能体按需读取）

## 处理流程（按 intent_type 分支）

### 模式 A：设计门（`intent_type == 'EXECUTION'`）

1. **项目上下文确认**：读取 AGENTS.md / kilo.json / 入口目录，确认技术栈与约束。
2. **澄清问题**（T2 完整规划必做）：模糊术语（用户/账户/任务/会话）逐一精确定义。
3. **方案提议**：每个重要决策列 2-3 个可选方案，给出推荐。
4. **重复模式扫描**（UI 与非 UI 同等适用，必做）：全量扫描同类实现模式 → 组件化/共享抽象方案 → 无法组件化的例外理由。
5. **需求扩散评估**：识别同类入口、状态、校验、提交、回显路径 → 覆盖矩阵。
6. **任务 DAG**：按依赖排序，标注可并行/必须串行，每单元含目标+关键文件+验收标准。
7. **风险与应对**：列出已知风险及缓解策略。

### 模式 B：分析门（`intent_type == 'INQUIRY'`）

> INQUIRY 模式特例——PLANNING 阶段主槽（planner）承担研究执行（因 INQUIRY 无 EXECUTING 阶段）；这是设计特例，非默认职责（I1）

1. **问题结构化**：将用户原始问题拆解为子问题/维度/角度。例："评估这个架构"→拆解为「可扩展性」「可维护性」「安全」「性能」四个维度。
2. **信息来源确认**：列出回答该问题需要阅读的文件、文档、历史记录、外部资料。标注哪些是当前项目内可获取的，哪些需要推理/常识补充。
3. **澄清与界定**（T2+ 必做）：
   - 问题边界：用户问的是"现状评估"还是"改进建议"？
   - 时间范围：基于当前代码版本还是历史演进？
   - 深度要求：概要结论还是逐文件逐函数分析？
4. **研究 DAG**：按信息依赖排序，每单元含研究目标+关键文件+信息来源+预期结论。
5. **偏见预检**：列出可能的确认偏误（如过度依赖最近修改、忽略历史失败模式），给出规避策略。
6. **结论框架**：预设输出结构——按什么维度组织结论、每个维度需要哪些证据支撑。
7. **逐单元研究**：执行 research_units 中每个研究单元（读文件/查证/记录证据）
8. **汇总证据**：按结论框架组织证据清单（file:line + snippet + relevance）
9. **产出 execution.analysis**：写入完整分析结论（对照 quality.md 结构定义：conclusion_summary + evidence + dimensions_covered/missing + bias_flags + confidence）
10. **风险与局限**：列出分析局限（如"未读取运行时日志""基于静态代码推断"）。

## 输出信号

### EXECUTION 模式输出

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"
transition_context:
  task_type: "T1" | "T2" | "T3"
  design_gate_type: "short" | "full"
  units: [{ unit_id, goal, key_files, dependencies, acceptance_criteria }]
# 阶段放行由 post:PLANNING 挂载点独立审查判定（通用挂载机制，见 graph.yaml 头注释），主槽智能体不自验
scan_coverage: "full" | "partial" | "N/A"
componentization_plan: "yes" | "no" | "N/A"
extension_points:
  - domain: "string"
    mechanism: "string"
    rationale: "string"
forbidden_files: ["string"]
```

### INQUIRY 模式输出

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"
transition_context:
  task_type: "T1" | "T2" | "T3"
  analysis_gate_type: "short" | "full"
  research_units: [{ unit_id, question, key_files, sources, expected_conclusion, dependencies }]
# 阶段放行由 post:PLANNING 挂载点独立审查判定
research_coverage: "full" | "partial" | "N/A"
conclusion_framework:
  dimensions: [{ name, evidence_required, priority }]
  bias_mitigation: ["string"]
analysis_limitations: ["string"]
execution:
  analysis:
    conclusion_summary: "string"
    evidence: [{ file, line, snippet, relevance }]
    dimensions_covered: ["string"]
    dimensions_missing: ["string"]
    bias_flags: ["string"]
    confidence: "high" | "medium" | "low"
```
> research_units 是研究计划（transition_context，保留作指针）；execution.analysis 是执行后的完整结论产物（M2）。
> Token 经验法则（I2）：research_units ≤5 个；单 unit 研究 ≤2000 token 预算。

## 路由规则（边定义见 graph.yaml）

- **EXECUTION 模式**：主槽输出方案 → 执行 `post:PLANNING` 挂载点 → 审查通过 → `PLANNING → EXECUTING`
- **INQUIRY 模式**：主槽输出分析框架 → 执行 `post:PLANNING` 挂载点 → 审查通过 → `PLANNING → QUALITY`（跳过 EXECUTING）
- 挂载点审查失败/超时/异常 → 挂载点 `on_fail: abort` → `[SLOT_ABORT]`，停在 PLANNING 等用户决策（不自动回流）
- 绕过审查直接进入下一阶段 → 下游验证/审查角色标 `[PLAN_REVIEW_MISS]` FAIL（见 stages/quality.md）

## 重入降级模式（T3 worktree 副本竞赛失败降级）

> 触发条件：T3 PARALLEL_EXECUTION 阶段 3 个 worktree 副本全 FAIL / 全 TIMEOUT，或 SYNTHESIZING 评分全员 < 阈值，或 diversity 违规，conductor 标 `[T3_PARALLEL_DEGRADED]`，将 tier 降 T2 后重入 PLANNING。planner 进入本模式。

**识别条件**（满足即进入重入降级模式）：
- `task_context.t3_degrade_flag == true`（conductor 降级序列写入的唯一可靠标记）

**处理方式**：
- 按 **T2 单路编码**规划（`sizing.tier` 已由 conductor 降为 T2），不再触发 worktree 副本竞赛（不生成多路并行实现方案，编码实现由单一 planner/coder 承担）
- 复用原任务需求与验收标准，重新产出单路 `units` DAG（与正常 T2 EXECUTION 设计门流程一致）
- 输出 `transition_context.task_type` 标注为 `T2`（非 T3），`design_gate_type` 按 T2 规则（`full`）

**与正常 design/analysis 模式的关系**：
- 重入降级模式是 **EXECUTION 设计门的子模式**（`intent_type == 'EXECUTION'`），不改变 intent_type
- 与正常 T2 设计门的区别仅在于：planner 需在方案中注明「原 T3 worktree 副本竞赛失败，本次为降级单路规划」，并在风险与应对中记录原竞赛失败原因（从 `task_context` 或 `t3_degrade_flag` 中提取）
- 不触发 INQUIRY 分析门（intent_type 仍为 EXECUTION）

## 硬规则（两种模式通用）

- ❌ "太简单不需要设计/分析" — 简单任务正是未审视假设造成返工的高发区。
- ❌ 未包含重复模式扫描清单就放行（UI 与非 UI 同等要求）。
- ❌ 主槽智能体自验方案/分析通过并自行进入下一阶段（放行由 post:PLANNING 挂载点独立审查判定）。
- ❌ 未经 post:PLANNING 挂载点审查放行即进入下一阶段。
- ❌ INQUIRY 模式下输出代码/调用修改性工具 → `[PROCESS_VIOLATION]`（咨询类禁止编码）。
