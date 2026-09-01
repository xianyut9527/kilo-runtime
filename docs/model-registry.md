---
description: |
  模型能力倾向矩阵（人类可读版）+ 按智能体能力需求选择策略 + 多样性保障规则。模型 ID 绑定由 kilo.json agent.<name>.model 字段统一管理；能力匹配无机械校验，本文档供人类选模型参考。
models:
  "hx/glm-5.2":
    vendor: zhipu
    architecture: glm-5.2
  "hx/glm-5.3":
    vendor: zhipu
    architecture: glm-5.3
  "hx/glm-5.3-flash":
    vendor: zhipu
    architecture: glm-5.3-flash
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
  "hx/minimax-m3":
    vendor: minimax
    architecture: minimax-m3
---

# docs/model-registry

> **迁移说明**：本文档原为 `agent/models/registry.md`。原位置会被 Kilo 递归扫描注册为 subagent（`models/registry`），造成注册表污染，故迁至 `docs/`。
>
> **v6.1 变更**：`lifecycle/capabilities.yaml` 已删除（纯声明性配置无机械校验）。本文档成为能力倾向的**唯一人类可读参考**，无机器可读副本。bootstrap 不做能力匹配校验，选模型时人类对照本文档即可。

## 设计原则

1. **模型是资源，不是角色**：`kilo.json` `agent.<name>.model` 字段统一声明每个智能体绑定哪个模型 ID；本文档**不绑定模型 ID**，只描述能力倾向供人类参考。
2. **能力倾向优先**：按智能体的能力倾向选模型，而非按 agent 名称硬编码。选模型时对照本文档的能力倾向列。
4. **单一真相来源**：模型 ID 变更只在 `kilo.json` 一处修改；能力倾向描述只在本文档一处维护。

## 模型能力矩阵（参考，实际选择见 kilo.json）

> 本表仅描述各模型的能力倾向，**不是绑定关系**。实际绑定以 `kilo.json` `agent.<name>.model` 为准。

| 模型 ID（kilo.json provider.hx.models） | 厂商 | 架构 | 推理 | 编码 | 长上下文 | 安全边界 | 稳定性排序 |
|------|------|------|------|------|----------|----------|----------|
| `hx/glm-5.2` | zhipu | glm-5.2 | ★★★★★ | ★★★★☆ | 200K | ★★★★★ | 1（最稳定） |
| `hx/glm-5.3` | zhipu | glm-5.3 | ★★★★★ | ★★★★☆ | 200K | ★★★★★ | 2 |
| `hx/deepseek-v4-pro` | deepseek | deepseek-v4-pro | ★★★★★ | ★★★★★ | 200K | ★★★★★ | 3 |
| `hx/kimi-k2.6` | moonshot | kimi-k2.6 | ★★★★★ | ★★★★☆ | 200K | ★★★★☆ | 4 |
| `hx/kimi-k2.7-code` | moonshot | kimi-k2.7-code | ★★★★☆ | ★★★★★ | 200K | ★★★★☆ | 5 |
| `hx/kimi-k3` | moonshot | kimi-k3 | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ | 6 |
| `hx/minimax-m3` | minimax | minimax-m3 | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ | 7 |
| `hx/deepseek-v4-flash` | deepseek | deepseek-v4-flash | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ | 8 |
| `hx/glm-5.3-flash` | zhipu | glm-5.3-flash | ★★★★☆ | ★★★☆☆ | 200K | ★★★★☆ | 9 |

> **稳定性排序用途**：`kilo.json` 中关键路径模型优先选用稳定性排序靠前的模型，当前默认 `glm-5.2` > `glm-5.3` > `deepseek-v4-pro` > `kimi-k2.6`。

## 稳定性优先选模型指南

当前稳定性排序（由稳定到不稳定）：`glm-5.2` > `glm-5.3` > `deepseek-v4-pro` > `kimi-k2.6` > `kimi-k2.7-code` > `kimi-k3` > `minimax-m3` > `deepseek-v4-flash` > `glm-5.3-flash`（glm-5.3 编号为 2，glm-5.3-flash 排末位 9）。

## 按智能体能力倾向矩阵

> 描述各智能体适合的能力倾向；变更某智能体的模型只需改 `kilo.json` `agent.<name>.model`。

### 单任务生命周期（conductor 编排）

