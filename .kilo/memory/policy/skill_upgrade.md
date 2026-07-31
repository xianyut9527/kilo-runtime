# Skill Upgrade 策略

> **模块位置**：`.kilo/memory/policy/skill_upgrade.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：当全局记忆积累到一定阈值，自动将高频、高置信度的 Pattern 固化为 Skill

> 目标：对应 brain-architecture L7: 提炼 → 应用 → Strategy Proposal

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
- 全局 Skill（跨项目复用）：`~/.config/kilo/.kilo/skills/{skill-name}/SKILL.md`（与 install.ps1 实际安装路径一致）

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
| 全局 | `~/.config/kilo/.kilo/skills/` | 跨项目通用（如 React 状态管理、API 设计） | 所有项目 |
| 项目 | `.kilo/skills/` | 项目专属（如特定业务规则、内部框架） | 当前项目 |

### 加载优先级

1. 项目级 Skill 优先于全局 Skill（同名时覆盖）
2. 全局 Skill 作为基线，项目级 Skill 作为增量

## 自动化程度

| 阶段 | 自动化动作 | 需人工确认 |
|------|-----------|-----------|
| V1（当前默认） | 检测触发条件 → 生成 Proposal → 写入草稿 | 是（Proposal 需人工审批后应用） |
| V2（v2.3 新增，opt-in） | 检测触发条件 → 连续 3 次 DONE 自动 AUTO_PROMOTED → fact_store 归档 | 否（`KILO_SKILL_UPGRADE_V2=true` 启用；不达标仍退回 V1） |

> **V1 阶段（默认）**：所有 Skill 升级必须经过人工确认。自动生成的 Skill 草稿标记为 `[AUTO_DRAFT]`，人工审批后移除标记。
>
> **V2 阶段（opt-in）**：详见下方「V2 算法」章节。需要环境变量 `KILO_SKILL_UPGRADE_V2=true` 启用；不设置则行为完全等同 V1。

## 人工审批决策规则（v2.6 成文，what/how 边界）

条件 A/B/C 只负责「达到阈值」，审批必须额外执行**边界判定**（来源：`patterns/SKILL.md` §pattern vs skill 边界）：

| 判定 | 含义 | 审批结论 | fact_store 处置 |
|---|---|---|---|
| **how 类**（步骤 / 流程 / 模板 / 方法论） | 程序性知识，适合固化为 SKILL.md | `MANUAL_PROMOTED` → 按 §Skill 文件生成规则落盘 | `archived=1`，evidence 追加 `promoted-to-skill:<name>-<date>` |
| **what 类**（具体反模式 / 具体模式 / 环境陷阱） | 陈述性经验，skill 化会重造 v2.1 已废除的 md 双源 | `REJECTED`（附边界理由） | **保持 active**（archived=0），继续走 M1 注入 / M6 回路 |
| **已被现有 skill 覆盖** | 内容已由某 SKILL.md 完整承载 | `MANUAL_PROMOTED`（指向既有 skill，不新建文件） | `archived=1`，evidence 指向既有 skill 名 |

**v2.6 审批先例（2026-07-20，首批 4 条 DRAFT 终审）**：

| fact_id | 结论 | 理由 |
|---|---|---|
| AP-014（逐页补丁式修复） | `MANUAL_PROMOTED` → 既有 skill `component-driven-fixes` | 内容已被该 skill + AGENTS.md 锚点 11 硬门全覆盖，无需新建文件 |
| AP-001（Edit BOM 污染） | `REJECTED` | what 类环境陷阱，常驻 fact_store 走注入流 |
| AP-005（PS 5.1 GBK 编码） | `REJECTED` | what 类环境陷阱，同上 |
| PAT-001（关联功能检查清单） | `REJECTED` | what 类检查清单条目，同上 |

> REJECTED 不删除 fact、不影响其 confidence/hit_count 累积；`skill_upgrade_log` 行保留作审计。
> `api/migrate_skill_upgrade_log.sql` 的 DRAFT 回填以 `upgrade_id = fact_id + '-DRAFT'` 为主键幂等，
> 已终审（REJECTED/PROMOTED）的 fact 不会因重跑迁移脚本而重新生成 DRAFT。

## V2 算法（v2.3 / #3，opt-in）

### 触发条件

每个满足 `fact_store.confidence >= 0.8 AND hit_count >= 3 AND archived = 0` 的 fact_id，在 `skill_upgrade_log` 表创建 DRAFT 行（由 `api/migrate_skill_upgrade_log.sql` 一次性回填）。

> **v2.6.1 边界约束**：V2 自动晋升（AUTO_PROMOTED → archived=1）**不经过人工审批的 what/how 边界判定**。
> 启用 V2 前必须确认：候选 fact 均为 how 类（程序性知识）。what 类 fact（具体反模式 / 环境陷阱）即使
> 达到阈值也应常驻 fact_store（见 §人工审批决策规则）。建议做法：启用 V2 前先按 §人工审批决策规则
> 对全部 DRAFT 行做一轮人工终审（what 类置 REJECTED），REJECTED 行不参与 V2 计数与晋升。

### 计数器自增（每次 M7 dispatch 后）

```sql
-- status = DONE 时累加
UPDATE skill_upgrade_log
SET consecutive_successes = consecutive_successes + 1,
    last_success_at = datetime('now'),
    last_evaluated_dispatch_id = :dispatch_id
