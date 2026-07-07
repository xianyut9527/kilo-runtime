---
name: workflow-reference
description: 编排参考规则（按需读取）— small_model 触发、Trace-First、MCP 闸门、需求扩散、委派包、skills 回写、Anthropic 模式映射、程序化记忆、MEMORY 回写说明
keywords: workflow, reference, 编排参考, small_model, Trace-First, MCP, 需求扩散, 委派包, skills 回写, MEMORY, 程序化记忆, Anthropic 模式
---

# Workflow Reference Rules

> 编排参考规则，按需读取。核心编排规则见 `workflow-core.md`。
> 涵盖：`small_model` 触发规则、Trace-First、外部索引与 MCP 使用闸门、需求扩散与同类点扫描、委派包、知识沉淀与 skills 回写、Anthropic 工作流模式映射、程序化记忆、交付 MEMORY 回写说明。

## small_model 触发规则

`kilo.json` 中已配置 `small_model` 字段（默认 `hx/MiniMax-M2.7-highspeed`）作为**降级路由入口**，不是强制替换。具体 agent 的 `model` 字段仍由 `kilo.json` 配置；`small_model` 仅在以下场景下被路由层选择使用：

### 适用场景（允许使用 `small_model`）

- **T0 极速通道任务**：符合极速通道全部 5 条标准的简单局部修改，推理深度低、上下文短。
- **轻量预审**：`pre-checker` 的 T0 轻量模式（仅做调用方检查 + 验收标准可验证性两项校验）。
- **结构化总结/分类**：低复杂度分类、确定性字段填充等。

### 不适用场景（必须使用 `agent.model` 配置的模型）

- **主控**：`coderAgent`（负责任务理解、路由、跟踪、交付，需深度推理与上下文维护）。
- **实现**：`engineer` / `executor-A` / `executor-B` / `executor-C`（需覆盖正常/边界/异常三条路径，搜索同类模式与调用方）。
- **审查**：`reviewer`（三视角审查、跨会话经验标注、影响面汇总）。
- **修复**：`fixer`（根因判定、同症状识别、范围约束）。
- **复杂规划**：`architect`（单元 DAG、并行冲突判断）、`ensemble`（多模型并行编排、双门禁协调）、`synthesizer`（候选合并与冲突裁决）。

### 路由约束

- `small_model` 是**可选降级路由**，不是 `agent.model` 的覆盖。具体 agent 仍以 `kilo.json` 中 `agent.<name>.model` 为准；只有路由层基于任务特征判断"低复杂度 + 短上下文"时才选择 `small_model`。
- 不允许为追求"快"或"省 token"而把 T1+ 任务路由到 `small_model`；T1 及以上任务因推理深度、上下文长度、影响面要求，必须使用 `agent.model`。
- 若 `agent.model` 不可用或失败，可临时降级到 `small_model`，但需在交付报告中显式标注降级原因。

## Trace-First

以下场景必须先形成链路包，再修改：

- 数据、状态、交互、接口、性能异常。
- 跨模块、多文件、配置流、状态流、调用链不清。
- 用户要求排查原因，或反馈"还有遗漏/链路有问题"。

链路包只保留：问题类型、入口、目标行为、关键链路节点、已确认异常点、待证伪假设、建议验证点。

全链路审计必须完整，禁止"发现一条路径 → 修复 → 交付"的循环；穷举所有可达路径后方可动手。

## 外部索引与 MCP 使用闸门

GitNexus、Context7、Playwright 等 MCP 工具用于补充证据，不是每个任务的固定前置步骤。

- T0 简单任务默认不调用 GitNexus；用专用搜索/读取工具或简短只读命令确认范围即可。
- T1 任务只在涉及调用链、同类点、接口契约、数据字段或跨文件影响时调用 GitNexus。
- T2/T3、需求扩散、Trace-First、API/数据/权限/核心逻辑变更，优先使用 GitNexus 做影响面分析，并用当前代码搜索结果复核。
- GitNexus 不可用、索引滞后或结果噪声过高时，不得反复重试；改用当前代码的搜索、阅读和验证证据，并在输出中说明。
- Context7 只用于需要最新外部库/框架/API 文档时；Playwright 只用于需要浏览器行为验证的 Web 任务。

