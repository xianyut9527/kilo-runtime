---
name: memory-strategy
description: 记忆系统策略指针文件。完整内容已迁移到 .kilo/memory/ 模块（AGENTS.md + policy/*.md）
keywords: memory-strategy, pointer, sqlite-first-md-fallback
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.2"
  category: memory
---

# Memory Strategy（指针文件）

> **本文档已迁移**：v2.2 完整策略（sqlite-first-md-fallback + 试用期 + M6 扩展）已拆分到 `.kilo/memory/` 模块：
>
> | 原章节 | 新位置 |
> |---|---|
> | 策略标识 + 核心原则 + Token Budget | `.kilo/memory/AGENTS.md` |
> | 任务开始查询 + 失败回溯查询 | `.kilo/memory/policy/query_strategy.md` |
> | 任务结束写入 SQL 模板 | `.kilo/memory/policy/dispatch_recorder.md` |
> | 初始化检查 4 步 SOP | `.kilo/memory/policy/init_check.md` |
> | md 文件保留范围 | `.kilo/memory/AGENTS.md` §公共 API |
>
> 本文件保留作为兼容性指针（AGENTS.md 第 8 条 `strategy: "memory-strategy.md"` 仍可命中），新代码请直接引用 `.kilo/memory/` 模块。

---

**模块入口**：`.kilo/memory/README.md`（公共 API 文档）
**模块对 agent 入口**：`.kilo/memory/AGENTS.md`
**schema 唯一源**：`.kilo/memory/schema/init.sql`
**业务规则**：`policy/*.md`（7 个文件）
**健康度 SQL**：`contracts/health_check.sql`