---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules

> **生命周期驱动**：conductor 按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount` 声明 at/order/when/on_fail，v6 单源）加载智能体（planner / coder / verifier / reviewer / fixer）。本文件以新术语描述流程规则。模型能力倾向唯一人类可读参考见 `docs/model-registry.md`（无机器可读副本，v6.1 删除 `lifecycle/capabilities.yaml`）。

## 默认路由

- 入口：`conductor` 负责理解需求、路由、跟踪验证和交付。
- 简单局部实现 → `coder`
- 架构变更、范围不清、跨层规则 → `planner`
- 显式 review 或安全/资金/权限/核心逻辑 → `reviewer`
- 多次失败、高风险、用户反馈"还是不对/有遗漏" → 升级 reviewer

## 模型选择策略

conductor 加载智能体时，按任务复杂度选择模型：

| 复杂度 | 模型 | 场景 |
|--------|------|------|
| 机械任务 | `small_model` | 1-2 文件纯表面修改、搜索、读取确认 |
| 标准任务 | `agent.model` | 多文件集成、常规功能实现、verifier/fixer |
| 架构/审查 | `model` 或最强推理模型 | 完整规划、安全审查、复杂根因分析 |

> 默认 agent 配置在 `kilo.json` 中声明；conductor 可在加载时按上表覆盖。

## 任务定级（两阶段）

执行类任务必须按以下两阶段流程定级，**两阶段均显式输出**：

- **阶段 A·开场预估**：用于路由/模型选择/设计门深度选择
- **阶段 B·规划后校准**：planner 设计门落地后，基于实际 unit DAG 复核实际等级

### 阶段 A·开场预估（必填）

```
【任务定级·预估】
- 任务等级：T0 / T1 / T2（预估）
- 定级依据：[具体判定条件]
- 执行路径：[直达coder / 拆单元+planner / planner+DAG / reviewer]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 阶段 B·规划后校准（必填，planner 设计门落地后立即输出）

```
【任务定级·校准】
- 实际等级：T0 / T1 / T2（校准）
- 校准依据：[实际 unit 数 / 跨模块 / 风险面 / 安全敏感词命中]
- 偏差：维持预估 / 上调 / 下调
- 偏差原因（如有）：...
- 偏差标记（如有）：
  - 上调 → `[TIER_UPGRADED]` + 原因
  - 下调 → `[DOWNGRADE_AFTER_PLAN]` + 依据
- review_mode：none / full（按本文件「review_mode 决策表」确定）
```

### 偏差规则

- **维持或上调**：默认放行
- **拿不准就升档**（成本不对称）：阶段 A 判据不足以区分相邻等级时预估取高一级——高估仅多付流程开销，低估导致返工与质量逃逸
- **下调**（如 T2 → T1）：必须同时满足以下全部硬条件：(1) 实际文件数 < 4；(2) 不跨模块；(3) 不命中安全敏感关键词；(4) PLANNING 阶段已正常完成（post:PLANNING 挂载点审查未中止流转）；(5) 不命中机制复杂度判定（与 Step 4a 同源，下调门二次确认）。满足全部条件后，须显式标注 `[DOWNGRADE_AFTER_PLAN]` 并写明依据。任一条件不满足则不得下调

> 性能注：阶段 B 不触发额外 planner 调用，仅在已有设计门产物基础上做复核；T0 不进阶段 B（极速通道豁免）。

### 定级决策树

