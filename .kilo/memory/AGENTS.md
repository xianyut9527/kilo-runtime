# Memory Module — AGENTS.md（agent 入口）

> **模块位置**：`.kilo/memory/AGENTS.md`（模块对 agent 的唯一注入入口）
> **注入时机**：当 `${HOME}/.config/kilo-data/memory.db` 存在且含 7 表时，由 lifecycle 在任务开始时按需加载（统一通过 `docs/memory-ops-reference.md`）
> **禁用方式**：删除或清空 `${HOME}/.config/kilo-data/memory.db` 即可优雅降级（不报错、不删除规则）
> **版本**：v2.6.2

## 模块标识

- **名称**：`memory-module`
- **版本**：`2.6.2`
- **策略**：`sqlite-first-md-fallback + bash-cli-channel + fts5-trigram + scope-isolation + helpful-rate-mandatory-feedback`
- **数据库路径**：`${HOME}/.config/kilo-data/memory.db`
- **访问通道**：主通道 = bash + sqlite3 CLI；备用通道 = 自建 memory-mcp（v3.0，`kilo.json` 中 `enabled:false` 默认关闭）
- **生命周期集成**：记忆操作统一由 `docs/memory-ops-reference.md` 定义，不再分散在各 agent 文件中

## 核心原则

1. **sqlite 唯一记忆**：所有结构化记忆（fact、failure、dispatch、project_context、calibration、skill_upgrade、skill_usage）优先查询 sqlite。**v2.5 起强制**：禁止 md 文件累积时序数据；md 文件仅保留静态规则 / 模板 / 指针。**访问方式**：通过 Kilo `bash` 工具调用 `sqlite3` CLI 读写 `~/.config/kilo-data/memory.db`。
2. **FTS5 镜像加速**：v2.4 起 fact_store / failure_db 维护 FTS5 虚表，query B 从 `LIKE` 改为 `MATCH`（效率 +++）；v2.6 起分词器 trigram（中文 ≥3 字符子串可命中）。
3. **helpful_rate 反馈（v2.6 强制）**：M6 节点**必须**输出 `[memory:helpful=...]` / `[memory:misleading=...]` 标记（无反馈显式 `[memory:helpful=none]`，禁止静默省略），反向校准 confidence（质量 +++）。
3b. **A' use_count 硬门（v2.6.2 原子化）**：M1 注入 project_context 必须执行 **query A+A' 单条 `UPDATE...RETURNING` SQL**（选中注入集 + use_count+1 + 返回内容一步完成，sqlite3 ≥3.35），RETURNING 新值即 A' 证据；`[memory:recall]` 提示直接引用。
4. **md 兜底（仅静态）**：v2.6.2 精简后不再维护 `MEMORY.md` / `USER.md`，用户偏好/安全约束统一由 sqlite `project_context` 表承载；**严禁** md 累积时序 / 经验 / 频次数据。
5. **写入即持久**：任务过程中产生的经验、失败模式、skill 使用事件必须写入 sqlite，不能留在 prompt 里丢失。

## 公共 API（agent 唯一应访问的入口）

**完整公共 API 清单**见同目录 `README.md` §公共 API（完整表）。本节仅给 agent 提供 4 条**最常用**入口：

| 场景 | 入口 |
|---|---|
| 任务开始注入 | M1 注入：SELECT project_context + fact_store + failure_db |
| 失败回溯 | M3 查询：SELECT FROM failure_db WHERE pattern MATCH ? |
| 任务结束 dispatch_log | M6/M7 写入：INSERT INTO dispatch_log / fact_store |
| 发现可复用模式 | M8 检测：fact_store.confidence ≥ 0.8 && hit_count ≥ 3 |

> 全部入口（含 contracts/health_check.sql）见 README.md。
> **生命周期集成后**：具体 SQL 模板和执行流程详见 `docs/memory-ops-reference.md`。

## 必读规则

**完整 checklist** 详见 `.kilo/instructions/workflow-core.md` §收尾自检（10 条硬门，含 M 节点编号）。本节仅给 agent 4 条**核心原则**：

1. **T1+ 必走收尾自检**；**T0/INQUIRY 命中"价值信号"时同样必走**（见 `agent/orchestrator.md` §记忆编排） — dispatch_log / fact_store / failure_db / model_calibration 全部必须执行，未执行 → `[MISSING_MEMORY_WRITE]` 阻塞交付
2. **记忆提示即时输出** — 记忆操作以即时单行提示可视化：召回时 `🧠 [memory:recall]`、写入时 `💾 [memory:write]`（含 ID，M6/M7/M8 可合并 1 行）；格式见 `docs/memory-ops-reference.md`；禁止输出 M1-M8 大表格
3. **md 不接收新经验** — `SKILL.md` 仅作归档索引或人工 gate，**所有可复用模式/反模式必须先入 `fact_store`**
4. **Skill 升级需人工 gate** — `fact_store.confidence ≥ 0.8 && hit_count ≥ 3` 才触发 `[AUTO_DRAFT]` 草稿，**不得直接 patch SKILL.md**

## Token Budget

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）

## 与 AGENTS.md（仓库根）的关系

仓库根 `AGENTS.md` 锚点 8「memory / skills / 自进化合规」指向本模块。生命周期驱动后，记忆操作统一由 `docs/memory-ops-reference.md` 定义，本文件保留为模块入口和 sqlite 契约说明。

## 模块不生效的降级行为

- `memory.db` 不存在 → 跳过所有 sqlite 查询/写入，Kilo 自动优雅降级；重新运行 `install.ps1`/`install.sh` 可自动安装 `sqlite3` + 初始化 `memory.db`
- `schema/init.sql` 缺失 → 模块不加载，但 `validate-config.mjs` check14 会 FAIL

## 相关文件

- `README.md` — 公共 API 文档
- `schema/init.sql` — DDL 唯一源
- `contracts/health_check.sql` — 健康度校验
- `docs/memory-ops-reference.md` — 生命周期集成后的能力插件定义