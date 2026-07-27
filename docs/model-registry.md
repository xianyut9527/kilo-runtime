---
description: 模型能力倾向矩阵（人类可读版）+ 按智能体能力需求选择策略 + 多样性保障规则。模型 ID 绑定由 kilo.json agent.<name>.model 字段统一管理；能力匹配无机械校验，本文档供人类选模型参考。
---

# docs/model-registry

> **迁移说明**：本文档原为 `agent/models/registry.md`。原位置会被 Kilo 递归扫描注册为 subagent（`models/registry`），造成注册表污染，故迁至 `docs/`。
>
> **v6.1 变更**：`lifecycle/capabilities.yaml` 已删除（纯声明性配置无机械校验）。本文档成为能力倾向的**唯一人类可读参考**，无机器可读副本。bootstrap 不做能力匹配校验，选模型时人类对照本文档即可。

## 设计原则

1. **模型是资源，不是角色**：`kilo.json` `agent.<name>.model` 字段统一声明每个智能体绑定哪个模型 ID；本文档**不绑定模型 ID**，只描述能力倾向供人类参考。
2. **能力倾向优先**：按智能体的能力倾向选模型，而非按 agent 名称硬编码。选模型时对照本文档的能力倾向列。
3. **多样性保障**：multiModel 模式下 3 个 coder 必须选不同厂商/不同架构模型（`lifecycle/multimodel-graph.yaml` `diversity_rule` 声明，人工对照本文档校验，违反 → `[DIVERSITY_VIOLATION]`）。
4. **单一真相来源**：模型 ID 变更只在 `kilo.json` 一处修改；能力倾向描述只在本文档一处维护。

## 模型能力矩阵（参考，实际选择见 kilo.json）

> 本表仅描述各模型的能力倾向，**不是绑定关系**。实际绑定以 `kilo.json` `agent.<name>.model` 为准。

| 模型 ID（kilo.json provider.hx.models） | 厂商 | 架构 | 推理 | 编码 | 长上下文 | 安全边界 |
|------|------|------|------|------|----------|----------|
| `hx/kimi-k2.6` | moonshot | kimi-k2.6 | ★★★★★ | ★★★★☆ | 200K | ★★★★☆ |
| `hx/kimi-k2.7-code` | moonshot | kimi-k2.7-code | ★★★★☆ | ★★★★★ | 200K | ★★★★☆ |
| `hx/kimi-k3` | moonshot | kimi-k3 | ★★★★★ | ★★★★★ | 200K | ★★★★★ |
| `hx/MiniMax-M3` | minimax | MiniMax-M3 | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ |
| `hx/MiniMax-M2.7-highspeed` | minimax | MiniMax-M2.7-highspeed | ★★★☆☆ | ★★★☆☆ | 200K | ★★★☆☆ |
| `hx/glm-5.2` | zhipu | glm-5.2 | ★★★★★ | ★★★★☆ | 200K | ★★★★★ |
| `hx/deepseek-v4-flash` | deepseek | deepseek-v4-flash | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ |

> **厂商/架构列用途**：`multimodel-graph.yaml` `diversity_rule` 要求 coder-a/b/c 的 `(vendor, architecture)` 两两不同。人工选模型时对照此列确认。

## 按智能体能力倾向矩阵

> 描述各智能体适合的能力倾向；变更某智能体的模型只需改 `kilo.json` `agent.<name>.model`。

### 单任务生命周期（conductor 编排）

| 智能体 | 生命周期阶段 | 能力倾向 | 能力要点 |
|--------|-------------|----------|----------|
| `conductor` | `INTENT` / `SIZING` / `DELIVERING` | `fast-reasoning` | 低延迟、轻量判定、记忆写入 |
| `planner` | `PLANNING` | `deep-reasoning` | 架构分析、长上下文、复杂推理 |
| `coder` | `EXECUTING` | `code-generation` | 编码专精、风格一致、最小改动 |
| `verifier` | `CHECKING`（正向） | `strict-verification` | 边界敏感、逻辑审查、安全敏感 |
| `reverse-auditor` | `CHECKING`（反向） | `strict-verification` | 严谨逻辑、反向推理 |
| `side-checker` | `REVIEWING`（侧向） | `deep-reasoning` | 边界/安全/性能多角度强推理 |
| `reviewer` | `REVIEWING`（审查） | `deep-reasoning` | 架构视角、安全视角、强 reasoning |
| `fixer` | `FIXING` | `code-generation` | 快速修复、最小改动、假设驱动调试 |

### multiModel 并行（3 coder + 1 fusion）

| 智能体 | 角色 | 能力倾向 | 能力要点 |
|--------|------|----------|----------|
| coder-A | 逻辑推理派 | `deep-reasoning` | 逻辑推理强，能发现边界条件 |
| coder-B | 安全边界派 | `strict-verification` 倾向 | 安全/边界敏感，擅长防御性编程 |
| coder-C | 代码生成派 | `code-generation` | 代码生成专精 |
| verifier | 严格验证 | `strict-verification` | 严格验证，发现边界问题和逻辑漏洞 |
| synthesizer-fusion | 独立融合编辑 | `long-context-synthesis` | 长上下文整合，代码风格统一 |
| multiModel（主控） | 拆分/委派/调度 | `fast-reasoning` | 拆分任务、调度智能体、不参与融合 |

> **多样化原则**：3 个 coder 必须选**不同厂商/不同架构**模型（`multimodel-graph.yaml` `diversity_rule`，人工对照本文档"厂商/架构"列校验，违反 → `[DIVERSITY_VIOLATION]`）。
> **融合隔离原则**：synthesizer-fusion 不知道 coder 模型身份，避免按模型声誉而非方案质量取舍。

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