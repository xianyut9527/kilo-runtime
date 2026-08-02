---
name: patterns
description: 正向模式索引（指向 fact_store）。2 条 PAT 条目存储于全局 sqlite fact_store 表，本文件保留索引与查询 SQL。
keywords: [patterns, best-practice, implementation-pattern, fact_store, sqlite, 索引]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.2"
  category: knowledge
  migrated_to: fact_store
---

# 正向模式索引（指向 fact_store）

> 2 条 PAT 条目（PAT-001 / PAT-002）存储于全局 sqlite `fact_store` 表（category='PATTERN'）。本文件仅作索引，agent 通过 `python scripts/memory.py` 按 tag 查询（模板见 `docs/memory-ops-reference.md`）。
>
> **为什么用 sqlite 而非 md**：与 anti-patterns 同——token 节省、hit_count 自增、confidence 反映真实命中度、跨项目共享。

## 2 条 PAT-XXX 索引

| ID | 标题 | tags |
|---|---|---|
| PAT-001 | 关联功能评估检查清单 | linkage, checklist, T1 |
| PAT-002 | 全局配置去重与运行时注入模式 | config-dedup, prompt-minimal, runtime-injection |

## 标准查询 SQL

```sql
-- 任务开始时检索相关正向模式（FTS5 trigram MATCH + bm25 排序；查询词 ≥3 字符）
SELECT f.fact_id, f.trigger, f.action, f.confidence, f.hit_count, f.tags,
       bm25(fact_fts) AS rank_score
FROM fact_fts
JOIN fact_store f ON f.rowid = fact_fts.rowid
WHERE fact_fts MATCH '当前任务关键词 OR 另一关键词'
  AND f.category = 'PATTERN'
  AND f.archived = 0
  AND f.confidence >= 0.6
  AND f.hit_count >= 2
ORDER BY rank_score
LIMIT 5;

-- <3 字符场景退化 LIKE
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category='PATTERN' AND archived = 0 AND confidence >= 0.6 AND hit_count >= 2
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%')
ORDER BY confidence DESC, hit_count DESC LIMIT 5;

-- 按 fact_id 精确查询
SELECT fact_id, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store WHERE fact_id IN ('PAT-001', 'PAT-002');
```

## 回写流程

新正向模式不再写入本文件。完整流程见 `docs/memory-ops-reference.md` §M4/M5：

1. 经验验证（任务一次通过 + reviewer 四视角全过）
2. **先** `SELECT fact_id FROM fact_store WHERE trigger=? AND action=?` 去重查询
3. 未命中 → `INSERT INTO fact_store`（category='PATTERN'，confidence 初始 0.6）
4. 命中 → `UPDATE hit_count + 1, confidence + 0.02`

## 「pattern」 vs 「skill」的边界

| 类型 | 性质 | 存储 |
|---|---|---|
| **PATTERN**（如 PAT-001 关联功能检查清单） | 「经历过什么事的经验」 | `fact_store` 表 |
| **Skill**（如 `verification-before-completion`） | 「怎么做事」的程序性知识 | `.kilo/skills/*/SKILL.md` |

判别标准：描述「how」（步骤/流程/模板）→ 保留为 SKILL；描述「what」（具体反模式/模式）→ 迁入 fact_store。