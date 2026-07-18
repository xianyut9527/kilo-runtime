---
name: skills-lifecycle
description: Skills 生命周期管理
keywords: skills, lifecycle, 回写, frontmatter
---

# Skills 生命周期管理

## Skills 分类表（与 `.kilo/skills/` 目录一一对应，新增/删除 skill 必须同步本表）

| 分类 | 目录 | 说明 |
|------|------|------|
| 工程方法论 | `brainstorming/` | 设计门硬门，编码前想法转规格 |
| 工程方法论 | `plan-execution/` | 计划执行追踪与 critical review |
| 工程方法论 | `subagent-driven-development/` | 顺序子代理开发流 |
| 工程方法论 | `dispatching-parallel-agents/` | 独立问题域并行派发 |
| 工程方法论 | `tdd-execution/` | 测试驱动执行 |
| 工程方法论 | `systematic-debugging/` | 系统化调试方法 |
| 工程方法论 | `verification-before-completion/` | 完成前验证底线 |
| 工程方法论 | `receiving-code-review/` | 接收审查反馈 |
| 工程方法论 | `requesting-code-review/` | 请求代码审查 |
| 工程方法论 | `finishing-a-development-branch/` | 分支收尾协议 |
| 工程方法论 | `using-git-worktrees/` | worktree 隔离 |
| 工程方法论 | `workflow/` | 通用工作流模式 |
| 工程方法论 | `component-driven-fixes/` | 重复 UI/样式/行为问题的组件化修复 |
| 知识库 | `patterns/` | 正向模式库 |
| 知识库 | `anti-patterns/` | 反模式总览与回写指引 |
| 知识库 | `anti-patterns-encoding/` | 反模式：编码类 |
| 知识库 | `anti-patterns-process/` | 反模式：流程类 |
| 知识库 | `anti-patterns-coordination/` | 反模式：协同类 |
| 知识库 | `anti-patterns-contract/` | 反模式：契约类 |
| 知识库 | `writing-skills/` | Skill 编写规范 |
| 知识库 | `hermes-migration/` | Hermes 迁移工具包 |
| UI 设计 | `design-system/` | 设计系统 |
| UI 设计 | `ui-accessibility/` | 无障碍 |
| UI 设计 | `ui-animation/` | 动效 |
| UI 设计 | `ui-color/` | 色彩 |
| UI 设计 | `ui-design-lab/` | 设计实验 |
| UI 设计 | `ui-frontend/` | 前端实现 |
| UI 设计 | `ui-polish/` | 打磨 |
| UI 设计 | `ui-seo/` | SEO |
| UI 设计 | `ui-shadcn/` | shadcn 组件 |
| UI 设计 | `ui-vocabulary/` | 设计词汇 |

## 回写触发条件

以下场景触发 skills 回写：

1. 同类错误出现 2 次及以上
2. 用户明确纠正
3. 发现新坑/边界陷阱
4. 未记录经验导致验证失败
5. reviewer 标注 `[建议回写 skills]`

## 回写流程

> **核心原则**（v2.0 起）：**SKILL.md 不再是经验沉淀的主入口**。新发现的 pattern / anti-pattern 必须先进入全局 sqlite `fact_store` 表（带 confidence / hit_count / tags），经 3 次命中且 confidence ≥ 0.8 后，才由 `skill-upgrade.md` 触发「`[AUTO_DRAFT]`」草稿；草稿经人工审批后才落盘为 SKILL.md。这是 V1 阶段的人工 gate，防止 LLM 自觉回写导致 skill 膨胀。

1. **识别**：确定经验类型（pattern / anti-pattern），并准备 trigger / action / tags 三元组
2. **验证**：确认已通过 checker/reviewer 验证，且能在 SQL 上证明 ≥1 次复现（否则不应进入）
3. **去重查询**（**必须**，跳过将导致 SKILL 膨胀）：
   ```sql
   SELECT fact_id, hit_count, confidence FROM fact_store
   WHERE trigger = ? AND action = ? AND archived = 0;
   ```
   - 命中 → `UPDATE fact_store SET hit_count = hit_count + 1, confidence = ?, updated_at = datetime('now') WHERE fact_id = ?`，流程结束（不进入第 4 步）
   - 未命中 → 继续第 4 步
4. **写入 sqlite**（主路径，**不再 patch SKILL.md**）：
   ```sql
   INSERT INTO fact_store (fact_id, category, trigger, condition, action, confidence, evidence, tags, hit_count, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 0.5, '["dispatch_id"]', ?, 1, datetime('now'), datetime('now'));
   ```
   - AntiPattern 初始 confidence = 0.5，Pattern = 0.6
   - 写入完成 → 流程结束
   - 写入失败 → 检查 memory.db 路径与 MCP 状态，参见 `memory-strategy.md` 「初始化检查」
5. **Skill 升级检测**（异步触发，不在主流程内阻塞）：
   - 由 `skill-upgrade.md` 条件 A：`confidence >= 0.8 AND hit_count >= 3 AND archived = 0` 触发
   - 满足时生成「`[AUTO_DRAFT]`」草稿（带 fact_id / trigger / action），由人工审批后才通过 `skill_manage(action='create'/'patch')` 落盘到 SKILL.md
   - 落盘成功后 `UPDATE fact_store SET archived = 1 WHERE fact_id = ?`
6. **链接**：在「相关条目」中建立交叉引用（仅对最终落盘的 SKILL.md 操作）

## SKILL.md 条目模板

```markdown
### {ID}: {条目标题}

**描述**：{一句话说明}

**检查清单/实现要点**：
1. ...
2. ...

**验证方式**：{如何验证}

**相关条目**：{anti-patterns/patterns/workflow 中的链接}
```

## frontmatter 规范

```yaml
---
name: {skill-name}
description: {≤1024 字符}
keywords: [tag1, tag2]
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: {category}
---
```

**约束**：
- `name` 必填，与目录名一致
- `description` 必填，≤1024 字符
- 标准 YAML 格式

## 约束

- 禁止编造未验证的经验
- 禁止在 skills 中记录临时状态/任务进度
- 单 SKILL.md 字符数建议 ≤3000，过长拆分
