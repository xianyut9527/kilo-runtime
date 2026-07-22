# Query Strategy 策略

> **模块位置**：`.kilo/memory/policy/query_strategy.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义任务开始与失败回溯时的 sqlite 查询规则、注入格式、hit_count 自增回路

## Token Budget

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）
- v2.4 起：FTS5 MATCH 替代 LIKE，单次 query 字符数预算更紧（命中更准，可适当放宽 LIMIT）
- v2.6 起：FTS5 分词器 trigram（中文 ≥3 字符子串可 MATCH）；**MATCH 查询词必须 ≥3 字符**，
  2 字中文关键词需扩展为 ≥3 字词组（如「编码」→「编码问题」）或退化 LIKE 查询

## 注入门槛（v2.4）

| 数据源 | 注入门槛 | 原因 |
|---|---|---|
| `project_context` | priority ≤ 5 + `scope='global' OR (scope='project' AND project_name=:current_project)`（v2.7 / #19 对齐 fact_store v2.3 / #5） | 高优先级架构决策优先；高频复用 context 自动浮顶；跨项目隔离避免 kilo_config 专属噪音污染业务项目 |
| `fact_store`（正式） | `confidence >= 0.7 AND hit_count >= 2 AND archived = 0 AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project)) AND (helpful_rate IS NULL OR helpful_rate >= 0.5)` | 过滤低质噪音 + 跨项目隔离（v2.3 / #5）+ v2.4 反馈质量门（#13） |
| `fact_store`（试用期，v2.2） | `confidence >= 0.5 AND hit_count < 2 AND archived = 0 AND created_at >= datetime('now', '-14 days') AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))`，每任务 ≤2 条，注入标记附加 `trial=1` | 新经验试用窗口：打破「未注入→无引用→hit 不增→永不注入」冷启动死锁 |
| `failure_db` | `same_symptom_count >= 1 AND resolved_at IS NOT NULL AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))` | 已解决的失败才注入；未解决的不污染上下文；v2.4 / #15 scope 隔离 |
| `model_calibration` | `sample_count >= 2 AND (compensation_prompt IS NULL OR compensation_prompt_consumed_count > 0 OR compensation_prompt_set_at >= datetime('now', '-30 days'))` | v2.6：注入样本门槛 3→2（样本稀疏期即可注入校准建议）；v2.3 / #8：补偿 prompt 30 天未消费不再注入；compensation prompt 生成门槛仍保持 `sample_count >= 5`（见 `policy/model_calibration.md`） |

> **FTS5 检索（v2.4 / #5）**：query B 由 `LIKE` 改为 `MATCH`（fact_fts 虚表），效率 +++。详见 §1 query B。
>
> **helpful_rate 门禁（v2.4 / #13）**：fact_store 注入门槛新增 `helpful_rate IS NULL OR helpful_rate >= 0.5`。低质 fact（多次反馈为 misleading）自动降权，避免反复注入误导。详见 §M6 helpful_rate 反馈流程。
>
> **跨项目 scope 隔离（v2.3 / #5；v2.7 扩展至 project_context）**：`:current_project` 由环境变量 `KILO_PROJECT_NAME` 解析；未设置时仅注入 `scope='global'` 行。v2.3 起 fact_store / failure_db 支持 scope；v2.7 起 project_context 同样支持（对齐隔离机制）。详见 `policy/fact_dedup.md` §scope 写入规则 + `policy/project_context_seed.md` §scope 写入决策。
>
> **M6 自增数据源扩展（v2.2）**：除 `[memory:fact_id=...]` 注入标记外，coderAgent 收尾时必须显式声明「本次实际参考但未注入的 fact_id」（来源：M4 去重查询命中、失败回溯命中、人工指定），对这些 fact_id 同样执行 hit_count+1 / confidence+0.02，确保经验价值随**真实使用**增长而非仅随注入增长。
>
> **M6 显式声明前置校验（v2.3 / #4）**：M6 UPDATE 前必须经 Stage 1 SELECT 校验（详见 `policy/m6_validation.md`），不存在或已 archived 的 fact_id 输出 `[M6_ORPHAN_REFERENCE]` 警告并从 UPDATE 列表移除。
>
> ~~早期项目 fallback（v2.0，已废弃）~~：原「仓库 commit < 10 放宽门槛」条款对「仓库成熟但数据稀疏」场景无效，由试用期机制替代。

---

## 1. 任务开始时（Context 构建阶段）

coderAgent 必须按以下顺序查询（每条 SELECT **必须带 ID 字段**用于回溯）：

```sql
-- A+A'. 项目上下文原子化注入（最高优先级，≤5 条，带 ID；v2.6.2 起 UPDATE...RETURNING 单 SQL）
-- 一条 SQL 同时完成：① 按门槛选中注入集 ② use_count+1 / last_used_at 更新（A' 硬门）③ RETURNING 返回注入内容
-- 物理上杜绝「只跑 SELECT 跳过 UPDATE」的系统性空转（v2.4–v2.6 根因：A/A' 两条独立 SQL，A' 被遗漏）
-- 前置：sqlite3 ≥ 3.35（UPDATE...RETURNING 支持；当前生产 3.45.3 实测通过）
-- v2.7：子查询加 scope 过滤（对齐 query B/C），避免 kilo_config 专属 PC 注入业务项目
--   :current_project 解析规则同 query B（KILO_PROJECT_NAME env；未设置则 project 分支不匹配，仅注入 global）
UPDATE project_context
SET use_count = use_count + 1,
    last_used_at = datetime('now')
