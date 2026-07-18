# Memory Strategy（默认：sqlite 优先 + md 兜底）

> 本文件定义 `.kilo/memory/` 目录下记忆系统的注入策略。
> **可插拔**：在 `AGENTS.md` 第8条中通过 `strategy: "memory-strategy.md"` 引用；更换文件名即可切换策略。
> 不引用本文件时，记忆系统不生效（等效全量关闭）。

## 策略标识

- **名称**：`sqlite-first-md-fallback`
- **版本**：`2.0`
- **适用文件**：`MEMORY.md`、`USER.md`（md 兜底）
- **适用数据库**：`${HOME}/.config/kilo-data/memory.db`（sqlite 优先；数据目录独立于配置目录，install 同步不会清除）

## 核心原则

1. **sqlite 优先**：所有结构化记忆（fact、failure、dispatch、project_context、calibration）优先查询 sqlite。
2. **md 兜底**：用户偏好、安全约束、通用约定等低频变更内容保留在 MEMORY.md / USER.md。
3. **写入即持久**：任务过程中产生的经验、失败模式必须写入 sqlite，不能留在 prompt 里丢失。

## 查询规则

### 1. 任务开始时（Context 构建阶段）

coderAgent 必须按以下顺序查询：

```sql
-- A. 项目上下文（最高优先级，≤5 条）
SELECT title, content, priority FROM project_context
WHERE category IN ('ARCHITECTURE', 'CONSTRAINT')
ORDER BY priority ASC, updated_at DESC
LIMIT 5;

-- B. 相关经验教训（按 tag 匹配）
SELECT trigger, condition, action, confidence FROM fact_store
WHERE tags LIKE '%当前任务关键词%' AND archived = 0
ORDER BY confidence DESC, hit_count DESC
LIMIT 5;

-- C. 历史失败模式（按 tag 匹配）
SELECT symptom, root_cause_level, fix_strategy FROM failure_db
WHERE tags LIKE '%当前任务关键词%' AND resolved_at IS NOT NULL
ORDER BY same_symptom_count DESC
LIMIT 3;

-- D. 模型校准建议（当前 agent + 任务类型）
SELECT compensation_prompt, success_rate FROM model_calibration
WHERE agent_role = '当前agent角色' AND task_type LIKE '%当前任务类型%'
ORDER BY sample_count DESC
LIMIT 1;
```

**查询后必须**：将 sqlite 返回结果格式化为文本，注入当前上下文。

### 2. 失败/回溯时（reflection.md 强制触发）

当命中以下条件时，**必须**查询 sqlite 而非仅依赖 `kilo_local_recall`：

```sql
-- 查找同类失败
SELECT symptom, fix_strategy, fix_location FROM failure_db
WHERE symptom LIKE '%当前错误关键词%' AND verified = 1
ORDER BY created_at DESC
LIMIT 3;

-- 查找相关反模式
SELECT trigger, action FROM fact_store
WHERE category = 'ANTIPATTERN' AND tags LIKE '%当前任务关键词%'
ORDER BY confidence DESC
LIMIT 3;
```

### 3. 任务结束时（经验沉淀阶段）

T1+ 任务完成后，coderAgent 必须执行写入：

```sql
-- 记录 dispatch 日志（两阶段定级 + review_mode）
INSERT INTO dispatch_log (
    dispatch_id, thread_id, agent, task_summary,
    initial_tier, final_tier, tier, review_mode, tier_deviation,
    model, status, error_code, duration_ms,
    input_tokens, output_tokens, files_changed, findings_count,
    created_at
)
VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,    -- initial_tier / final_tier / tier(=final_tier) / review_mode / tier_deviation
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?
);

-- 事后分析：tier 偏差分布（喂给 model_calibration）
SELECT
    initial_tier,
    final_tier,
    tier_deviation,
    COUNT(*) as cnt,
    AVG(duration_ms) as avg_duration
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY initial_tier, final_tier, tier_deviation
ORDER BY cnt DESC;

-- 事后分析：review_mode 命中分布（验证 lightweight 升级触发器是否合理）
SELECT
    final_tier,
    review_mode,
    COUNT(*) as cnt,
    AVG(findings_count) as avg_findings
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY final_tier, review_mode
ORDER BY cnt DESC;

-- 若 checker/reviewer 发现有效模式，写入 fact_store
INSERT INTO fact_store (fact_id, category, trigger, condition, action, confidence, evidence, tags, created_at, updated_at)
VALUES (...);

-- 若任务失败或 fixer 多轮，写入 failure_db
INSERT INTO failure_db (failure_id, dispatch_id, root_cause_level, symptom, fix_strategy, fix_location, verified, tags, created_at)
VALUES (...);
```

