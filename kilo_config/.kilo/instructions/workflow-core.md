---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules

## 默认路由

- 入口：`coderAgent` 负责理解需求、路由、跟踪验证和交付。
- 简单局部实现 → `engineer`
- 架构变更、范围不清、跨层规则 → `architect`
- 显式 review 或安全/资金/权限/核心逻辑 → `reviewer`
- 多次失败、高风险、用户反馈"还是不对/有遗漏" → `ensemble`

## 模型选择策略（来源：`.kilo/skills/plan-execution/SKILL.md` 追踪规范 + superpowers/subagent-driven-development）

coderAgent 委派 agent 时，按任务复杂度选择模型：

| 复杂度 | 模型 | 场景 |
|--------|------|------|
| 机械任务 | `small_model` | 1-2 文件纯表面修改、搜索、读取确认 |
| 标准任务 | `agent.model` | 多文件集成、常规功能实现、checker/fix |
| 架构/审查 | `model` 或最强推理模型 | 完整规划、安全审查、T3 ensemble、复杂根因分析 |

> 默认 agent 配置在 `kilo.json` 中声明；coderAgent 可在委派时按上表覆盖。

## 任务定级

执行类任务必须按以下流程定级，并显式输出定级结论：

```
【任务定级结论】
- 任务等级：T0 / T1 / T2 / T3
- 定级依据：[具体判定条件]
- 执行路径：[直达engineer / 拆单元+pre-checker / architect+DAG / reviewer/ensemble]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 定级决策树

```
Step 1: 意图判定（core.md）
  ├─ 咨询类 → 只分析，不改文件
  └─ 执行类 → 继续 Step 2

Step 2: T0 极速通道检查（5条全部满足）
  ├─ 全部满足 → T0，直达 engineer
  └─ 任一不满足 → 继续 Step 3

Step 3: 需求清晰度检查
  ├─ 模糊/矛盾/高风险/范围不清 → 先澄清，清晰后重新定级
  └─ 清晰 → 继续 Step 4

Step 4: 复杂度量化判定
  ├─ 命中安全敏感关键词 → 最低 T2
  ├─ 单文件/单点修改，有明确验收标准 → T1
  └─ 跨模块/规则扩散/无明确验收 → T2+
```

### T0 极速通道（5条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖

T0 直达 engineer，无需 pre-checker、checker、reviewer。

### T1-T3 定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准 | architect 短设计门 → 拆单元，每单元 engineer → checker 闭环 |
| T2 | 跨模块，5+ 文件，规则扩散，命中安全敏感词 | architect 完整规划 → 单元 DAG → reviewer |
| T3 | 安全/资金/权限/核心逻辑，fixer 3 轮仍失败 | 全量 ensemble → reviewer → 用户决策 |

> **设计门分级**（来源：superpowers/brainstorming）：T1 走"短设计门"（architect 输出 1-3 句方案+验收点即可放行 engineer）；T2 走"完整规划"（architect 输出任务 DAG+依赖+风险）。连 1 行配置变更也走短设计门--"太简单不需要设计"是反模式，简单任务正是未审视假设造成返工的高发区。

### 安全敏感模块识别

命中以下关键词 → **最低 T2**：

`user / account / auth / login / password / token / jwt / session / payment / checkout / wallet / balance / fund / transfer`

## 单元化编排

T1+ 任务必须拆分为可验证的单元，每单元独立闭环。

### 单元定义

- **最小可交付单元**：一个单元必须能独立验证、独立回滚。
- **单元边界**：以文件/模块/接口为界，避免跨界单元。
- **单元依赖**：单元间依赖必须是 DAG（无循环）。

### 单元 DAG

```
architect 规划 → 生成单元列表 → 并行/串行执行 → 逐单元验收 → 总体验收
```

- 无依赖单元 → 并行执行
- 有依赖单元 → 按依赖顺序串行

## 门禁与闭环

### 单元级闭环（T1+）

每单元：engineer → checker → 如需 fixer → 重新 checker。

- engineer 不自验，必须过 checker。
- engineer 输出必须包含状态信号（`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`）。
- `NEEDS_CONTEXT` / `BLOCKED` → coderAgent 停止并回传，不进入 checker。
- checker FAIL → fixer 修复 → 重新 checker。
- fixer 连续 2 轮同症状 → 升级 reviewer。

### 总体验收（T2+）

所有单元通过后：
1. reviewer 三视角审查（安全/架构/简化）
2. 所有单元集成验证
3. 回归测试

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 设计门（T1+）| T1 短设计门、T2 完整规划未过不得进 engineer；通过标记 `[DESIGN_GATE_PASS]`，未过/跳过标记 `[DESIGN_GATE_MISS]` | `[DESIGN_GATE_MISS]` |
| 不自验 | engineer 不得自行验证 | `[PROCESS_VIOLATION]` |
| 状态信号 | engineer 必须输出 `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED` | `[MISSING_STATUS_SIGNAL]` |
| 双重 checker | 正向（需求/语法/逻辑/边界）+ 反向（SCOPE_CREEP/调试残留/重复实现） | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` |
| 同症状防空转 | 连续 2 轮 fixer 同症状 → 升级 reviewer | `[NEEDS_REVIEW]` |
| Circuit Breaker | 连续 3 次无法收敛 → 停止 | `[CIRCUIT_BREAKER]` |
| 验收映射表 | 每条标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态 | `[MISSING_ACCEPTANCE_MAP]` |
| 计划执行门禁 | 计划执行前必须 critical review；遇 blocker 立即停止不猜测 | `[PLAN_DEVIATION]` |
| 结构化输出验证 | agent 返回必须经过 schema 自检（JSON.parse/XML 标签检查），失败 → 重试 | `[MALFORMED_OUTPUT]` |
| sqlite 记忆写入 | T1+ 任务完成后必须写入 dispatch_log；发现有效模式必须写入 fact_store/failure_db | `[MISSING_MEMORY_WRITE]` |

