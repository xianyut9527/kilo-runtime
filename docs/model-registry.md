---
description: 模型能力倾向矩阵（人类可读版）+ 按智能体能力需求选择策略 + 多样性保障规则。模型 ID 绑定由 kilo.json agent.<name>.model 字段统一管理；能力匹配无机械校验，本文档供人类选模型参考。
deprecated_for_critical: ["hx/kimi-k2.7-code"]
diversity_map:
  "hx/glm-5.2":
    vendor: zhipu
    architecture: glm-5.2
  "hx/deepseek-v4-pro":
    vendor: deepseek
    architecture: deepseek-v4-pro
  "hx/deepseek-v4-flash":
    vendor: deepseek
    architecture: deepseek-v4-flash
  "hx/kimi-k2.6":
    vendor: moonshot
    architecture: kimi-k2.6
  "hx/kimi-k2.7-code":
    vendor: moonshot
    architecture: kimi-k2.7-code
  "hx/kimi-k3":
    vendor: moonshot
    architecture: kimi-k3
  "hx/MiniMax-M3":
    vendor: minimax
    architecture: MiniMax-M3
  "hx/MiniMax-M2.7-highspeed":
    vendor: minimax
    architecture: MiniMax-M2.7-highspeed
diversity_rule:
  applies_to:
    - verifier
    - reverse-auditor
    - side-checker
    - reviewer
  note: T3 阶段级多模型并行中，PLANNING/EXECUTING 的 3 个变体由 multiModel 在运行时从 diversity_map 选择不同 vendor/architecture；此处 applies_to 取 QUALITY 四视角作为静态可校验集合，确保关键路径至少覆盖 4 个不同厂商/架构。
---

# docs/model-registry

> **迁移说明**：本文档原为 `agent/models/registry.md`。原位置会被 Kilo 递归扫描注册为 subagent（`models/registry`），造成注册表污染，故迁至 `docs/`。
>
> **v6.1 变更**：`lifecycle/capabilities.yaml` 已删除（纯声明性配置无机械校验）。本文档成为能力倾向的**唯一人类可读参考**，无机器可读副本。bootstrap 不做能力匹配校验，选模型时人类对照本文档即可。

## 设计原则

1. **模型是资源，不是角色**：`kilo.json` `agent.<name>.model` 字段统一声明每个智能体绑定哪个模型 ID；本文档**不绑定模型 ID**，只描述能力倾向供人类参考。
2. **能力倾向优先**：按智能体的能力倾向选模型，而非按 agent 名称硬编码。选模型时对照本文档的能力倾向列。
3. **多样性保障**：T3 阶段级多模型并行中，PLANNING/EXECUTING 各阶段内并行 3 个不同厂商/不同架构的模型变体（由 multiModel 在运行时按 `diversity_map` 选择，违反 → `[DIVERSITY_VIOLATION]`）。QUALITY 四视角（verifier / reverse-auditor / reviewer / side-checker）已天然覆盖 4 个不同厂商/架构，形成交叉验证。
4. **单一真相来源**：模型 ID 变更只在 `kilo.json` 一处修改；能力倾向描述只在本文档一处维护。

## 模型能力矩阵（参考，实际选择见 kilo.json）

> 本表仅描述各模型的能力倾向，**不是绑定关系**。实际绑定以 `kilo.json` `agent.<name>.model` 为准。

| 模型 ID（kilo.json provider.hx.models） | 厂商 | 架构 | 推理 | 编码 | 长上下文 | 安全边界 | 稳定性排序 |
|------|------|------|------|------|----------|----------|----------|
| `hx/glm-5.2` | zhipu | glm-5.2 | ★★★★★ | ★★★★☆ | 200K | ★★★★★ | 1（最稳定） |
| `hx/deepseek-v4-pro` | deepseek | deepseek-v4-pro | ★★★★★ | ★★★★★ | 200K | ★★★★★ | 2 |
| `hx/kimi-k2.6` | moonshot | kimi-k2.6 | ★★★★★ | ★★★★☆ | 200K | ★★★★☆ | 3 |
| `hx/kimi-k2.7-code` | moonshot | kimi-k2.7-code | ★★★★☆ | ★★★★★ | 200K | ★★★★☆ | 4 |
| `hx/kimi-k3` | moonshot | kimi-k3 | ★★★★★ | ★★★★★ | 200K | ★★★★★ | 待观察 |
| `hx/MiniMax-M3` | minimax | MiniMax-M3 | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ | 5 |
| `hx/MiniMax-M2.7-highspeed` | minimax | MiniMax-M2.7-highspeed | ★★★☆☆ | ★★★☆☆ | 200K | ★★★☆☆ | 6 |
| `hx/deepseek-v4-flash` | deepseek | deepseek-v4-flash | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ | 7 |