**写入规则**：
- fact_store.confidence 初始值为 0.5，经 3 次验证后上调至 0.8
- failure_db.verified 必须在 fixer 修复且 checker 重新验证通过后设为 1
- 同一 symptom 再次出现 → UPDATE same_symptom_count + 1

## md 文件保留范围（仅以下场景）

| 内容 | 存储位置 | 原因 |
|------|----------|------|
| 用户偏好 | USER.md | 用户直接编辑，不需要结构化查询 |
| 安全约束 | USER.md | 静态规则，不需要版本追踪 |
| 归档索引 | MEMORY.md | 指向 sqlite 或 archive/ 的索引 |
| 通用约定 | MEMORY.md | 低频变更，md 可读性更好 |

## Token Budget 调整

- sqlite 查询结果注入总量 **≤ 2000 tokens**（约 8000 字符）
- 超出时按优先级截断：project_context > fact_store > failure_db > model_calibration
- md 文件注入仍保持 **≤ 1500 tokens**（作为兜底）

## 初始化检查

首次启动或 `${HOME}/.config/kilo-data/memory.db` 不存在时：

### 1. 确保数据目录存在

```bash
# Linux / macOS
mkdir -p "${HOME}/.config/kilo-data"

# Windows (PowerShell)
New-Item -ItemType Directory -Path "${env:USERPROFILE}\.config\kilo-data" -Force
```

> `mcp-sqlite` 不会自动创建不存在的父目录。目录缺失是导致 MCP 启动超时最常见的原因。

### 2. 建表

通过 sqlite MCP 执行仓库中的初始化脚本：

```sql
-- 方式 A：让 sqlite MCP 读取并执行仓库中的 init.sql
.read ${KILO_CONFIG_DIR}/.kilo/memory/init.sql
```

或在命令行直接用 `sqlite3`：

```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" < ".kilo/memory/init.sql"
```

Windows 若无 `sqlite3` CLI，可通过 sqlite MCP 的交互式查询逐条执行 `init.sql` 中的 `CREATE TABLE` 语句。

### 3. 验证表存在

```sql
SELECT name FROM sqlite_master WHERE type='table';
```

应至少返回：`fact_store`、`failure_db`、`dispatch_log`、`project_context`、`model_calibration`。

### 4. 初始化 model_calibration 基线数据（可选）

首次部署后，可插入各 agent 的初始占位记录，便于后续动态校准计算成功率。示例：

```sql
INSERT INTO model_calibration (
    calibration_id, model, agent_role, task_type,
    success_rate, avg_findings, sample_count, last_evaluated_at
) VALUES (
    'cal-glm-reviewer-config', 'hx/glm-5.2', 'reviewer', 'config-review',
    1.0, 0, 1, datetime('now')
)
ON CONFLICT(calibration_id) DO NOTHING;
```

> 基线记录仅用于避免首次动态校准时 `sample_count = 0` 导致的除零或空值问题；真实成功率会随 `dispatch_log` 写入被覆盖。

## 版本升级说明

v1.0 → v2.0：
- 新增 sqlite 优先查询层
- md 文件退化为兜底和静态规则
- 引入 model_calibration 动态积累
- 写入规则从"建议"升级为"强制"
