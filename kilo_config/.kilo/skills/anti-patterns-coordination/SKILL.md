---
name: anti-patterns-coordination
description: 📦 [已归档 v2.1] 协调类反模式条目已全部迁入全局 sqlite fact_store；本文件仅保留迁移指引，不再包含 AP-XXX 全文。
keywords: [archived, coordination, linkage, deletion-residue, rename, subagent, 关联遗漏, 引用断链]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.2"
  category: knowledge
  archived: true
  content_removed: true
  migrated_to: fact_store
  migration_evidence: .kilo/memory/api/migrate_skill_to_fact_store.sql
  active_index: .kilo/skills/anti-patterns/SKILL.md
---

> ⚠️ **本文件已归档 + 内容已清空（v2.2, 2026-07-19）**
>
> 历史：本文件曾包含 6 条 AP 条目（AP-004 / AP-006 / AP-007 / AP-010 / AP-012 / AP-013），v2.1 已迁入全局 sqlite `fact_store`。
> v2.2 起：AP-XXX 全文已彻底删除，仅保留迁移指引作为 human-readable 索引。
>
> - 迁移脚本：`.kilo/memory/api/migrate_skill_to_fact_store.sql`
> - 活跃索引：`.kilo/skills/anti-patterns/SKILL.md`（v2.1，纯索引）
> - 标准查询 SQL：见索引文件「标准查询 SQL」章节
>
> **agent 不应通过 skill 工具加载本文件**。如需查询具体反模式，使用：
> ```sql
> SELECT fact_id, trigger, action, confidence, hit_count, tags, evidence
> FROM fact_store WHERE fact_id IN ('AP-004', 'AP-006', 'AP-007', 'AP-010', 'AP-012', 'AP-013');
> ```
>
> 如需人工查阅某条 AP 全文，**直接读 fact_store 行**（trigger + condition + action + evidence 字段），不再有任何 md 副本。