WHERE promotion_status = 'DRAFT'
  AND fact_id IN (SELECT fact_id FROM fact_store
                  WHERE confidence >= 0.8 AND hit_count >= 3 AND archived = 0);

-- status = FAILED / DONE_WITH_CONCERNS 时重置
UPDATE skill_upgrade_log
SET consecutive_successes = 0
WHERE promotion_status = 'DRAFT'
  AND fact_id IN (:affected_fact_ids);

-- 累加 ≥ 3 → AUTO_PROMOTED
UPDATE skill_upgrade_log
SET promotion_status = 'AUTO_PROMOTED',
    promoted_at = datetime('now')
WHERE promotion_status = 'DRAFT'
  AND consecutive_successes >= 3;

-- fact_store 对应行归档
UPDATE fact_store
SET archived = 1, updated_at = datetime('now')
WHERE fact_id IN (
  SELECT fact_id FROM skill_upgrade_log
  WHERE promotion_status = 'AUTO_PROMOTED' AND promoted_at = :just_promoted_at
);
```

完整 SQL 块见 `policy/dispatch_recorder.md` §v2.3 skill_upgrade V2 自增。

### 跨项目 scope 兼容性（v2.3 / #5）

`fact_store.scope = 'project'` 的 fact 不参与 V2 计数（V2 仅针对通用模式自动晋升；项目专属 fact 即使 confidence 高也不该全局晋升为 Skill）。

### 启用与回退

- **启用**：`KILO_SKILL_UPGRADE_V2=true` 环境变量；M7 dispatch 收尾后跑 V2 SQL 块
- **回退**：`KILO_SKILL_UPGRADE_V2=false`（默认）；行为等同 V1，`skill_upgrade_log` 表保留作审计但不晋升

### V2 升级后标记

Skill 固化后，必须更新 fact_store：

```sql
UPDATE fact_store SET archived = 1, updated_at = datetime('now')
WHERE fact_id = ?;
```

避免同一 Pattern 重复生成 Skill。

## 相关策略

- `fact_dedup.md` — fact_store 去重写入（升级检测的输入）
- `../../instructions/skills-lifecycle.md` — SKILL.md 分类与生命周期（指针文件）
- `policy/dispatch_recorder.md` §v2.3 skill_upgrade V2 自增 — M7 触发 SQL 块
- `api/migrate_skill_upgrade_log.sql` — DRAFT 行回填迁移脚本
- `policy/query_strategy.md` §4 — V2 self-increment 在 M6 hit_count 自增之后执行（顺序敏感）