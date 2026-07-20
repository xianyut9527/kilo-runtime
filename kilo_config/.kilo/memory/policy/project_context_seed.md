# Project Context Seed 维护规则（v2.3 / #1）

> **模块位置**：`.kilo/memory/policy/project_context_seed.md`
> **职责**：定义 `project_context` 表种子的维护规则与触发更新条件
> **种子数据**：`.kilo/memory/api/seed_project_context.sql`（首次部署自动 seed 8 条）

## 1. 现有种子（v2.3 起，8 条）

| context_id | category | priority | title | source |
|---|---|---|---|---|
| PC-001 | ARCHITECTURE | 2 | 七层架构（Brain → L7 Evolution） | brain-architecture.md |
| PC-002 | TECH_STACK | 3 | 模型与 MCP 配置（kilo.json） | kilo.json |
| PC-003 | CONSTRAINT | 1 | 强制 sqlite 优先 + md 兜底 | instructions/core.md §Memory 探测 |
| PC-004 | CONSTRAINT | 1 | 跳步即停 / `[PROCESS_VIOLATION]` | AGENTS.md 锚点 9 |
| PC-005 | BUSINESS_RULE | 2 | T1+ pre-checker → engineer → checker → fixer 闭环 | instructions/workflow-core.md |
| PC-006 | BUSINESS_RULE | 3 | review_mode 决策表（T0=none, T1=lightweight, T2+=full） | instructions/workflow-core.md |
| PC-007 | BUSINESS_RULE | 2 | Schema 变更三文件同步（铁律 2/3） | .kilo/memory/README.md |
| PC-008 | TECH_STACK | 4 | 临时文件位置 $env:TEMP / /tmp/ | instructions/core.md §资源生命周期 |

完整 SQL 在 `.kilo/memory/api/seed_project_context.sql`。

## 2. 注入流

`policy/query_strategy.md` §1 query A 注入（v2.4 起含 use_count 动态排序；v2.6 起 A' UPDATE 为硬门）：

```sql
SELECT context_id, title, content, priority, tags, use_count, last_used_at
FROM project_context
WHERE category IN ('ARCHITECTURE', 'CONSTRAINT') AND priority <= 5
ORDER BY priority ASC, use_count DESC, updated_at DESC
LIMIT 5;

-- A'. 注入完成后立即 UPDATE（v2.6 硬门，禁止跳过）
UPDATE project_context
SET use_count = use_count + 1, last_used_at = datetime('now')
WHERE context_id IN (...);
```

priority ≤ 5 的项全部注入。8 条种子全部命中（priority 范围 1-4）。

## 3. 维护规则

### 触发新增 / 更新 / 删除种子的条件

| 场景 | 动作 |
|---|---|
| 新增架构决策 / 业务规则 / 技术栈 / 约束 | 在 `api/seed_project_context.sql` + `schema/init.sql` 末尾 seed 段**同步追加** INSERT OR IGNORE 行；新增 `policy/project_context_seed.md` 表格行 |
| 修改现有种子内容（语义变化） | 在两个 SQL 文件中**同步 UPDATE**；在 `policy/project_context_seed.md` 表格中标注"v2.x 更新" |
| 删除种子 | 同步删除两个 SQL 文件的对应行 + 表格行；如已部署到生产环境需先 SELECT 检查引用（agent prompt 中可能硬编码 fact_id） |
| 修改 priority / category | 同步两文件 + 表格行；priority 升降直接影响 M1 注入顺序 |

### 三文件同步铁律（与 README 铁律 2/3 一致）

种子变更必须同时改 3 个文件，缺一即破坏模块完整性：

1. `.kilo/memory/api/seed_project_context.sql`（独立可重跑的迁移脚本）
2. `.kilo/memory/schema/init.sql` 末尾段（首次部署自动 seed）
3. `.kilo/memory/policy/project_context_seed.md` 本表格（人类可读的维护文档）

## 4. 验证

```bash
# 期望返回 8 行
sqlite3 memory.db "SELECT context_id, category, priority FROM project_context ORDER BY priority, context_id;"

# 期望 pass（actual ≥ 5）
sqlite3 memory.db < .kilo/memory/contracts/health_check.sql | grep PROJECT_CONTEXT_SEEDED

# check17 应 PASS
node validate-config.mjs
```

## 5. 相关文件

- `api/seed_project_context.sql` — 迁移脚本（独立可重跑）
- `schema/init.sql` 末尾段 — 首次部署自动 seed
- `README.md` 公共 API 表 — 入口声明
- `contracts/health_check.sql` `PROJECT_CONTEXT_SEEDED` — 健康度校验
- `policy/query_strategy.md` §1 query A — 注入 SQL
- `policy/init_check.md` step 5 — 4 步 SOP 后的 seed 步骤