### 异常路由表

coderAgent 解析 agent 返回或工具调用结果时，按以下分级路由处理：

| 错误码 | 触发条件 | 路由策略 | 说明 |
|--------|----------|----------|------|
| `TIMEOUT` | 子 agent / MCP 调用超时 | 退避重试 3 次 → ESCALATE reviewer | 首次退避 5s，后续指数增长 |
| `RATE_LIMIT` | 模型限流 | 指数退避 + 切备用模型 | 退避间隔 5s/10s/20s |
| `CONTEXT_OVERFLOW` | 上下文超限 | 转 compaction 压缩后重试 1 次 | 压缩后仍超限 → 拆单元 |
| `AUTH` | 鉴权失败 | **不重试**，立即升级人工 | 可能是密钥失效 |
| `BAD_INPUT` | 委派包参数不合法 | **不重试**，回 coderAgent 修正 | 通常是 dispatch 生成错误 |
| `TOOL_DENIED` | 工具被策略拒绝 | 转人机回路确认 | 可能命中安全策略 |
| `CRASH` | 进程/MCP 崩溃 | 重试 1 次 → 切备用执行器 | 备用执行器指同任务其他模型 |
| `AMBIGUOUS` | 输出无法解析/语义不清 | 重试 1 次（换严 schema）→ reviewer | 要求 agent 用更严格格式重输出 |
| `MALFORMED_OUTPUT` | 结构化输出格式错误 | 要求重输出，连续 2 次 → reviewer | 见 `output-schema.md` |

**路由原则**：
- 可恢复错误（TIMEOUT/RATE_LIMIT/CONTEXT_OVERFLOW）→ 自动重试
- 不可恢复错误（AUTH/BAD_INPUT）→ 立即停止，回传 coderAgent 或人工
- 语义错误（AMBIGUOUS/MALFORMED_OUTPUT）→ 降级重试，仍失败升级 reviewer

## 交付

### 收尾三步

1. **验证确认**：测试、构建、类型、Lint 通过；声明完成必须有本轮 fresh 证据，不得援引上一轮或他人结论（来源：superpowers/verification-before-completion）。
2. **范围确认**：`git diff --` 确认改动范围，无 SCOPE_CREEP。
3. **经验沉淀与自进化**（全局 sqlite 优先 + 项目 md 兜底）：
   - **必须写入全局 sqlite**：T1+ 任务完成后，通过 sqlite MCP 写入 `dispatch_log`；若 checker/reviewer 发现有效模式，写入 `fact_store`；若任务失败或 fixer 多轮，写入 `failure_db`
     - 写入规则详见 `.kilo/instructions/evolution.md`
   - **Skill 升级检测**：当 `fact_store.confidence >= 0.8` 且 `hit_count >= 3` 时，按 `.kilo/instructions/skill-upgrade.md` 生成 Skill 升级提案
   - **可选写入项目 md**：可复用事实 → `MEMORY.md`（仅作归档索引）；架构约束 → `AGENTS.md`
   - **全局记忆系统未初始化**（`~/.config/kilo/memory/memory.db` 不存在）→ 运行 `bun ~/.config/kilo/memory/init-db.ts` 初始化，再写入

### 分支收尾协议（来源：superpowers/finishing-a-development-branch）

执行类任务交付后，coderAgent 必须按序确认：

1. **工作树状态**：`git status` 确认无遗留未跟踪文件、无残留临时脚本/构建产物。
2. **提交边界**：单次提交对应单一定级单元；跨单元改动必须分提交，禁止"一锅烩"。
3. **分支去向**：明确告知用户当前分支名、是否需要 PR/MR、是否需要回主干合并；不擅自 push 或合并。
4. **worktree 隔离**（可选）：高风险或长任务建议在 git worktree 中执行，交付后清理 worktree（`git worktree remove`），避免污染主工作树。

### 交付信号

- **正常交付**："任务完成，以上是全部变更和验证结果。"
- **降级交付**："任务部分完成，以下是已完成内容、未完成项和阻塞原因。"
- **失败交付**："任务未完成，阻塞原因是 X，建议方案是 Y。"

### 计划执行门禁（来源：`.kilo/skills/plan-execution/SKILL.md`#执行前-Critical-Review + superpowers/executing-plans）

T2+ 任务执行 architect 计划前，coderAgent 必须：

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
