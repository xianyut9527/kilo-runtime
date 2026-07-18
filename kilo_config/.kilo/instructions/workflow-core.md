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

## 任务定级（两阶段）

执行类任务必须按以下两阶段流程定级，**两阶段均显式输出**：

- **阶段 A·开场预估**：用于路由/模型选择/设计门深度选择
- **阶段 B·规划后校准**：architect 设计门落地后，基于实际 unit DAG 复核实际等级

### 阶段 A·开场预估（必填）

```
【任务定级·预估】
- 任务等级：T0 / T1 / T2 / T3（预估）
- 定级依据：[具体判定条件]
- 执行路径：[直达engineer / 拆单元+pre-checker / architect+DAG / reviewer/ensemble]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 阶段 B·规划后校准（必填，architect 设计门落地后立即输出）

```
【任务定级·校准】
- 实际等级：T0 / T1 / T2 / T3（校准）
- 校准依据：[实际 unit 数 / 跨模块 / 风险面 / 安全敏感词命中]
- 偏差：维持预估 / 上调 / 下调
- 偏差原因（如有）：...
- review_mode：none / lightweight / full（按本文件「review_mode 决策表」确定）
```

### 偏差规则

- **维持或上调**：默认放行
- **拿不准就升档**（成本不对称）：阶段 A 判据不足以区分相邻等级时预估取高一级——高估仅多付流程开销，低估导致返工与质量逃逸
- **下调**（如 T2 → T1）：必须同时满足以下全部硬条件：(1) 实际文件数 < 4；(2) 不跨模块；(3) 不命中安全敏感关键词；(4) architect 设计门已过 `[DESIGN_GATE_PASS]`。满足全部条件后，须显式标注 `[DOWNGRADE_AFTER_PLAN]` 并写明依据。任一条件不满足则不得下调

> 性能注：阶段 B 不触发额外 architect 调用，仅在已有设计门产物基础上做复核；T0 不进阶段 B（极速通道豁免）。

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

T0 直达 engineer，无需 pre-checker、checker、reviewer。

### T1-T3 预估定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准 | architect 短设计门 → 拆单元，每单元 engineer → checker 闭环 |
| T2 | 跨模块，5+ 文件，规则扩散，命中安全敏感词 | architect 完整规划 → 单元 DAG → reviewer |
| T3 | 安全/资金/权限/核心逻辑，fixer 3 轮仍失败 | 全量 ensemble → reviewer → 用户决策 |

> **设计门分级**（来源：superpowers/brainstorming）：T1 走"短设计门"（architect 输出 1-3 句方案+验收点即可放行 engineer）；T2 走"完整规划"（architect 输出任务 DAG+依赖+风险）。连 1 行配置变更也走短设计门--"太简单不需要设计"是反模式，简单任务正是未审视假设造成返工的高发区。

> **T1 直办条款**：当 T1 任务单元数=1、纯执行性、验收标准逐条可命令验证时，coderAgent 可不拆委派直接执行，避免委派链切片上下文损耗；但短设计门（自审 1-3 句方案+验收点）与 checker 验证不得省略。直办仅限单模块改动，一旦发现跨模块扩散立即升级为委派链路。禁止以直办为由跳过任何验证门禁。

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

### 总体验收（T1+）

所有单元通过后，coderAgent 按 `review_mode` 选择 reviewer 模式：

#### review_mode 决策表

```
预估等级 + 校准命中条件 → review_mode
─────────────────────────────────────────────────
T0                              → none（无 reviewer）
T1 且 实际修改文件数 = 1        → lightweight
T1 且 实际修改文件数 2-3        → lightweight
T1 且 实际修改文件数 ≥ 4        → full（自动升级）
T1 且 命中跨模块条件             → full（自动升级）
T1 且 命中安全敏感关键词          → full（自动升级）
T2 / T3                         → full
```

#### 模式说明

- **none**：跳过 reviewer。仅 T0（极速通道）适用。
- **lightweight**：双视角审查（架构 + SCOPE_CREEP），跳过安全视角。reviewer 模型不变（`glm-5.2`），但产出 token 减约 1/3。
- **full**：四视角审查（安全/架构/简化/SCOPE_CREEP），T2+ 默认模式 + T1 命中升级条件后切换至此。

#### 升级触发器

阶段 B 校准命中以下任一条件，**强制升级 review_mode**：
1. 实际修改文件数 ≥ 4（无论预估 T1/T2）
2. 跨模块（修改文件命中 ≥ 2 个独立目录/包）
3. 命中安全敏感关键词（user/auth/payment/... 同上）

升级后 coderAgent 必须在阶段 B 输出中显式标注 `[REVIEW_MODE_UPGRADED: lightweight→full]`，并写入 dispatch_log 的 `review_mode` 字段。

> 性能注：T1 单文件/小改动任务走 lightweight，token 成本约为 full 的 60-70%，质量门禁覆盖度不变（架构 + 范围 = 最常漏的两个视角）；只有跨模块/安全敏感才升级到 full。

#### 总体验收三步

1. reviewer 按 review_mode 审查
2. 所有单元集成验证
3. 回归测试

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 设计门（T1+）| T1 短设计门、T2 完整规划未过不得进 engineer；通过标记 `[DESIGN_GATE_PASS]`，未过/跳过标记 `[DESIGN_GATE_MISS]` | `[DESIGN_GATE_MISS]` |
| 不自验 | engineer 不得自行验证 | `[PROCESS_VIOLATION]` |
| 状态信号 | engineer 必须输出 `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED` | `[MISSING_STATUS_SIGNAL]` |
| 双重 checker | 正向（需求/语法/逻辑/边界）+ 反向（SCOPE_CREEP/调试残留/重复实现/局部补丁） | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` / `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 局部补丁拦截 | 重复模式未走组件化/共享抽象，逐页复制样式 | `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 扫描与防复发交付门 | engineer 交付必须含全量同类点扫描清单 + 至少一项防复发产物 | `[MISSING_SCAN]` / `[MISSING_PREVENTION]` |
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

