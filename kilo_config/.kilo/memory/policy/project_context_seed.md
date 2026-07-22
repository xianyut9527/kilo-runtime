# Project Context Seed 维护规则（v2.7 / #19）

> **模块位置**：`.kilo/memory/policy/project_context_seed.md`
> **职责**：定义 `project_context` 表种子的维护规则与触发更新条件
> **种子数据**：`.kilo/memory/api/seed_project_context.sql`（首次部署自动 seed 8 条）
> **v2.7 变更**：project_context 加 scope / project_name 列（对齐 fact_store v2.3 / #5），8 条种子重新分类为 4 global + 4 project(kilo_config)

## 1. 现有种子（v2.7 起，8 条；scope 分布 4 global + 4 project=kilo_config）

| context_id | category | priority | title | source | scope | project_name |
|---|---|---|---|---|---|---|
| PC-001 | ARCHITECTURE | 2 | 七层架构（Brain → L7 Evolution） | brain-architecture.md | project | kilo_config |
| PC-002 | TECH_STACK | 3 | 模型与 MCP 配置（kilo.json） | kilo.json | project | kilo_config |
| PC-003 | CONSTRAINT | 1 | 强制 sqlite 优先 + md 兜底 | instructions/core.md §Memory 探测 | project | kilo_config |
| PC-004 | CONSTRAINT | 1 | 跳步即停 / `[PROCESS_VIOLATION]` | AGENTS.md 锚点 9 | global | NULL |
| PC-005 | BUSINESS_RULE | 2 | T1+ pre-checker → engineer → checker → fixer 闭环 | instructions/workflow-core.md | global | NULL |
| PC-006 | BUSINESS_RULE | 3 | review_mode 决策表（T0=none, T1=lightweight, T2+=full） | instructions/workflow-core.md | global | NULL |
| PC-007 | BUSINESS_RULE | 2 | Schema 变更三文件同步（铁律 2/3） | .kilo/memory/README.md | project | kilo_config |
| PC-008 | TECH_STACK | 4 | 临时文件位置 $env:TEMP / /tmp/ | instructions/core.md §资源生命周期 | global | NULL |

完整 SQL 在 `.kilo/memory/api/seed_project_context.sql`。

**scope 划分原则**：
- `global`：通用流程规则 / 工程约束（跳步即停、单元闭环、review_mode、临时文件）—— 所有项目注入
- `project`：kilo_config 专属架构 / 配置 / 记忆模块内部规则（七层架构、kilo.json、sqlite 优先、三文件同步）—— 仅 KILO_PROJECT_NAME=kilo_config 时注入

## 2. 注入流

`policy/query_strategy.md` §1 query A+A' 注入（v2.4 起含 use_count 动态排序；v2.6 起 A' UPDATE 为硬门；**v2.7 起加 scope 过滤**）：

```sql
-- v2.7：子查询加 scope 过滤（对齐 query B/C），避免 kilo_config 专属 PC 注入业务项目
UPDATE project_context
SET use_count = use_count + 1, last_used_at = datetime('now')
WHERE context_id IN (
    SELECT context_id FROM project_context
    WHERE category IN ('ARCHITECTURE', 'CONSTRAINT') AND priority <= 5
      AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))
    ORDER BY priority ASC, use_count DESC, updated_at DESC
    LIMIT 5
)
RETURNING context_id, title, content, priority, tags, use_count, last_used_at, scope, project_name;
```

priority ≤ 5 的项全部命中。**v2.7 scope 过滤效果**：
- `KILO_PROJECT_NAME=kilo_config` → 注入 8 条（4 global + 4 project=kilo_config）
- `KILO_PROJECT_NAME=<业务项目>` → 仅注入 4 条 global（PC-004/005/006/008），不被 kilo_config 专属噪音污染
- `KILO_PROJECT_NAME` 未设置 → 仅注入 4 条 global（project 分支不匹配）

## 3. 维护规则

### 触发新增 / 更新 / 删除种子的条件

| 场景 | 动作 |
|---|---|
| 新增架构决策 / 业务规则 / 技术栈 / 约束 | 在 `api/seed_project_context.sql` + `schema/init.sql` 末尾 seed 段**同步追加** INSERT OR IGNORE 行（含 scope / project_name）；新增 `policy/project_context_seed.md` 表格行 |
| 修改现有种子内容（语义变化） | 在两个 SQL 文件中**同步 UPDATE**；在 `policy/project_context_seed.md` 表格中标注"v2.x 更新" |
| 修改 scope / project_name | 同步两文件 + 表格行；scope 决定是否跨项目注入（详见 §scope 写入决策） |
| 删除种子 | 同步删除两个 SQL 文件的对应行 + 表格行；如已部署到生产环境需先 SELECT 检查引用（agent prompt 中可能硬编码 fact_id） |
| 修改 priority / category | 同步两文件 + 表格行；priority 升降直接影响 M1 注入顺序 |

