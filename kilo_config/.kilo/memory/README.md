# Memory Module

> **模块位置**：`.kilo/memory/`（仓库内唯一记忆边界）
> **职责**：跨项目持久化结构化经验 + 任务调度日志 + 模型校准 + 项目上下文 + 反馈质量量化
> **状态**：v2.6（**SQLite 唯一记忆** + md 静态规则兜底 + FTS5 trigram + helpful_rate 强制反馈 + scope 隔离 + 回路空转告警）
> **作者**：coderAgent 自动维护 + 人工审核

## 模块架构（4 层）

```
.kilo/memory/
├── README.md            ← 本文件（公共 API 文档，其他模块唯一应看的入口）
├── AGENTS.md            ← 模块对 agent 的指令（自动注入）
├── schema/              ← 第 1 层：DDL 唯一源
│   └── init.sql         ← 7 表 + 26 索引 + 4 视图 + 2 FTS5 虚表（trigram，v2.6）+ 8 条 project_context 自动种子（v2.5 +skill_usage_events）
├── policy/              ← 第 2 层：业务规则决策树（11 个文件，v2.4 / v2.3 新增 4 个）
│   ├── dispatch_recorder.md     ← dispatch_log 写入（含 v2.4 helpful/misleading 列）
│   ├── fact_dedup.md            ← fact_store 去重 + 写入（含 scope 规则 v2.3 / #5）
│   ├── failure_recorder.md      ← failure_db 写入（含 v2.4 scope 镜像 + FTS5）
│   ├── skill_upgrade.md         ← fact_store 触发 skill 升级（含 V2 算法 v2.3 / #3）
│   ├── model_calibration.md     ← 模型校准更新（含补偿 prompt 消费追踪 v2.3 / #8）
│   ├── query_strategy.md        ← 任务开始 + 失败回溯查询（含 M6 前置校验 v2.3 / #4 + helpful_rate v2.4 / #13）
│   ├── init_check.md            ← memory.db 首次部署 + v2.3/v2.4 升级 SOP（6 步）
│   ├── trial_archive.md         ← 14 天 trial 过期归档（v2.3 / #2）
│   ├── project_context_seed.md  ← project_context 8 条种子维护规则（v2.3 / #1）
│   ├── m6_validation.md         ← M6 标记 Stage 1 前置校验 + Stage 3 helpful/misleading（v2.3 / #4 + v2.4 / #13）
│   └── semantic_search.md       ← 跨会话语义检索 v4.0 接口规范（v2.3 / #6）
├── api/                 ← 第 3 层：实现层（迁移脚本 + 未来 MCP server）
│   ├── migrate_skill_to_fact_store.sql       ← v2.1 一次性迁移（14 AP + 2 PAT）
│   ├── seed_project_context.sql             ← v2.3 / #1 project_context 8 条种子
│   ├── trial_archive.sql                     ← v2.3 / #2 14 天 trial 过期归档
│   ├── migrate_skill_upgrade_log.sql        ← v2.3 / #3 skill_upgrade_log DRAFT 回填
│   ├── migrate_add_scope_column.sql          ← v2.3 / #5 fact_store scope 列迁移
│   ├── migrate_compensation_columns.sql      ← v2.3 / #8 model_calibration 列迁移
│   ├── migrate_dispatch_compensation_columns.sql  ← v2.3 / #8 dispatch_log 列迁移
│   ├── migrate_helpful_columns.sql           ← v2.4 / #13 fact_store helpful 列
│   ├── migrate_failure_scope_and_fts.sql     ← v2.4 / #15 failure_db scope + FTS5
│   ├── migrate_project_context_use.sql       ← v2.4 / #2 project_context use_count
│   ├── migrate_dispatch_feedback_columns.sql  ← v2.4 / #13 dispatch_log 反馈列
│   ├── migrate_fact_fts.sql                   ← v2.4 / #5 fact_store FTS5 虚表
│   ├── migrate_fts_trigram.sql                 ← v2.6 FTS5 分词器 unicode61 → trigram 重建
│   └── migrate_skill_usage_log_to_sqlite.sql   ← v2.5 / #T1 .log → skill_usage_events 迁移
└── contracts/           ← 第 4 层：接口契约
    └── health_check.sql ← 标准化健康度查询（v2.6 16 项；被 validate-config.mjs check17 调用）
```

## 公共 API（外部模块唯一应访问的入口）

