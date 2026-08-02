---
name: skills-lifecycle
description: Skills 生命周期管理（v2.5 sqlite 唯一记忆原则：禁止 md append 时序数据；SKILL.md 仅作"how"模板保留，PATTERN/ANTIPATTERN 等"what"必须入 SQLite fact_store）
keywords: skills, lifecycle, sqlite, fact-store, no-md-append
---

# Skills Lifecycle Management（v2.5 — sqlite 唯一记忆）

> **v2.5 强化原则**：所有时序数据 / 使用统计 / 累积经验必须入 SQLite（sqlite 唯一记忆原则）。md 文件仅保留：
> - **静态规则**（本文件 = skills 生命周期规则）
> - **how 模板**（SKILL.md = 工作流程模板，不累积时序）
> - **what 数据**（PATTERN / ANTIPATTERN / RECIPE / WARNING）必须入 `fact_store`，禁止 md append
>
> **回写流程**：去重查询 + fact_store 写入 + skill 升级检测 的完整逻辑由 `.kilo/memory/AGENTS.md` 与 `README.md` 统一定义。
>
> 本文件保留 **SKILL.md 分类表 + 回写触发条件 + SKILL.md 条目模板 + frontmatter 规范**（即 SKILL.md 文件层面的生命周期）；不再重复 sqlite fact_store 的写入规则。
>
> 模块入口：`.kilo/memory/README.md`（公共 API 文档）。

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
| 工程方法论 | `component-driven-fixes/` | 重复实现模式组件化修复（UI 与非 UI 通用） |
| 知识库 | `patterns/` | 正向模式库 |
| 知识库 | `anti-patterns/` | 反模式索引（14 条 AP-XXX 已全部迁入 fact_store；4 个子 skill 目录已于 v2.3 删除，查询 SQL 见 docs/memory-ops-reference.md） |
| 知识库 | `writing-skills/` | Skill 编写规范 |
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

以下场景触发 skills 回写（实际写入 sqlite fact_store，详见 `.kilo/memory/AGENTS.md`）：

1. 同类错误出现 2 次及以上
2. 用户明确纠正
3. 发现新坑/边界陷阱
4. 未记录经验导致验证失败
5. reviewer 标注 `[建议回写 skills]`

**完整回写流程**（去重 SQL → fact_store INSERT/UPDATE → skill 升级检测）见 `.kilo/memory/AGENTS.md`。

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
  - kilo-agent >= 2026
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
