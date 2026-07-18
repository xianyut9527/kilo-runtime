# Memory Module

> **模块位置**：`.kilo/memory/`（仓库内唯一记忆边界）
> **职责**：跨项目持久化结构化经验 + 任务调度日志 + 模型校准 + 项目上下文
> **状态**：v2.0（SQLite 优先 + md 兜底）
> **作者**：coderAgent 自动维护 + 人工审核

## 模块架构（4 层）

```
.kilo/memory/
├── README.md            ← 本文件（公共 API 文档，其他模块唯一应看的入口）
├── AGENTS.md            ← 模块对 agent 的指令（自动注入）
├── schema/              ← 第 1 层：DDL 唯一源
│   └── init.sql         ← 5 表 + 索引 + 视图
├── policy/              ← 第 2 层：业务规则决策树
│   ├── dispatch_recorder.md     ← dispatch_log 写入
│   ├── fact_dedup.md            ← fact_store 去重 + 写入
│   ├── failure_recorder.md      ← failure_db 写入
│   ├── skill_upgrade.md         ← fact_store 触发 skill 升级
│   ├── model_calibration.md     ← 模型校准更新
│   ├── query_strategy.md        ← 任务开始 + 失败回溯查询
│   └── init_check.md            ← memory.db 首次部署 SOP
├── api/                 ← 第 3 层：实现层（迁移脚本 + 未来 MCP server）
│   └── migrate_skill_to_fact_store.sql  ← v2.1 一次性迁移脚本（14 AP + 2 PAT）
└── contracts/           ← 第 4 层：接口契约
    └── health_check.sql ← 标准化健康度查询（被 validate-config.mjs check17 调用）
```

## 公共 API（外部模块唯一应访问的入口）

| 入口 | 触发方 | 用途 |
|---|---|---|
| `schema/init.sql` | install / 首次部署 | 建表（5 表 + 索引 + 视图） |
| `policy/query_strategy.md` §1 | coderAgent 任务开始 | 注入项目上下文 + 相关经验 + 失败模式 + 模型校准 |
| `policy/query_strategy.md` §2 | checker/reviewer FAIL 回溯 | 查同类失败 + 相关反模式 |
| `policy/dispatch_recorder.md` | coderAgent 任务结束（T1+） | 写 dispatch_log |
| `policy/fact_dedup.md` | coderAgent 发现可复用模式 | 去重 + INSERT/UPDATE fact_store |
| `policy/failure_recorder.md` | fixer 多轮 / Circuit Breaker | INSERT failure_db |
| `policy/model_calibration.md` | 每次 dispatch 后 | 增量更新 model_calibration |
| `policy/skill_upgrade.md` | 自动检测（条件 A/B/C） | fact_store 触发 SKILL.md 升级提案 |
| `policy/init_check.md` | 首次部署 / memory.db 缺失 | 4 步初始化 SOP |
| `contracts/health_check.sql` | validate-config.mjs check17 | 标准化健康度查询 |

## 核心铁律（3 条）

### 铁律 1：**唯一入口**

> **其他模块只能通过 sqlite MCP 工具与记忆交互**。
>
> - ✅ 引用 `.kilo/memory/policy/*.md` 查找业务规则
> - ✅ 引用 `.kilo/memory/schema/init.sql` 了解表结构
> - ❌ **禁止**在其他位置重复定义 SQL 模板、定义表结构、定义写入规则
> - ❌ **禁止**其他模块直接操作 `${HOME}/.config/kilo-data/memory.db`

### 铁律 2：**模块自洽**

> 模块自身具备完整性检查能力（`contracts/health_check.sql`）。
> check17 在每次 `node validate-config.mjs` 时执行，确保：
> - 5 表结构齐全
> - 核心索引存在
> - 视图存在
> - 行数统计可读

### 铁律 3：**演进路径**

> schema 变更必须**同时**改 3 个文件（缺一即破坏模块完整性）：
>
> 1. `schema/init.sql`（DDL 唯一源）
> 2. `contracts/health_check.sql`（表名 / 索引名 / 视图名同步）
> 3. `policy/*.md` 对应文档（业务规则同步）

---

## 检索约定（v2.0）

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
| fact_store | confidence ≥ 0.7 AND hit_count ≥ 2 AND archived = 0 |
| failure_db | resolved_at IS NOT NULL AND same_symptom_count ≥ 1 |
| project_context | priority ≤ 5 |
| model_calibration | sample_count ≥ 3 |

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
| `kilo.json` | `mcp.sqlite` 配置指向 `~/.config/kilo-data/memory.db` |

## 升级路径

| 阶段 | 内容 |
|---|---|
| v2.0 | 模块边界封装 + 4 层分离 + check17 健康度 |
| **v2.1**（当前） | **14 条 AP + 2 条 PAT 从 SKILL.md 迁移到 fact_store（去 md 化）**；新增 `api/migrate_skill_to_fact_store.sql` |
| v3.0（未来） | 自定义 MCP server（api/ 层）+ tool 强制执行 + 删除 `[MISSING_MEMORY_WRITE]` 标记 |
| v4.0（远期） | 跨会话语义检索（当前是 LIKE 模糊匹配）+ 跨项目共享 fact_store |

> **稳定原则**：不在 v2 稳定前触碰 v3 设计。

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

## 扩展指南

加一张新表的步骤：

1. 在 `schema/init.sql` 加 `CREATE TABLE` + 索引
2. 在 `contracts/health_check.sql` 的 REQUIRED 列表加新表名
3. 新建 `policy/<table>_recorder.md`（写入规则）+ 可能需要 `policy/query_strategy.md` 加查询模板
4. 在本 README.md「公共 API」表新增一行
5. 跑 `node validate-config.mjs` 确认 check17 PASS