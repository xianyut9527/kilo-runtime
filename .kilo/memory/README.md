# Memory Module

> **模块位置**：`.kilo/memory/`（仓库内唯一记忆边界）
> **职责**：跨项目持久化结构化经验 + 任务调度日志 + 模型校准 + 项目上下文 + 反馈质量量化
> **状态**：v2.6.2（**SQLite 唯一记忆** + md 静态规则兜底 + FTS5 trigram + helpful_rate 强制反馈 + scope 隔离 + 回路空转告警 + 视图可查询性校验）
> **作者**：conductor 自动维护 + 人工审核

## 模块架构（2 层精简）

```
.kilo/memory/
├── README.md            ← 本文件（公共 API 文档，其他模块唯一应看的入口）
├── AGENTS.md            ← 模块对 agent 的指令（运行时注入）
├── memory-strategy.md   ← 兼容性指针文件（`strategy: "memory-strategy.md"` 仍可命中）
├── init.sql             ← 旧版根级 DDL 别名（与 schema/init.sql 保持同步，install 脚本兼容入口）
├── schema/              ← 第 1 层：DDL 唯一源
│   └── init.sql         ← 7 表 + 26 索引 + 4 视图 + 2 FTS5 虚表（trigram，v2.6）+ 8 条 project_context 自动种子（v2.5 +skill_usage_events）
└── contracts/           ← 第 2 层：接口契约
    └── health_check.sql ← 标准化健康度查询（v2.6.2 18 项；被 validate-config.mjs check17 调用）
```

> **v2.6.2 精简**：原 `policy/*.md`（11 文件）和 `api/*.sql`（13 文件）和 `api/mcp/*`（4 文件）已在 commit `de3915e` 删除——业务规则与 SQL 模板统一由 `docs/memory-ops-reference.md` 定义（生命周期驱动后），迁移脚本与 v2.3→v2.6.2 升级历史归档为 CHANGELOG 记录。

## 公共 API（外部模块唯一应访问的入口）

| 入口 | 触发方 | 用途 |
|---|---|---|
| `schema/init.sql` | install / 首次部署 | 建表（7 表 + 索引 + 视图 + 2 FTS5 虚表）+ 8 条 project_context 自动种子 |
| `docs/memory-ops-reference.md` | lifecycle `S01` / `S16` 阶段 | M1 注入查询模板 + M4-M8 写入模板 + 降级处理（conductor 在 S16 内建调用） |
| `.kilo/instructions/workflow-core.md` §收尾自检 | conductor 收尾 | 10 条硬门 checklist（M4-M8 SQL 模板内联） |
| `contracts/health_check.sql` | validate-config.mjs check17 | 18 项健康度查询（v2.6.2 含反馈执行率 soft-warn） |
| `AGENTS.md` | 运行时自动注入 | 模块对 agent 的核心原则 + Token Budget + 必读规则 |

## 核心铁律（3 条）

### 铁律 1：**唯一入口**

> **其他模块通过 `python scripts/memory.py` 与记忆交互**（主通道；sqlite3 CLI 为可选替代）。
>
> - ✅ 引用 `docs/memory-ops-reference.md` 查找 SQL 模板
> - ✅ 引用 `.kilo/memory/schema/init.sql` 了解表结构
> - ❌ **禁止**在其他位置重复定义 SQL 模板、定义表结构、定义写入规则
> - ❌ **禁止**其他模块直接操作 `${HOME}/.config/kilo-data/memory.db`

### 铁律 2：**模块自洽**

> 模块自身具备完整性检查能力（`contracts/health_check.sql`）。
> check17 在每次 `node validate-config.mjs` 时执行，确保：
> - 7 表结构齐全（v2.5 含 `skill_usage_events`）
> - 核心索引存在（≥21，含 v2.3 新增 `idx_fact_scope` / `idx_upgrade_fact` / `idx_upgrade_status`）
> - 视图存在且可查询（v2.6.1 #17 VIEWS_QUERYABLE_OK）
> - 行数统计可读
> - 第 6-17 项为 soft-warn 检查（不阻断交付）

### 铁律 3：**演进路径**