> **厂商/架构列用途**：T3 阶段级多模型并行中，multiModel 在 PLANNING/EXECUTING 各阶段内并行调度 3 个不同厂商/架构的变体；QUALITY 四视角天然覆盖 4 个不同厂商/架构。人工选模型时对照此列确认异源覆盖。
> **稳定性排序用途**：`kilo.json` 中关键路径模型优先选用稳定性排序靠前的模型，当前默认 `glm-5.2` > `deepseek-v4-pro` > `kimi-k2.6`。

## 稳定性优先选模型指南

当前稳定性排序（由稳定到不稳定）：`glm-5.2` > `deepseek-v4-pro` > `kimi-k2.6` > `kimi-k2.7-code` > `MiniMax-M3` > `MiniMax-M2.7-highspeed` > `deepseek-v4-flash`。
`kimi-k2.7-code` 已降级使用，不再担任 conductor / multiModel / coder 等关键路径模型；`deepseek-v4-pro` 作为主力高性能模型补充到关键路径。

## 按智能体能力倾向矩阵

> 描述各智能体适合的能力倾向；变更某智能体的模型只需改 `kilo.json` `agent.<name>.model`。

### 单任务生命周期（conductor 编排）

| 智能体 | 生命周期阶段 | 能力倾向 | 能力要点 |
|--------|-------------|----------|----------|
| `conductor` | `INTENT` / `SIZING` / `DELIVERING` | `fast-reasoning` | 低延迟、轻量判定、记忆写入 |
| `planner` | `PLANNING` | `deep-reasoning` | 架构分析、长上下文、复杂推理 |
| `coder` | `EXECUTING` | `code-generation` | 编码专精、风格一致、最小改动 |
| `verifier` | `QUALITY`（verify hook） | `strict-verification` | 边界敏感、逻辑审查、安全敏感 |
| `reverse-auditor` | `QUALITY`（verify hook, T2+） | `strict-verification` | 严谨逻辑、反向推理 |
| `side-checker` | `QUALITY`（review hook, T2+） | `deep-reasoning` | 边界/安全/性能多角度强推理 |
| `reviewer` | `QUALITY`（review hook） | `deep-reasoning` | 架构视角、安全视角、强 reasoning |
| `fixer` | `QUALITY`（fix hook, auto-trigger） | `code-generation` | 快速修复、最小改动、假设驱动调试 |

### multiModel 阶段级并行（T3）

| 智能体 | 角色 | 能力倾向 | 能力要点 |
|--------|------|----------|----------|
| multiModel | 阶段级并行调度/融合 | `fast-reasoning` | PLANNING 阶段主槽拦截正常流程，串行调度 3 个不同厂商/架构的规划变体，收集方案后融合为单一结果写入 `task_context.plan`，主图继续流转 |
| planner-a | T3 PLANNING 变体-A | `deep-reasoning` | 方案设计视角（hx/kimi-k2.6），只输出方案摘要，由 multiModel 内部调度 |
| planner-b | T3 PLANNING 变体-B | `deep-reasoning` | 架构分析视角（hx/deepseek-v4-pro），只输出方案摘要，由 multiModel 内部调度 |
| planner-c | T3 PLANNING 变体-C | `deep-reasoning` | 边界发现视角（hx/glm-5.2），只输出方案摘要，由 multiModel 内部调度 |

> **多样化原则**：T3 PLANNING 3 个变体为不同厂商/不同架构模型（kimi-k2.6 / deepseek-v4-pro / glm-5.2），按 `diversity_map` 校验（违反 → `[DIVERSITY_VIOLATION]`）。QUALITY 四视角（verifier / reverse-auditor / reviewer / side-checker）已天然覆盖 4 个不同厂商/架构，形成交叉验证。
> **融合隔离原则**：multiModel 融合阶段不知道变体模型身份，避免按模型声誉而非方案质量取舍。
> **当前会话串行**：3 个变体由 multiModel 用 `task` 工具当前会话串行调度（各返回 ≤2000 字符方案摘要），无 worktree 依赖；EXECUTING 回归单路 coder。

## 模型降级规则

| 触发条件 | 降级策略 |
|----------|----------|
| RATE_LIMIT 连续 3 次 | 降级为同能力倾向的次优模型（改 `kilo.json` `agent.<name>.model`） |
| 次优模型也不可用 | single-coder 直办 + `[MULTIMODEL_DEGRADED]` |
| 累计 3 次 multiModel 失败 | 停止 multiModel + single-coder + `[MULTIMODEL_ABANDONED]` |
| T3 过去 24h 失败率 ≥30% | 跳过 multiModel，直接 single-coder |

## 校准机制

- `model_calibration` 表记录每个模型在每个能力维度上的表现
- 每次任务完成后更新：accuracy、latency、token_usage、helpful_rate
- 当某模型在某维度连续 3 次低于阈值 → 自动降级推荐（更新 `kilo.json` 建议由用户审批，不自动改写）