---
name: workflow-core
description: 编排核心规则 — 搜索纪律、需求扩散、闭环门禁、验证修复（精简注入版）
keywords: workflow, orchestration, 搜索纪律, 需求扩散, 闭环, 验证修复
---

# Workflow Core Rules（精简注入版）

> **详细示例与历史见 `workflow-detail.md`**。
> **生命周期驱动**：conductor 按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount` 声明 at/order/when/on_fail，v6 单源）加载智能体（planner / coder / verifier / reviewer / fixer）。本文件以新术语描述流程规则。模型能力倾向唯一人类可读参考见 `docs/model-registry.md`（无机器可读副本，v6.1 删除 `lifecycle/capabilities.yaml`）。

## 搜索四层阶梯纪律

> **AGENTS.md 锚点 15 引用本节**——本节是 §Trace-First 与 §MCP 优先 的单源定义，不可拆走。

### §Trace-First：执行类任务信息检索必须按阶梯递进

| 阶梯 | 工具 | 范围 | 适用 |
|------|------|------|------|
| L0 文档 | 读 `agent/*.md` / `instructions/*.md` / `lifecycle/*.md` 锚点 | 锚点名称 + 规则来源 | 第一步 |
| L1 Glob | 按文件名/路径模式精确定位 | 路径前缀 | 第二步 |
| L2 窄搜 | Grep 带 `include` 限定文件类型/路径前缀 | 目标 ≤3 文件 | 第三步 |
| L3 广搜 | Grep 全仓（仅在前三阶梯无果、且明确知晓调用方后使用） | 全仓 | 末位 |
| L4 MCP 索引（可选） | 通用 MCP 工具（按 IDE 注入） | 调用链/影响面/官方文档 | 业务仓库默认（若启用） |

**阶梯跳级违规**：
- 绕过 L2 直接全仓 Grep → `[SEARCH_LADDER_VIOLATION]`
- 已索引仓库首选 Grep 而非图谱（L4）→ `[SEARCH_LADDER_VIOLATION]`
- 全仓 Grep 无 `include` 限定 → `[SEARCH_LADDER_VIOLATION]`

### §MCP 优先：业务仓库默认走 MCP 图谱/索引能力

- **业务仓库默认 L4 起步**：大代码库（>1000 文件）首选 `gitnexus_query` / `gitnexus_context` / `gitnexus_impact`，避免暴力文本搜索
- **未启用 gitnexus 的仓库回退 L3**：L3 广搜必须有明确调用方知晓，全仓 `grep` 必须带 `include` 限定目录/扩展名
- **索引刷新（可选）**：若 gitnexus 索引过期，按工具文档跑对应 refresh

> **反例**：在已索引仓库用 `grep` 全仓扫描是阶梯跳级。正确做法：`gitnexus_context name=funcName` 或先 `gitnexus_query` 收窄范围。

## 需求扩散

命中扩散触发词时，需求可能横跨多个入口/状态/校验点/回显/历史数据。必须形成需求扩散包后再拆任务，未形成不得编码。

### 扩散触发词清单

命中以下任一触发词，即进入需求扩散流程：

- 范围词：所有/任何/全部/同类/模块/互斥/唯一/全局/统一/联动
- 约束词：禁用/权限/菜单/角色/状态一致/选择范围
- 改变业务规则（非仅文案样式）
- 多入口/多状态/多配置/多校验/多回显/历史数据
- 用户反馈「半吊子/不干净/另一处也能选」
- 同规则可能在其他层也有实现

### 扩散包强制结构

`requirement_spread` 字段名与 `agent/planner.md` 对齐，必含 5 项（`business_invariants` / `impact_surface` / `scan_evidence` / `coverage_matrix` / `acceptance_criteria`）——详细见 `workflow-detail.md` §B。

### 未形成不得编码硬门

命中扩散触发词时，未形成需求扩散包前不得编码。缺失由 `transition-check.mjs` 在 PLANNING→EXECUTING 边拦截。

## 门禁与闭环

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| Circuit Breaker | 连续 3 次无法收敛 → 停止 | `[CIRCUIT_BREAKER]` |
| 验收映射表 | 每条标准 → 实现 → 验证 → 边界 → 状态 | `[MISSING_ACCEPTANCE_MAP]` |

> 异常路由表 + 标记 → 硬动作映射（conductor 必须执行）见 `workflow-detail.md` §D。

## 验证与修复通用原则

1. **不信任声明**：要求证据，怀疑一切
2. **先验证后交付**：未通过验证不得标记完成
3. **回归先行**：修复后首先确认未引入回归
4. **根因闭合**：排查类任务必须证明根因闭合，而非表层补丁
5. **三层修复**：执行层 → 方法层 → 需求层，逐层上升

> 分支收尾协议、交付信号、计划执行门禁、收尾三步等见 `workflow-detail.md` §E。