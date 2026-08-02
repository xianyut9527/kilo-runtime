---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules

> **生命周期驱动**：conductor 按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount` 声明 at/order/when/on_fail，v6 单源）加载智能体。本文件以新术语描述流程规则。模型能力倾向唯一人类可读参考见 `docs/model-registry.md`（无机器可读副本）。

## 默认路由

- 入口：`conductor` 负责理解需求、路由、跟踪验证和交付。
- 简单局部实现 → `coder`
- 架构变更、范围不清、跨层规则 → `planner`
- 显式 review 或安全/资金/权限/核心逻辑 → `reviewer` + `side-checker`
- 多次失败、高风险、用户反馈"还是不对/有遗漏" → T3 worktree 端到端副本竞赛（PARALLEL_EXECUTION）

## 模型选择策略

conductor 加载智能体时，按任务复杂度选择模型：机械任务→`small_model`；标准任务→`agent.model`；架构/审查→最强推理模型。默认 agent 配置在 `kilo.json` 中声明；conductor 可在加载时覆盖。

## 任务定级（两阶段）

执行类任务必须按以下两阶段流程定级，**两阶段均显式输出**：

- **阶段 A·开场预估**：用于路由/模型选择/设计门深度选择
- **阶段 B·规划后校准**：planner 设计门落地后，基于实际 unit DAG 复核实际等级

### 阶段 A·开场预估（必填）

```
【任务定级·预估】
- 任务等级：T0 / T1 / T2 / T3（预估）
- 定级依据：[具体判定条件]
- 执行路径：[直达coder / 拆单元+planner / planner+DAG / reviewer / T3 worktree 并行]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 阶段 B·规划后校准（必填，planner 设计门落地后立即输出）

```
【任务定级·校准】
- 实际等级：T0 / T1 / T2 / T3（校准）
- 校准依据：[实际 unit 数 / 跨模块 / 风险面 / 安全敏感词命中]
- 偏差：维持预估 / 上调 / 下调
- 偏差原因（如有）：...
- review_mode：none / full（按本文件「review_mode 决策表」确定）
```

### 偏差规则

- **维持或上调**：默认放行
- **拿不准就升档**（成本不对称）：阶段 A 判据不足以区分相邻等级时预估取高一级——高估仅多付流程开销，低估导致返工与质量逃逸
- **下调**（如 T2 → T1）：必须同时满足以下全部硬条件：(1) 实际文件数 < 4；(2) 不跨模块；(3) 不命中安全敏感关键词；(4) PLANNING 阶段已正常完成（post:PLANNING 挂载点审查未中止流转）。满足全部条件后，须显式标注 `[DOWNGRADE_AFTER_PLAN]` 并写明依据。任一条件不满足则不得下调

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
  ├─ 单文件/单点修改，有明确验收标准 → T1
  ├─ 跨模块/规则扩散/无明确验收 → T2+
  └─ 判据不足以区分相邻等级 → 默认取高一级（成本不对称原则，详见「偏差规则」）
```

### T0 极速通道（5条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖

T0 直达 coder，无需 planner、verifier、reviewer。

### T1-T3 预估定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准 | planner 短设计门 → 拆单元，每单元 coder → verifier 闭环 |
| T2 | 跨模块，5+ 文件，规则扩散，命中安全敏感词 | planner 完整规划 → 单元 DAG → reviewer |
| T3 | 安全/资金/权限/核心逻辑，fixer 3 轮仍失败 | T3 worktree 端到端副本竞赛 → SYNTHESIZING 选优 → 用户决策 |

> **设计门分级**（来源：superpowers/brainstorming）：T1 走"短设计门"（planner 输出 1-3 句方案+验收点即可放行 coder）；T2 走"完整规划"（planner 输出任务 DAG+依赖+风险）。连 1 行配置变更也走短设计门--"太简单不需要设计"是反模式，简单任务正是未审视假设造成返工的高发区。

> **T1 直办条款**：当 T1 任务单元数=1、纯执行性、验收标准逐条可命令验证时，conductor 可不拆委派直接执行，避免委派链切片上下文损耗；但短设计门（自审 1-3 句方案+验收点）与 verifier 验证不得省略。直办仅限单模块改动，一旦发现跨模块扩散立即升级为委派链路。禁止以直办为由跳过任何验证门禁。

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
T1 / T2 / T3 → full（四视角：安全/架构/简化/SCOPE_CREEP）
```