| 智能体 | 生命周期阶段 | 能力倾向 | 能力要点 |
|--------|-------------|----------|----------|
| `conductor` | `INIT` / `DELIVERING` | `fast-reasoning` | 低延迟、轻量判定 |
| `planner` | `PLANNING` | `deep-reasoning` | 架构分析、长上下文、复杂推理 |
| `coder` | `EXECUTING` | `code-generation` | 编码专精、风格一致、最小改动 |
| `verifier` | `QUALITY`（verify hook） | `strict-verification` | 边界敏感、逻辑审查、安全敏感 |
| `reviewer` | `QUALITY`（review hook） | `deep-reasoning` | 架构视角、安全视角、强 reasoning |
| `fixer` | `QUALITY`（fix hook, auto-trigger） | `code-generation` | 快速修复、最小改动、假设驱动调试 |


## 模型降级规则

| 触发条件 | 降级策略 |
|----------|----------|
| RATE_LIMIT 连续 3 次 | 降级为同能力倾向的次优模型（改 `kilo.json` `agent.<name>.model`） |

## 校准机制

> 已废弃：model_calibration 表已移除，校准逻辑改为 kilo.json 手动配置。

- ~~`model_calibration` 表记录每个模型在每个能力维度上的表现~~
- ~~每次任务完成后更新：accuracy、latency、token_usage、helpful_rate~~
- ~~当某模型在某维度连续 3 次低于阈值 → 自动降级推荐（更新 `kilo.json` 建议由用户审批，不自动改写）~~


## 当前模型绑定决策记录（P1-1 固化，防回摆）

> 历史曾出现 conductor/coder/fixer 在 minimax-m3 与 deepseek-v4-flash 间反复切换（2617f3a 切 minimax-m3 -> 后续回 deepseek-v4-flash）。本节固化当前决策理由，改绑前先评估以下依据。

| 智能体 | 当前模型(kilo.json) | 决策理由 |
|--------|---------------------|----------|
| conductor(默认主) | hx/glm-5.3-flash | reasoning + 低延迟编排判定；conductor edit:deny 不写代码，flash 档够用且省成本；glm 族稳定性优于 minimax-m3 |
| coder | hx/deepseek-v4-flash | 编码 ★★★★☆ + 200K 上下文；flash 档兼顾速度与编码能力 |
| fixer | hx/deepseek-v4-flash | 最小修复场景同 coder，复用绑定降低切换成本 |
| planner | hx/glm-5.3 | 规划需深推理，glm-5.3（reasoning ★★★★★，2026-08 升级）对稳定性与深推理要求最高 |
| verifier | hx/glm-5.3-flash | 正向验证快通道：保留 reasoning 的 flash 档，低延迟；与 L124 T1 model_overrides 覆盖(deepseek-v4-flash)分层——kilo.json 基础绑定=glm-5.3-flash |
| plan-reviewer/reviewer | hx/kimi-k2.6 | 多模态输入(image) + 强 reasoning，方案/代码审查需深度推理 |
| reverse-auditor | hx/glm-5.3 | 反向核对需强推理，glm-5.3 深推理档与 planner 同族 |
| small_model | hx/minimax-m3 | economy 降级目标，轻量任务省成本 |
| code_optimized_model | hx/kimi-k2.7-code | code 升级路径锚点（model-selector 读此字段替代硬编码魔数） |
## Tier 级模型覆盖（model_overrides）

> lifecycle/config.yaml tier_defaults[Tn].model_overrides 字段，由 apply-tier-auto 机械写入 task_context.config.model_overrides。conductor dispatch 时若该字段存在，覆盖 kilo.json 的 agent 模型绑定。优先级：config.model_overrides.<agent> > runtime_decision > kilo.json agent.<name>.model。

| Tier | Agent | 覆盖模型 | 理由 |
|------|-------|----------|------|
| T1 | verifier | hx/deepseek-v4-flash | 保留 reasoning，比 glm-5.2 轻量；机械门托底 L2 风险 |
| T2 | (无覆盖) | — | 保留 glm-5.2 全视角验证 |

> 设计约束：T2 不覆盖（保留最稳定模型）；方案 B 用 deepseek-v4-flash（保留 reasoning），不用 flash-noreason（SCOPE_CREEP 漏报风险）。


**改绑检查**：改任一 agent 模型前，对照本表理由列评估是否仍成立；模型切换 commit 须在 message 说明新理由，避免无记录回摆。