## 需求扩散与同类点扫描

以下场景触发，未形成需求扩散包前不得编码：

- 用户表达包含"所有、任何、全部、同类、模块、互斥、唯一、全局、统一、联动、禁用、权限、菜单、角色、状态一致、选择范围"。
- 需求改变业务规则，而不是只改文案/样式。
- 涉及多个入口、状态、配置、保存、校验、回显或历史数据。
- 用户反馈"只改了一处、半吊子、不干净、另一个地方也能选"。
- 需求涉及校验、限制、权限、规则、约束、状态、互斥、必填、格式、范围、禁用、启用的增删改。
- 修改点属于某一层（UI/接口/数据/配置），但同一规则可能在其他层也有实现。
- T1 任务若涉及业务规则、校验逻辑、状态变更、枚举/常量修改，coderAgent 不得因"文件数少"而跳过需求扩散，必须产出同类点扫描摘要。

需求扩散包必须包含：

- 业务不变量：一句话描述系统级规则。
- 影响面：入口/UI、状态/缓存、校验/提交、回显/初始化、兼容/迁移。
- 扫描证据：grep/glob 搜索词、命中摘要、纳入/排除理由。
- 覆盖矩阵：同类点 → 处理方式 → 验证方式。
- 验收标准：覆盖全部纳入点；无法覆盖标记 `[UNCOVERABLE_REQUIREMENT]`。

局部修改仅在以下情况允许：

- 已证明单一事实来源就在该处，其他入口复用同一路径。
- 覆盖矩阵证明其他同类点不受影响。
- 用户明确接受局部行为差异。

## 委派包

委派只传高信号信息：

```text
任务来源:
目标:
上下文锚定: [上次目标/状态/本次差异]
需求扩散包: [触发时必填]
结构化知识: [GitNexus 查询摘要：执行流/影响面/数据依赖/API 消费者，标注索引可能滞后的部分]
关键文件:
约束:
验收标准: [硬约束：每条必须可验证（有代码路径或验证命令）；不可验证标 [NEEDS_CLARIFICATION] 退回]
已知失败: [命令 + 关键片段]
反馈报告: [重试/升级时必填]
```

## 知识沉淀与 skills 回写

经验沉淀的输出不仅用于当前任务回顾，还应评估是否值得写入项目长期知识库 `.kilo/skills/`。

### 回写触发条件

见 `.kilo/instructions/skills-lifecycle.md` 的「回写触发条件」。

### 回写流程

见 `.kilo/instructions/skills-lifecycle.md` 的「回写流程」。

### 约束

- 只写入经客观验证的经验；禁止将未验证的推测写入长期知识库。
- 禁止在多个 skills 文件中重复维护同一规则；同一规则只在最相关的分类中完整维护一次。
- 局部项目的经验写入项目级 `.kilo/skills/`；全局骨架的经验通过正常 PR/维护流程更新本仓库。

## Anthropic 工作流模式映射

参考 Anthropic "Building Effective Agents" 提出的 5 大工作流模式，显式映射到 kilo 的 agent 角色：

| 模式 | 描述 | kilo 映射 | 触发条件 |
|------|------|----------|----------|
| **Prompt Chaining** | 任务分解为串行步骤，每步 LLM 调用处理上一步输出 | engineer/architect 单元 DAG 串行 | T0 之外的任务 |
| **Routing** | 输入分类后路由到专门的下游任务 | coderAgent 任务定级路由 | 所有任务 |
| **Parallelization** | 多个 LLM 调用并行处理后聚合输出 | ensemble + executor-A/B/C | T3 高风险任务 / 多次失败 |
| **Orchestrator-Workers** | 中央 LLM 动态拆解、委派、合成 | architect 拆解 + engineer 实现闭环 | T1+ 任务 |
| **Evaluator-Optimizer** | 一个 LLM 生成、另一个评估反馈循环 | reviewer + checker + fixer 门禁循环 | T1+ 任务 |

### 模式选择决策树

