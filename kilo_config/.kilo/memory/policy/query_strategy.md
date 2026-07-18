# Query Strategy 策略

> **模块位置**：`.kilo/memory/policy/query_strategy.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义任务开始与失败回溯时的 sqlite 查询规则、注入格式、hit_count 自增回路

## Token Budget

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）

## 注入门槛（v2.2）

| 数据源 | 注入门槛 | 原因 |
|---|---|---|
| `project_context` | priority ≤ 5 | 高优先级架构决策优先 |
| `fact_store`（正式） | `confidence >= 0.7 AND hit_count >= 2 AND archived = 0` | 过滤低质噪音 |
| `fact_store`（试用期，v2.2） | `confidence >= 0.5 AND hit_count < 2 AND archived = 0 AND created_at >= datetime('now', '-14 days')`，每任务 ≤2 条，注入标记附加 `trial=1` | 新经验试用窗口：打破「未注入→无引用→hit 不增→永不注入」冷启动死锁 |
| `failure_db` | `same_symptom_count >= 1 AND resolved_at IS NOT NULL` | 已解决的失败才注入；未解决的不污染上下文 |
| `model_calibration` | `sample_count >= 3` | 样本不足的校准数据无统计意义 |

> **试用期机制（v2.2）**：新写入经验 14 天内为试用期。试用期条目命中任务关键词即可注入（上限 2 条），在 M6 自增后与正式条目同权竞争；14 天窗口后回归正式门槛。
>
> **M6 自增数据源扩展（v2.2）**：除 `[memory:fact_id=...]` 注入标记外，coderAgent 收尾时必须显式声明「本次实际参考但未注入的 fact_id」（来源：M4 去重查询命中、失败回溯命中、人工指定），对这些 fact_id 同样执行 hit_count+1 / confidence+0.02，确保经验价值随**真实使用**增长而非仅随注入增长。
>
> ~~早期项目 fallback（v2.0，已废弃）~~：原「仓库 commit < 10 放宽门槛」条款对「仓库成熟但数据稀疏」场景无效，由试用期机制替代。

---

## 1. 任务开始时（Context 构建阶段）

coderAgent 必须按以下顺序查询（每条 SELECT **必须带 ID 字段**用于回溯）：

```sql
-- A. 项目上下文（最高优先级，≤5 条，带 ID）
SELECT context_id, title, content, priority, tags FROM project_context
WHERE category IN ('ARCHITECTURE', 'CONSTRAINT') AND priority <= 5
ORDER BY priority ASC, updated_at DESC
LIMIT 5;

-- B. 相关经验教训（按 tag 匹配 + 置信度门槛，带 ID + tags + evidence）
SELECT fact_id, category, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store
WHERE tags LIKE '%,%当前任务关键词%,%'  -- 逗号分隔精确匹配（前导 % 为全表扫描，数据量小时可接受）
   OR trigger LIKE '%当前任务关键词%'    -- 兜底：trigger 字段模糊匹配
   OR action LIKE '%当前任务关键词%'     -- 兜底：action 字段模糊匹配
  AND archived = 0
  AND confidence >= 0.7
  AND hit_count >= 2
ORDER BY confidence DESC, hit_count DESC
LIMIT 5;

-- B2. 试用期新经验（v2.2 冷启动窗口，≤2 条，注入标记附加 trial=1）
SELECT fact_id, category, trigger, condition, action, confidence, hit_count, tags, evidence
FROM fact_store
WHERE archived = 0
  AND confidence >= 0.5
  AND hit_count < 2
  AND created_at >= datetime('now', '-14 days')
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%' OR action LIKE '%当前任务关键词%')
ORDER BY created_at DESC
LIMIT 2;

-- C. 历史失败模式（按 tag 匹配 + 门槛，带 ID + same_symptom_count）
SELECT failure_id, symptom, root_cause_level, fix_strategy, fix_location, same_symptom_count, tags
FROM failure_db
WHERE (tags LIKE '%,%当前任务关键词%,%' OR symptom LIKE '%当前任务关键词%')
  AND resolved_at IS NOT NULL
  AND same_symptom_count >= 1
ORDER BY same_symptom_count DESC
LIMIT 3;

-- D. 模型校准建议（当前 agent + 任务类型 + 样本门槛）
SELECT calibration_id, compensation_prompt, success_rate, sample_count
FROM model_calibration
WHERE agent_role = '当前agent角色'
  AND task_type LIKE '%当前任务类型%'
  AND sample_count >= 3
