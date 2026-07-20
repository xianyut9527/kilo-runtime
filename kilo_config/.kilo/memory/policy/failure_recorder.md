# Failure Recorder 策略

> **模块位置**：`.kilo/memory/policy/failure_recorder.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **版本**：v2.6 降低写入门槛（checker 首轮 FAIL 即记录）；v2.4 增加 scope / project_name 列（与 fact_store 对齐，#15 跨项目隔离）+ failure_fts FTS5 虚表（v2.6 分词器 trigram）
> **职责**：定义 failure_db 的写入条件与模板

## 写入条件

满足任一：
- **checker 任意轮 FAIL（findings_count ≥ 1）**（v2.6 新增，降门槛：v2.4/v2.5 期间 failure_db 恒为 0 行，
  失败模式从未沉淀。轻量记录 verified=0；fixer/checker 复验通过后按 §状态更新 置 verified=1 + resolved_at）
- fixer 连续 2 轮同症状
- Circuit Breaker 触发
- 用户反馈"还是有问题/不对/遗漏"

> v2.6 降门槛说明：原条件（fixer ≥2 轮 / Circuit Breaker / 用户返工）过于靠后，导致大量「checker 首轮 FAIL
> 即被 engineer 直修」的真实失败模式流失。首轮 FAIL 即记录可使 failure_db 成为 M2 回溯的真实数据源；
> 仍禁止写入项目特定代码与敏感信息（见 §禁止事项）。

## 写入模板

```sql
INSERT INTO failure_db (failure_id, dispatch_id, root_cause_level, symptom, fix_strategy, fix_location, verified, tags, created_at)
VALUES (?, ?, '执行层|方法层|需求层', '症状描述', '修复策略', '文件:行号', 0, '["tag1"]', datetime('now'));
```

## 状态更新

### verified 字段

- **初始值**：0（未验证）
- **更新时机**：fixer 修复后，checker 重新验证通过 → `UPDATE failure_db SET verified = 1, resolved_at = datetime('now') WHERE failure_id = ?`

### same_symptom_count 字段

同一 symptom 再次出现时递增：

```sql
UPDATE failure_db SET same_symptom_count = same_symptom_count + 1
WHERE symptom = ? AND resolved_at IS NULL;
```

## 根因级别

`root_cause_level` 必须是以下三者之一：

| 级别 | 含义 | 修复策略 |
|---|---|---|
| **执行层** | 代码逻辑错误、边界遗漏、实现偏差 | 直接修复代码 |
| **方法层** | 搜索不全、分析偏差、验证遗漏 | 改进方法，补充搜索/验证 |
| **需求层** | 需求理解错误、范围不清、验收标准缺失 | 重新澄清需求，调整验收标准 |

详见 `../../instructions/reflection.md`「三层判定」。

## 关联查询

写入 failure_db 后，可通过以下视图查询高频失败模式（由 `schema/init.sql` 定义）：

```sql
SELECT * FROM v_failure_patterns WHERE occurrence >= 2;
```

## 禁止事项

- 禁止写入项目特定代码（如具体变量名、业务逻辑）
- 禁止写入敏感信息（API Key、密码、内部域名）

## v2.4 跨项目 scope 写入规则（#15）

`failure_db` 在 v2.4 起镜像 `fact_store` 的 scope 隔离机制（详见 `policy/fact_dedup.md` §v2.3 跨项目 scope 写入规则）。

| scope 取值 | project_name 取值 | 注入条件 |
|---|---|---|
| `'global'`（默认） | NULL | 任意项目注入失败回溯 |
| `'project'` | `:current_project` | 仅本项目注入 |

**写入决策**：与 fact 一致 — 用户标记 `[scope=project]` / 经验含项目专属代码 → `'project'`，否则 `'global'`。

## FTS5 全文检索（#5 镜像；v2.6 trigram 分词）

`failure_db` 与 `fact_store` 同步维护 FTS5 虚表（`failure_fts`）。M2 失败回溯 query 由 `LIKE` 改为 `MATCH`，效率 +++。v2.6 起分词器为 trigram（中文 ≥3 字符子串可 MATCH；2 字中文词需扩展为 ≥3 字词组或退化 LIKE）。

详见 `policy/query_strategy.md` §3 失败/回溯查询 + `api/migrate_failure_scope_and_fts.sql`（v2.4 列+虚表迁移）+ `api/migrate_fts_trigram.sql`（v2.6 分词器重建）。

## 相关策略

- `dispatch_recorder.md` — dispatch_log 写入（failure_db 的 dispatch_id 来源）
- `model_calibration.md` — failure_db 数据喂给模型校准
- `../../instructions/reflection.md` — 三层判定 + 强制跨会话根因回溯
- `policy/fact_dedup.md` §v2.3 跨项目 scope 写入规则 — scope 取值判定（failure_db 镜像）
- `policy/query_strategy.md` §3 — M2 失败回溯 FTS5 MATCH 语法