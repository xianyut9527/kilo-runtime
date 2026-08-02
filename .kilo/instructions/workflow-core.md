---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules

## 生命周期驱动

conductor 按 `lifecycle/graph.yaml` DAG（纯拓扑）+ `lifecycle/stages/*.md` 阶段执行逻辑 + `agent/*.md` frontmatter `mount` 声明加载智能体。模型能力倾向参考 `docs/model-registry.md`。

## 默认路由

- **简单局部实现** → `coder`
- **架构变更 / 范围不清 / 跨层规则** → `planner`
- **显式 review / 安全 / 资金 / 权限 / 核心逻辑** → `reviewer` + `side-checker`
- **多次失败 / 高风险 / 用户反馈“还是不对/有遗漏”** → T3 worktree 端到端副本竞赛

## 任务定级（两阶段）

执行类任务须显式输出两阶段定级：

- **阶段 A·开场预估**：用于路由/模型选择/设计门深度。
- **阶段 B·规划后校准**：planner 设计门落地后基于实际 unit DAG 复核。

### 阶段 A 模板

```
【任务定级·预估】
- 任务等级：T0 / T1 / T2 / T3（预估）
- 定级依据：[具体判定条件]
- 执行路径：[直达coder / 拆单元+planner / planner+DAG / reviewer / T3 worktree 并行]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 阶段 B 模板

```
【任务定级·校准】
- 实际等级：T0 / T1 / T2 / T3（校准）
- 校准依据：[实际 unit 数 / 跨模块 / 风险面 / 安全敏感词命中]
- 偏差：维持预估 / 上调 / 下调
- review_mode：none / full
```

### 偏差规则

- 维持或上调：默认放行。
- 拿不准就升档：判据不足以区分相邻等级时预估取高一级。
- 下调（如 T2 → T1）必须同时满足：文件数 < 4、不跨模块、不命中安全敏感关键词、PLANNING 已过 post 审查。须显式标注 `[DOWNGRADE_AFTER_PLAN]`。

### T0 极速通道（5条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖

T0 直达 coder，无需 planner/verifier/reviewer。

### T1-T3 预估定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准 | planner 短设计门 → 拆单元 → 每单元 coder → verifier 闭环 |
| T2 | 跨模块，5+ 文件，规则扩散，命中安全敏感词 | planner 完整规划 → 单元 DAG → reviewer |
| T3 | 安全/资金/权限/核心逻辑，fixer 3 轮仍失败 | T3 worktree 端到端副本竞赛 → SYNTHESIZING 选优 → 用户决策 |

**安全敏感模块识别**：命中 `user / account / auth / login / password / token / jwt / session / payment / checkout / wallet / balance / fund / transfer / admin / root / key / secret / credential / api_key / certificate / otp / mfa` → 最低 T2。

## 单元化编排

T1+ 任务拆分为可验证单元，每单元独立验证、独立回滚，依赖关系为 DAG。

## 门禁与闭环

### 单元级闭环（T1+）

每单元：coder → verifier → fixer（如需） → 重新 verifier。

- coder 不自验，必须过 verifier。
- coder 输出状态信号：`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`。
- verifier FAIL → fixer → 重新 verifier；fixer 连续 2 轮同症状 → 升级 reviewer。

### 总体验收（T1+）

所有单元通过后，调用 `reviewer` 做四视角审查（安全/架构/简化/SCOPE_CREEP）。T0 → none，T1+ → full。

### 质量门禁

| 门禁 | 失败标记 |
|------|----------|
| 设计门未过 | `[PLAN_REVIEW_MISS]` |
| coder 自验 | `[PROCESS_VIOLATION]` |
| 缺少状态信号 | `[MISSING_STATUS_SIGNAL]` |
| 正向/反向 verifier 失败 | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` / `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 局部补丁（逐处复制粘贴） | `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` |
| 缺少同类点扫描 / 防复发产物 | `[MISSING_SCAN]` / `[MISSING_PREVENTION]` |
| 连续 2 轮 fixer 同症状 | `[NEEDS_REVIEW]` |
| 连续 3 次无法收敛 | `[CIRCUIT_BREAKER]` |
| 缺少验收映射表 | `[MISSING_ACCEPTANCE_MAP]` |
| 结构化输出格式错误 | `[MALFORMED_OUTPUT]` |
| T1+ 未完成 sqlite 记忆写入 | `[MISSING_MEMORY_WRITE]` |

### 异常路由表

| 错误码 | 路由策略 |
|--------|----------|
| `TIMEOUT` | 退避重试 3 次 → reviewer |
| `RATE_LIMIT` | 指数退避 + 切备用模型 |
| `CONTEXT_OVERFLOW` | 压缩后重试 1 次 → 仍超限拆单元 |
| `AUTH` / `BAD_INPUT` | 不重试，立即升级 |
| `AMBIGUOUS` / `MALFORMED_OUTPUT` | 重试 1 次（严 schema） → reviewer |

### 标记 → 硬动作

conductor 检测后必须显式输出动作；未处理即进入下游 → `[PROCESS_VIOLATION]`。

| 标记 | 硬动作 |
|------|--------|
| `[MALFORMED_OUTPUT]` | 严 schema 重输出；第 2 次失败 → reviewer |
| `[MISSING_STATUS_SIGNAL]` | 要求显式状态；仍失败 → reviewer |
| `[MISSING_RECALL]` | 补 sqlite 查询，完成后进入修复 |
| `[MISSING_MEMORY_WRITE]` | 补写 dispatch_log，完成前不得标记任务完成 |
| `[MISSING_CONTEXT_QUERY]` | 补调必要工具，完成后重新检查点 |
| `[PROCESS_VIOLATION]` | 标记违规 + 暂停 + 从上一检查点恢复 |
| `[CIRCUIT_BREAKER]` | 停止修复 + 降级交付报告 + 建议用户决策 |
| `[NEEDS_REVIEW]` | 停止 fixer + 升级 reviewer，其结论为最终状态 |

## 重复模式修复 / 组件化 SOP（UI 与非 UI 通用）

同一模式 ≥2 处出现时：

1. **全量扫描清单先行**：grep/glob/gitnexus 产出完整命中清单。
2. **根因分类**：缺少共享抽象 / 已有但实现错误 / 独立上下文无法抽象。
3. **组件化优先**：提炼共享组件 / util / service / adapter / 配置驱动。
4. **同步依赖**：同批修改所有消费者。
5. **防复发产物**：交付含 lint 规则 / 共享组件 / 文档硬约束。
6. **反向验证**：旧模式命中数=0，新引用命中数=预期消费者数。

违反 → `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`，verifier 必须 FAIL。

## 交付

### 收尾自检（T1+ 必走；T0/INQUIRY 命中价值信号时同样必走）

按 `.kilo/memory/README.md` + `docs/memory-ops-reference.md` 执行：

- [ ] **dispatch_log 必写（M7）**
- [ ] **fact_store 去重与插入（M4）**
- [ ] **fact_store hit_count 自增回路（M6）**
- [ ] **M6 Stage 3 helpful/misleading 反馈**
- [ ] **failure_db 写入（M5）**
- [ ] **model_calibration 更新（M8）**
- [ ] **fixer error_code 回写**
- [ ] **Skill 升级检测**：confidence≥0.8 && hit_count≥3 → `[AUTO_DRAFT]`，不得直接 patch SKILL.md

未执行任何一项 → `[MISSING_MEMORY_WRITE]`，conductor 必须立即补写。

### 收尾三步

1. 验证确认：测试、构建、类型、Lint 通过。
2. 范围确认：`git diff --` 确认无 SCOPE_CREEP。
3. 经验沉淀：执行收尾自检。

### 分支收尾协议

1. `git status` 确认无遗留未跟踪文件。
2. 单次提交对应单一定级单元。
3. 明确告知用户分支名、是否需要 PR/MR，不擅自 push/合并。
4. worktree 隔离：高风险或长任务建议在 git worktree 执行，交付后清理。

### small_model 路由规则

仅当 1-2 文件纯表面修改、无逻辑变更、不需推理链、非安全敏感时使用。**禁止**把 verifier/fixer/reviewer 路由到 small_model。