ORDER BY sample_count DESC
LIMIT 1;
```

**查询后必须**：将 sqlite 返回结果按下方「标准注入格式」渲染后注入当前上下文。

---

## 2. 标准注入格式（P1-1 强制）

所有 sqlite 检索结果必须按以下 markdown 模板渲染，**禁止自由格式**：

### fact_store 行

```markdown
[memory:fact_id={fact_id} category={category} confidence={confidence} hit_count={hit_count} tags=[{tags}]]
- **触发场景**: {trigger}
- **触发条件**: {condition | "无"}
- **推荐做法**: {action}
- **证据**: {evidence}（JSON 数组，含 dispatch_id）
```

### failure_db 行

```markdown
[memory:failure_id={failure_id} root_cause={root_cause_level} recurrence={same_symptom_count} tags=[{tags}]]
- **症状**: {symptom}
- **修复策略**: {fix_strategy}
- **修复位置**: {fix_location | "未记录"}
```

### project_context 行

```markdown
[memory:context_id={context_id} category={category} priority={priority}]
- **{title}**: {content}
- **来源**: {source_file | "未记录"}
```

### model_calibration 行

```markdown
[memory:calibration_id={calibration_id} model={model} success_rate={success_rate} samples={sample_count}]
- **补偿 prompt**: {compensation_prompt | "无"}
```

### 注入示例

```markdown
[memory:fact_id=M-001 category=ANTIPATTERN confidence=0.85 hit_count=5 tags=[react,api,error-handling]]
- **触发场景**: BFF 层缺错误边界
- **触发条件**: 调用外部 API 时未捕获 reject
- **推荐做法**: 用 Result<T, E> 替代 throw；统一在 BFF 层 try/catch 转 HTTP 5xx
- **证据**: ["disp-thread-20260718-001", "disp-thread-20260715-003"]

[memory:failure_id=F-003 root_cause=执行层 recurrence=2 tags=[encoding,bom]]
- **症状**: kilo.json JSON.parse 失败
- **修复策略**: 检测并剥离 UTF-8 BOM (0xEF 0xBB 0xBF)
- **修复位置**: scripts/scan-encoding.mjs:14
```

**模型使用规则**：
- 引用经验时**必须保留 `[memory:xxx_id=...]` 标记**在回答中（让 reviewer 可审计）
- 同 dispatch 多次使用同一条 fact → 仅在第一次保留标记（避免冗余）

---

## 3. 失败/回溯时（reflection.md 强制触发）

当命中以下条件时，**必须**查询 sqlite 而非仅依赖 `kilo_local_recall`：

```sql
-- 查找同类失败（带 ID + 位置）
SELECT failure_id, symptom, fix_strategy, fix_location, same_symptom_count, tags
FROM failure_db
WHERE (symptom LIKE '%当前错误关键词%' OR tags LIKE '%,%当前错误关键词%,%')
  AND verified = 1
ORDER BY same_symptom_count DESC, created_at DESC
LIMIT 3;

-- 查找相关反模式（带 ID）
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category = 'ANTIPATTERN'
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%')
  AND archived = 0
ORDER BY confidence DESC, hit_count DESC
LIMIT 3;
```

---

## 4. hit_count 自增回路（P1-3 强制）

**目的**：解决「经验被反复使用但 hit_count 永远=1」的回路断裂问题。

**触发**：每次 T1+ 任务收尾时，coderAgent 必须：

1. 回顾本次任务中**实际引用过的 fact_id 列表**，来源有两个（v2.2 扩展）：
   - **注入引用**：agent 输出中的 `[memory:fact_id=...]` 标记（含 `trial=1` 试用期条目）
   - **显式声明**：coderAgent 收尾时声明「本次实际参考但未注入的 fact_id」（来源：M4 去重查询命中、失败回溯命中、人工指定），**必须使用结构化标记**（reviewer 可机械审计）：

     ```markdown
     [memory:referenced_fact_ids=AP-001,AP-005 not_injected=true]
     ```

     该标记与注入标记同级出现在 M6 节点日志「引用列表」列，与注入引用同等触发 hit_count 自增。
2. 对每个 fact_id 执行 hit_count 自增：

```sql
UPDATE fact_store
SET hit_count = hit_count + 1,
    -- 累积提升 confidence（每次使用 +0.02，封顶 0.95）
    confidence = MIN(0.95, confidence + 0.02),
    updated_at = datetime('now')
