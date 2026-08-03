---
name: skill-usage-tracking
description: Skill 使用频次记录协议（已简化 — 工作流精简后不再独立追踪）
keywords: skill-usage, tracking
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "3.0"
  category: knowledge
---

# Skill 使用频次记录协议（已简化）

> **工作流简化后**：skill 使用追踪不再作为独立系统维护。skill 加载由 `skill` 工具按需触发，conductor 在 DELIVERING 阶段记录关键决策与模式供后续任务参考。历史频次数据不再累积。