| 入口 | 触发方 | 用途 |
|---|---|---|
| `schema/init.sql` | install / 首次部署 | 建表（7 表 + 索引 + 视图 + 2 FTS5 虚表）+ 8 条 project_context 自动种子 |
| `policy/query_strategy.md` §1 | coderAgent 任务开始 | 注入项目上下文 + 相关经验 + 失败模式 + 模型校准 |
| `policy/query_strategy.md` §2 | checker/reviewer FAIL 回溯 | 查同类失败 + 相关反模式 |
| `policy/dispatch_recorder.md` | coderAgent 任务结束（T1+） | 写 dispatch_log（含 v2.3 / #8 补偿 prompt 列） |
| `policy/fact_dedup.md` | coderAgent 发现可复用模式 | 去重 + INSERT/UPDATE fact_store（含 scope 写入规则 v2.3 / #5） |
| `policy/failure_recorder.md` | checker FAIL / fixer 多轮 / Circuit Breaker / 用户反馈 | INSERT failure_db（v2.6 降门槛） |
| `policy/model_calibration.md` | 每次 dispatch 后 | 增量更新 model_calibration（含补偿 prompt 消费追踪 v2.3 / #8） |
| `policy/skill_upgrade.md` | 自动检测（条件 A/B/C） | fact_store 触发 SKILL.md 升级提案（含 V2 opt-in 算法 v2.3 / #3） |
| `policy/init_check.md` | 首次部署 / memory.db 缺失 / v2.3 升级 | 6 步初始化 SOP |
| `policy/project_context_seed.md` | 维护 project_context 种子 | 8 条种子的新增/更新/删除规则 |
| `policy/trial_archive.md` | 周 cron / 启动钩子 / M7 advisory | 14 天 trial 过期归档（v2.3 / #2） |
| `policy/m6_validation.md` | M6 hit_count 自增回路前置 | Stage 1 SELECT 校验 + Stage 2 UPDATE + Stage 3 helpful/misleading（v2.6 强制） |
| `policy/semantic_search.md` | v4.0 实施期 | 跨会话语义检索接口规范（v2.3 / #6） |
| `api/seed_project_context.sql` | v2.3 升级补种 / 维护 | project_context 8 条 INSERT OR IGNORE |
| `api/trial_archive.sql` | v2.3 trial 过期 | UPDATE fact_store SET archived=1 |
| `api/migrate_skill_upgrade_log.sql` | v2.3 升级回填 | skill_upgrade_log DRAFT 行 |
| `api/migrate_add_scope_column.sql` | v2.2 → v2.3 升级 | fact_store scope 列 |
| `api/migrate_compensation_columns.sql` | v2.2 → v2.3 升级 | model_calibration 补偿列 |
| `api/migrate_dispatch_compensation_columns.sql` | v2.2 → v2.3 升级 | dispatch_log 补偿列 |
| `contracts/health_check.sql` | validate-config.mjs check17 | 16 项健康度查询（v2.6 新增 2 项回路空转 soft-warn） |
| `api/migrate_fts_trigram.sql` | v2.4/v2.5 → v2.6 升级 | FTS5 分词器 trigram 重建（含触发器 + rebuild） |

## 核心铁律（3 条）

### 铁律 1：**唯一入口**

> **其他模块通过 bash 调用 sqlite3 CLI 与记忆交互**（v2.5-过渡版主通道；v3.0 起可选自建 memory-mcp，默认 `enabled:false`）。
>
> - ✅ 引用 `.kilo/memory/policy/*.md` 查找业务规则
> - ✅ 引用 `.kilo/memory/schema/init.sql` 了解表结构
> - ❌ **禁止**在其他位置重复定义 SQL 模板、定义表结构、定义写入规则
> - ❌ **禁止**其他模块直接操作 `${HOME}/.config/kilo-data/memory.db`

### 铁律 2：**模块自洽**

> 模块自身具备完整性检查能力（`contracts/health_check.sql`）。
> check17 在每次 `node validate-config.mjs` 时执行，确保：
> - 7 表结构齐全（v2.5 含 `skill_usage_events`）
> - 核心索引存在（≥17，含 v2.3 新增 `idx_fact_scope` / `idx_upgrade_fact` / `idx_upgrade_status`）
> - 视图存在
> - 行数统计可读
> - v2.3 新增 6 项 soft-warn 检查（不阻断交付）

### 铁律 3：**演进路径**

> schema 变更必须**同时**改 3 个文件（缺一即破坏模块完整性）：
>
> 1. `schema/init.sql`（DDL 唯一源）
> 2. `contracts/health_check.sql`（表名 / 索引名 / 视图名同步）
> 3. `policy/*.md` 对应文档（业务规则同步）
>
> v2.3 额外约束：跨项目 scope 隔离时新增列必须同步 `api/migrate_*.sql` 迁移脚本 + `policy/init_check.md` 6.x 步骤。

