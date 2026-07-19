# Cross-Session Semantic Search Spec（v2.3 / #6 — v4.0 接口规范）

> **模块位置**：`.kilo/memory/policy/semantic_search.md`
> **状态**：v4.0 接口规范（实现延期；本文档锁定接口契约以避免 schema 漂移）
> **当前实现**：`LIKE '%keyword%'` 字符串模糊匹配（`policy/query_strategy.md` §1 query B）
> **远期目标**：向量检索 + 跨项目语义匹配

## 1. 背景与动机

当前 `fact_store` / `failure_db` 检索使用 `tags LIKE '%,%keyword%,%'` + `trigger LIKE '%keyword%'` 字符串匹配，存在 3 类问题：

1. **语义等价盲区**：`"react 表单错误处理"` 与 `"React form validation"` 字符串不等价但语义同义
2. **跨语言盲区**：中文触发场景（如「Windows 下 Edit 工具改 UTF-8 文件」）与英文 description 互不匹配
3. **冷启动低质**：tags JSON 不规范时 LIKE 命中率显著下降

向量检索（embedding + cosine similarity）能直接解决上述问题，但要求：

- 不可破坏当前 LIKE 实现（向后兼容）
- 不可破坏 4 层模块架构（schema/policy/contracts/api）
- 不可破坏 v2.2 trial 机制与 v2.3 scope 列

## 2. 接口契约（v4.0 locked）

### 2.1 输入

| 参数 | 类型 | 默认值 | 必填 | 含义 |
|---|---|---|---|---|
| `query_embedding` | BLOB | — | 是 | 查询向量化（768 维 float32 little-endian；维度常量见下） |
| `top_k` | INTEGER | 5 | 否 | 返回前 K 条最相似记录 |
| `min_similarity` | REAL | 0.7 | 否 | 相似度阈值（cosine similarity，0-1） |
| `scope_filter` | TEXT | 'global' | 否 | 'global' / 'project:<name>' / 'all' |
| `category_filter` | TEXT | NULL | 否 | 'PATTERN' / 'ANTIPATTERN' / 'RECIPE' / 'WARNING' 或 NULL（不限） |
| `archived_filter` | INTEGER | 0 | 否 | 0 = 仅未归档；1 = 含已归档 |

### 2.2 输出

```
[
  {
    "fact_id": "AP-001",
    "similarity": 0.89,
    "category": "ANTIPATTERN",
    "trigger": "...",
    "action": "...",
    "confidence": 0.95,
    "hit_count": 5
  },
  ...
]
```

按 similarity DESC 排序，最多 `top_k` 条。

### 2.3 维度常量

```
EMBEDDING_DIM = 768
EMBEDDING_MODEL = "text-embedding-3-small"  # 占位；v4.0 实现期可替换
```

锁定 768 维以确保迁移期一致性。如未来切换 embedding 模型，需要：

1. 旧列 `fact_embedding BLOB` 保留（NULL = 未向量化）
2. 新列 `fact_embedding_v2 BLOB` 存新模型向量
3. 查询时回退 LIKE（NULL embedding）或新列查询

## 3. 存储扩展（v4.0 实施期）

### 3.1 新增列

```sql
-- fact_store 增加 embedding 列
ALTER TABLE fact_store ADD COLUMN fact_embedding BLOB;  -- 768 dim float32 little-endian

-- failure_db 增加 embedding 列（failure 同样需要语义检索）
ALTER TABLE failure_db ADD COLUMN failure_embedding BLOB;

-- 索引（SQLite 无原生向量索引，使用外部向量数据库或 BLOB 二次过滤）
-- v4.0 实施期需评估：sqlite-vss / qdrant / pgvector / milvus
```

### 3.2 回填策略

```sql
-- 已有行的 embedding = NULL；查询时回退 LIKE
-- 新写入行必须在 fact_dedup.md §提取流程中同步生成 embedding
```

### 3.3 混合查询策略

```sql
-- 当 embedding 列存在时优先向量检索；否则回退 LIKE
SELECT fact_id, similarity, ...
FROM (
  SELECT
    fact_id, category, trigger, action, confidence, hit_count,
    -- 假设有向量相似度函数 vec_similarity(fact_embedding, :query_embedding)
    vec_similarity(fact_embedding, :query_embedding) AS similarity
  FROM fact_store
  WHERE fact_embedding IS NOT NULL
    AND archived = :archived_filter
    AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))
  ORDER BY similarity DESC
  LIMIT :top_k
)
WHERE similarity >= :min_similarity;
```

回退路径（embedding 为 NULL）：

