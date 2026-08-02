# Memory Module — AGENTS.md（agent 入口）

> **模块位置**：`.kilo/memory/AGENTS.md`
> **注入时机**：当 `~/.config/kilo-data/memory.db` 存在且含 7 表时按需加载
> **禁用方式**：删除或清空 `~/.config/kilo-data/memory.db` 即可优雅降级

## 核心原则

1. **sqlite 唯一记忆**：所有结构化记忆优先查询 sqlite；禁止 md 文件累积时序/经验/频次数据。
2. **FTS5 镜像加速**：fact_store / failure_db 维护 FTS5 虚表，query B 用 `MATCH`。
3. **helpful_rate 反馈（v2.6 强制）**：M6 必须输出 `[memory:helpful=...]` / `[memory:misleading=...]` 或 `[memory:helpful=none]`。
4. **A' use_count 硬门（v2.6.2 原子化）**：M1 注入 project_context 执行 `UPDATE...RETURNING` 一步完成选中+use_count+1。
5. **md 兜底仅静态**：用户偏好/安全约束统一由 sqlite `project_context` 承载；写入即持久。

## 公共 API（agent 入口）

| 场景 | 入口 |
|---|---|
| 任务开始注入 | M1 注入：`docs/memory-ops-reference.md` §M1 |
| 失败回溯 | M3 查询：SELECT FROM failure_db |
| 任务结束写入 | M6/M7/M8：`docs/memory-ops-reference.md` §收尾 |
| 健康度检查 | `python scripts/memory.py check` |

## 必读规则

完整 checklist 见 `.kilo/instructions/workflow-core.md` §收尾自检。本节仅列 4 条核心原则：

1. **T1+ 必走收尾自检**；T0/INQUIRY 命中价值信号时同样必走。
2. **记忆提示即时输出**：召回 `🧠 [memory:recall]`、写入 `💾 [memory:write]`；禁止输出 M1-M8 大表格。
3. **md 不接收新经验**：所有可复用模式/反模式先入 `fact_store`。
4. **Skill 升级需人工 gate**：`fact_store.confidence ≥ 0.8 && hit_count ≥ 3` 触发 `[AUTO_DRAFT]`，不得直接 patch SKILL.md。

## Token Budget

- sqlite 查询结果注入总量 ≤ 2000 tokens（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 兜底 ≤ 1500 tokens

## 与仓库根 AGENTS.md 的关系

仓库根 `AGENTS.md` 指向本模块。具体 SQL 模板由 `docs/memory-ops-reference.md` 定义。

## 模块降级行为

- `memory.db` 不存在 → 跳过 sqlite 查询/写入，优雅降级。
- `schema/init.sql` 缺失 → 模块不加载，`lifecycle-doctor.mjs` 装配自检 FAIL。

## 相关文件

- `README.md` — 公共 API 文档
- `schema/init.sql` — DDL 唯一源
- `contracts/health_check.sql` — 健康度校验
- `docs/memory-ops-reference.md` — SQL 模板与业务规则
