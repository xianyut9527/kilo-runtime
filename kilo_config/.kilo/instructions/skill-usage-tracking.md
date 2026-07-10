---
name: skill-usage-tracking
description: 6 主流程 agent（coder / engineer / architect / checker / fixer / reviewer）使用 skill 时的频次自动记录协议与日志规范。
keywords: skill-usage, tracking, log, telemetry, 频次, 记录, 日志
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# Skill 使用频次记录协议

> 6 主流程 agent（coderAgent / engineer / architect / checker / fixer / reviewer）每次加载或回写 skill 时，必须向 `.kilo/memory/skill-usage.log` 追加一行。
> 用途：沉淀 skill 实际使用频次与失败率，为 skills-lifecycle 治理提供数据。

## 1. 何时记录

- **完成触发**：agent 单元完成 / 整体任务交付时，记录本次任务中实际加载的每个 skill。
- **反思触发**：触发 reflection.md 的"强制跨会话根因回溯"或 Circuit Breaker 时，记录反思中涉及的 skill。

## 2. 记录什么

每行一个 skill，包含 5 字段：

| 字段 | 说明 |
|------|------|
| `timestamp` | ISO8601（`Get-Date -Format 'o'` 或 `date -Iseconds`） |
| `session_id` | 当前会话 ID（Kilo 注入或随机） |
| `skill_name` | skill 目录名（如 `verification-before-completion`） |
| `trigger` | 短描述（≤40 字符，如 `U1 前置加载` / `反思触发`） |
| `outcome` | `success` / `fail` / `partial` |

## 3. 如何聚合

- 写入路径：`.kilo/memory/skill-usage.log`（项目内，相对工作区根）。
- 格式：`<timestamp>|<session_id>|<skill_name>|<trigger>|<outcome>`（竖线分隔，便于后续 awk / rg 统计）。
- 追加方式：`Add-Content` / `>> append`，不得覆盖；不得修改历史行。
- 隐私：禁止记录 prompt 正文、密钥、用户隐私。

## 4. 反作弊与最小化

- 仅记录 skill 元数据，不记录内容。
- 失败重试算 1 次 `partial`，不重复写多行。
- 同会话同 skill 连续 3 次同 outcome 合并为 1 行（trigger 标注 `merged`）。
- executor-A / B / C、synthesizer、ensemble、pre-checker 不参与本协议。

## 5. 统计消费

`coderAgent` 在季度 review 时跑：

```bash
rg "^[^|]+\|[^|]+\|(verification-before-completion)" .kilo/memory/skill-usage.log | wc -l
```

按频次排序输出，确认核心 skill 仍在使用、冷门 skill 进入淘汰候选。
