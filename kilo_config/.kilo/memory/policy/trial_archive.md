# Trial Archive SOP（v2.3 / #2 — 14 天 trial 过期归档）

> **模块位置**：`.kilo/memory/policy/trial_archive.md`
> **职责**：定义 trial 期 fact_store 行的生命周期终结规则
> **执行脚本**：`.kilo/memory/api/trial_archive.sql`

## 1. 背景

v2.2 引入试用期机制（trial = `confidence >= 0.5 AND hit_count < 2 AND created_at <= 14 天内`，每任务 ≤2 条）解决「未注入→无引用→hit 不增→永不注入」的冷启动死锁。但 trial 期满后没有任何归档路径：

- **当前状态**：14 天窗口后 trial 行自然失去注入资格（既不满足正式门槛也不在试用窗口内），但 `archived=0` 永久保留
- **问题**：
  1. `fact_store` 表被低质噪音持续累积，无法在 `WHERE confidence >= 0.7 AND hit_count >= 2` 之外被查询（但也不会被清理）
  2. trial 行若被 M6 自增回路无意义地 hit（人工手动引用），会无意义地涨 confidence
  3. check17 健康度无法反映真实有效 fact 数

## 2. 归档规则

### Trial 行定义（v2.3）

```
trial = fact_store
  WHERE archived = 0
    AND confidence >= 0.5
    AND confidence < 0.7      -- < 0.7 = 未升入正式门槛（正式 = confidence ≥ 0.7）
    AND hit_count < 2         -- 未达到正式门槛的 hit 数（正式 = hit_count ≥ 2）
    AND created_at < datetime('now', '-14 days')
```

满足上述 4 条件即视为「trial 过期未升入正式」。

### 归档动作

```sql
UPDATE fact_store
SET archived = 1,
    evidence = json_insert(
        COALESCE(evidence, '[]'),
        '$[#]',
        'archived-trial-expiry-' || strftime('%Y%m%d', 'now')
    ),
    updated_at = datetime('now')
WHERE <trial 条件>;
```

### 不可逆性

归档后的 trial 行**永不复活**，即使后续 hit_count 上升。理由：

- 14 天窗口已过，trial 机制的核心价值（冷启动破局）已失效
- evidence 字段保留 `archived-trial-expiry-YYYYMMDD` 痕迹，可审计
- 复活需要新增 fact_id，避免误用历史低质 trial 数据

## 3. 触发时机

### 推荐路径 1：周期 cron（首选）

```bash
# 每周日凌晨 03:00 跑一次
0 3 * * 0 sqlite3 "${HOME}/.config/kilo-data/memory.db" < \
  /path/to/.kilo/memory/api/trial_archive.sql >> /var/log/kilo-trial-archive.log 2>&1
```

### 推荐路径 2：启动钩子

Kilo 启动时调用 `api/trial_archive.sql`；建议加 24h 节流（同 1 天内不重复执行），防止频繁启动消耗 IO。

### 推荐路径 3：M7 dispatch 收尾 advisory

`policy/dispatch_recorder.md` §5 推荐在 M7 INSERT 完成后调用 trial_archive SQL，**advisory（不阻塞）**。理由：每次任务收尾顺手清理，trial 行积累量始终很小。

## 4. check17 健康度

`contracts/health_check.sql` 中 `TRIAL_EXPIRED_PENDING` 行扫描未归档的过期 trial 行数。映射到 check17 的 `warnings.push('[TRIAL_EXPIRED_PENDING] expired=N')`，**不阻断交付**（soft-warn）。

## 5. 与注入门槛的关系

v2.2 注入门槛（`policy/query_strategy.md` §注入门槛）试用期满后规则变化：

- v2.2 描述：「14 天窗口后回归正式门槛」
- v2.3 描述：「14 天窗口后由 `policy/trial_archive.md` SOP 自动归档（archived=1）」

实质行为不变（trial 行 14 天后均不可注入），但 v2.3 显式标记 lifecycle 终结，而非悄悄沉默。

## 6. 验证

```bash
# 1. 模拟过期 trial 行
sqlite3 memory.db "INSERT INTO fact_store (fact_id, category, trigger, action, confidence, hit_count, created_at, updated_at, archived) VALUES ('TEST-TRIAL-EXPIRED', 'ANTIPATTERN', 'test', 'test', 0.5, 1, '2026-07-01', '2026-07-01', 0);"

# 2. 跑归档脚本
sqlite3 memory.db < .kilo/memory/api/trial_archive.sql

# 3. 验证该行已 archived=1
sqlite3 memory.db "SELECT fact_id, archived, evidence FROM fact_store WHERE fact_id='TEST-TRIAL-EXPIRED';"
-- 期望：archived=1, evidence 含 'archived-trial-expiry-20260719'

# 4. check17 应 PASS（warnings 数组不再含 TRIAL_EXPIRED_PENDING）
node validate-config.mjs
```

## 7. 禁止事项

- 禁止手动 UPDATE trial 行的 archived=0 复活
- 禁止修改 evidence 中的 `archived-trial-expiry-*` 痕迹字段
- 禁止在 trial 期未满前归档（必须严格 14 天）

## 8. 相关文件

- `api/trial_archive.sql` — 归档 SQL 脚本（事务 + UPDATE + 输出归档数）
- `contracts/health_check.sql` `TRIAL_EXPIRED_PENDING` — 健康度校验
- `policy/query_strategy.md` §注入门槛 — 试用期满后的状态描述
- `policy/dispatch_recorder.md` §5 — advisory 触发位置