> schema 变更必须**同时**改 2 个文件（缺一即破坏模块完整性）：
>
> 1. `schema/init.sql`（DDL 唯一源）
> 2. `contracts/health_check.sql`（表名 / 索引名 / 视图名同步）
>
> 业务规则变更改 `docs/memory-ops-reference.md`（生命周期驱动后唯一业务规则入口）。

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

完整模板见 `docs/memory-ops-reference.md` §SQL 模板。

### 注入门槛

| 数据源 | 门槛 |
|---|---|
| fact_store（正式） | confidence ≥ 0.7 AND hit_count ≥ 2 AND archived = 0 |
| fact_store（试用期，v2.2） | confidence ≥ 0.5 AND hit_count < 2 AND created_at ≤ 14 天内，每任务 ≤2 条（标记 `trial=1`） |
| failure_db | resolved_at IS NOT NULL AND same_symptom_count ≥ 1 |
| project_context | priority ≤ 5 |
| model_calibration | sample_count ≥ 2（v2.6 起；原 ≥3 放宽） |

> 完整规则见 `docs/memory-ops-reference.md` + `instructions/workflow-core.md` §收尾自检。

### hit_count 自增回路

每次 T1+ 任务收尾时，从 agent 输出中的 `[memory:fact_id=...]` 标记提取本次用到的 fact_id 列表，**对每个 fact_id 执行 `UPDATE hit_count + 1, confidence + 0.02 (上限 0.95)`**。详见 `docs/memory-ops-reference.md` + `instructions/workflow-core.md` §收尾自检。

---

## MEMORY.md vs fact_store 边界

> **v2.6.2 精简后**：`MEMORY.md` / `USER.md` / `MODULE_GUIDE.md` 已删除——用户偏好与安全约束统一由 sqlite `project_context` 表承载；归档索引由 `fact_store` 表 + `fact_id` 直接引用，无需 md 指针。

| 内容 | 存储位置 | 原因 |
|---|---|---|
| **可复用模式/反模式**（PATTERN / ANTIPATTERN / RECIPE / WARNING） | `fact_store` 表 | 需要置信度/命中数/证据/触发条件等结构化字段；高频检索 |
| **失败案例** | `failure_db` 表 | 需要根因层/复发次数/解决时间等 |
| **项目架构/业务规则** | `project_context` 表 | 优先级/类别/来源文件 |
| **模型校准数据** | `model_calibration` 表 | 动态累积成功率/补偿 prompt |
| **用户偏好/安全约束** | `project_context` 表（category='user_preference' / 'security_constraint'） | sqlite 查询，无需独立 md 文件 |

> **核心规则**：**禁止把任务经验直接 append 到 SKILL.md**。所有可复用模式/反模式必须先入 `fact_store`，满足 `confidence ≥ 0.8 && hit_count ≥ 3` 后触发 `[AUTO_DRAFT]` 草稿，人工审批后才落盘为 SKILL.md。

## 与其他模块的关系

| 模块 | 关系 |
|---|---|
| `.kilo/instructions/` | `workflow-core.md` §收尾自检定义 10 条硬门；不重复定义 SQL |
| `.kilo/skills/` | skill 是 sqlite fact_store 的固化产物（满足 confidence/hit_count 门槛后触发草稿） |
| `agent/*.md` | 智能体 prompt 不直接引用 SQL；通过 lifecycle 阶段文件加载智能体，conductor 在 S16 查阅 `docs/memory-ops-reference.md` |
| `docs/memory-ops-reference.md` | 生命周期驱动后唯一业务规则与 SQL 模板入口 |
| `validate-config.mjs` | check17 通过 contracts/health_check.sql 校验模块；check14 校验模块入口文件存在 |
| `kilo.json` | 记忆主通道 = `python scripts/memory.py`（sqlite3 CLI 可选替代）；数据库文件 `~/.config/kilo-data/memory.db` |

## 升级路径