### ensemble 并发配额（T3 任务专用）

多执行器并行投票模式必须遵守并发上限，防止触发 provider 限流或上下文爆炸：

| 触发条件 | 行为 | 失败回退 |
|----------|------|----------|
| 单次 ensemble 触发 | ≤3 executor + 1 synthesizer = 4 并发硬上限 | 任一组件异常 → 串行化剩余 executor |
| 任一组件触发 RATE_LIMIT | 自动串行化 executor（保 2 折并发，即 1+1+1 改为 1→1→1） | 3 次限流 → 降级为单 engineer 直办 + 标记 `[ENSEMBLE_DEGRADED]` |
| 累计 3 次 ensemble 失败（含 rate-limit / crash） | 停止 ensemble 模式，降级为 single-engineer | 任务降级交付，标注 `[ENSEMBLE_ABANDONED]`，事后回写 failure_db |

**执行要求**：
- coderAgent 触发 ensemble 前必须先扫 `dispatch_log` 查过去 24h 内 `tier = 'T3'` 任务的失败率
- 单次失败率 ≥ 30% → 跳过 ensemble 直接 single-engineer（节省 token + 避免雪崩）
- 任一 executor 返回 `BLOCKED` / `NEEDS_CONTEXT` → 不等待其他 executor，立即停止整个 ensemble 上报 coderAgent

### 标记 → 硬动作映射（coderAgent 必须执行）

以下标记由 coderAgent 在解析子 agent 输出时自动检测，检测后必须执行对应硬动作，不得跳过：

| 标记 | 检测方式 | 硬动作 | 失败后果 |
|------|----------|--------|----------|
| `[MALFORMED_OUTPUT]` | JSON.parse 失败 / XML 标签缺失 / 必需字段缺失 | 1. 要求子 agent 用更严格格式重输出<br>2. 第 2 次仍失败 → 调用 reviewer | 流程中断，不得进入下游 |
| `[MISSING_STATUS_SIGNAL]` | 无法提取 `DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED` | 1. 要求子 agent 显式输出状态<br>2. 仍失败 → 调用 reviewer | 流程中断，不得进入下游 |
| `[MISSING_RECALL]` | 回溯阶段未执行 sqlite 查询 | 1. 立即执行 sqlite 查询<br>2. 查询完成前不得进入修复阶段 | 阻塞修复，直到查询完成 |
| `[MISSING_MEMORY_WRITE]` | T1+ 任务结束未写入 `dispatch_log` | 1. 立即补写 `dispatch_log`<br>2. 写入完成前不得标记任务完成 | 阻塞交付，直到写入完成 |
| `[MISSING_CONTEXT_QUERY]` | 编码前未按规则调用 Context Engine | 1. 立即补调必要工具<br>2. 完成后重新检查点 | 阻塞编码，直到查询完成 |
| `[PROCESS_VIOLATION]` | 流程跳步 | 1. 标记违规<br>2. 暂停执行<br>3. 修正后从上一个检查点恢复 | 任务暂停 |
| `[CIRCUIT_BREAKER]` | 连续 3 次无法收敛 | 1. 停止修复<br>2. 生成降级交付报告<br>3. 建议用户决策 | 任务终止 |
| `[NEEDS_REVIEW]` | fixer 连续 2 轮同症状 | 1. 停止 fixer<br>2. 升级 reviewer<br>3. reviewer 结论作为最终状态 | fixer 终止 |

