# Memory Module

> **模块位置**：`.kilo/memory/`（仓库内唯一记忆边界）
> **职责**：跨项目持久化结构化经验 + 任务调度日志 + 模型校准 + 项目上下文 + 反馈质量量化
> **状态**：v2.7（SQLite 唯一记忆 + md 静态规则兜底 + FTS5 trigram + helpful_rate 强制反馈 + scope 隔离）

## 公共 API（外部模块唯一入口）

| 入口 | 触发方 | 用途 |
|---|---|---|
| `schema/init.sql` | install / 首次部署 | 建表（7 表 + 索引 + 视图 + 2 FTS5 虚表）+ 8 条 project_context 种子 |
| `docs/memory-ops-reference.md` | lifecycle DELIVERING 阶段 | M1-M8 SQL 模板 + 业务规则 |
| `.kilo/instructions/workflow-core.md` §收尾自检 | conductor 收尾 | 10 条硬门 checklist |
| `contracts/health_check.sql` | `python scripts/memory.py check` | 20 项健康度查询契约源 |
| `AGENTS.md` | 运行时自动注入 | 模块对 agent 的核心原则 + Token Budget + 必读规则 |

## 核心铁律

1. **唯一入口**：其他模块通过 `python scripts/memory.py` 与记忆交互；禁止直接操作 `~/.config/kilo-data/memory.db`；禁止在其他位置重复定义 SQL/表结构/写入规则。
2. **模块自洽**：`python scripts/memory.py check` 验证 7 表、核心索引、视图可查询性、行数统计及 soft-warn 项。
3. **演进路径**：schema 变更必须同时改 `schema/init.sql` 和 `contracts/health_check.sql`；业务规则变更改 `docs/memory-ops-reference.md`。

## 检索约定

- 所有查询结果必须包含 ID 字段（fact_id / failure_id / context_id / calibration_id）。
- 标准注入格式：`[memory:fact_id={id} category={cat} confidence={c} hit_count={n} tags=[...]]`。
- 注入门槛见 `docs/memory-ops-reference.md` §门槛表。

## MEMORY.md vs fact_store 边界

| 内容 | 存储位置 |
|---|---|
| 可复用模式/反模式 | `fact_store` |
| 失败案例 | `failure_db` |
| 项目架构/业务规则 | `project_context` |
| 模型校准数据 | `model_calibration` |
| 用户偏好/安全约束 | `project_context` |

**禁止把任务经验直接 append 到 SKILL.md**。可复用模式先入 `fact_store`，满足 `confidence ≥ 0.8 && hit_count ≥ 3` 后触发 `[AUTO_DRAFT]`，人工审批后落盘。

## 与其他模块的关系

- `.kilo/instructions/workflow-core.md`：定义收尾 10 条硬门；不重复定义 SQL。
- `.kilo/skills/`：skill 是 `fact_store` 的固化产物。
- `agent/*.md`：智能体 prompt 不直接引用 SQL；通过 lifecycle 阶段加载，conductor 在 DELIVERING 查阅 `docs/memory-ops-reference.md`。
- `python scripts/memory.py`：主通道；数据库文件 `~/.config/kilo-data/memory.db`。
- `kilo.json`：记忆主通道 = `python scripts/memory.py`。

## 故障排查

| 症状 | 排查 |
|---|---|
| `no such table: fact_store` | 重新运行 `install.ps1` 或 `install.sh` 初始化 memory.db |
| `[MEMORY_LAYER_HOLLOW]` | 任务收尾未执行 sqlite INSERT |
| `[TRIAL_EXPIRED_PENDING]` | 归档 14 天前未达标的 trial 行 |
| `[FEEDBACK_LOOP_IDLE]` | M6 Stage 3 未输出 helpful/misleading 标记 |
| `[CONTEXT_USE_COUNT_STALE]` | M1 query A' UPDATE...RETURNING 未执行 |
| `[VIEWS_QUERYABLE_OK]` | 重新执行 `schema/init.sql` 末尾 CREATE VIEW 段 |

## 扩展指南

加一张新表的步骤：
1. `schema/init.sql` 加 `CREATE TABLE` + 索引
2. `contracts/health_check.sql` 的 REQUIRED 列表加新表名
3. `docs/memory-ops-reference.md` 补充对应 M 节点 SQL 模板
4. 本 README.md「公共 API」表新增一行
