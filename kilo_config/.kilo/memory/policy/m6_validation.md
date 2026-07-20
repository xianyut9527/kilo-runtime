# M6 标记前置校验规范（v2.4 / #4 + #13；v2.6 Stage 3 强制化）

> **模块位置**：`.kilo/memory/policy/m6_validation.md`
> **职责**：定义 v2.2 `[memory:referenced_fact_ids=... not_injected=true]` 标记的前置校验（#4）+ v2.4 helpful/misleading 反馈流程（#13，v2.6 起 Stage 3 强制输出），防止 typo / fact_id 失效导致 hit_count 静默 no-op，并支持反向校准 confidence
> **关联节点**：M6 hit_count 自增回路（`policy/query_strategy.md` §4）+ M6 helpful_rate 反馈（`policy/query_strategy.md` §M6 helpful_rate 反馈流程）

## 1. 背景

v2.2 M6 自增回路引入「显式声明」扩展：coderAgent 收尾时可声明「本次实际参考但未注入的 fact_id」，结构化标记为 `[memory:referenced_fact_ids=A,B,C not_injected=true]`。该标记与注入引用同权，触发 hit_count +1 / confidence +0.02。

**问题**：若声明的 fact_id 不存在（typo 或 fact 已归档），UPDATE 静默 no-op（rows affected = 0），agent 无法察觉「本次 M6 实际未生效」。长期累积会污染 M6 自增回路的统计意义。

## 2. 标记格式规范（canonical regex）

```
\[memory:referenced_fact_ids=([A-Z]+-\d+(?:,[A-Z]+-\d+)*) not_injected=true\]
```

| 部分 | 规则 |
|---|---|
| `fact_id` 格式 | `<CATEGORY_PREFIX>-<NUMBER>`，例如 `AP-001` / `PAT-002` / `M-001` |
| 分隔符 | 英文逗号 `,` 后无空格 |
| `not_injected=true` | 字面字符串，必须出现（区分于注入标记 `[memory:fact_id=...]`） |

## 3. 两阶段处理流程（强制）

### Stage 1: Validate（前置校验）

在 M6 hit_count UPDATE 前，agent **必须**解析 `referenced_fact_ids` 列表，对每个 ID 执行 SELECT：

```sql
SELECT fact_id FROM fact_store WHERE fact_id IN (?, ?, ?, ...) AND archived = 0;
```

判定：

| 查询结果 | 处理 |
|---|---|
| 全部命中 | 进入 Stage 2 |
| 部分命中，部分不存在或已 archived | 仅对命中项进入 Stage 2；对不存在的项**生成 `[M6_ORPHAN_REFERENCE]` 警告**并写入 M6 节点日志（warn 而非 fail） |
| 全部不存在 | 跳过 Stage 2；M6 节点日志输出 `[M6_ALL_ORPHAN]` 警告；任务可继续交付 |

### Stage 2: Update（hit_count 自增）

对 Stage 1 校验通过的 fact_id 列表执行标准 M6 UPDATE：

```sql
UPDATE fact_store
SET hit_count = hit_count + 1,
    confidence = MIN(0.95, confidence + 0.02),
    updated_at = datetime('now')
WHERE fact_id IN (?, ?, ?, ...);  -- 仅含 Stage 1 命中项
```

### Stage 3: helpful/misleading 反馈处理（v2.4 / #13；**v2.6 起强制**）

> **v2.6 变更**：Stage 3 从「可输出」升级为「T1+ 任务必输出」。无反馈时必须显式输出
> `[memory:helpful=none]`（禁止静默省略），否则视为 M6 未完成 → `[MISSING_MEMORY_WRITE]`。
> 强制化理由：v2.4/v2.5 期间全库 helpful_count/misleading_count 恒为 0，helpful_rate 质量门形同虚设
> （健康度证据：`contracts/health_check.sql` §15 FEEDBACK_LOOP_IDLE）。

**反馈标记格式**：

```
[memory:helpful=A,B,C]      ← 本次 dispatch 中有价值的 fact
[memory:misleading=X,Y]     ← 本次 dispatch 中误导/不适用的 fact
[memory:helpful=none]       ← 无反馈时的显式空标记（v2.6 起强制兜底）
```

**反馈 id 校验**：helpful/misleading 列表中的 fact_id 与 Stage 1 共用同一次 SELECT 校验
（`WHERE fact_id IN (...) AND archived = 0`）；orphan id 输出 `[M6_ORPHAN_REFERENCE]` 并从反馈 UPDATE 移除。

**反馈 UPDATE**（含 v2.4 confidence 综合校准公式落地：helpful +0.02 / misleading −0.05）：

```sql
-- helpful：helpful_count+1，重算 helpful_rate，confidence +0.02（封顶 0.95）
UPDATE fact_store
SET helpful_count = helpful_count + 1,
    helpful_rate = CAST(helpful_count + 1 AS REAL) / (helpful_count + 1 + misleading_count),
    confidence = MIN(0.95, confidence + 0.02),
    updated_at = datetime('now')
WHERE fact_id IN (:helpful_fact_ids);

-- misleading：misleading_count+1，重算 helpful_rate，confidence −0.05（保底 0.1）
UPDATE fact_store
SET misleading_count = misleading_count + 1,
    helpful_rate = CAST(helpful_count AS REAL) / (helpful_count + misleading_count + 1),
    confidence = MAX(0.1, confidence - 0.05),
    updated_at = datetime('now')
WHERE fact_id IN (:misleading_fact_ids);
```