```
Step 1: 任务是否需要串行步骤链？→ 是 → Prompt Chaining（engineer 单元 DAG）
Step 2: 任务是否需要不同专门处理？→ 是 → Routing（coderAgent 任务定级）
Step 3: 任务可并行处理吗？→ 是 → Parallelization（ensemble）
Step 4: 任务需要动态拆解吗？→ 是 → Orchestrator-Workers（architect）
Step 5: 任务需要迭代优化吗？→ 是 → Evaluator-Optimizer（reviewer 链）
```

### 5 模式之间的互斥与协同

- 5 模式可**叠加**使用（如先 Routing 路由到子任务，再 Orchestrator-Workers 拆解）
- 同一任务可同时命中多个模式（如 ensemble 是 Parallelization + Orchestrator-Workers）
- **不得**误用模式（如把单文件 T0 任务升级到 ensemble 是过度工程化）

### 模式升级条件

| 当前模式 | 升级到 | 条件 |
|----------|--------|------|
| Prompt Chaining | Orchestrator-Workers | 步骤数 ≥ 3 且每步有独立验收标准 |
| Orchestrator-Workers | Parallelization | 单元间无依赖且验证可并行 |
| Evaluator-Optimizer | Parallelization | 多轮优化仍不收敛 |
| 任何模式 | ensemble | fixer 3 轮仍失败 / 用户反馈不干净 |

## 程序化记忆

`.kilo/memory/` 目录下的 MEMORY.md 和 USER.md 是项目级程序化记忆。

### MEMORY.md 写入触发

满足以下任一条件时，coderAgent 在交付阶段评估是否追加：

1. **跨 2 次以上任务重复出现的架构约束**（如"本项目必须用 DTO 而非裸 dict"）
2. **经 reviewer 确认为系统级而非项目级的经验**（如"所有 Python 项目统一用 uv 而非 pip"）
3. **修复不收敛（fixer 多轮失败）时发现的根因模式**（如"Windows 路径长度 260 限制反复触发"）

### USER.md 写入触发

仅由用户直接编辑写入（agent 不得自动写入 USER.md）。

### 加载机制

coderAgent 在任务启动时（意图判定完成后）执行：

1. 检测 `.kilo/memory/` 目录存在性
2. 若存在，将 `MEMORY.md` 和 `USER.md` 内容作为冻结快照注入当前会话上下文
3. 优先级：MEMORY > USER > 项目级 AGENTS.md > 全局 instructions

### 字符限制与超限处理

| 文件 | 字符限制 | 来源 |
|------|----------|------|
| MEMORY.md | ≤ 2200 字符 | 参照 Hermes Agent 设计 |
| USER.md | ≤ 1375 字符 | 参照 Hermes Agent 设计 |

MEMORY.md 超过 2200 字符时，coderAgent 触发压缩：将最旧的低频条目迁移到 `.kilo/memory/archive/YYYY-MM/`，原位置保留 1 行索引，总长度回到 ≤ 1800 字符后停止归档。

### 安全约束

⚠️ **禁止写入**（`reviewer` 安全视角自检会拦截）：API Key / Token / 密码 / 凭证 / 内部域名 / IP / PII / NDA 内容。

## 交付 MEMORY / skills 回写说明

### 回写决策矩阵

coderAgent 在交付阶段评估本次任务经验：

| 经验类型 | 写入目标 | 决策依据 |
|----------|----------|----------|
| 跨项目通用架构约束 | MEMORY.md | "这条经验在多个项目都有用吗？" 是 → MEMORY |
| 项目特定实现技能 | SKILL.md | "这条经验只对本项目有用吗？" 是 → SKILL |
| 临时调试上下文 | 不写 | 无复用价值 |
| 易于重新发现的事实 | 不写 | 可由网络搜索替代 |

- **不重复**：MEMORY 中已存在的条目不要重复写入 SKILL。
- **写入权限**：MEMORY.md 由 coderAgent 写入；USER.md 由用户直接编辑；SKILL.md 由 coderAgent 在交付阶段写入（命中触发条件时）。

### reviewer 标注

reviewer 在审查结论末尾若发现经验属于跨会话级别，应追加：

```text
[建议写入 MEMORY.md]
分类：<架构约束 / 安全模式 / 根因修复>
依据：<为什么这条值得跨会话保留>
```

coderAgent 收到此标注后在交付阶段评估是否写入 MEMORY.md。
