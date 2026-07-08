---
name: skills-lifecycle
description: Skills 生命周期管理
keywords: skills, lifecycle, 回写, frontmatter
---

# Skills 生命周期管理

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