**与 Stage 2 的叠加关系（设计意图）**：hit_count 自增（使用频次）与 helpful/misleading（质量反馈）是
独立双通道，同一 fact 同轮可同时命中两者（如被引用且被标 helpful → confidence 合计 +0.04）。
同一 fact 同轮同时出现在 helpful 与 misleading → 两条 UPDATE 依次生效（净 confidence −0.03），
并在 M6 节点日志输出 ⚠️ 备注（语义矛盾，建议下次只标其一）。

**结果落盘**：反馈的 fact_id 列表随 M7 写入 `dispatch_log.helpful_fact_ids / misleading_fact_ids`
（详见 `policy/dispatch_recorder.md` §v2.4 M7 反馈字段写入规则）。

## 4. 边界场景

| 场景 | 行为 |
|---|---|
| `referenced_fact_ids` 为空字符串（如 `[memory:referenced_fact_ids= not_injected=true]`） | M6 跳过 UPDATE；节点日志记录 `M6 marker present but empty list` |
| fact_id 含小写字母（如 `ap-001`） | 视为 typo，Stage 1 失败，记录 orphan；不修正大小写 |
| fact_id 跨项目 scope 隔离（v2.3 / #5） | Stage 1 SELECT 加 `AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))` |
| fact 已 archived 但仍被引用 | Stage 1 视为 orphan（archived=0 过滤）；输出 `[M6_REFERENCED_ARCHIVED]` 警告，提示「该 fact 已被归档，建议从 referenced_fact_ids 移除」 |

## 5. 与 M3 注入引用的关系

M3 注入引用（`[memory:fact_id=X]` 在 agent 输出中出现）和 M6 显式声明（`referenced_fact_ids`）是两套独立机制：

| 机制 | 触发位置 | 校验强度 | 失败处理 |
|---|---|---|---|
| M3 注入引用 | M1 注入时已 SELECT 校验（不存在则不会注入） | 强（上游保证） | 不存在即不会出现在 prompt，无需 Stage 1 |
| M6 显式声明 | 任务收尾声明 | 弱（依赖 agent 自律） | 必须 Stage 1 校验 |

Stage 1 仅对 M6 显式声明执行；M3 注入引用因上游 SELECT 已保证存在，无需重复校验。

## 6. M6 节点日志模板

完整 markdown 模板见 `agent/coderAgent.md` §记忆节点日志 / M6。Stage 1 警告格式：

```
M6 hit_count 自增 | 🔄 UPDATE fact_store
- 声明引用列表: AP-001, AP-005, AP-XXX, PAT-001
- Stage 1 校验: 命中 3 项 (AP-001, AP-005, PAT-001), orphan 1 项 (AP-XXX)
- ⚠️ [M6_ORPHAN_REFERENCE] AP-XXX 不存在或已归档，已从 UPDATE 列表移除
- Stage 2 UPDATE: 3 rows affected
- 新 confidence: AP-001=0.87, AP-005=0.87, PAT-001=0.87
```

## 7. check17 联动

`contracts/health_check.sql` 中 `FACT_ID_REFERENCED_INTACT` 行检查 16 条迁移 bootstrap facts（AP-001..AP-014 + PAT-001/002）的**存在性**（不过滤 archived，防意外删除）。映射到 check17 的 `warnings.push('[FACT_ID_ORPHAN] actual=N')`，**不阻断交付**。

> 例外说明（v2.6.1）：AP-014 经 v2.6 人工审批 MANUAL_PROMOTED 后 `archived=1`（合法归档，已由
> `component-driven-fixes` skill 固化覆盖），不影响本检查（计数仍 =16）。若未来再有审批归档，
> 期望计数需同步下调并在此备注。

该检查为被动防御（防误删），主动防御由 Stage 1 完成。

v2.6 起 helpful_rate 反馈有对应 soft-warn 检查：`contracts/health_check.sql` §15 `FEEDBACK_LOOP_IDLE`
（dispatch_log ≥5 但全库反馈事件 = 0 → Stage 3 从未激活，映射 check17 warnings[]，不阻断交付）。

## 8. 相关文件

- `policy/query_strategy.md` §4 hit_count 自增回路 — M6 主流程
- `policy/query_strategy.md` §M6 helpful_rate 反馈流程 — v2.4 / #13 Stage 3
- `policy/query_strategy.md` §M-001 动态注入 — v2.4 2AP+1PAT 规范
- `agent/coderAgent.md` §记忆节点日志 — M6 输出格式
- `contracts/health_check.sql` `FACT_ID_REFERENCED_INTACT` — 被动防御
- `api/migrate_skill_to_fact_store.sql` — bootstrap 16 条 fact 的来源
- `api/migrate_helpful_columns.sql` — v2.4 列迁移