```sql
SELECT fact_id, category, trigger, action, confidence, hit_count,
       0.0 AS similarity  -- 字符串匹配无相似度，标记 0
FROM fact_store
WHERE fact_embedding IS NULL
  AND (tags LIKE '%,%keyword%,%' OR trigger LIKE '%keyword%' OR action LIKE '%keyword%')
  AND archived = 0
ORDER BY confidence DESC, hit_count DESC
LIMIT :top_k;
```

## 4. MCP 工具契约（v4.0 实施期）

### 4.1 工具名

```
mcp_sqlite_semantic_search(query, top_k, min_similarity, scope_filter, category_filter)
```

### 4.2 参数映射

| MCP 参数 | 接口参数 | 来源 |
|---|---|---|
| `query` | `query_embedding` | 内部调 embedding 模型生成 |
| `top_k` | `top_k` | 直传 |
| `min_similarity` | `min_similarity` | 直传 |
| `scope_filter` | `scope_filter` | 默认 'global' |
| `category_filter` | `category_filter` | 可选 |

### 4.3 嵌入生成责任

v4.0 实施期需明确：embedding 生成是 Kilo runtime 责任还是 MCP server 责任？两种方案对比：

| 方案 | 优点 | 缺点 |
|---|---|---|
| Kilo runtime 负责 | 可访问完整对话上下文 | 需新增加 embedding provider 配置 |
| MCP server 负责 | 解耦，Kilo 不感知 embedding | MCP server 需新调 embedding API |

推荐：**Kilo runtime 负责**（与现有 provider 配置一致）。

## 5. 迁移路径

### 5.1 渐进迁移（推荐）

1. **v3.0**（近期）：api/ 层新增 MCP server 占位（`api/mcp_semantic_search_stub.sql`，仅返回空结果），`policy/query_strategy.md` §1 query B 增加 `IF embedding IS NOT NULL THEN ... ELSE LIKE` 分支
2. **v3.1**：实现 embedding 生成（依赖 provider 配置）
3. **v3.2**：backfill 已有 fact 的 embedding（一次性脚本）
4. **v4.0**：完整 MCP 工具发布，旧 LIKE 路径保留为回退

### 5.2 不破坏性约束

- 任何 v4.0 实施不得 `DROP COLUMN` 或 `DROP TABLE`
- 任何 v4.0 实施不得修改现有 `tags` / `trigger` / `action` 列
- v4.0 实施必须保留 `policy/query_strategy.md` §1 query B 的 LIKE 回退路径

## 6. 限制与开放问题

| 问题 | 当前决策 | 后续讨论 |
|---|---|---|
| 嵌入维度（768）是否合适 | v4.0 锁定 | v5.0 可评估 1024/1536 |
| 向量索引后端（sqlite-vss / 外部） | 评估中 | v4.0 实施期选定 |
| 跨语言支持（zh/en/ja） | 依赖 embedding 模型本身 | 选 multilingual-e5-large 等 |
| 冷启动无 embedding 行 | LIKE 回退 | 实施 backfill 脚本 |
| 与 trial / scope 的交互 | 保留 trial 过滤 + scope 过滤 | 无变更 |

## 7. 验证（v4.0 实施期）

```sql
-- 1. 列存在性
SELECT COUNT(*) FROM pragma_table_info('fact_store') WHERE name = 'fact_embedding';
-- 期望 ≥1

-- 2. 向量化回填率
SELECT
  (SELECT COUNT(*) FROM fact_store) AS total,
  (SELECT COUNT(*) FROM fact_store WHERE fact_embedding IS NOT NULL) AS embedded,
  ROUND(100.0 * (SELECT COUNT(*) FROM fact_store WHERE fact_embedding IS NOT NULL) / (SELECT COUNT(*) FROM fact_store), 1) AS embed_pct;
-- 期望 embed_pct >= 80（v4.0 GA 目标）

-- 3. 混合查询回退
-- 输入 keyword="BOM" + embedding=NULL
-- 期望：走 LIKE 路径，返回含 "BOM" 的 fact（如 AP-001）
```

## 8. 相关文件

- `policy/query_strategy.md` §1 query B — 当前 LIKE 实现，v4.0 改造基础
- `schema/init.sql` fact_store / failure_db CREATE TABLE — v4.0 实施时加 embedding 列
- `api/migrate_add_scope_column.sql` — v2.3 模式参考（PRAGMA-guard migration）
- `README.md` §升级路径 v4.0 条目 — 引用本文件

---

> **稳定原则**：本文档为接口规范，任何 v4.0 实施变更需先修改本文档并经评审；不在 v4.0 稳定前触碰 v5.x 设计。