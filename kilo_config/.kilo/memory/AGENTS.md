# Memory Module — AGENTS.md（agent 入口）

> **模块位置**：`.kilo/memory/AGENTS.md`（模块对 agent 的唯一注入入口）
> **注入时机**：当 `${HOME}/.config/kilo-data/memory.db` 存在且含 7 表时，由 coderAgent / engineer / reviewer 在任务开始时按需加载
> **禁用方式**：删除或清空 `${HOME}/.config/kilo-data/memory.db` 即可优雅降级（不报错、不删除规则）
> **版本**：v2.6.2（含 FTS5 trigram 全文检索 / helpful_rate 强制反馈 / failure_db scope 隔离 / project_context A' 原子化 UPDATE...RETURNING / M-001 动态 2AP+1PAT / 视图可查询性校验 / 反馈执行率告警）

## 模块标识

- **名称**：`memory-module`
- **版本**：`2.6.2`
- **策略**：`sqlite-first-md-fallback + bash-cli-channel + fts5-trigram + scope-isolation + helpful-rate-mandatory-feedback`
- **数据库路径**：`${HOME}/.config/kilo-data/memory.db`
- **访问通道**：主通道 = bash + sqlite3 CLI（v2.5-过渡版，模板见 `policy/bash_sqlite_template.md`）；备用通道 = 自建 memory-mcp（v3.0，`kilo.json` 中 `enabled:false` 默认关闭）

## 核心原则

1. **sqlite 唯一记忆**：所有结构化记忆（fact、failure、dispatch、project_context、calibration、skill_upgrade、skill_usage）优先查询 sqlite。**v2.5 起强制**：禁止 md 文件累积时序数据（`.kilo/memory/skill-usage.log` 已迁移至 `skill_usage_events` 表）；md 文件仅保留静态规则 / 模板 / 指针。**访问方式**：通过 Kilo `bash` 工具调用 `sqlite3` CLI 读写 `~/.config/kilo-data/memory.db`（命令模板见 `policy/bash_sqlite_template.md`）。
2. **FTS5 镜像加速**：v2.4 起 fact_store / failure_db 维护 FTS5 虚表，query B 从 `LIKE` 改为 `MATCH`（效率 +++）；v2.6 起分词器 trigram（中文 ≥3 字符子串可命中），详见 `policy/query_strategy.md` §1 query B。
3. **helpful_rate 反馈（v2.6 强制）**：M6 节点**必须**输出 `[memory:helpful=...]` / `[memory:misleading=...]` 标记（无反馈显式 `[memory:helpful=none]`，禁止静默省略），反向校准 confidence（质量 +++），详见 `policy/m6_validation.md` §3 Stage 3。
3b. **A' use_count 硬门（v2.6.2 原子化）**：M1 注入 project_context 必须执行 **query A+A' 单条 `UPDATE...RETURNING` SQL**（选中注入集 + use_count+1 + 返回内容一步完成，sqlite3 ≥3.35），RETURNING 新值即 A' 证据；`[memory:recall]` 提示直接引用，详见 `policy/query_strategy.md` §1。
4. **md 兜底（仅静态）**：用户偏好、安全约束等低频变更内容保留在 `MEMORY.md` / `USER.md`；**严禁** md 累积时序 / 经验 / 频次数据。
5. **写入即持久**：任务过程中产生的经验、失败模式、skill 使用事件必须写入 sqlite，不能留在 prompt 里丢失。

## 公共 API（agent 唯一应访问的入口）

**完整公共 API 清单**见同目录 `README.md` §公共 API（完整表）。本节仅给 agent 提供 4 条**最常用**入口：

| 场景 | 入口 |
|---|---|
| 任务开始注入 | `policy/query_strategy.md` §1 |
| 失败回溯 | `policy/query_strategy.md` §3 |
| 任务结束 dispatch_log | `policy/dispatch_recorder.md` |
| 发现可复用模式 | `policy/fact_dedup.md` |

> 全部入口（fact_dedup / failure_recorder / model_calibration / skill_upgrade / init_check / contracts/health_check.sql）见 README.md。

## 必读规则

**完整 checklist** 详见 `.kilo/instructions/workflow-core.md` §收尾自检（10 条硬门，含 M 节点编号）。本节仅给 agent 4 条**核心原则**：

1. **T1+ 必走收尾自检** — dispatch_log / fact_store / failure_db / model_calibration 全部必须执行，未执行 → `[MISSING_MEMORY_WRITE]` 阻塞交付
2. **记忆提示即时输出** — 记忆操作以即时单行提示可视化：召回时 `🧠 [memory:recall]`、写入时 `💾 [memory:write]`（含 ID，M6/M7/M8 可合并 1 行）；格式见 `agent/coderAgent.md` §记忆提示；禁止输出 M1-M8 大表格
3. **md 不接收新经验** — `MEMORY.md` / `USER.md` / `SKILL.md` 仅作归档索引或人工 gate，**所有可复用模式/反模式必须先入 `fact_store`**
4. **Skill 升级需人工 gate** — `fact_store.confidence ≥ 0.8 && hit_count ≥ 3` 才触发 `policy/skill_upgrade.md` `[AUTO_DRAFT]` 草稿，**不得直接 patch SKILL.md**

## Token Budget

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）

## 与 AGENTS.md（仓库根）的关系

仓库根 `AGENTS.md` 锚点 8「memory / skills / 自进化合规」指向本模块。本文件是该锚点的展开版本，**优先读本文件**了解记忆模块的具体规则。

## 模块不生效的降级行为

- `memory.db` 不存在 → 跳过所有 sqlite 查询/写入，Kilo 自动优雅降级
- `policy/*.md` 缺失 → 该规则视为不存在（不影响其他规则）
- `schema/init.sql` 缺失 → 模块不加载，但 `validate-config.mjs` check14 会 FAIL

## 相关文件

- `README.md` — 公共 API 文档
- `schema/init.sql` — DDL 唯一源
- `policy/*.md` — 业务规则
- `contracts/health_check.sql` — 健康度校验