| 阶段 | 内容 |
|---|---|
| v2.0 | 模块边界封装 + 4 层分离 + check17 健康度 |
| v2.1 | 14 条 AP + 2 条 PAT 从 SKILL.md 迁移到 fact_store（去 md 化） |
| v2.2 | 4 个 archived sub-skill 文件彻底删除；fact_store 试用期机制；M6 自增数据源扩展 |
| v2.3 | project_context 8 条种子自动 fill / trial 14 天过期归档 / skill_upgrade V2 / M6 Stage 1 前置校验 / scope 隔离 / semantic_search v4.0 接口规范 / 补偿 prompt 消费追踪 |
| v2.4 | FTS5 全文索引 / project_context use_count 动态排序 / fact_store helpful_rate 反馈量化 / failure_db scope 镜像 / dispatch_log 结构化反馈列 |
| v2.5 | SQLite 唯一记忆原则：禁止 md 文件累积时序数据；MEMORY.md ≤1500 纯指针化；archive/YYYY-MM/ md 归档协议废除 |
| v2.6 | FTS5 分词器 trigram / M6 helpful/misleading 强制化 / M1 query A' use_count 硬门 / health_check 回路空转告警 / failure_db 写入降门槛 / model_calibration 注入门槛放宽 |
| v2.6.1 | 修复 v_failure_patterns 视图 GROUP_CONCAT DISTINCT 语法 / health_check VIEWS_QUERYABLE_OK / test.js temp DB 隔离 / 删除死表 mcp_config |
| v2.6.2 | M1 query A+A' 原子化 UPDATE...RETURNING / health_check FEEDBACK_RATE_LOW / **精简：删除 policy/ + api/ + api/mcp/（业务规则统一到 `docs/memory-ops-reference.md`）** |
| v2.7（schema 当前） | project_context.scope / project_name 列（跨项目隔离，对齐 fact_store v2.3）/ idx_project_scope 复合索引 / v_active_project_context 视图加 scope 列 / 8 条种子回填 scope / health_check #19 #20 / 业务规则入口统一为 `docs/memory-ops-reference.md` |
| v3.0（未来） | 可选自建 MCP server（kilo.json `mcp` 段按需启用）；当前主通道为 `python scripts/memory.py`（sqlite3 CLI 可选替代） |

> **稳定原则**：不在 v2 稳定前触碰 v3 设计。

## 故障排查

| 症状 | 排查 |
|---|---|
| `no such table: fact_store` | 重新运行 `install.ps1`（Windows）或 `install.sh`（macOS/Linux）自动初始化 memory.db |
| check17 提示 `[MEMORY_LAYER_HOLLOW]` | memory.db 表齐全但 dispatch_log/fact_store 全空 → 任务收尾未执行 sqlite INSERT |
| check17 FAIL 但表存在 | `contracts/health_check.sql` 索引/视图缺失 → 比对 `schema/init.sql` |
| check17 `[PROJECT_CONTEXT_EMPTY]` | project_context 种子未应用 → 执行 `schema/init.sql` 末尾 INSERT OR IGNORE 段 |
| check17 `[TRIAL_EXPIRED_PENDING]` | 14 天过期 trial 行未归档 → 手动执行 `UPDATE fact_store SET archived=1 WHERE created_at < date('now','-14 days') AND hit_count < 2` |
| check17 `[FEEDBACK_LOOP_IDLE]` | dispatch ≥5 但全库 helpful/misleading 反馈 = 0 → M6 Stage 3 未激活，强制输出 `[memory:helpful=...]` 反馈标记 |
| check17 `[CONTEXT_USE_COUNT_STALE]` | dispatch ≥5 但 project_context use_count 总和 = 0 → M1 query A' UPDATE 未执行，按 `docs/memory-ops-reference.md` M1 模板执行 `UPDATE...RETURNING` |
| check17 `[VIEWS_QUERYABLE_OK]` | 视图体内 SQL 损坏 → 重新执行 `schema/init.sql` 末尾 CREATE VIEW 段 |
| FTS5 中文 MATCH 恒 0 命中 | v2.6 前部署的 DB 虚表为 unicode61 分词 → 重建：`DROP TABLE fact_fts; DROP TABLE failure_fts;` 再执行 `schema/init.sql` 中的 CREATE VIRTUAL TABLE 段 |

## 扩展指南

加一张新表的步骤：

1. 在 `schema/init.sql` 加 `CREATE TABLE` + 索引
2. 在 `contracts/health_check.sql` 的 REQUIRED 列表加新表名
3. 在 `docs/memory-ops-reference.md` 补充对应 M 节点的 SQL 模板
4. 在本 README.md「公共 API」表新增一行