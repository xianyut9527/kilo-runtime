---
description: 生命周期总览。8 个阶段的状态机定义、智能体加载映射、快速导航和组合规则。
---

# lifecycle/README

## 生命周期状态机（多智能体协作）

```
S00(START)
  │
  ▼
S01(INTENT) [conductor] ──→ S02(INTENT_DONE) ──→ S03(SIZING) [conductor]
  │                                                    │
  ▼                                                    ▼
INQUIRY（咨询类）→ M1 召回 → 直接回答 → 价值信号? → M4-M8 轻量写入 → S17_DONE                    T0 → S07(EXECUTING) [coder] ──→ S16(DELIVERING) [conductor]
                                                      │                        │
                                                      T1 → S05(PLANNING)      PASS → S16(DELIVERING)
                                                     │    [planner]            │
                                                     T2 → S05(PLANNING)      FAIL → S11(FIXING) [fixer] ──→ S09(CHECKING)
                                                          │    │                │
                                                          └──→ S06(PLAN_APPROVED)──→ S07(EXECUTING) [coder]
                                                                                     │
                                                                                     S09(CHECKING)
                                                                                     ├─ [verifier] 正向
                                                                                     └─ [reverse-auditor] 反向（T2+，并行）
                                                                                     │
                                                                                      FAIL ──→ S11(FIXING) [fixer]     T1+ → S13(REVIEWING)
                                                                                     │                                ├─ [side-checker] 侧向（T2+，并行）
                                                                                     │                                └─ [reviewer] 审查
                                                                                     PASS/CONDITIONAL → S14(REVIEW_PASSED) → S16(DELIVERING)
                                                                                     │
                                                                                     FAIL → S11(FIXING) [fixer] ──→ S09(CHECKING)
                                                                                     │
                                                                                     S16(DELIVERING) [conductor] → S17(DONE)
                                                                                     │
                                                                                     T3 → MM_INIT（multiModel 专属生命周期，见 multiModel.md）
```

## 阶段文件索引

| # | 阶段 | 文件 | 加载智能体（v3.2 条件加载） | 质量门禁 |
|---|------|------|---------------------------|----------|
| 01 | 意图判定 | `01-intent.md` | `conductor`（必加载） | 类型明确 |
| 02 | 任务定级 | `02-sizing.md` | `conductor`（必加载） | T0-T3 准确 + 写入 `config.agents` |
| 03 | 设计门 | `03-design.md` | `planner`（`config.agents.planner`） | `[DESIGN_GATE_PASS]` |
| 04 | 实现 | `04-implementation.md` | `coder`（`config.agents.coder`） | 验收映射表 + 三件套 |
| 05 | 验证 | `05-verification.md` | `verifier`（必加载）+ `reverse-auditor`（`?config.agents.reverse_auditor`） | 正向+反向 PASS |
| 06 | 审查 | `06-review.md` | `side-checker`（`?config.agents.side_checker`）+ `reviewer`（必加载） | 侧向+审查四视角通过 |
| 07 | 修复 | `07-repair.md` | `fixer`（`config.agents.fixer`） | 根因确认 + 验证通过 |
| 08 | 交付 | `08-delivering.md` | `conductor`（必加载） | `[MISSING_MEMORY_WRITE]` 检查 |

> **v3.2 条件加载语法**：`agents` 数组项支持两种形式：
> - 裸字符串（如 `verifier`）：必加载
> - `"<name>?<condition>"`（如 `reverse-auditor?config.agents.reverse_auditor`）：仅当 condition 为 true 时加载
> conductor 在 S03 定级后写入 `task_context.config.agents`，阶段文件按条件表达式解析实际加载哪些智能体。这是真正的可插拔/可扩展机制——用户可在 prompt 中显式覆盖 `config.agents` 组合。

## 组合规则（v3.2 配置驱动）

> **v3.2 改变**：组合不再由定级硬编码决定，而是 conductor 在 S03 写入 `task_context.config.agents`，阶段文件按条件加载语法解析。以下为定级对应的**默认值**，用户可在 prompt 中显式覆盖。

### T0（直达执行）— 默认 config.agents
`config.agents = { coder: true, 其他: false }`，`review_mode = none`
- 路径：`S01` → `S03`（T0）→ `S07` → `S16` → `S17`
- 无设计门，无 verifier，无 reviewer；记忆写入**按"价值信号"触发**（非按定级一刀切，详见 `agent/conductor.md` §记忆编排 T0 条款）
- M1 必选（`memory.db` 存在时强制执行）

### T1（短设计门 + full 四视角审查）— 默认 config.agents
`config.agents = { planner: true, coder: true, verifier: true, reviewer: true, fixer: true, reverse_auditor: false, side_checker: false, synthesizer_fusion: false }`，`review_mode = full`
- 路径：`S01` → `S03`（T1）→ `S05`（短设计门）→ `S06` → `S07` → `S09` → `S10` → `S13`（full 四视角）→ `S14` → `S16` → `S17`

### T2（完整规划 + 全审查）— 默认 config.agents
`config.agents = T1 + { reverse_auditor: true, side_checker: true }`，`review_mode = full`
- 路径：`S01` → `S03`（T2）→ `S05`（完整规划）→ `S06` → `S07`（按 DAG 串行/并行）→ `S09` → `S10` → `S13`（full）→ `S14` → `S16` → `S17`

### T3（multiModel 并行）— 默认 config.agents
走 multiModel 生命周期，`config.agents.synthesizer_fusion = true`
- 路径：`S01` → `S03`（T3）→ `MM_INIT` → `MM_INJECT` → `MM_EXECUTING` → `MM_CHECKING` → `MM_FUSING` → `MM_FCHECK` → `MM_DELIVERING` → `MM_ARCHIVED`
- multiModel 生命周期见 `agent/multiModel.md`，不重复在此展开。

### 用户自定义覆盖（v3.2 可插拔）
- 用户在 prompt 中声明"本次需要 reverse-auditor"或"跳过 reviewer"→ conductor 写入 `config.agents` + `config.custom_overrides`
- 阶段文件按最终 `config.agents` 条件加载，不受定级硬编码约束
- 这是真正的可插拔/可扩展机制

## 核心原则

1. **生命周期是主线索**：每个阶段定义输入、加载智能体、输出信号、路由下游。智能体文件是独立单元，模型是资源。
2. **智能体文件独立化**：每个智能体有独立 prompt + 模型 + context window，不再共享单一 agent 的上下文。
3. **conductor 是编排者**：从"全能主控"变为"生命周期状态机驱动者"，按阶段文件定义的状态流转加载对应智能体，管理 task_context 共享。
4. **质量门禁不可跳过**：`[DESIGN_GATE_PASS]`、`verifier PASS`、`reviewer 通过`、`[MISSING_MEMORY_WRITE]` 检查都是硬门。
