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

1. **识别**：确定经验类型（pattern / anti-pattern）
2. **验证**：确认已通过 checker/reviewer 验证
3. **格式化**：按 SKILL.md 条目模板编写
4. **写入**：`skill_manage(action='create'/'patch')`
5. **链接**：在"相关条目"中建立交叉引用

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
