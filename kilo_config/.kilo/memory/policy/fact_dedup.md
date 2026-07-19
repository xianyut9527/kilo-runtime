# Fact Dedup 策略

> **模块位置**：`.kilo/memory/policy/fact_dedup.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`
> **职责**：定义 fact_store 的去重查询与写入规则

## 核心原则（v2.0 起）

**SKILL.md 不再是经验沉淀的主入口**。新发现的 pattern / anti-pattern 必须先进入全局 sqlite `fact_store` 表（带 confidence / hit_count / tags），经 3 次命中且 confidence ≥ 0.8 后，才由 `skill_upgrade.md` 触发「`[AUTO_DRAFT]`」草稿；草稿经人工审批后才落盘为 SKILL.md。这是 V1 阶段的人工 gate，防止 LLM 自觉回写导致 skill 膨胀。

## 提取条件

### AntiPattern 提取条件（满足任一）

1. checker 发现重复问题：同一类问题（如"缺少边界检查"）在 2 次以上任务中出现
2. fixer 连续修复：fixer 轮数 ≥2
3. 用户反馈"还是有问题"：用户要求返工
4. reviewer 标记安全/架构风险：`risk = HIGH`

### Pattern 提取条件（满足全部）

1. 任务一次通过（checker findings_count = 0）
2. 策略可复用（非项目特定代码）
3. reviewer 三视角全部通过

## 提取模板

```sql
INSERT INTO fact_store (fact_id, category, trigger, condition, action, confidence, evidence, tags, hit_count, helpful_count, misleading_count, scope, project_name, created_at, updated_at)
VALUES (?, 'ANTIPATTERN', '触发场景', '触发条件', '推荐做法', 0.5, '["dispatch_id"]', '["tag1", "tag2"]', 1, 0, 0, COALESCE(?, 'global'), ?, datetime('now'), datetime('now'));
-- 参数 1-9 同 v2.2；参数 10-11 = helpful_count / misleading_count（v2.4 默认 0/0，未收到反馈）；参数 12 = scope（默认 'global'）；参数 13 = project_name（scope='global' 时 NULL；scope='project' 时为 KILO_PROJECT_NAME）
```

**v2.4 helpful_rate 初始化**：新 INSERT 行 `helpful_count = 0` / `misleading_count = 0`；`helpful_rate = NULL`（NULL 视为"暂无反馈"，满足 v2.4 注入门槛）。M6 Stage 3 收到反馈后自动 UPDATE（详见 `policy/m6_validation.md` §3）。

**confidence 初始值**：
- AntiPattern: 0.5（首次提取）
- Pattern: 0.6（首次提取）
- 经 3 次验证后上调至 0.8
- 经 5 次验证后上调至 0.9

## 去重规则（强制）

**插入前必须先查**：

```sql
SELECT fact_id, hit_count, confidence FROM fact_store
WHERE trigger = ? AND action = ? AND archived = 0;
```

### 三分支判定

| 查询结果 | 动作 |
|---|---|
| 命中（已有同 trigger+action 记录） | `UPDATE fact_store SET hit_count = hit_count + 1, confidence = ?, updated_at = datetime('now') WHERE fact_id = ?`，流程结束 |
| 命中且 hit_count ≥ 3 且 confidence < 0.8 | UPDATE confidence 至 0.8，触发 `skill_upgrade.md` 升级检测 |
| 未命中 | INSERT 新记录（见上节模板） |

## 写入流程（6 步）

1. **识别**：确定经验类型（pattern / anti-pattern），并准备 trigger / action / tags 三元组
2. **验证**：确认已通过 checker/reviewer 验证，且能在 SQL 上证明 ≥1 次复现
3. **去重查询**（**必须**，跳过将导致 SKILL 膨胀）
4. **分支处理**：命中 UPDATE / 未命中 INSERT
5. **Skill 升级检测**（异步触发，不在主流程内阻塞）：`skill_upgrade.md` 条件 A：`confidence >= 0.8 AND hit_count >= 3 AND archived = 0`
6. **链接**：在「相关条目」中建立交叉引用（仅对最终落盘的 SKILL.md 操作）

## 禁止事项

- 禁止直接 patch SKILL.md 承载新经验
- 禁止编造未验证的经验（必须有 dispatch_id 作为 evidence）
- 禁止重复写入相同 Pattern（先查后写）
- 禁止写入敏感信息（API Key、密码、内部域名）

## v2.3 跨项目 scope 写入规则（#5）

`scope` 字段决定 fact 的可见性范围：

| scope 取值 | project_name 取值 | 注入条件 | 典型场景 |
|---|---|---|---|
| `'global'`（默认） | NULL | 任意项目注入 | 跨项目通用经验（如 AP-001 Windows BOM / AP-005 PowerShell 5.1 编码） |
| `'project'` | `:current_project`（= `KILO_PROJECT_NAME` env） | 仅 `project_name = :current_project` 时注入 | 项目专属经验（如某 BFF 路由约定 / 内部命名） |

**写入决策**（agent 在提取经验时判定）：

| 判定条件 | scope 值 |
|---|---|
| 用户标记 `[scope=project]` 提取元数据 | `'project'` + `project_name = KILO_PROJECT_NAME` |
| 经验含项目专属代码 / 业务逻辑（如具体变量名、内部接口） | `'project'` + `project_name = KILO_PROJECT_NAME` |
| 经验可跨项目复用（编码规范 / 工具使用 / 流程陷阱） | `'global'`（默认） |
| 不确定 | `'global'`（保守默认） |

**v2.3 历史数据兼容**：v2.2 迁移时所有 `fact_store` 行的 `scope` 自动设为 `'global'`（`ALTER TABLE ADD COLUMN ... DEFAULT 'global'`），无需回填。

详见 `policy/query_strategy.md` §1 query B scope 过滤 + `api/migrate_add_scope_column.sql`。

## 相关策略

- `skill_upgrade.md` — fact_store 触发 skill 升级的检测逻辑
- `../../instructions/skills-lifecycle.md` — SKILL.md 分类与生命周期（指针文件）