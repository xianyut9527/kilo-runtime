# Memory Module — AGENTS.md（agent 入口）

> **模块位置**：`.kilo/memory/AGENTS.md`（模块对 agent 的唯一注入入口）
> **注入时机**：当 `${HOME}/.config/kilo-data/memory.db` 存在且含 5 表时，由 coderAgent / engineer / reviewer 在任务开始时按需加载
> **禁用方式**：删除或清空 `${HOME}/.config/kilo-data/memory.db` 即可优雅降级（不报错、不删除规则）

## 模块标识

- **名称**：`memory-module`
- **版本**：`2.0`
- **策略**：`sqlite-first-md-fallback`
- **数据库路径**：`${HOME}/.config/kilo-data/memory.db`

## 核心原则

1. **sqlite 优先**：所有结构化记忆（fact、failure、dispatch、project_context、calibration）优先查询 sqlite。
2. **md 兜底**：用户偏好、安全约束、通用约定等低频变更内容保留在 `MEMORY.md` / `USER.md`。
3. **写入即持久**：任务过程中产生的经验、失败模式必须写入 sqlite，不能留在 prompt 里丢失。

## 公共 API（agent 唯一应访问的入口）

完整列表见 `README.md` §公共 API。常用入口：

| 场景 | 入口 |
|---|---|
| 任务开始注入 | `policy/query_strategy.md` §1 |
| 失败回溯 | `policy/query_strategy.md` §2 |
| 任务结束 dispatch_log | `policy/dispatch_recorder.md` |
| 发现可复用模式 | `policy/fact_dedup.md` |
| fixer 多轮 / 失败 | `policy/failure_recorder.md` |
| 模型校准 | `policy/model_calibration.md` |
| skill 升级检测 | `policy/skill_upgrade.md` |
| 首次部署 | `policy/init_check.md` |

## 必读规则

### 收尾自检（硬门）

T1+ 任务「经验沉淀」执行前，必须按以下 checklist 全部勾选，任何一项未执行都不得标记任务完成。详见 `.kilo/instructions/workflow-core.md` §收尾自检。

- [ ] dispatch_log INSERT
- [ ] fact_store 去重 + INSERT/UPDATE
- [ ] failure_db INSERT（如有失败）
- [ ] model_calibration UPDATE
- [ ] fixer error_code 回写（如触发 fixer）
- [ ] skill 升级检测（仅记录，不自动落盘）

未执行 → `[MISSING_MEMORY_WRITE]`，阻塞交付。

### md 写入边界

- `MEMORY.md` / `USER.md` 仅作归档索引 / 用户偏好 / 安全约束，**不接收新经验条目**
- `SKILL.md` 仅在 `fact_store.confidence ≥ 0.8 && hit_count ≥ 3` 后由 `policy/skill_upgrade.md` 触发 `[AUTO_DRAFT]` 草稿，**人工审批后才落盘**

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