**执行要求**：
- 所有标记检测必须在子 agent 返回后 **10 秒内**完成
- 标记触发后，coderAgent 必须在回复中显式输出「检测到 `[标记名]`，执行动作：...」
- 任何标记未处理即进入下游 → `[PROCESS_VIOLATION]`

## 规范统一 / 审计类任务 SOP

触发条件：「统一 XX 规范」「全量审计」「批量整改」「全局替换」类任务。此类任务的失败模式高度一致（边改边发现、逐页补丁、无防复发），必须按以下五步执行，缺步即 `[PROCESS_VIOLATION]`：

1. **全量扫描清单先行**：先用 grep/glob 产出完整命中清单（文件数 + 行数 + 分类），作为验收基准写入委派包；禁止边改边发现。
2. **组件化优先**：重复 ≥3 处的模式必须提炼为共享组件 / design token / mixin，禁止逐页复制粘贴式修补。
3. **注释溯源**：每处整改标注规范条目编号（如 `ui-spec §2 H1`），便于审计回归与后续反查。
4. **防复发产物**：交付必须包含至少一项防复发机制（token 体系 / 共享组件 / lint 规则 / 文档硬约束条款），否则视为未完成。
5. **反向验证**：交付前对「应清零项」做反向 grep（命中数=0），对「应统一引用项」做正向 grep（命中数=目标页面/模块数），两组数据写入验收映射表。

## 重复模式修复 / 组件化 SOP（UI/前端/跨页行为通用）

任何涉及 UI、样式、布局、交互行为的修复任务，若同一症状在 ≥2 个页面/组件出现，或用户已声明「类似问题普遍存在」/「所有页面都有这个问题」，强制按以下流程执行，禁止逐页打补丁：

1. **全量扫描清单先行**：用 grep/glob/gitnexus 产出完整命中清单（文件 + 行号 + 出现次数），作为验收基准写入委派包。
2. **根因分类**：
   - **A. 缺少共享抽象**（如无公共 Layout、无 design token、无全局样式）→ 创建/扩展共享抽象。
   - **B. 已有共享抽象但实现错误/未被消费** → 修正共享抽象并同步所有消费者。
   - **C. 各页面确实处于独立上下文且无法抽象** → 必须在验收映射表中写明理由，且需用户显式确认。
3. **组件化优先**：重复 ≥2 处的模式必须优先提炼为共享组件 / layout / design token / mixin / 全局 CSS；禁止把同一段样式复制到多个页面。
4. **同步依赖**：所有受影响的页面/组件必须同批修改，禁止「先改一个看看」。
5. **防复发产物**：交付必须包含至少一项防复发机制（design token、共享组件、lint 规则、文档条款、自动化测试、视觉回归测试），否则视为未完成。
6. **反向验证**：交付前对旧模式做反向 grep（命中数=0），对新引用做正向 grep（命中数=预期消费者数），数据写入验收映射表。

违反任意一步 → `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`，checker 必须 FAIL。

> 命中「统一 XX 规范」「全量审计」「批量整改」「全局替换」类任务时，额外按上方「规范统一 / 审计类任务 SOP」五步执行。

## 交付

### 收尾自检（硬门：T1+ 必走，缺则 `[MISSING_MEMORY_WRITE]` 阻塞交付）

