---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志（精简注入版）
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules（精简注入版）

> **详细示例与历史见 `workflow-detail.md`**。
> **生命周期驱动**：conductor 按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount` 声明 at/order/when/on_fail，v6 单源）加载智能体（planner / coder / verifier / reviewer / fixer）。本文件以新术语描述流程规则。模型能力倾向唯一人类可读参考见 `docs/model-registry.md`（无机器可读副本，v6.1 删除 `lifecycle/capabilities.yaml`）。

## 默认路由

- 入口：`conductor` 负责理解需求、路由、跟踪验证和交付。
- 简单局部实现 → `coder`
- 架构变更、范围不清、跨层规则 → `planner`
- 显式 review 或安全/资金/权限/核心逻辑 → `reviewer`
- 多次失败、高风险、用户反馈"还是不对/有遗漏" → 升级 reviewer

## 模型选择策略

| 复杂度 | 模型 | 场景 |
|--------|------|------|
| 机械任务 | `small_model` | 1-2 文件纯表面修改、搜索、读取确认 |
| 标准任务 | `agent.model` | 多文件集成、常规功能实现、verifier/fixer |
| 架构/审查 | `model` 或最强推理模型 | 完整规划、安全审查、复杂根因分析 |

> 默认 agent 配置在 `kilo.json` 中声明；conductor 可在加载时按上表覆盖。

## 任务定级（两阶段）

执行类任务必须按以下两阶段流程定级，**两阶段均显式输出**（完整模板见 `workflow-detail.md` §A）：

- **阶段 A·开场预估**：用于路由/模型选择/设计门深度选择
- **阶段 B·规划后校准**：planner 设计门落地后，基于实际 unit DAG 复核实际等级

### 偏差规则

- **维持或上调**：默认放行
- **拿不准就升档**（成本不对称）：阶段 A 判据不足以区分相邻等级时预估取高一级
- **下调**（如 T2 → T1）：必须满足 5 条硬条件（见 `workflow-detail.md` §A.3），满足后须显式标注 `[DOWNGRADE_AFTER_PLAN]`

> 性能注：阶段 B 不触发额外 planner 调用，仅在已有设计门产物基础上做复核；T0 不进阶段 B（极速通道豁免）。

### T0 极速通道（6 条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖
6. 未命中扩散触发词（需求明确）

T0 直达 coder，无需 planner、verifier、reviewer。

### T1-T2 预估定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准，**且无命中扩散触发词** | planner 短设计门 → 拆单元，每单元 coder → verifier 闭环 |
| T2 | **任一命中**：跨模块 / 5+ 文件 / 规则扩散 / 安全敏感词 / 机制·契约变更（见 `workflow-detail.md` §A.4 Step 4a） | planner 完整规划 → 单元 DAG → reviewer |

> **设计门分级**（来源：superpowers/brainstorming）：T1 走"短设计门"（planner 输出 1-3 句方案+验收点即可放行 coder）；T2 走"完整规划"（planner 输出任务 DAG+依赖+风险）。连 1 行配置变更也走短设计门——"太简单不需要设计"是反模式。

### 安全敏感模块识别

命中以下关键词 → **最低 T2**：

`user / account / auth / login / password / token / jwt / session / payment / checkout / wallet / balance / fund / transfer / admin / root / key / secret / credential / api_key / certificate / otp / mfa`

> T0/T1/T2 完整决策树（含 Step 1a T0 前置硬否决闸门 + Step 4a 机制复杂度升档判定）见 `workflow-detail.md` §A.4。

## 搜索四层阶梯纪律

> **AGENTS.md 锚点 15 引用本节**——本节是 §Trace-First 与 §MCP 优先 的单源定义，不可拆走。

### §Trace-First：执行类任务信息检索必须按阶梯递进

| 阶梯 | 工具 | 范围 | 适用 |
|------|------|------|------|
| L0 文档 | 读 `agent/*.md` / `instructions/*.md` / `lifecycle/*.md` 锚点 | 锚点名称 + 规则来源 | 第一步 |
| L1 Glob | 按文件名/路径模式精确定位 | 路径前缀 | 第二步 |
| L2 窄搜 | Grep 带 `include` 限定文件类型/路径前缀 | 目标 ≤3 文件 | 第三步 |
| L3 广搜 | Grep 全仓（仅在前三阶梯无果、且明确知晓调用方后使用） | 全仓 | 末位 |
| L4 MCP 图谱/索引 | GitNexus / Context7 等索引工具 | 调用链/影响面/官方文档 | 业务仓库默认 |

**阶梯跳级违规**：
- 绕过 L2 直接全仓 Grep → `[SEARCH_LADDER_VIOLATION]`
- 已索引仓库首选 Grep 而非图谱（L4）→ `[SEARCH_LADDER_VIOLATION]`
- 全仓 Grep 无 `include` 限定 → `[SEARCH_LADDER_VIOLATION]`

### §MCP 优先：业务仓库默认走 MCP 图谱/索引能力

- **业务仓库默认 L4 起步**：大代码库（>1000 文件）首选 GitNexus `query` / `context` / `impact`，避免暴力文本搜索
- **未启用图谱的仓库回退 L3**：L3 广搜必须有明确调用方知晓，全仓 Grep 必须带 `include` 限定目录/扩展名
- **Kilo 框架不绑定特定 MCP**：具体工具由当前环境 MCP 决定（GitNexus / Context7 / 其他）
- **索引刷新**：代码大改后建议跑 `gitnexus analyze <path>` 刷新图谱

> **反例**：在已索引仓库用 `rg "funcName" .` 全仓扫描是阶梯跳级。正确做法：`mcp_gitnexus_context name=funcName` 或先 `mcp_gitnexus_query` 收窄范围。

## 单元化编排

T1+ 任务必须拆分为可验证的单元，每单元独立闭环。

### 单元定义

- **最小可交付单元**：一个单元必须能独立验证、独立回滚
- **单元边界**：以文件/模块/接口为界，避免跨界单元
- **单元依赖**：单元间依赖必须是 DAG（无循环）

### 单元 DAG 流程

```
planner 规划 → 生成单元列表 → 并行/串行执行 → 逐单元验收 → 总体验收
```

- 无依赖单元 → 并行执行
- 有依赖单元 → 按依赖顺序串行

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

### 单元级闭环（T1+）

每单元：coder → verifier → 如需 fixer → 重新 verifier。

- coder 不自验，必须过 verifier
- coder 输出必须包含状态信号（`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`）
- `NEEDS_CONTEXT` / `BLOCKED` → conductor 停止并回传，不进入 verifier
- verifier FAIL → fixer 修复 → 重新 verifier
- fixer 连续 2 轮同症状 → 升级 reviewer

### review_mode 决策表

```
预估等级 -> review_mode
──────────────────────────
T0      -> none（无验证/审查角色；机械门 scan-encoding）
T1      -> fast（机械门 acceptance-check + diff-boundary-check + 正向验证；反向验证/审查角色 tiers:[T2] 不加载）
T2      -> full（机械门 + 正向验证 + 反向验证 + 审查，四视角全并行）
```

> **T1 快通道不是"质量打折"**：T1 质量由 acceptance-check（机器证明对）+ diff-boundary（机器证明在界）+ 正向验证（forward 逻辑/边界）+ coding-engineering.md playbook 托底。T2 保留四视角完整审查。详见 `workflow-detail.md` §C。

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 设计门（T1+） | T1 短设计门、T2 完整规划未过不得进 coder | `[PLAN_REVIEW_MISS]` |
| 不自验 | coder 不得自行验证 | `[PROCESS_VIOLATION]` |
| 状态信号 | coder 必须输出 `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED` | `[MISSING_STATUS_SIGNAL]` |
| 双重 verifier | 正向 + 反向 | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` / `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 局部补丁拦截 | 重复模式未走组件化 | `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 扫描与防复发交付门 | 交付必须含全量同类点扫描 + 防复发产物 | `[MISSING_SCAN]` / `[MISSING_PREVENTION]` |
| 同症状防空转 | 连续 2 轮 fixer 同症状 → 升级 reviewer | `[NEEDS_REVIEW]` |
| Circuit Breaker | 连续 3 次无法收敛 → 停止 | `[CIRCUIT_BREAKER]` |
| 验收映射表 | 每条标准 → 实现 → 验证 → 边界 → 状态 | `[MISSING_ACCEPTANCE_MAP]` |
| 计划执行门禁 | 计划执行前必须 critical review | `[PLAN_DEVIATION]` |
| 结构化输出验证 | agent 返回必须 schema 自检 | `[MALFORMED_OUTPUT]` |
| 可执行验收门（机械） | QUALITY verify 前跑 `acceptance-check.mjs` | `[ACCEPTANCE_FAIL]` |

> 异常路由表 + 标记 → 硬动作映射（conductor 必须执行）见 `workflow-detail.md` §D。

## 验证与修复通用原则

1. **不信任声明**：要求证据，怀疑一切
2. **先验证后交付**：未通过验证不得标记完成
3. **回归先行**：修复后首先确认未引入回归
4. **根因闭合**：排查类任务必须证明根因闭合，而非表层补丁
5. **三层修复**：执行层 → 方法层 → 需求层，逐层上升

> 分支收尾协议、交付信号、计划执行门禁、收尾三步等见 `workflow-detail.md` §E。