---

## 检索约定（v2.2）

### SELECT 必须带 ID

**所有查询结果必须包含 ID 字段**（fact_id / failure_id / context_id / calibration_id），用于：
- 上下文标记 `[memory:fact_id=M-001 ...]`（reviewer 可审计）
- 收尾阶段 hit_count 自增回路
- 跨会话回溯的精确引用

### 标准注入格式

```markdown
[memory:fact_id={fact_id} category={category} confidence={confidence} hit_count={hit_count} tags=[{tags}]]
- **触发场景**: {trigger}
- **推荐做法**: {action}
- **证据**: {evidence}
```

完整模板见 `policy/query_strategy.md` §2。

### 注入门槛

| 数据源 | 门槛 |
|---|---|
| fact_store（正式） | confidence ≥ 0.7 AND hit_count ≥ 2 AND archived = 0 |
| fact_store（试用期，v2.2） | confidence ≥ 0.5 AND hit_count < 2 AND created_at ≤ 14 天内，每任务 ≤2 条（标记 `trial=1`） |
| failure_db | resolved_at IS NOT NULL AND same_symptom_count ≥ 1 |
| project_context | priority ≤ 5 |
| model_calibration | sample_count ≥ 2（v2.6 起；原 ≥3 放宽） |

> v2.2 试用期机制 + M6 自增数据源扩展（显式声明未注入但实际参考的 fact_id）详见 `policy/query_strategy.md` §注入门槛 / §4。

完整规则见 `policy/query_strategy.md` §注入门槛。

### hit_count 自增回路

每次 T1+ 任务收尾时，从 agent 输出中的 `[memory:fact_id=...]` 标记提取本次用到的 fact_id 列表，**对每个 fact_id 执行 `UPDATE hit_count + 1, confidence + 0.02 (上限 0.95)`**。详见 `policy/query_strategy.md` §4 + `instructions/workflow-core.md` §收尾自检。

---

## MEMORY.md vs fact_store 边界（R-3 明确）

| 内容 | 存储位置 | 原因 |
|---|---|---|
| **可复用模式/反模式**（PATTERN / ANTIPATTERN / RECIPE / WARNING） | `fact_store` 表 | 需要置信度/命中数/证据/触发条件等结构化字段；高频检索 |
| **失败案例** | `failure_db` 表 | 需要根因层/复发次数/解决时间等 |
| **项目架构/业务规则** | `project_context` 表 | 优先级/类别/来源文件 |
| **模型校准数据** | `model_calibration` 表 | 动态累积成功率/补偿 prompt |
| **用户偏好**（手动编辑） | `MEMORY.md` / `USER.md`（md 兜底） | 用户直接编辑，不需要结构化查询 |
| **安全约束**（静态） | `USER.md`（md 兜底） | 静态规则，不需要版本追踪 |
| **归档索引** | `MEMORY.md`（指向 fact_id） | 标注「这条经验在 fact_store[M-xxx]」供人读 |

> **核心规则**：**禁止把任务经验直接 append 到 MEMORY.md / SKILL.md**。所有可复用模式/反模式必须先入 `fact_store`，满足 `confidence ≥ 0.8 && hit_count ≥ 3` 后由 `policy/skill_upgrade.md` 触发 `[AUTO_DRAFT]` 草稿，人工审批后才落盘为 SKILL.md。

## 与其他模块的关系

| 模块 | 关系 |
|---|---|
| `.kilo/instructions/` | 通过 policy 引用，不重复定义规则 |
| `.kilo/skills/` | skill 是 sqlite fact_store 的固化产物（`policy/skill_upgrade.md`） |
| `agent/*.md` | agent prompt 不直接引用 SQL；引用 policy 文件 |
| `validate-config.mjs` | check17 通过 contracts/health_check.sql 校验模块 |
| `kilo.json` | 记忆主通道 = bash + sqlite3 CLI（v2.5-过渡版）；可选 `mcp.memory` 自建 MCP（v3.0，默认 `enabled:false`）；数据库文件 `~/.config/kilo-data/memory.db` |

## 升级路径

