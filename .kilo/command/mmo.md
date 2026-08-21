---
description: "多模型并行执行同一任务 + 融合查漏补缺，一次性高质量完成"
agent: conductor
---

# /mmo — 多模型执行 + 融合

你是工作流编排者（conductor）。用户通过 `/mmo` 触发多模型并行执行 + 融合查漏补缺。你的职责是按需编排能力，一次性交付高质量结果。

## 核心流程

```
3 个顶级大模型并行执行同一任务
        ↓
融合模型做查漏补全（union 模式）
        ↓
（可选）调 skill 生成最终报告
```

## 用法

```
/mmo <任务描述> [选项]
```

## 选项

| 选项 | 说明 | 默认 |
|---|---|---|
| `--pre "<cmd>"` | 执行前先跑命令（如 git log），输出注入执行模型 | 无 |
| `--data <file>` | 指定数据文件，内容注入执行模型 | 无 |
| `--anchors "f1,f2"` | 融合模型读这些文件核对共识 | 无 |
| `--skill <name>` | 融合后调 skill 生成最终报告 | 无（直接输出融合结果） |
| `--out <file>` | 融合结果落盘 | 只 stdout |
| `--models "m1,m2,m3"` | 临时覆盖执行模型 | 用 `kilo.json` `mmo.executor_models` |
| `--fusion <model>` | 临时覆盖融合模型 | 用 `kilo.json` `mmo.fusion_model` |
| `--fusion-mode <mode>` | `union`(查漏补全) / `weighted_consensus`(共识提取) | `union` |
| `--temp-exec <0-1>` | 执行模型温度 | 0.2 |
| `--temp-fusion <0-1>` | 融合模型温度 | 0.1 |
| `--verbose, -v` | 详细日志 | false |

## 编排步骤

### 1. 解析 `$ARGUMENTS`

提取任务描述 + 所有 `--` 选项。

### 2. 如有 `--pre`：conductor 用 bash 跑命令抓数据

```bash
<pre 命令> > "$env:TEMP\kilo\mmo-data.txt" 2>&1
```

数据落盘 `mmo-data.txt`，后续作为 `--data` 传给 mmo.mjs。

### 3. 调 mmo.mjs（多模型并行 + 融合）

```bash
node ".kilo/scripts/mmo.mjs" "<任务描述>" --data "$env:TEMP\kilo\mmo-data.txt" --fusion-mode union --out "$env:TEMP\kilo\mmo-fusion.md" --verbose 2>&1
```

- 3 个执行模型并行（Promise.allSettled，不阻塞）
- 融合模型做查漏补全（union 模式）：每个模型独有的数据点全部合并，标注"仅模型 X 提及"
- 分歧点标注 `⚠️ 分歧`，融合模型选证据最可信的版本
- 失败模型自动降级（`min_executors_required=2` 兜底）
- 融合结果落盘 `mmo-fusion.md`

### 4. 如有 `--skill`：conductor 用 skill 工具调 skill

```javascript
skill({ name: "<skill名>" })
```

skill 会读 `mmo-fusion.md` 生成最终报告。常见 skill：
- `deliver-assistant` — Word 交付文档
- `pm-weekly-month-report` — 周报/月报
- `pm-meeting-report` — 沟通纪要
- `deliver-code-review` — 代码审查

### 5. 如无 `--skill`：直接展示融合结果

把 `mmo-fusion.md` 内容展示给用户。

## 示例

```bash
# 纯多模型执行（最简）
/mmo 分析 src/auth/ 的安全性

# 抓 git 数据 + 多模型整理 + 融合
/mmo 整理 2026 年 1-7 月代码贡献数据 --pre "git log --since=2026-01-01 --until=2026-07-31 --numstat"

# 完整 pipeline：抓数据 + 多模型 + 调 skill 生成报告
/mmo 生成 2026 年 1-7 月代码贡献报告 --pre "git log --since=2026-01-01 --until=2026-07-31 --numstat" --skill pm-weekly-month-report --out report.docx

# 临时换模型
/mmo 审查架构 --models "hx/glm-5.2,hx/kimi-k3,hx/deepseek-v4-flash"

# 融合模型读文件核对
/mmo 核对报告数据 --anchors "authors.json,repos.csv"

# 创意任务调高温度
/mmo 生成产品方案 --temp-exec 0.7
```

## 配置

`.kilo/mmo.json`（独立配置文件，**不放 kilo.json**——kilo.json 有 schema 校验 `additionalProperties: false`，自定义字段非法）：

```json
{
  "executor_models": ["hx/glm-5.2", "hx/kimi-k2.6", "hx/deepseek-v4-flash"],
  "fusion_model": "hx/minimax-m3",
  "executor_temperature": 0.2,
  "fusion_temperature": 0.1,
  "timeout_ms": 600000,
  "max_output_tokens": 16384,
  "fusion_strategy": "weighted_consensus",
  "min_executors_required": 2
}
```

| 字段 | 说明 | 默认 |
|---|---|---|
| `executor_models` | 并行执行模型（3 个） | `["hx/glm-5.2", "hx/kimi-k2.6", "hx/deepseek-v4-flash"]` |
| `fusion_model` | 融合模型 | `"hx/minimax-m3"` |
| `executor_temperature` | 执行温度 | 0.2 |
| `fusion_temperature` | 融合温度 | 0.1 |
| `timeout_ms` | 单模型超时 | 600000 |
| `max_output_tokens` | 单模型最大输出 | 16384 |
| `fusion_strategy` | 默认融合策略 | `"weighted_consensus"` |
| `min_executors_required` | 最少成功数 | 2 |

**为什么放独立文件**：`kilo.json` 有 `$schema: https://app.kilo.ai/config.json` 校验，`additionalProperties: false`，自定义字段会被框架拒绝。`.kilo/mmo.json` 由 `mmo.mjs` 自己读取，与 Kilo 框架解耦。

## 融合模式

| 模式 | 说明 | 适用 |
|---|---|---|
| `union` | **查漏补全**——每个模型独有的数据点都合并，标注来源 | 数据整理（大数据集分块整理） |
| `weighted_consensus` | 共识提取——3 模型一致优先，分歧标注 | 主观判断（评分/审查） |

**默认 `union`**——因为你的核心诉求是"查漏补缺"。

## 故障处理

| exit | 含义 | 处理 |
|---|---|---|
| 0 | 全成功 | 展示融合结果 |
| 2 | 配置错误 | 检查 `kilo.json` `mmo` 块 + `HX_API_KEY` |
| 3 | 执行模型不足（<2 成功） | 检查模型可用性，或调低 `min_executors_required` |
| 4 | 融合失败 | 已降级输出 3 份原始拼接，提示人工判断 |
| 5 | `--pre` / `--data` 失败 | 检查命令/文件路径 |

## 审计

每次执行在 `.kilo/mmo-audit/<id>.json` 保存完整记录（任务/3 份原始输出/融合输出/耗时/tokens）。

## 不做的事

- 不替代 conductor 生命周期编排（`/mmo` 是一次性任务，不走 DAG）
- 不缓存结果（每次全新执行）
- `--skill` 阶段由 conductor 用 skill 工具调，不是 mmo.mjs 自己调（Node 脚本无 skill 权限）