> **review_mode 不分档**：T1+ 一律 full 四视角审查。任何审查档位化设计（如"跳过安全视角节省 token"）属质量妥协，无意义。

#### 模式说明

- **none**：跳过 reviewer。仅 T0 极速通道适用。
- **full**：四视角审查（安全/架构/简化/SCOPE_CREEP），T1+ 唯一模式。

#### 总体验收三步

1. reviewer 按 review_mode 审查
2. 所有单元集成验证
3. 回归测试

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 设计门（T1+）| T1 短设计门、T2 完整规划未过不得进 coder；方案放行由 post:PLANNING 挂载点独立审查（失败即 abort 中止流转）；绕过审查进 coder 由 verifier 拦截 | `[PLAN_REVIEW_MISS]` |
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
| sqlite 记忆写入 | T1+ 任务完成后必须写入 dispatch_log；T0/INQUIRY 命中"价值信号"时同样必须写入（见 `agent/conductor.md` §记忆编排）；发现有效模式必须写入 fact_store/failure_db | `[MISSING_MEMORY_WRITE]` |

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

完整标记清单见 `output-schema.md` §标记语言。以下为 conductor 检测后必须执行的硬动作（不得跳过）：

| 标记 | 硬动作 |
|------|--------|
| `[MALFORMED_OUTPUT]` | 要求 agent 用更严格格式重输出；第 2 次仍失败 → 调用 reviewer |
| `[MISSING_STATUS_SIGNAL]` | 要求 agent 显式输出状态；仍失败 → 调用 reviewer |
| `[MISSING_RECALL]` | 立即执行 sqlite 查询；查询完成前不得进入修复阶段 |
| `[MISSING_MEMORY_WRITE]` | 立即补写 dispatch_log；写入完成前不得标记任务完成 |
| `[MISSING_CONTEXT_QUERY]` | 立即补调必要工具；完成后重新检查点 |
| `[PROCESS_VIOLATION]` | 标记违规 + 暂停执行 + 修正后从上一个检查点恢复 |
| `[CIRCUIT_BREAKER]` | 停止修复 + 生成降级交付报告 + 建议用户决策 |
| `[NEEDS_REVIEW]` | 停止 fixer + 升级 reviewer，reviewer 结论作为最终状态 |

**执行要求**：所有标记检测必须在子 agent 返回后 **10 秒内**完成；触发后 conductor 必须显式输出「检测到 `[标记名]`，执行动作：...」；任何标记未处理即进入下游 → `[PROCESS_VIOLATION]`。

## 重复模式修复 / 组件化 SOP（UI 与非 UI 通用）

同一实现模式在 ≥2 个文件/模块出现时，强制按以下流程执行，禁止逐处打补丁。"统一 XX 规范""全量审计""批量整改""全局替换"类任务同样适用本 SOP：

1. **全量扫描清单先行**：grep/glob/gitnexus 产出完整命中清单（文件数+行数+分类），作为验收基准；禁止边改边发现。
2. **根因分类**：A. 缺少共享抽象 → 创建/扩展；B. 已有但实现错误 → 修正并同步消费者；C. 独立上下文无法抽象 → 验收映射表写明理由+用户确认。
3. **组件化优先**：重复 ≥2 处提炼为共享抽象（UI: 组件/layout/design token/mixin/全局 CSS；非 UI: util/hook/service/repository/adapter/策略接口/配置驱动/插件化）。
4. **同步依赖**：所有受影响文件/模块同批修改，禁止「先改一个看看」。
5. **注释溯源**（审计类任务）：每处整改标注规范条目编号，便于审计回归。
6. **防复发产物**：交付必须包含至少一项防复发机制（token 体系/共享组件/lint 规则/文档硬约束条款）。
7. **反向验证**：旧模式反向 grep（命中数=0），新引用正向 grep（命中数=预期消费者数），写入验收映射表。

违反任意一步 → `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`，verifier 必须 FAIL。

## 交付

### 收尾自检（硬门：T1+ 必走；T0/INQUIRY 命中"价值信号"时同样必走，缺则 `[MISSING_MEMORY_WRITE]` 阻塞交付）

T1+ 任务「经验沉淀」执行前，conductor 必须按以下 checklist 全部勾选。每条对应具体 SQL / 工具调用，可被自动验证。完整 SQL 模板见 `docs/memory-ops-reference.md`。

