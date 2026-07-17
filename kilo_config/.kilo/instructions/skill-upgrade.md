# Skill 自动升级规则

> 目标：当全局记忆积累到一定阈值，自动将高频、高置信度的 Pattern 固化为 Skill。
> 对应 brain-architecture L7: 提炼 → 应用 → Strategy Proposal

## 升级触发条件

### 条件 A：AntiPattern → Skill（强制规则）

```sql
SELECT trigger, action, confidence, hit_count FROM fact_store
WHERE category = 'ANTIPATTERN' AND confidence >= 0.8 AND hit_count >= 3 AND archived = 0;
```

满足条件 → 生成 Skill 升级提案。

### 条件 B：Pattern → Skill（可选优化）

```sql
SELECT trigger, action, confidence, hit_count FROM fact_store
WHERE category = 'PATTERN' AND confidence >= 0.85 AND hit_count >= 5 AND archived = 0;
```

满足条件 → 生成 Skill 优化提案。

### 条件 C：Failure 复发预警 → Skill（紧急修复）

```sql
SELECT symptom, fix_strategy, same_symptom_count FROM failure_db
WHERE same_symptom_count >= 3 AND verified = 1;
```

满足条件 → 生成紧急修复 Skill 或更新现有 Skill。

## 升级流程

```
查询 sqlite 触发条件
  → 生成 Strategy Proposal（变更摘要）
  → Regression Test（验证 Skill 是否覆盖原有场景）
  → 更新/新建 .kilo/skills/{skill-name}/SKILL.md
  → 标记 fact_store.archived = 1（已固化）
  → 记录 skill_upgrade_log
```

## Skill 文件生成规则

### 文件位置

- 项目级 Skill：`.kilo/skills/{skill-name}/SKILL.md`
- 全局 Skill（跨项目复用）：`~/.config/kilo/skills/{skill-name}/SKILL.md`

### 文件模板

```markdown
---
name: {skill-name}
description: {从 trigger 和 action 自动生成}
keywords: {从 tags 提取}
evolved_from: {fact_id}
confidence: {fact_store.confidence}
hit_count: {fact_store.hit_count}
---

# {skill-name}

> 来源：自动从 fact_store 提取（fact_id: {fact_id}）
> 触发条件：{trigger}
> 置信度：{confidence} | 命中次数：{hit_count}

## 规则

{action}

## 验证方式

{从 related dispatch 的验收标准中提取}

## 历史

- {日期}: 首次提取（dispatch: {dispatch_id}）
- {日期}: 置信度上调至 {confidence}
```

## 回归测试（Regression Test）

Skill 升级前必须验证：

1. **覆盖验证**：新 Skill 是否覆盖了触发该 Pattern 的所有历史场景
2. **不降级验证**：应用新 Skill 后，相关任务的预期成功率是否不低于基线
3. **无冲突验证**：新 Skill 与现有 Skill 之间无矛盾

### 回归测试查询

```sql
-- 查找相关历史 dispatch
SELECT dispatch_id, status, findings_count FROM dispatch_log
WHERE task_summary LIKE '%关键词%' 
ORDER BY created_at DESC LIMIT 5;

-- 验证成功率是否提升
SELECT AVG(CASE WHEN status = 'DONE' THEN 1.0 ELSE 0.0 END) as success_rate
FROM dispatch_log
WHERE task_summary LIKE '%关键词%' AND created_at >= date('now', '-30 days');
```

## 升级后标记

Skill 固化后，必须更新 fact_store：

```sql
UPDATE fact_store SET archived = 1, updated_at = datetime('now')
WHERE fact_id = ?;
```

避免同一 Pattern 重复生成 Skill。

## 技能目录管理

### 项目级 vs 全局级

| 级别 | 路径 | 适用场景 | 复用范围 |
|------|------|----------|----------|
| 全局 | `~/.config/kilo/skills/` | 跨项目通用（如 React 状态管理、API 设计） | 所有项目 |
| 项目 | `.kilo/skills/` | 项目专属（如特定业务规则、内部框架） | 当前项目 |

### 加载优先级

1. 项目级 Skill 优先于全局 Skill（同名时覆盖）
2. 全局 Skill 作为基线，项目级 Skill 作为增量

## 自动化程度

| 阶段 | 自动化动作 | 需人工确认 |
|------|-----------|-----------|
| V1（当前） | 检测触发条件 → 生成 Proposal → 写入草稿 | 是（Proposal 需人工审批后应用） |
| V2（未来） | 检测触发条件 → 自动应用 → 标记归档 | 否（成功率连续 3 次不降级后自动） |

> **当前阶段为 V1**：所有 Skill 升级必须经过人工确认。自动生成的 Skill 草稿标记为 `[AUTO_DRAFT]`，人工审批后移除标记。
