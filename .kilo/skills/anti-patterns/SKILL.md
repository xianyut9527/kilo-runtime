---
name: anti-patterns
description: 反模式索引（指向 fact_store）。14 条 AP-XXX 经验条目存储于全局 sqlite fact_store 表，本文件保留索引与查询 SQL。
keywords: [anti-patterns, index, fact_store, sqlite, 索引]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.3"
  category: knowledge
  migrated_to: fact_store
---

# 反模式索引（指向 fact_store）

> 14 条 AP-XXX 经验条目存储于全局 sqlite `fact_store` 表（category='ANTIPATTERN'）。本文件仅作索引，agent 通过 `python scripts/memory.py` 按 tag 查询（模板见 `docs/memory-ops-reference.md`）。
>
> **为什么用 sqlite 而非 md**：token 节省 ~85%（只 SELECT 相关 tag，不加载全文）；hit_count 自增回路反映使用价值；confidence 自动反映真实命中度；跨项目共享。

## 14 条 AP-XXX 索引

| ID | 标题 | tags |
|---|---|---|
| AP-001 | Edit 工具 BOM 污染 | encoding, bom, json, yaml, windows |
| AP-002 | 软约束 vs 硬门禁 | process, soft-rule, hard-gate |
| AP-003 | pre-checker FAIL 修正后未复验 | process, skip-step, pre-checker |
| AP-004 | 子智能体返回空结果未升级 | coordination, subagent, empty-result |
| AP-005 | PowerShell 5.1 GBK 编码根因 | encoding, gbk, powershell-5.1 |
| AP-006 | 关联功能遗漏 | coordination, linkage, rework |
| AP-007 | Agent 删除遗漏执行主体引用 | coordination, agent-deletion |
| AP-008 | Agent Frontmatter 权限与职责不一致 | contract, permission, overprivilege |
| AP-009 | 多单元工作区 SCOPE_CREEP 全量 diff 误判 | process, scope-creep, multi-unit |
| AP-010 | 删除配置字段前未确认外部消费者 | coordination, config-deletion |
| AP-011 | 由校验代码反推运行时能力 | contract, placeholder, runtime-capability |
| AP-012 | 引用化前未确认目标文件覆盖完整性 | coordination, reference-extract |
| AP-013 | 重命名函数时遗漏内部调用同步 | coordination, rename, internal-call |
| AP-014 | 逐页补丁式修复（已固化 → skill `component-driven-fixes`，fact_store 行 archived=1） | process, copy-paste-fix, component |

## 标准查询 SQL

```sql
-- 任务开始时检索相关反模式（FTS5 trigram MATCH + bm25 排序；查询词 ≥3 字符）
SELECT f.fact_id, f.trigger, f.action, f.confidence, f.hit_count, f.tags,
       bm25(fact_fts) AS rank_score
FROM fact_fts
JOIN fact_store f ON f.rowid = fact_fts.rowid
WHERE fact_fts MATCH '当前任务关键词 OR 另一关键词'
  AND f.category = 'ANTIPATTERN'
  AND f.archived = 0
  AND f.confidence >= 0.7
  AND f.hit_count >= 2
ORDER BY rank_score
LIMIT 5;

-- <3 字符场景退化 LIKE
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category='ANTIPATTERN' AND archived = 0 AND confidence >= 0.7 AND hit_count >= 2
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%')
ORDER BY confidence DESC, hit_count DESC LIMIT 5;

-- 按 fact_id 精确查询
SELECT fact_id, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store WHERE fact_id IN ('AP-001', 'AP-005', 'AP-014');

-- 失败回溯时查询同类反模式（reflection.md 强制触发）
SELECT fact_id, trigger, action, confidence
FROM fact_store
WHERE category='ANTIPATTERN' AND (tags LIKE '%,%错误关键词%,%' OR trigger LIKE '%错误关键词%')
  AND archived = 0
ORDER BY confidence DESC, hit_count DESC LIMIT 3;
```

## 回写流程

新反模式不再写入 SKILL.md。完整流程见 `docs/memory-ops-reference.md` §M4/M5：

1. 经验验证（verifier/reviewer 通过）
2. **先** `SELECT fact_id FROM fact_store WHERE trigger=? AND action=?` 去重查询
3. 未命中 → `INSERT INTO fact_store`（category='ANTIPATTERN'）
4. 命中 → `UPDATE fact_store SET hit_count=hit_count+1, confidence=?, updated_at=?`
5. SKILL.md 保持纯索引状态