```
Step 1: 意图判定（core.md）
  ├─ 咨询类 → 只分析，不改文件
  └─ 执行类 → 继续 Step 2

Step 2: T0 极速通道检查（5条全部满足）
  ├─ 全部满足 → T0，直达 coder
  └─ 任一不满足 → 继续 Step 3

Step 3: 需求清晰度检查
  ├─ 模糊/矛盾/高风险/范围不清 → 先澄清，清晰后重新定级
  └─ 清晰 → 继续 Step 4

Step 4: 复杂度量化判定（预估）
  ├─ 命中安全敏感关键词 → 最低 T2
  ├─ 跨模块(≥2 独立目录) 或 5+ 文件 或 规则扩散(同模式跨≥2处) → T2，标注命中项
  ├─ 机制复杂度判定(见 Step 4a)命中 → T2
  ├─ 2-5 文件 且 单模块 且 有明确验收标准 且 无 T2 命中 → T1
  └─ 判据不足以区分相邻等级 → 默认取高一级，标 [TIER_UPGRADED]

Step 4a: 机制复杂度升档判定（仅在 Step 4 未明确 T2 时进入）
  排除条款：纯文案/格式/命名/删除/注释不属机制复杂度，仍按常规文件数/跨模块判据
  实质性门槛：仅当满足任一条件才进入 3 类判定——影响 ≥2 个下游消费方，或跨越 ≥2 个单元，或改变对外可观测行为
  3 类量化阈值（满足门槛后，命中任一即升 T2）：
    1. 跨脚本耦合：改动影响 ≥2 个脚本的控制流或共享可变状态（含全局变量、事件总线、文件级副作用）
    2. 架构语义：对 lifecycle/graph.yaml 语义描述的实质性变更（graph.yaml 本身 forbidden 不动；仅指引用/解释 graph 语义的其他文件变更）
    3. 行为契约：task_context schema 字段语义变更、或 agent/*.md frontmatter 契约字段语义变更（如 mount/task_context/gate 字段含义改变）
  有意收紧：命中即升 T2 是设计选择——机制复杂度低估会导致全生命周期传播错误，按成本不对称原则直接取高
```

### T0 极速通道（6条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖
6. 命中扩散触发词（需求模糊扩散，不满足'用户明确'条件）

T0 直达 coder，无需 planner、verifier、reviewer。

### T1-T2 预估定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准，**且无命中扩散触发词** | planner 短设计门 → 拆单元，每单元 coder → verifier 闭环 |
| T2 | **任一命中**：跨模块 / 5+ 文件 / 规则扩散 / 安全敏感词 / 机制·契约变更（见 Step 4a） | planner 完整规划 → 单元 DAG → reviewer |

> **设计门分级**（来源：superpowers/brainstorming）：T1 走"短设计门"（planner 输出 1-3 句方案+验收点即可放行 coder）；T2 走"完整规划"（planner 输出任务 DAG+依赖+风险）。连 1 行配置变更也走短设计门--"太简单不需要设计"是反模式，简单任务正是未审视假设造成返工的高发区。

### 安全敏感模块识别

命中以下关键词 → **最低 T2**：

`user / account / auth / login / password / token / jwt / session / payment / checkout / wallet / balance / fund / transfer / admin / root / key / secret / credential / api_key / certificate / otp / mfa`

## 单元化编排

T1+ 任务必须拆分为可验证的单元，每单元独立闭环。

### 单元定义

- **最小可交付单元**：一个单元必须能独立验证、独立回滚。
- **单元边界**：以文件/模块/接口为界，避免跨界单元。
- **单元依赖**：单元间依赖必须是 DAG（无循环）。

### 单元 DAG

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

`requirement_spread` 字段名与 `agent/planner.md` 对齐，必含以下 5 项：

- **business_invariants**（array）：一句话系统级规则，所有纳入点必须共同满足的不变量。
- **impact_surface**（string）：入口/UI、状态/缓存、校验/提交、回显/初始化、兼容/迁移。
- **scan_evidence**（string）：grep/glob 搜索词、命中摘要、纳入/排除理由。
- **coverage_matrix**（array）：同类点 → 处理方式 → 验证方式，每条含 `conclusion` 字段。
- **acceptance_criteria**（array）：覆盖全部纳入点；无法覆盖的标 `[UNCOVERABLE_REQUIREMENT]`。

### 未形成不得编码硬门

命中扩散触发词时，未形成需求扩散包前不得编码。缺失由 `transition-check.mjs` 在 PLANNING→EXECUTING 边拦截。

### 交付前覆盖矩阵核对

交付前 conductor 核对 coverage_matrix 每条 `conclusion`；存在 `[UNVERIFIED]` / `[PARTIAL_IMPLEMENTATION]` / `[REGRESSION]` 不得标 ✅ 不得交付，由 `flow-audit.mjs` 交付前审计校验。

## 门禁与闭环

### 单元级闭环（T1+）

每单元：coder → verifier → 如需 fixer → 重新 verifier。

