# Failure Recorder 策略

> **模块位置**：`.kilo/memory/policy/failure_recorder.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义 failure_db 的写入条件与模板

## 写入条件

满足任一：
- fixer 连续 2 轮同症状
- Circuit Breaker 触发
- 用户反馈"还是有问题/不对/遗漏"

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

## 相关策略

- `dispatch_recorder.md` — dispatch_log 写入（failure_db 的 dispatch_id 来源）
- `model_calibration.md` — failure_db 数据喂给模型校准
- `../../instructions/reflection.md` — 三层判定 + 强制跨会话根因回溯