---
name: anti-patterns
description: 反模式索引（v2.1 改为指向 fact_store）。14 条 AP-XXX 经验条目已迁移到全局 sqlite fact_store 表，本文件仅保留索引与查询 SQL。
keywords: [anti-patterns, index, fact_store, sqlite, 索引]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.2"
  category: knowledge
  migrated_to: fact_store
  migration_evidence: .kilo/memory/api/migrate_skill_to_fact_store.sql
---

# 反模式索引（指向 fact_store）

> ⚠️ **v2.1 重大变更**：14 条 AP-XXX 经验条目已于 2026-07-19 从本 skill 迁出，**全部进入全局 sqlite `fact_store` 表**。
> 迁移脚本：`.kilo/memory/api/migrate_skill_to_fact_store.sql`
> 详细说明：`.kilo/memory/README.md` §迁移记录
>
> **本文件仅作为索引保留**。agent 不再加载 4 个 sub-skill 全文，而是通过 bash 调用 sqlite3 CLI 按 tag 查询相关反模式（模板见 `.kilo/memory/policy/bash_sqlite_template.md`）。

## 为什么迁移

之前 14 条 AP-XXX 作为 markdown 存储在 4 个 sub-skill 文件（encoding/process/coordination/contract），每次相关任务都会**全量加载所有 markdown 全文**（1400-4200 tokens / 任务），且无法统计「这条反模式被命中过几次」「它的置信度真实是多少」。

迁移到 sqlite 后：
- **token 节省 ~85%**：只 SELECT 相关 tag 的 5-10 行，不再加载全文
- **hit_count 自增回路生效**：每次应用 fact，自动 `UPDATE fact_store SET hit_count = hit_count + 1`
- **confidence 自动反映使用价值**：经 3 次命中后 confidence → 0.8，自动触发 skill-upgrade 检测
- **跨项目共享**：sqlite 全局持久，其他项目也能查到

## 14 条 AP-XXX 索引（指向 fact_store）

| ID | 标题 | tags | 迁移 confidence |
|---|---|---|---|
| AP-001 | Edit 工具 BOM 污染 | encoding, bom, json, yaml, windows | 1.0 |
| AP-002 | 软约束 vs 硬门禁 | process, soft-rule, hard-gate | 1.0 |
| AP-003 | pre-checker FAIL 修正后未复验 | process, skip-step, pre-checker | 1.0 |
| AP-004 | 子智能体返回空结果未升级 | coordination, subagent, empty-result | 1.0 |
| AP-005 | PowerShell 5.1 GBK 编码根因 | encoding, gbk, powershell-5.1 | 1.0 |
| AP-006 | 关联功能遗漏 | coordination, linkage, rework | 1.0 |
| AP-007 | Agent 删除遗漏执行主体引用 | coordination, agent-deletion | 1.0 |
| AP-008 | Agent Frontmatter 权限与职责不一致 | contract, permission, overprivilege | 1.0 |
| AP-009 | 多单元工作区 SCOPE_CREEP 全量 diff 误判 | process, scope-creep, multi-unit | 1.0 |
| AP-010 | 删除配置字段前未确认外部消费者 | coordination, config-deletion | 1.0 |
| AP-011 | 由校验代码反推运行时能力 | contract, placeholder, runtime-capability | 1.0 |
| AP-012 | 引用化前未确认目标文件覆盖完整性 | coordination, reference-extract | 1.0 |
| AP-013 | 重命名函数时遗漏内部调用同步 | coordination, rename, internal-call | 1.0 |
| AP-014 | 逐页补丁式修复（v2.6 已固化 → skill `component-driven-fixes`，fact_store 行 archived=1） | process, copy-paste-fix, component | 1.0 |

## 标准查询 SQL

```sql
-- 任务开始时检索相关反模式（v2.6 主路径：FTS5 trigram MATCH + bm25 排序；查询词 ≥3 字符）
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

-- 2 字中文词等 <3 字符场景退化 LIKE（tags 逗号分隔精确匹配）
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category='ANTIPATTERN'
  AND archived = 0
  AND confidence >= 0.7
  AND hit_count >= 2
  AND (
    tags LIKE '%,%当前任务关键词%,%'
    OR trigger LIKE '%当前任务关键词%'
  )
ORDER BY confidence DESC, hit_count DESC
LIMIT 5;
```

```sql
-- 按 fact_id 精确查询（用于在输出中引用某条具体反模式）
SELECT fact_id, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store
WHERE fact_id IN ('AP-001', 'AP-005', 'AP-014');
```

```sql
-- 失败回溯时查询同类反模式（reflection.md 强制触发）
SELECT fact_id, trigger, action, confidence
FROM fact_store
WHERE category='ANTIPATTERN'
  AND (tags LIKE '%,%错误关键词%,%' OR trigger LIKE '%错误关键词%')
  AND archived = 0
ORDER BY confidence DESC, hit_count DESC
LIMIT 3;
```

## 回写流程（v2.1 起）

新反模式不再写入 SKILL.md。完整流程见 `.kilo/memory/policy/fact_dedup.md`：

1. 经验验证（checker/reviewer 通过）
2. **先** `SELECT fact_id FROM fact_store WHERE trigger=? AND action=?` 去重查询
3. 未命中 → `INSERT INTO fact_store`（category='ANTIPATTERN'）
4. 命中 → `UPDATE fact_store SET hit_count=hit_count+1, confidence=?, updated_at=?`
5. SKILL.md 保持纯索引状态

## sub-skill 文件状态（v2.2：内容已清空）

| 文件 | 状态 |
|---|---|
| `anti-patterns-encoding/SKILL.md` | 📦 **v2.2 内容已清空**（仅保留 frontmatter + 迁移指引） |
| `anti-patterns-process/SKILL.md` | 📦 **v2.2 内容已清空** |
| `anti-patterns-coordination/SKILL.md` | 📦 **v2.2 内容已清空** |
| `anti-patterns-contract/SKILL.md` | 📦 **v2.2 内容已清空** |

> **v2.2 关键变更**：4 个 sub-skill 文件不仅加 archived 警告，**AP-XXX 全文已彻底删除**，仅保留 frontmatter + 迁移指引。即使 agent 误加载归档文件，最大消耗 = 30 行（vs 之前 ~250 行/条目 × 14 条 = 3500+ 行）。
>
> **完全去 md 化**：14 条 AP 全文唯一权威源 = 全局 sqlite `fact_store` 表，无任何 md 副本。