WHERE fact_id IN (?, ?, ?, ...);  -- 本次用到的 fact_id 列表
```

3. 对每个 failure_id 也执行复发计数（如果本次失败与历史同类）：

```sql
UPDATE failure_db
SET same_symptom_count = same_symptom_count + 1,
    resolved_at = COALESCE(resolved_at, datetime('now'))
WHERE failure_id = ?;  -- 本次命中的失败记录
```

**列入收尾自检**：详见 `.kilo/instructions/workflow-core.md` §收尾自检 checklist。

---

## 5. 任务结束时（经验沉淀）

详见 `dispatch_recorder.md` / `fact_dedup.md` / `failure_recorder.md` / `model_calibration.md`。

---

## md 文件保留范围（仅以下场景）

| 内容 | 存储位置 | 原因 |
|------|----------|------|
| 用户偏好 | USER.md | 用户直接编辑，不需要结构化查询 |
| 安全约束 | USER.md | 静态规则，不需要版本追踪 |
| 归档索引 | MEMORY.md | 指向 sqlite fact_id 的索引（不直接存储经验） |
| 通用约定 | MEMORY.md | 低频变更，md 可读性更好 |

> **MEMORY.md vs fact_store 边界**：MEMORY.md 不再存储经验条目，仅存储**指向 fact_id 的索引**（如 `[已归档] 详见 fact_store[M-001]`）。所有可复用的模式/反模式必须进入 fact_store。

---

## 相关策略

- `dispatch_recorder.md` — 任务结束写入
- `fact_dedup.md` — fact_store 去重写入
- `failure_recorder.md` — failure_db 写入
- `model_calibration.md` — 模型校准更新
- `../../instructions/workflow-core.md` §收尾自检 — hit_count 自增回路的硬门入口

---

## 节点定义 M1-M8（记忆节点日志）

> **目的**：让记忆操作可视化，与任务 8 节点流程日志对齐输出。完整 markdown 模板见 `../../../agent/coderAgent.md` §记忆节点日志。

| 节点 | 触发时机 | 操作类型 | 必填输出 |
|---|---|---|---|
| **M1** 任务上下文注入 | 任务开始 | 🔍 SELECT 4 表 | 注入条数（fact_store=N / failure_db=M / model_calibration=K）+ token 用量 |
| **M2** 失败回溯 | `core.md` §自进化触发点 4 条件命中 | 🔍 SELECT failure_db + fact_store | 命中的 failure_id / fact_id 列表 |
| **M3** 经验引用 | 任务执行中 | agent 输出嵌入 `[memory:fact_id=X]` 标记 | 引用列表（喂给 M6） |
| **M4** fact_store 去重 | 发现可复用模式 | 🔍 去重 + 📝 INSERT / 🔄 UPDATE | fact_id + action（INSERT/UPDATE） |
| **M5** failure_db 写入 | 失败 / fixer 多轮 / 用户反馈 | 📝 INSERT failure_db | failure_id + root_cause_level |
| **M6** hit_count 自增 | 任务收尾 | 🔄 UPDATE fact_store hit_count+1, confidence+0.02 | 自增的 fact_id 列表 + 新 confidence |
| **M7** dispatch_log 写入 | 任务收尾（T1+） | 📝 INSERT dispatch_log | dispatch_id + tier + review_mode |
| **M8** model_calibration 更新 | dispatch 后 | 🔄 UPDATE model_calibration | model + agent_role + success_rate 变化 |

### 节点触发顺序

```
任务开始
  ↓ M1: 注入
  ↓ 执行单元
  ↓ 失败条件命中？→ 是 → M2: 回溯查询
  ↓ 发现可复用模式？→ 是 → M4: 去重写入
  ↓ 任务失败 / fixer 多轮？→ 是 → M5: 写入 failure_db
  ↓ 任务收尾
     ├─ M6: hit_count 自增（从 M3 收集引用列表）
     ├─ M7: dispatch_log 写入
     └─ M8: model_calibration 更新
```

### 状态图标

| 图标 | 含义 |
|---|---|
| 🔍 | query（SELECT） |
| 📝 | write（INSERT） |
| 🔄 | update（UPDATE） |
| ✅ | success |
| ⚠️ | partial（部分命中 / 部分门槛未达） |
| ❌ | failure（SQL 错误 / 必填缺失） |
| ⏭️ | skipped（memory.db 未初始化 / T0 跳过） |

### 输出格式示例

完整 markdown 模板 + 典型 T1 任务输出示例见 `../../../agent/coderAgent.md` §记忆节点日志（本文件不重复维护）。