WHERE context_id IN (
    SELECT context_id FROM project_context
    WHERE category IN ('ARCHITECTURE', 'CONSTRAINT') AND priority <= 5
      AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))
    ORDER BY priority ASC, use_count DESC, updated_at DESC
    LIMIT 5
)
RETURNING context_id, title, content, priority, tags, use_count, last_used_at, scope, project_name;

-- A' 硬门（v2.6.2 原子化）：RETURNING 返回的 use_count 新值即 A' 执行证据，
-- `[memory:recall]` 提示直接引用（如 `A' ✅ PC-001 use_count=3`；RETURNING 空结果时显式输出 `A' ⏭️ 无注入`）。
-- 健康度兜底：contracts/health_check.sql §16 CONTEXT_USE_COUNT_STALE（soft-warn）。

-- B. 相关经验教训（v2.4 / #5 FTS5 MATCH 替代 LIKE；v2.6 trigram 分词；scope 隔离 v2.3 / #5；helpful_rate 过滤 #13）
-- :query_keywords 构造规则（v2.6 trigram）：
--   1. 每个关键词 ≥3 字符（trigram 约束；2 字中文词扩展为 ≥3 字词组）
--   2. 多关键词用 OR 连接（如 'GBK OR "解析失败" OR yaml'）
--   3. 含空格/标点或中文词组用双引号包裹（如 '"默认编码"'）
SELECT f.fact_id, f.category, f.trigger, f.condition, f.action, f.confidence, f.hit_count, f.tags, f.evidence, f.helpful_rate,
       bm25(fact_fts) AS rank_score
FROM fact_fts
JOIN fact_store f ON f.rowid = fact_fts.rowid
WHERE fact_fts MATCH :query_keywords  -- FTS5 全文索引（MATCH 语法，trigram 分词）
  AND f.archived = 0
  AND f.confidence >= 0.7
  AND f.hit_count >= 2
  AND (f.scope = 'global' OR (f.scope = 'project' AND f.project_name = :current_project))
  AND (f.helpful_rate IS NULL OR f.helpful_rate >= 0.5)
ORDER BY rank_score
LIMIT 5;

-- B2. 试用期新经验（v2.2 冷启动窗口，≤2 条，注入标记附加 trial=1，scope 隔离 v2.3 / #5）
SELECT fact_id, category, trigger, condition, action, confidence, hit_count, tags, evidence, scope, project_name
FROM fact_store
WHERE archived = 0
  AND confidence >= 0.5
  AND hit_count < 2
  AND created_at >= datetime('now', '-14 days')
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%' OR action LIKE '%当前任务关键词%')
  AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))
ORDER BY created_at DESC
LIMIT 2;

-- C. 历史失败模式（v2.6.1 起 failure_fts MATCH；带 ID + same_symptom_count；scope 隔离 v2.4 / #15）
-- :failure_keywords 构造规则同 query B（trigram ≥3 字符；2 字词扩展或退化 LIKE）
SELECT f.failure_id, f.symptom, f.root_cause_level, f.fix_strategy, f.fix_location, f.same_symptom_count, f.tags,
       bm25(failure_fts) AS rank_score
FROM failure_fts
JOIN failure_db f ON f.rowid = failure_fts.rowid
WHERE failure_fts MATCH :failure_keywords
  AND f.resolved_at IS NOT NULL
  AND f.same_symptom_count >= 1
  AND (f.scope = 'global' OR (f.scope = 'project' AND f.project_name = :current_project))
ORDER BY rank_score
LIMIT 3;