### scope 写入决策（v2.7 新增）

| 条目特征 | scope 取值 | 理由 |
|---|---|---|
| 通用流程约束（workflow / process / hard-gate） | `global` | 任何使用 Kilo 的项目都需要遵守 |
| 平台无关的工程约束（临时文件 / 跳步即停） | `global` | 跨项目通用 |
| kilo_config 自身的架构愿景（brain-architecture / 七层架构） | `project` + `kilo_config` | 业务项目无需此上下文，属于 kilo_config 设计理念 |
| kilo.json 具体模型 / MCP 配置快照 | `project` + `kilo_config` | 各项目模型不同，kilo_config 的配置快照对业务项目是噪音 |
| 记忆模块内部维护规则（schema 三文件同步 / sqlite 优先） | `project` + `kilo_config` | 仅 kilo_config 维护记忆模块时需要 |
| 业务项目专属的业务规则 / 架构决策 | `project` + `<KILO_PROJECT_NAME>` | 各业务项目自行 seed（见 §6） |

**关键原则**：`KILO_PROJECT_NAME` 未设置时，注入查询的 project 分支不匹配 → 仅注入 global 行。业务项目默认安全（不被 kilo_config 专属噪音污染）。kilo_config 自身需设置 `KILO_PROJECT_NAME=kilo_config` 才能注入自己的 4 条 project PC。

### 三文件同步铁律（与 README 铁律 2/3 一致）

种子变更必须同时改 3 个文件，缺一即破坏模块完整性：

1. `.kilo/memory/api/seed_project_context.sql`（独立可重跑的迁移脚本）
2. `.kilo/memory/schema/init.sql` 末尾段（首次部署自动 seed）
3. `.kilo/memory/policy/project_context_seed.md` 本表格（人类可读的维护文档）

## 4. 验证

```bash
# 期望返回 8 行（v2.7 起含 scope / project_name 列）
sqlite3 memory.db "SELECT context_id, scope, project_name, category, priority FROM project_context ORDER BY scope DESC, priority, context_id;"
# 期望：project 4 行（PC-001/002/003/007, project_name=kilo_config）+ global 4 行（PC-004/005/006/008, project_name=NULL）

# 期望 pass（actual ≥ 5）
sqlite3 memory.db < .kilo/memory/contracts/health_check.sql | grep PROJECT_CONTEXT_SEEDED

# v2.7 新增检查项应 pass
sqlite3 memory.db < .kilo/memory/contracts/health_check.sql | grep PROJECT_CONTEXT_SCOPE
# 期望：PROJECT_CONTEXT_SCOPE_COLUMN_PRESENT|pass|present_count=2/2
#       PROJECT_CONTEXT_SCOPE_DISTRIBUTION|pass|global=4,project=4,project_null_name=0

# check17 应 PASS
node validate-config.mjs
```

## 5. 相关文件

- `api/seed_project_context.sql` — 迁移脚本（独立可重跑；v2.7 含 scope 值 + 升级 UPDATE 段）
- `api/migrate_project_context_scope.sql` — v2.7 既有 DB 升级脚本（加列 + 回填 scope）
- `schema/init.sql` 末尾段 — 首次部署自动 seed（v2.7 含 scope 列）
- `README.md` 公共 API 表 — 入口声明
- `contracts/health_check.sql` `PROJECT_CONTEXT_SEEDED` + `PROJECT_CONTEXT_SCOPE_COLUMN_PRESENT` + `PROJECT_CONTEXT_SCOPE_DISTRIBUTION` — 健康度校验
- `policy/query_strategy.md` §1 query A+A' — 注入 SQL（v2.7 含 scope 过滤）
- `policy/init_check.md` step 5 / 6e — 6 步 SOP 中的 seed 步骤 + v2.7 升级迁移

## 6. 业务项目自定义 seed 机制（v2.7 新增）

各业务项目维护自己的 `project_context` 种子，与 kilo_config 的全局种子隔离：

| 场景 | 做法 |
|---|---|
| 业务项目首次部署 | `schema/init.sql` 自动 seed 8 条（4 global + 4 project=kilo_config）；业务项目无需额外操作即可获得 4 条 global 通用约束 |
| 业务项目添加自己的架构/规则 | 在项目自己的 `.kilo/memory/api/seed_project_context_<project>.sql` 追加 INSERT OR IGNORE 行，scope='project', project_name=<KILO_PROJECT_NAME> |
| 业务项目设置 KILO_PROJECT_NAME | 通过项目 `.env` / shell profile / kilo.json env 段设置 `KILO_PROJECT_NAME=<稳定标识>`；未设置则仅注入 global 行 |
| global 种子扩展 | 仅由 kilo_config 维护者修改（通用流程规则，所有项目共享） |