T1+ 任务「经验沉淀」执行前，coderAgent 必须按以下 checklist 全部勾选，任何一项未执行都不得标记任务完成。每条都对应一条具体 SQL / 工具调用，可被自动验证。

- [ ] **dispatch_log 必写（M7）**：通过 sqlite MCP 执行 `INSERT INTO dispatch_log ...`（含 `dispatch_id` / `thread_id` / `agent` / `task_summary` / `initial_tier` / `final_tier` / `tier` / `review_mode` / `tier_deviation` / `model` / `status` / `duration_ms` / `files_changed` / `findings_count` / `created_at`），详见 `.kilo/memory/policy/dispatch_recorder.md`
- [ ] **fact_store 去重与插入（M4）**：发现可复用 pattern / anti-pattern 时，先 `SELECT fact_id FROM fact_store WHERE trigger=? AND action=? AND archived=0`；命中则 `UPDATE hit_count+1, confidence, updated_at`，未命中则 `INSERT`（AntiPattern 初始 confidence=0.5 / Pattern=0.6），详见 `.kilo/memory/policy/fact_dedup.md`
- [ ] **fact_store hit_count 自增回路（M6）**：回顾本次任务中**实际引用过的 fact_id 列表**（从 agent 输出中的 `[memory:fact_id=...]` 标记提取），对每个 fact_id 执行 `UPDATE fact_store SET hit_count = hit_count + 1, confidence = MIN(0.95, confidence + 0.02), updated_at = datetime('now') WHERE fact_id IN (...)`；若本次失败与历史 failure_db 记录同类，对应 `UPDATE failure_db SET same_symptom_count = same_symptom_count + 1`。详见 `.kilo/memory/policy/query_strategy.md` §4
- [ ] **failure_db 写入（M5）**：fixer 连续 2 轮同症状 / Circuit Breaker 触发 / 用户反馈「还是不对」→ `INSERT INTO failure_db ...`，verified 由后续 checker 验证后置 1，详见 `.kilo/memory/policy/failure_recorder.md`
- [ ] **model_calibration 更新（M8）**：`success_rate = (success_rate*sample_count + ?) / (sample_count + 1)`，DONE=1.0 / DONE_WITH_CONCERNS=0.7 / FAILED=0.0，详见 `.kilo/memory/policy/model_calibration.md`
- [ ] **fixer error_code 回写**：fixer 被触发过 → `UPDATE dispatch_log SET error_code='FIXED_BY_FIXER_ROUND_N' WHERE dispatch_id=?`，缺则 `[MISSING_FIXER_WRITE]`
- [ ] **Skill 升级检测（仅记录，不自动落盘）**：`SELECT trigger, action, confidence, hit_count FROM fact_store WHERE category='ANTIPATTERN' AND confidence >= 0.8 AND hit_count >= 3 AND archived = 0`；命中 → 按 `.kilo/memory/policy/skill_upgrade.md` 生成「`[AUTO_DRAFT]`」草稿标记，**不得直接 patch SKILL.md**，必须经人工确认（V1 阶段）
- [ ] **md 兜底**（可选）：MEMORY.md / USER.md 仅作归档索引或用户偏好，不作为经验沉淀主路径
- [ ] **记忆节点日志输出（M1-M8）**：在交付前输出 markdown 表格（同任务 8 节点对齐），让用户直观看到记忆系统在做什么；模板见 `agent/coderAgent.md` §记忆节点日志

> **路径口径**：sqlite 路径统一为 `${HOME}/.config/kilo-data/memory.db`，由 Kilo 运行时解析，install 阶段不替换。详见 `.kilo/memory/policy/init_check.md`「4 步初始化 SOP」章节。

未执行上述任何一项 → `[MISSING_MEMORY_WRITE]`，coderAgent 必须立即补写，不得进入「分支收尾协议」。

### 收尾三步

1. **验证确认**：测试、构建、类型、Lint 通过；声明完成必须有本轮 fresh 证据，不得援引上一轮或他人结论（来源：superpowers/verification-before-completion）。
2. **范围确认**：`git diff --` 确认改动范围，无 SCOPE_CREEP。
3. **经验沉淀与自进化**：执行流程详见上方 §收尾自检（硬门）；该清单已覆盖 dispatch_log / fact_store / failure_db / model_calibration 全部写入要求与 M 节点日志输出。

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