-- D. 模型校准建议（当前 agent + 任务类型 + 样本门槛；v2.3 / #8 增加补偿 prompt 消费过滤）
SELECT calibration_id, compensation_prompt, compensation_prompt_set_at, compensation_prompt_consumed_count, success_rate, sample_count
FROM model_calibration
WHERE agent_role = '当前agent角色'
  AND task_type LIKE '%当前任务类型%'
  AND sample_count >= 2  -- v2.6：注入样本门槛 3→2
  AND (compensation_prompt IS NULL
       OR compensation_prompt_consumed_count > 0
       OR compensation_prompt_set_at >= datetime('now', '-30 days'))  -- 30 天未消费不再注入
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
[memory:context_id={context_id} category={category} priority={priority} scope={scope}]
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
-- 查找同类失败（v2.6.1 起 failure_fts MATCH；带 ID + 位置；verified=1 只回溯已验证修复）
SELECT f.failure_id, f.symptom, f.fix_strategy, f.fix_location, f.same_symptom_count, f.tags,
       bm25(failure_fts) AS rank_score
FROM failure_fts
JOIN failure_db f ON f.rowid = failure_fts.rowid
WHERE failure_fts MATCH :error_keywords  -- trigram ≥3 字符；2 字词扩展或退化 LIKE
  AND f.verified = 1
  AND (f.scope = 'global' OR (f.scope = 'project' AND f.project_name = :current_project))
ORDER BY rank_score
LIMIT 3;

-- 查找相关反模式（带 ID；保留 LIKE —— ANTIPATTERN 精确类别过滤 + trigram 由 query B 覆盖）
SELECT fact_id, trigger, action, confidence, hit_count, tags
FROM fact_store
WHERE category = 'ANTIPATTERN'
  AND (tags LIKE '%,%当前任务关键词%,%' OR trigger LIKE '%当前任务关键词%')
  AND archived = 0
  AND (scope = 'global' OR (scope = 'project' AND project_name = :current_project))
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

     该标记与注入标记同级出现在交付输出中（供 M6 收集），与注入引用同等触发 hit_count 自增。
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

## M-001 动态注入规范（v2.4 扩展：2AP + 1PAT）

> **变更历史**：v2.3 引入动态注入（M-001 取 top-2 ANTIPATTERN by hit_count）；v2.4 扩展为 **2 ANTIPATTERN + 1 PATTERN**（共 3 条），覆盖更全。

### 选择规则

```sql
-- top-2 ANTIPATTERN（强警告）
SELECT fact_id FROM fact_store
WHERE category = 'ANTIPATTERN' AND archived = 0 AND confidence >= 0.8
ORDER BY hit_count DESC, confidence DESC
LIMIT 2;

-- top-1 PATTERN（强推荐）
SELECT fact_id FROM fact_store
WHERE category = 'PATTERN' AND archived = 0 AND confidence >= 0.8
ORDER BY hit_count DESC, confidence DESC
LIMIT 1;
```

合并渲染：

```markdown
[memory:fact_id={ap1},{ap2},{pat1} mode=dynamic]
- 强警告（v2.4）: {ap1.trigger} → {ap1.action}; {ap2.trigger} → {ap2.action}
- 强推荐（v2.4）: {pat1.trigger} → {pat1.action}
```

### 边界 case

| 场景 | 行为 |
|---|---|
| ANTIPATTERN 候选 < 2 | 取所有可用的 + 1 PATTERN（共 1-2 条） |
| PATTERN 候选 = 0 | 仅注入 ANTIPATTERN（fallback 到 v2.3 行为） |
| fact_store 全空 | 注入静态描述（同 v2.3 fallback） |
| helpful_rate < 0.5 | 跳过（helpful_rate 门禁过滤） |

详见 [MEMORY.md](../MEMORY.md) `<DYNAMIC_INJECT>` 占位符替换。

---

## M6 helpful_rate 反馈流程（v2.4 / #13；**v2.6 起强制**）

> **背景**：v2.3 的 hit_count 自增回路只看"用了多少次"，不区分"用了有没有用"。v2.4 增加 helpful_rate 反馈维度。
> **v2.6 强制化**：v2.4/v2.5 期间全库反馈事件恒为 0，质量门形同虚设。v2.6 起 T1+ 任务 M6 必须输出反馈标记，
> 无反馈显式输出 `[memory:helpful=none]`。完整处理流程（含 id 校验 / 叠加规则 / 空标记）见
> `policy/m6_validation.md` §3 Stage 3；健康度兜底 `contracts/health_check.sql` §15 FEEDBACK_LOOP_IDLE。

### M6 反馈标记格式

```
[memory:helpful=A,B,C]      ← 本次 dispatch 中有价值的 fact
[memory:misleading=X,Y]     ← 本次 dispatch 中误导/不适用的 fact
[memory:helpful=none]       ← 无反馈时的显式空标记（v2.6 起强制兜底）
```

### M6 反馈处理流程