| 阶段 | 内容 |
|---|---|
| v2.0 | 模块边界封装 + 4 层分离 + check17 健康度 |
| v2.1 | 14 条 AP + 2 条 PAT 从 SKILL.md 迁移到 fact_store（去 md 化）；新增 `api/migrate_skill_to_fact_store.sql` |
| v2.2 | 4 个 archived sub-skill 文件 AP-XXX 全文彻底删除；fact_store 试用期机制（conf ≥ 0.5 + hit < 2 + 14 天窗口 + trial=1 标记）；M6 自增数据源扩展（显式声明未注入但实际参考的 fact_id 同权 +hit+conf） |
| **v2.3** | (1) project_context 8 条种子自动 fill (#1)；(2) trial 14 天过期归档 SOP (#2)；(3) skill_upgrade V2 opt-in 自动化 + `skill_upgrade_log` 表 (#3)；(4) M6 显式声明 Stage 1 前置校验 (#4)；(5) fact_store `scope` / `project_name` 列 + 跨项目隔离 (#5)；(6) semantic_search v4.0 接口规范文档化 (#6)；(7) MEMORY.md M-001 动态注入 (#7)；(8) model_calibration / dispatch_log 补偿 prompt 消费追踪 + 30 天过期告警 (#8) |
| **v2.4** | (1) FTS5 全文索引（fact_fts / failure_fts + 触发器 + bm25 排序）效率 +++ (#5)；(2) project_context `use_count` / `last_used_at` 动态排序 (#2)；(3) fact_store `helpful_count` / `misleading_count` / `helpful_rate` 反馈质量量化 (#13)；(4) M-001 动态注入 2AP + 1PAT (#7 扩展)；(5) failure_db `scope` / `project_name` 列镜像 (#15)；(6) dispatch_log `trigger_fact_ids` / `helpful_fact_ids` / `misleading_fact_ids` 结构化反馈 (#13)；(7) output-schema preflight 自检（输出前 1st defense）稳定性 +++ (#10) |
| **v2.5** | (1) **SQLite 唯一记忆原则**：禁止 md 文件累积时序数据（`.kilo/memory/skill-usage.log` 已迁移至 `skill_usage_events` 表）(#T1)；(2) `MEMORY.md` 字符上限收紧至 ≤1500，纯指针化（无 prose）；(3) `archive/YYYY-MM/` md 归档协议废除（全部走 SQLite `archived=1`） |
| **v2.6**（当前） | (1) FTS5 分词器 unicode61 → **trigram**（修复中文 MATCH 0 命中缺陷；MATCH 查询词需 ≥3 字符）；(2) M6 helpful/misleading **强制化**（Stage 3 补入 m6_validation；无反馈显式 `[memory:helpful=none]`；SQL 落地 confidence ±公式）；(3) M1 query A' use_count UPDATE 升级为**硬门**；(4) health_check 新增 2 项回路空转 soft-warn（FEEDBACK_LOOP_IDLE / CONTEXT_USE_COUNT_STALE）+ 修复 validate-config.mjs soft-warn 死代码误判硬 FAIL；(5) failure_db 写入降门槛（checker 首轮 FAIL 即记录）；(6) model_calibration 注入门槛 sample≥3→≥2；(7) skill_upgrade 首批 4 条 DRAFT 终审 + what/how 边界规则成文（AP-014→MANUAL_PROMOTED 归档；AP-001/AP-005/PAT-001→REJECTED 常驻 fact_store）；(8) 数据治理：清理 TEST-MCP 残留 12 行 + 删除无文档死表 audit_log |
| v3.0（未来） | 自定义 MCP server（api/ 层）+ tool 强制执行 + 删除 `[MISSING_MEMORY_WRITE]` 标记 |
| v4.0（远期） | 跨会话语义检索（接口规范见 `policy/semantic_search.md`）+ 跨项目共享 fact_store（v2.3 scope 列已就位，仅替换检索后端） |

> **稳定原则**：不在 v2 稳定前触碰 v3 设计；不在 v3 稳定前触碰 v4 实现（v4 接口已 lock，见 `policy/semantic_search.md` §2）。

## 迁移记录（v2.1, 2026-07-19）

### 去 md 化（SKILL.md 经验 → fact_store）

**之前**（v2.0）：
- 14 条 AP-XXX + 2 条 PAT-XXX 分散在 4 个 `anti-patterns-*/SKILL.md` + `patterns/SKILL.md`
- 每次相关任务 agent 加载全部 markdown 全文（1400-4200 tokens / 任务）
- 无 hit_count / 无 confidence 自动校准 / 无 M6 自增回路

**之后**（v2.1）：
- 16 条经验**全部进入全局 sqlite `fact_store` 表**（带 confidence / hit_count / tags / evidence）
- `anti-patterns/SKILL.md` 和 `patterns/SKILL.md` 改为**纯索引**（指向 fact_id）
- 4 个 sub-skill 文件**加 [已归档] 警告**，禁止作为 agent 加载源（仅作历史存档）
- `MEMORY.md` M-001 引用从 `skills/anti-patterns/SKILL.md#AP-001` 改为 `fact_store WHERE fact_id IN ('AP-001','AP-005')`

### 收益

| 维度 | 之前 | 之后 |
|---|---|---|
| 单任务 token 占用（记忆部分） | 1400-4200 | 200-500（-85%） |
| hit_count 统计 | 不可能（md） | 自动（M6 回路） |
| confidence 自动校准 | 不可能 | 自动（每次使用 +0.02，上限 0.95） |
| 跨项目共享 | 不可能（md 项目本地） | 共享（sqlite 全局） |
| M 节点日志输出 | 无 | M3 引用 [memory:fact_id=AP-001 ...] 标记可审计 |

### 迁移执行

```bash
# 一次性迁移（建议首次部署后立即执行）
sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_skill_to_fact_store.sql

# 验证
sqlite3 "${HOME}/.config/kilo-data/memory.db" \
  "SELECT COUNT(*) FROM fact_store WHERE fact_id LIKE 'AP-%' OR fact_id LIKE 'PAT-%';"
# 期望：16
```

### 经验 vs Skill 边界（决策树）

```
新条目
├─ 描述「how」（步骤 / 流程 / 模板）→ 保留为 .kilo/skills/*/SKILL.md
└─ 描述「what」（具体反模式 / 具体模式）→ 必入 fact_store
   ├─ 触发场景 + 推荐做法 + 验证方式 → category='ANTIPATTERN' 或 'PATTERN'
   ├─ 命中 3 次且 confidence ≥ 0.8 → skill-upgrade.md 触发 [AUTO_DRAFT] 草稿
   └─ 草稿人工审批后才落盘为 SKILL.md
```

## 故障排查

| 症状 | 排查 |
|---|---|
| MCP 启动超时 | `policy/init_check.md` 步骤 1（建目录） |
| `no such table: fact_store` | `policy/init_check.md` 步骤 2（建表） |
| check17 提示 `[MEMORY_LAYER_HOLLOW]` | memory.db 表齐全但 dispatch_log/fact_store 全空 → 任务收尾未执行 sqlite INSERT |
| check17 FAIL 但表存在 | `contracts/health_check.sql` 索引/视图缺失 → 比对 schema/init.sql |
| check17 `[PROJECT_CONTEXT_EMPTY]` | v2.3 / #1：`api/seed_project_context.sql` 未执行或 8 条种子未应用 |
| check17 `[TRIAL_EXPIRED_PENDING]` | v2.3 / #2：14 天过期 trial 行未归档 → 执行 `api/trial_archive.sql` |
| check17 `[FACT_ID_ORPHAN]` | v2.3 / #4：bootstrap 16 条 AP/PAT fact 被意外删除/归档 → 检查 `fact_store` 中 AP-*/PAT-* 行 |
| check17 `[SCOPE_COLUMN_MISSING]` | v2.3 / #5：v2.2 → v2.3 升级未跑 `api/migrate_add_scope_column.sql` |
| check17 `[COMPENSATION_PROMPT_STALE]` | v2.3 / #8：model_calibration 设置补偿 prompt 后 30 天未消费 → 人工 review 失修 prompt |
| check17 `[FEEDBACK_LOOP_IDLE]` | v2.6：dispatch ≥5 但全库 helpful/misleading 反馈 = 0 → M6 Stage 3 未激活，按 `policy/m6_validation.md` §3 Stage 3 强制输出反馈标记 |
| check17 `[CONTEXT_USE_COUNT_STALE]` | v2.6：dispatch ≥5 但 project_context use_count 总和 = 0 → M1 query A' UPDATE 未执行，按 `policy/query_strategy.md` §1 A' 硬门执行 |
| FTS5 中文 MATCH 恒 0 命中 | v2.6 前部署的 DB 虚表为 unicode61 分词 → 执行 `api/migrate_fts_trigram.sql` 重建 |
| v2.3 升级 `REQUIRED_TABLES_MISSING` actual=5 | `api/migrate_skill_upgrade_log.sql` 未跑（含 CREATE TABLE IF NOT EXISTS） |

## 扩展指南

加一张新表的步骤：

1. 在 `schema/init.sql` 加 `CREATE TABLE` + 索引
2. 在 `contracts/health_check.sql` 的 REQUIRED 列表加新表名
3. 新建 `policy/<table>_recorder.md`（写入规则）+ 可能需要 `policy/query_strategy.md` 加查询模板
4. 在本 README.md「公共 API」表新增一行
5. 跑 `node validate-config.mjs` 确认 check17 PASS