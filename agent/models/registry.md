---
description: 模型能力矩阵 + 按智能体能力需求选择策略 + 多样性保障规则。模型 ID 绑定由 kilo.json agent.<name>.model 字段统一管理，本文件只定义能力需求矩阵。
---

# models/registry

## 设计原则

1. **模型是资源，不是角色**：`kilo.json` `agent.<name>.model` 字段统一声明每个智能体绑定哪个模型 ID；本文件**不绑定模型 ID**，只定义能力需求矩阵。
2. **能力匹配优先**：按智能体的能力需求选模型，而非按 agent 名称硬编码。`kilo.json` 声明的模型应满足本文件 §按智能体能力需求矩阵 中该智能体的能力要求。
3. **多样性保障**：multiModel 模式下 3 个 coder 必须选不同厂商/不同架构模型。
4. **单一真相来源**：模型 ID 变更只在 `kilo.json` 一处修改，agent .md / lifecycle / orchestrator / multiModel 均不硬编码模型 ID。

## 模型能力矩阵（参考，实际选择见 kilo.json）

> 本表仅描述各模型的能力倾向，**不是绑定关系**。实际绑定以 `kilo.json` `agent.<name>.model` 为准。

| 模型 ID（kilo.json provider.hx.models） | 架构倾向 | 推理 | 编码 | 长上下文 | 安全边界 |
|------|------|------|------|----------|----------|
| `hx/kimi-k2.6` | 通用 reasoning | ★★★★★ | ★★★★☆ | 200K | ★★★★☆ |
| `hx/kimi-k2.7-code` | Code-tuned | ★★★★☆ | ★★★★★ | 200K | ★★★★☆ |
| `hx/kimi-k3` | 通用 reasoning（强） | ★★★★★ | ★★★★★ | 200K | ★★★★★ |
| `hx/MiniMax-M3` | 通用 | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ |
| `hx/MiniMax-M2.7-highspeed` | 通用（低延迟） | ★★★☆☆ | ★★★☆☆ | 200K | ★★★☆☆ |
| `hx/glm-5.2` | 通用（边界敏感） | ★★★★★ | ★★★★☆ | 200K | ★★★★★ |
| `hx/deepseek-v4-flash` | 通用（快速） | ★★★★☆ | ★★★★☆ | 200K | ★★★★☆ |

## 按智能体能力需求矩阵

> 本表定义每个智能体的**能力需求**（registry 别名），`kilo.json` 声明的模型应满足该能力需求。变更某智能体的模型只需改 `kilo.json`，无需改本文件。

### 单任务生命周期（orchestrator 编排）

| 智能体 | 生命周期阶段 | 能力需求（registry 别名） | 能力要点 |
|--------|-------------|--------------------------|----------|
| `orchestrator` | `S01_INTENT` / `S03_SIZING` / `S16_DELIVERING` | `fast-reasoning` | 低延迟、轻量判定、记忆写入 |
| `planner` | `S05_PLANNING` | `deep-reasoning` | 架构分析、长上下文、复杂推理 |
| `coder` | `S07_EXECUTING` | `code-generation` | 编码专精、风格一致、最小改动 |
| `verifier` | `S09_CHECKING`（正向） | `strict-verification` | 边界敏感、逻辑审查、安全敏感 |
| `reverse-auditor` | `S09_CHECKING`（反向） | `strict-verification` | 严谨逻辑、反向推理 |
| `side-checker` | `S13_REVIEWING`（侧向） | `deep-reasoning` | 边界/安全/性能多角度强推理 |
| `reviewer` | `S13_REVIEWING`（审查） | `deep-reasoning` | 架构视角、安全视角、强 reasoning |
| `fixer` | `S11_FIXING` | `code-generation` | 快速修复、最小改动、假设驱动调试 |

### multiModel 并行（3 coder + 1 fusion）

| 智能体 | 角色 | 能力需求 | 能力要点 |
|--------|------|----------|----------|
| coder-A | 逻辑推理派 | `deep-reasoning` | 逻辑推理强，能发现边界条件 |
| coder-B | 安全边界派 | `strict-verification` 倾向 | 安全/边界敏感，擅长防御性编程 |
| coder-C | 代码生成派 | `code-generation` | 代码生成专精 |
| verifier | 严格验证 | `strict-verification` | 严格验证，发现边界问题和逻辑漏洞 |
| synthesizer-fusion | 独立融合编辑 | `long-context-synthesis` | 长上下文整合，代码风格统一 |
| multiModel（主控） | 拆分/委派/调度 | `fast-reasoning` | 拆分任务、调度智能体、不参与融合 |

> **多样化原则**：3 个 coder 必须选**不同架构/不同厂商**模型。`kilo.json` 中 coder-A/B/C 的模型应分属不同 tuned 方向（reasoning / 安全边界 / code-tuned）。
> **融合隔离原则**：synthesizer-fusion 不知道 coder 模型身份，避免按模型声誉而非方案质量取舍。

## 模型降级规则

| 触发条件 | 降级策略 |
|----------|----------|
| RATE_LIMIT 连续 3 次 | 降级为同能力矩阵的次优模型（改 `kilo.json` `agent.<name>.model`） |
| 次优模型也不可用 | single-coder 直办 + `[MULTIMODEL_DEGRADED]` |
| 累计 3 次 multiModel 失败 | 停止 multiModel + single-coder + `[MULTIMODEL_ABANDONED]` |
| T3 过去 24h 失败率 ≥30% | 跳过 multiModel，直接 single-coder |

## kilo.json 配置示例（实际绑定以 kilo.json 为准）

```json
{
  "model": "hx/MiniMax-M3",
  "small_model": "hx/MiniMax-M2.7-highspeed",
  "default_agent": "orchestrator",
  "agent": {
    "orchestrator":         { "mode": "primary",  "model": "hx/kimi-k2.6",       "prompt": "..." },
    "multiModel":           { "mode": "primary",  "model": "hx/kimi-k2.6",       "prompt": "..." },
    "synthesizer-fusion":   { "mode": "subagent", "model": "hx/kimi-k2.6",       "prompt": "..." },
    "planner":              { "mode": "subagent", "model": "hx/kimi-k3",         "prompt": "..." },
    "coder":                { "mode": "subagent", "model": "hx/kimi-k2.7-code",  "prompt": "..." },
    "verifier":             { "mode": "subagent", "model": "hx/glm-5.2",        "prompt": "..." },
    "reverse-auditor":      { "mode": "subagent", "model": "hx/glm-5.2",        "prompt": "..." },
    "side-checker":         { "mode": "subagent", "model": "hx/kimi-k3",         "prompt": "..." },
    "reviewer":             { "mode": "subagent", "model": "hx/kimi-k3",         "prompt": "..." },
    "fixer":                { "mode": "subagent", "model": "hx/kimi-k2.7-code",  "prompt": "..." }
  }
}
```

> 上述配置仅为示例；实际绑定以仓库 `kilo.json` 为单一真相来源。变更某智能体模型只需改 `kilo.json` 一处。

## 校准机制

- `model_calibration` 表记录每个模型在每个能力维度上的表现
- 每次任务完成后更新：accuracy、latency、token_usage、helpful_rate
- 当某模型在某维度连续 3 次低于阈值 → 自动降级推荐（更新 `kilo.json` 建议由用户审批，不自动改写）