```sql
-- 1. 解析标记，UPDATE fact_store（v2.6 起 SQL 落地 confidence 综合校准公式）
UPDATE fact_store
SET helpful_count = helpful_count + 1,
    helpful_rate = CAST(helpful_count + 1 AS REAL) / (helpful_count + 1 + misleading_count),
    confidence = MIN(0.95, confidence + 0.02),
    updated_at = datetime('now')
WHERE fact_id IN (:helpful_fact_ids);

UPDATE fact_store
SET misleading_count = misleading_count + 1,
    helpful_rate = CAST(helpful_count AS REAL) / (helpful_count + misleading_count + 1),
    confidence = MAX(0.1, confidence - 0.05),
    updated_at = datetime('now')
WHERE fact_id IN (:misleading_fact_ids);

-- 2. 写入 dispatch_log（结构化反馈记录，随 M7 INSERT 一并写入）
UPDATE dispatch_log
SET helpful_fact_ids = :helpful_json,
    misleading_fact_ids = :misleading_json
WHERE dispatch_id = :dispatch_id;
```

### 与 hit_count 自增回路的关系

- v2.3 hit_count +1：每次 fact 引用都 +1
- v2.4 helpful_count / misleading_count：仅在 M6 显式反馈时 +1
- `confidence` 在 v2.4 起同时受 hit_count 和 helpful_rate 影响（详见下面公式）

### confidence 综合校准公式（v2.4）

```
new_confidence = MIN(0.95, confidence + 0.02 * helpful_factor - 0.05 * misleading_factor)
```

其中：
- `helpful_factor = 1.0` 当 fact 在本次 dispatch 的 helpful 列表中
- `misleading_factor = 1.0` 当 fact 在本次 dispatch 的 misleading 列表中
- 未收到反馈的 fact 仍按 v2.3 规则 `confidence + 0.02`（hit_count 路径）

### 低质 fact 自动降权（v2.4 / #13 注入门槛）

注入门槛新增 `helpful_rate IS NULL OR helpful_rate >= 0.5`：

- misleading 反馈 ≥ helpful 反馈 → helpful_rate < 0.5 → 自动从注入流降权
- 但 fact_store 不立即 archived=1（保留作审计），仅在 `skill_upgrade` V2 中按 helpful_rate 升序晋升

### 完整示例

详见 `policy/m6_validation.md` §3 + `agent/coderAgent.md` §M6 输出模板。

---

## 相关策略

- `dispatch_recorder.md` — 任务结束写入
- `fact_dedup.md` — fact_store 去重写入
- `failure_recorder.md` — failure_db 写入
- `model_calibration.md` — 模型校准更新
- `../../instructions/workflow-core.md` §收尾自检 — hit_count 自增回路的硬门入口

---

## 节点定义 M1-M8（执行标准）

> **定位**：M1-M8 是记忆操作的**执行标准**（何时查 / 写什么 / 硬门），不再要求输出大表格。
> **输出形式（hermes 风格轻提示）**：召回时一条 `🧠 [memory:recall]`、写入时一条 `💾 [memory:write]`，在操作发生的当下即时输出（含 ID，可审计）。完整提示格式见 `../../../agent/coderAgent.md` §记忆提示。

| 节点 | 触发时机 | 操作类型 | 必填输出 |
|---|---|---|---|
| **M1** 任务上下文注入 | 任务开始 | 🔍 SELECT 4 表 + 🔄 UPDATE use_count（A'，v2.6 硬门） | 注入条数（fact_store=N / failure_db=M / model_calibration=K / project_context=P）+ A' UPDATE 证据 + token 用量 |
| **M2** 失败回溯 | `core.md` §自进化触发点 4 条件命中 | 🔍 SELECT failure_db + fact_store | 命中的 failure_id / fact_id 列表 |
| **M3** 经验引用 | 任务执行中 | agent 输出嵌入 `[memory:fact_id=X]` 标记 | 引用列表（喂给 M6） |
| **M4** fact_store 去重 | 发现可复用模式 | 🔍 去重 + 📝 INSERT / 🔄 UPDATE | fact_id + action（INSERT/UPDATE） |
| **M5** failure_db 写入 | 失败 / fixer 多轮 / 用户反馈 | 📝 INSERT failure_db | failure_id + root_cause_level |
| **M6** hit_count 自增 + helpful_rate 反馈 | 任务收尾 | 🔄 UPDATE fact_store hit_count+1, confidence±（Stage 1/2/3） | 自增的 fact_id 列表 + 新 confidence + helpful/misleading 标记（v2.6 强制，无反馈显式 none） |
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

### 输出格式

即时轻提示格式（`[memory:recall]` / `[memory:write]`）+ 审计行内标记规范见 `../../../agent/coderAgent.md` §记忆提示（本文件不重复维护）。