- coder 不自验，必须过 verifier。
- coder 输出必须包含状态信号（`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`）。
- `NEEDS_CONTEXT` / `BLOCKED` → conductor 停止并回传，不进入 verifier。
- verifier FAIL → fixer 修复 → 重新 verifier。
- fixer 连续 2 轮同症状 → 升级 reviewer。

### 总体验收（T1+）

所有单元通过后，conductor 调用 `reviewer` 做总体验审：

#### review_mode 决策表

```
预估等级 → review_mode
──────────────────────────
T0      → none（无 reviewer）
T1 / T2 → full（四视角：安全/架构/简化/SCOPE_CREEP）
```

> **不采用"轻量档位"**：质量门禁不打折。任何审查档位化设计（如"跳过安全视角以节省 token"）都意味着质量妥协——属于无意义的工程化控制。T1+ 一律走四视角完整审查。

#### 模式说明

- **none**：跳过 reviewer。仅 T0（极速通道）适用。
- **full**：四视角审查（安全/架构/简化/SCOPE_CREEP），T1+ 唯一模式。

#### 总体验收三步

1. reviewer 按 review_mode 审查
2. 所有单元集成验证
3. 回归测试

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 设计门（T1+）| T1 短设计门、T2 完整规划未过不得进 coder；方案放行由 post:PLANNING 挂载点独立审查（失败即 abort 中止流转）；绕过审查进 coder 由 verifier 拦截（仅 T2（plan-reviewer tiers 含 T2）时；T1（tiers 不含 T1）关闭 plan-reviewer 不触发 `[PLAN_REVIEW_MISS]`） | [PLAN_REVIEW_MISS] |
| 不自验 | coder 不得自行验证 | `[PROCESS_VIOLATION]` |
| 状态信号 | coder 必须输出 `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED` | `[MISSING_STATUS_SIGNAL]` |
| 双重 verifier | 正向（需求/语法/逻辑/边界）+ 反向（SCOPE_CREEP/调试残留/重复实现/局部补丁） | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` / `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 局部补丁拦截 | 重复模式未走组件化/共享抽象，逐处复制粘贴（UI 与非 UI 同等适用） | `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 扫描与防复发交付门 | coder 交付必须含全量同类点扫描清单 + 至少一项防复发产物 | `[MISSING_SCAN]` / `[MISSING_PREVENTION]` |
| 同症状防空转 | 连续 2 轮 fixer 同症状 → 升级 reviewer | `[NEEDS_REVIEW]` |
| Circuit Breaker | 连续 3 次无法收敛 → 停止 | `[CIRCUIT_BREAKER]` |
| 验收映射表 | 每条标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态 | `[MISSING_ACCEPTANCE_MAP]` |
| 计划执行门禁 | 计划执行前必须 critical review；遇 blocker 立即停止不猜测 | `[PLAN_DEVIATION]` |
| 结构化输出验证 | agent 返回必须经过 schema 自检（JSON.parse/XML 标签检查），失败 → 重试 | `[MALFORMED_OUTPUT]` |

### 异常路由表

conductor 解析 agent 返回或工具调用结果时，按以下分级路由处理：

| 错误码 | 触发条件 | 路由策略 | 说明 |
|--------|----------|----------|------|
| `TIMEOUT` | 子 agent / MCP 调用超时 | 退避重试 3 次 → ESCALATE reviewer | 首次退避 5s，后续指数增长 |
| `RATE_LIMIT` | 模型限流 | 指数退避 + 切备用模型 | 退避间隔 5s/10s/20s |
| `CONTEXT_OVERFLOW` | 上下文超限 | 转 compaction 压缩后重试 1 次 | 压缩后仍超限 → 拆单元 |
| `AUTH` | 鉴权失败 | **不重试**，立即升级人工 | 可能是密钥失效 |
| `BAD_INPUT` | 委派包参数不合法 | **不重试**，回 conductor 修正 | 通常是 dispatch 生成错误 |
| `TOOL_DENIED` | 工具被策略拒绝 | 转人机回路确认 | 可能命中安全策略 |
| `CRASH` | 进程/MCP 崩溃 | 重试 1 次 → 切备用执行器 | 备用执行器指同任务其他模型 |
| `AMBIGUOUS` | 输出无法解析/语义不清 | 重试 1 次（换严 schema）→ reviewer | 要求 agent 用更严格格式重输出 |
| `MALFORMED_OUTPUT` | 结构化输出格式错误 | 要求重输出，连续 2 次 → reviewer | 见 `output-schema.md` |

**路由原则**：
- 可恢复错误（TIMEOUT/RATE_LIMIT/CONTEXT_OVERFLOW）→ 自动重试
- 不可恢复错误（AUTH/BAD_INPUT）→ 立即停止，回传 conductor 或人工
- 语义错误（AMBIGUOUS/MALFORMED_OUTPUT）→ 降级重试，仍失败升级 reviewer

### 标记 → 硬动作映射（conductor 必须执行）

以下标记由 conductor 在解析子 agent 输出时自动检测，检测后必须执行对应硬动作，不得跳过：

| 标记 | 检测方式 | 硬动作 | 失败后果 |
|------|----------|--------|----------|
| `[MALFORMED_OUTPUT]` | JSON.parse 失败 / XML 标签缺失 / 必需字段缺失 | 1. 要求子 agent 用更严格格式重输出<br>2. 第 2 次仍失败 → 调用 reviewer | 流程中断，不得进入下游 |
| `[MISSING_STATUS_SIGNAL]` | 无法提取 `DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED` | 1. 要求子 agent 显式输出状态<br>2. 仍失败 → 调用 reviewer | 流程中断，不得进入下游 |
| `[MISSING_RECALL]` | 回溯阶段未执行 kilo_local_recall | 1. 立即执行 kilo_local_recall<br>2. 查询完成前不得进入修复阶段 | 阻塞修复，直到查询完成 |
| `[MISSING_CONTEXT_QUERY]` | 编码前未按规则调用 Context Engine | 1. 立即补调必要工具<br>2. 完成后重新检查点 | 阻塞编码，直到查询完成 |
| `[PROCESS_VIOLATION]` | 流程跳步 | 1. 标记违规<br>2. 暂停执行<br>3. 修正后从上一个检查点恢复 | 任务暂停 |
| `[CIRCUIT_BREAKER]` | 连续 3 次无法收敛 | 1. 停止修复<br>2. 生成降级交付报告<br>3. 建议用户决策 | 任务终止 |
| `[NEEDS_REVIEW]` | fixer 连续 2 轮同症状 | 1. 停止 fixer<br>2. 升级 reviewer<br>3. reviewer 结论作为最终状态 | fixer 终止 |

**执行要求**：
- 所有标记检测必须在子 agent 返回后 **10 秒内**完成
- 标记触发后，conductor 必须在回复中显式输出「检测到 `[标记名]`，执行动作：...」
- 任何标记未处理即进入下游 → `[PROCESS_VIOLATION]`

## 规范统一 / 审计类任务 SOP

触发条件：「统一 XX 规范」「全量审计」「批量整改」「全局替换」类任务。此类任务的失败模式高度一致（边改边发现、逐页补丁、无防复发），必须按以下五步执行，缺步即 `[PROCESS_VIOLATION]`：

1. **全量扫描清单先行**：先用 grep/glob 产出完整命中清单（文件数 + 行数 + 分类），作为验收基准写入委派包；禁止边改边发现。
2. **组件化优先**：重复 ≥3 处的模式必须提炼为共享抽象（UI: 组件/layout/design token/mixin；非 UI: util/hook/service/adapter/策略接口/配置驱动），禁止逐处复制粘贴式修补。
3. **注释溯源**：每处整改标注规范条目编号（如 `ui-spec §2 H1`），便于审计回归与后续反查。
4. **防复发产物**：交付必须包含至少一项防复发机制（token 体系 / 共享组件 / lint 规则 / 文档硬约束条款），否则视为未完成。
5. **反向验证**：交付前对「应清零项」做反向 grep（命中数=0），对「应统一引用项」做正向 grep（命中数=目标页面/模块数），两组数据写入验收映射表。

## 重复模式修复 / 组件化 SOP（UI 与非 UI 通用）

任何任务，若同一实现模式（UI 样式/布局/交互、后端逻辑、数据访问、错误处理、日志、配置读取、第三方集成等）在 ≥2 个文件/模块出现，或用户已声明「类似问题普遍存在」/「所有页面/模块都有这个问题」，强制按以下流程执行，禁止逐处打补丁。UI 与非 UI 同等适用，不人为割裂。

1. **全量扫描清单先行**：用 grep/glob/gitnexus 产出完整命中清单（文件 + 行号 + 出现次数），作为验收基准写入委派包。
2. **根因分类**：
   - **A. 缺少共享抽象**（如无公共组件、无 util、无 service、无 adapter、无 design token）→ 创建/扩展共享抽象。
   - **B. 已有共享抽象但实现错误/未被消费** → 修正共享抽象并同步所有消费者。
   - **C. 各处确实处于独立上下文且无法抽象** → 必须在验收映射表中写明理由，且需用户显式确认。
3. **组件化优先**：重复 ≥2 处的模式必须优先提炼为共享抽象——UI 域：共享组件 / layout / design token / mixin / 全局 CSS；非 UI 域：util / hook / service / repository / adapter / 策略接口 / 配置驱动 / 插件化；禁止把同一段样式/结构/逻辑复制到多个文件。
4. **同步依赖**：所有受影响的文件/模块必须同批修改，禁止「先改一个看看」。
5. **防复发产物**：交付必须包含至少一项防复发机制（共享抽象本身、design token、lint 规则、文档条款、自动化测试、视觉回归测试、类型约束），否则视为未完成。
6. **反向验证**：交付前对旧模式做反向 grep（命中数=0），对新引用做正向 grep（命中数=预期消费者数），数据写入验收映射表。

违反任意一步 → `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`，verifier 必须 FAIL。

> 命中「统一 XX 规范」「全量审计」「批量整改」「全局替换」类任务时，额外按上方「规范统一 / 审计类任务 SOP」五步执行。

## 交付

### 收尾三步

1. **验证确认**：测试、构建、类型、Lint 通过；声明完成必须有本轮 fresh 证据，不得援引上一轮或他人结论（来源：superpowers/verification-before-completion）。
2. **范围确认**：`git diff --` 确认改动范围，无 SCOPE_CREEP。
3. **经验沉淀**：T1+ 任务完成后，conductor 记录任务执行摘要与关键决策，供后续任务参考。

### 分支收尾协议（来源：superpowers/finishing-a-development-branch）

执行类任务交付后，conductor 必须按序确认：

1. **工作树状态**：`git status` 确认无遗留未跟踪文件、无残留临时脚本/构建产物。
2. **提交边界**：单次提交对应单一定级单元；跨单元改动必须分提交，禁止"一锅烩"。
3. **分支去向**：明确告知用户当前分支名、是否需要 PR/MR、是否需要回主干合并；不擅自 push 或合并。
4. **worktree 隔离**（可选）：高风险或长任务建议在 git worktree 中执行，交付后清理 worktree（`git worktree remove`），避免污染主工作树。

### 交付信号

- **正常交付**："任务完成，以上是全部变更和验证结果。"
- **降级交付**："任务部分完成，以下是已完成内容、未完成项和阻塞原因。"
- **失败交付**："任务未完成，阻塞原因是 X，建议方案是 Y。"

### 计划执行门禁

T2+ 任务执行 planner 计划前，conductor 必须：

1. **Critical Review**：重新审阅计划，标记任何疑问或风险；有疑虑先澄清再执行。
2. **创建追踪 todo**：按任务 DAG 生成结构化 todo 列表，逐条标记进度。
3. **遇 blocker 即停**：缺失依赖、测试失败、指令不清 → 停止，请求澄清，**不猜测**。
4. **顺序执行**：按 DAG 依赖顺序执行，不擅自并行串行依赖单元。
5. **每步验证**：每个单元完成后按验收标准验证，不累积到全部完成再验。

## 验证与修复通用原则

1. **不信任声明**：要求证据，怀疑一切。
2. **先验证后交付**：未通过验证不得标记完成。
3. **回归先行**：修复后首先确认未引入回归。
4. **根因闭合**：排查类任务必须证明根因闭合，而非表层补丁。
5. **三层修复**：执行层 → 方法层 → 需求层，逐层上升。

