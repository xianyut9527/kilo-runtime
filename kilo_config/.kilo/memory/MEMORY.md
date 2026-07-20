---
name: memory
description: 静态指针兜底（v2.6 sqlite 唯一记忆）。本文件仅作 M-001 动态注入占位 + 静态指针；所有经验/日志/时序数据入 SQLite。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.6"
  char_limit: 1500
  category: memory
---

# MEMORY.md（sqlite 唯一记忆 — 静态指针）

> **本文件不是**记忆存储载体（v2.5 sqlite 唯一记忆原则）。所有数据入 `${HOME}/.config/kilo-data/memory.db` 的 7 张表 + 2 FTS5 虚表。
> 字符限制：**≤ 1500 字符**；由 `.kilo/memory/AGENTS.md` 按 **[tag]** 按需注入。

## M-001 [tag:config]

### M-001: kilo_config 全局配置运行约束  [memory:fact_id=<DYNAMIC_INJECT: top-2 AP + top-1 PAT by hit_count>]

> 详细触发场景 / 推荐做法：每次 M1 注入时由 `policy/query_strategy.md` §M-001 实时计算。
> Windows + PowerShell 5.1 默认 GBK 编码 → install.ps1 已永久化 UTF-8

## 归档协议 [tag:general]（v2.5 起禁止 md 累积）

**禁止** md 文件作为归档载体（sqlite 唯一记忆）。所有时序 / 累积数据入 SQLite：
- fact / failure 归档：`UPDATE ... SET archived=1`（详见 `policy/trial_archive.md`）
- skill_usage / dispatch 归档：SQLite 表内时间窗口查询 + 后续月度 partition