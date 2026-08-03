---
name: skills-lifecycle
description: Skills 生命周期治理 — 编写规范、回写触发、发现位置
keywords: skills, lifecycle
---

# Skills Lifecycle Management

> **架构定位**：本文件是 skill 能力扩展层的**治理规则**参考文档（按需引用，不自动注入），不承载具体 skill 内容。skill 是运行时按需加载的能力扩展，与全局配置层（本仓库）解耦——全局骨架不预置、不枚举、不硬引用任何具体 skill。

## skill 发现位置

skill 由运行时 `skill` 工具按 `kilo.json` `skills.paths` 声明的路径发现，仓库不预置 skill 源文件：

1. **全局部署目录**：`${KILO_CONFIG_DIR}/.kilo/skills`（本仓库经 install 部署到全局目录后，该目录为 install 复制目标；本仓库源码不预置 skill 源文件，故部署目录通常为空，除非用户手动放入）。
2. **项目级**：项目根目录 `.kilo/skills/`（项目特化，最高优先级，由各项目自维护）。
3. **社区/用户级**：`${HOME}/.agents/skills`（社区技能源，只读引用）。

命名冲突时按 frontmatter `name` 字段去重，项目级优先。frontmatter 兼容 [agentskills.io](https://agentskills.io/specification) 开放标准。

> 全局配置层不维护具体 skill 清单——skill 的存在、数量、分类由项目级与社区源决定。agent 不应在配置文本中硬引用具体 skill 名，避免配置层与能力扩展层耦合。

## 回写触发条件

以下场景触发 skill 回写（写入项目级 `.kilo/skills/`，不回写全局仓库）：

1. 同类错误出现 2 次及以上
2. 用户明确纠正
3. 发现新坑/边界陷阱
4. 未记录经验导致验证失败
5. reviewer 标注 `[建议回写 skills]`

## SKILL.md 条目模板

```markdown
### {ID}: {条目标题}

**描述**：{一句话说明}

**检查清单/实现要点**：
1. ...

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

## 治理约束

- 禁止编造未验证的经验
- 禁止在 skills 中记录临时状态/任务进度
- 单 SKILL.md 字符数建议 ≤3000，过长拆分
- skill 回写只写入项目级 `.kilo/skills/`，禁止回写全局配置仓库