- [ ] **dispatch_log 必写（M7）**：`INSERT INTO dispatch_log ...`（含 dispatch_id/thread_id/agent/task_summary/tier/review_mode/model/status/duration_ms/files_changed/findings_count/created_at）
- [ ] **fact_store 去重与插入（M4）**：先 SELECT 查重，命中 UPDATE hit_count+1/confidence，未命中 INSERT（AntiPattern confidence=0.5 / Pattern=0.6）
- [ ] **fact_store hit_count 自增回路（M6）**：对本次引用的 fact_id 执行 `UPDATE hit_count+1, confidence=MIN(0.95,confidence+0.02)`；同类失败同步 `UPDATE failure_db same_symptom_count+1`
- [ ] **M6 Stage 3 helpful/misleading 反馈（v2.6 强制硬门）**：必须输出 `[memory:helpful=A,B]` / `[memory:misleading=X]` 或无反馈 `[memory:helpful=none]`，禁止静默省略
- [ ] **failure_db 写入（M5）**：verifier 首轮 FAIL 即记录；fixer 连续 2 轮同症状 / Circuit Breaker / 用户反馈「还是不对」同样必须 INSERT
- [ ] **model_calibration 更新（M8）**：`success_rate = (success_rate*sample_count + ?) / (sample_count + 1)`，DONE=1.0 / DONE_WITH_CONCERNS=0.7 / FAILED=0.0
- [ ] **fixer error_code 回写**：fixer 被触发过 → `UPDATE dispatch_log SET error_code='FIXED_BY_FIXER_ROUND_N'`
- [ ] **Skill 升级检测（仅记录，不自动落盘）**：confidence≥0.8 && hit_count≥3 → 生成 `[AUTO_DRAFT]` 草稿，不得直接 patch SKILL.md
- [ ] **记忆提示输出（轻量即时）**：召回 `🧠 [memory:recall]`（含注入条数+ID+A'证据），写入 `💾 [memory:write]`（含 fact_id/dispatch_id，M6/M7/M8 可合并 1 行）；禁止输出 M1-M8 大表格

> **路径口径**：sqlite 路径统一为 `${HOME}/.config/kilo-data/memory.db`，由 Kilo 运行时解析。初始化与建表脚本见 `.kilo/memory/schema/init.sql`（install 脚本自动执行）。

未执行上述任何一项 → `[MISSING_MEMORY_WRITE]`，conductor 必须立即补写，不得进入「分支收尾协议」。

### 收尾三步

1. **验证确认**：测试、构建、类型、Lint 通过；声明完成必须有本轮 fresh 证据。
2. **范围确认**：`git diff --` 确认改动范围，无 SCOPE_CREEP。
3. **经验沉淀与自进化**：执行上方 §收尾自检（硬门）。

### 分支收尾协议

1. **工作树状态**：`git status` 确认无遗留未跟踪文件。
2. **提交边界**：单次提交对应单一定级单元；跨单元改动分提交，禁止"一锅烩"。
3. **分支去向**：明确告知用户当前分支名、是否需要 PR/MR；不擅自 push 或合并。
4. **worktree 隔离**（可选）：高风险或长任务建议在 git worktree 中执行，交付后清理。

### 交付信号

- **正常交付**："任务完成，以上是全部变更和验证结果。"
- **降级交付**："任务部分完成，以下是已完成内容、未完成项和阻塞原因。"
- **失败交付**："任务未完成，阻塞原因是 X，建议方案是 Y。"

### 计划执行门禁

T2+ 任务执行 planner 计划前，conductor 必须：Critical Review → 创建追踪 todo → 遇 blocker 即停 → 顺序执行 → 每步验证。

## 验证与修复通用原则

见 `.kilo/instructions/reflection.md` §三层判定 + §Circuit Breaker。

## small_model 路由规则

`small_model` 仅在以下条件**全部满足**时使用：① 1-2 文件纯表面修改（文案/格式/命名/注释）；② 无逻辑变更、无跨模块依赖；③ 不需推理链（搜索/读取确认/机械替换）；④ 非安全敏感模块。任一不满足 → 用 `agent.model` 或更强。**禁止**把 verifier/fixer/reviewer 等质量门禁角色路由到 small_model。
