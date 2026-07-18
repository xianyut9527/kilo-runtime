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
└── contracts/           ← 第 3 层：接口契约
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
| v2.0（当前） | 模块边界封装 + 4 层分离 + check17 健康度 |
| v3.0（未来） | 自定义 MCP server（api/ 层）+ tool 强制执行 + 删除 `[MISSING_MEMORY_WRITE]` 标记 |
| v4.0（远期） | 跨会话语义检索（当前是 LIKE 模糊匹配）+ 跨项目共享 fact_store |

> **稳定原则**：不在 v2 稳定前触碰 v3 设计。

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