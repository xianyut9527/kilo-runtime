---
name: patterns
description: 正向模式索引（v2.1 改为指向 fact_store）。2 条 PAT 条目已迁移到全局 sqlite fact_store 表，本文件仅保留索引与查询 SQL。
keywords:
  - patterns
  - best-practice
  - implementation-pattern
  - fact_store
  - sqlite
  - 索引
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.1"
  category: knowledge
  migrated_to: fact_store
  migration_evidence: .kilo/memory/api/migrate_skill_to_fact_store.sql
---

# 正向模式索引（指向 fact_store）

> ⚠️ **v2.1 重大变更**：2 条 PAT 条目（PAT-001 / PAT-002）已于 2026-07-19 从本 skill 迁出，**全部进入全局 sqlite `fact_store` 表**（category='PATTERN'）。
> 迁移脚本：`.kilo/memory/api/migrate_skill_to_fact_store.sql`
>
> **本文件仅作为索引保留**。agent 通过 sqlite MCP 按 tag 查询相关正向模式。

## 为什么迁移

之前 2 条 PAT-XXX 作为 markdown 存储在本文件，每次相关任务都会**加载全文**（500-1000 tokens / 任务），且无法统计使用频率。

迁移到 sqlite 后：
- token 节省 ~80%
- hit_count 自增回路生效
- 与 AP-XXX 统一管理（fact_store 同时承载 PATTERN 和 ANTIPATTERN 两类）
- 可与失败模式（failure_db）做反向验证：PAT-001 引用率高 → failure_db 中相关失败记录少

## 2 条 PAT-XXX 索引

| ID | 标题 | tags | 迁移 confidence |
|---|---|---|---|
| PAT-001 | 关联功能评估检查清单 | linkage, checklist, T1 | 1.0 |
| PAT-002 | 全局配置去重与运行时注入模式 | config-dedup, prompt-minimal, runtime-injection | 1.0 |

## 标准查询 SQL

```sql
-- 任务开始时按 tag 检索相关正向模式
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category='PATTERN'
  AND archived = 0
  AND confidence >= 0.6
  AND hit_count >= 2
  AND (
    tags LIKE '%,%当前任务关键词%,%'
    OR trigger LIKE '%当前任务关键词%'
  )
ORDER BY confidence DESC, hit_count DESC
LIMIT 5;
```

```sql
-- 按 fact_id 精确查询
SELECT fact_id, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store
WHERE fact_id IN ('PAT-001', 'PAT-002');
```

## 回写流程（v2.1 起）

新正向模式不再写入本文件。完整流程见 `.kilo/memory/policy/fact_dedup.md`：

1. 经验验证（任务一次通过 + reviewer 三视角全过）
2. **先** `SELECT fact_id FROM fact_store WHERE trigger=? AND action=?` 去重查询
3. 未命中 → `INSERT INTO fact_store`（category='PATTERN'，confidence 初始 0.6）
4. 命中 → `UPDATE hit_count + 1, confidence + 0.02`

## 关于「pattern」 vs 「skill」的边界

| 类型 | 性质 | 存储 |
|---|---|---|
| **PATTERN**（如 PAT-001 关联功能检查清单） | 「经历过什么事的经验」 | `fact_store` 表 |
| **Skill**（如 `verification-before-completion`） | 「怎么做事」的程序性知识 | `.kilo/skills/*/SKILL.md` |

判别标准：
- 描述「how」（步骤、流程、模板）→ 保留为 SKILL
- 描述「what」（具体反模式 / 具体模式）→ 迁入 fact_store