# Skills 生命周期管理

> 本文件定义 `.kilo/skills/` 目录下长期知识库的维护规则、触发条件、分类规范和约束。
> 运行时由 coderAgent 按需加载，作为项目特定知识的注入源。

## 设计目标

- 让项目经验从"每次会话后随风消散"变成"可积累、可复用"的长期资产。
- 保持全局配置精简，项目特有知识下沉到项目级 `.kilo/skills/`。
- 知识写入必须经过验证闭环，禁止自动编造。

## 回写触发条件

以下情况的经验必须评估是否回写：

1. **跨层陷阱**：发现本项目特有的模块依赖、初始化顺序、状态传播或边界条件问题。
2. **重复错误**：同一类错误（如空指针、未分页、未校验）在 2 次及以上任务中由 checker/reviewer 发现。
3. **契约变更**：API 输入输出、数据库字段、事件结构、配置格式发生变更。
4. **安全新知**：安全审查中发现新的攻击面、防护绕过方式或权限边界案例。
5. **可复用模式**：任务 DAG、模块划分、分层策略在多个需求中可复用。

## 回写流程

```
coderAgent 评估经验沉淀
    ↓ 命中触发条件？
    ↓ 已通过 checker/reviewer 验证？
coderAgent 读取现有 skills 文件
    ↓ 判断：追加 / 修改 / 新建
写入对应 SKILL.md
    ↓
coderAgent 确认文件内容
```

## Skills 分类规范

| 分类 | 目录 | 存放内容 | 示例 |
|------|------|----------|------|
| 代码模式 | `patterns/` | 可复用的实现范式、最佳实践、推荐写法 | "所有列表查询必须带 LIMIT 和 ORDER BY" |
| 反模式 | `anti-patterns/` | 反复出现的错误、踩坑记录、禁止事项 | "禁止在循环内调用外部 HTTP 接口" |

### 条目模板

每个 SKILL.md 中的条目建议使用以下结构：

```markdown
### {条目标题}

**类型**: pattern / anti-pattern
**添加时间**: YYYY-MM-DD
**来源任务**: <task_id 或 commit 短哈希>
**验证状态**: 已验证 / 待验证
**最近更新**: YYYY-MM-DD

**描述**: 
一句话描述规则或陷阱。

**上下文**: 
在什么场景下适用或触发。

**示例**:
\```代码或配置片段\```

**验证方式**:
如何确认该规则被遵守或该陷阱被避免。

**相关条目**:
- [链接到同一项目其他 skill 条目]
```

## SKILL.md frontmatter 规范

SKILL.md 顶层 frontmatter 必须包含以下字段（兼容 [agentskills.io](https://agentskills.io/specification) 开放标准，可与 Hermes / Claude Code 等工具的技能目录互通）：

| 字段 | 必填 | 约束 |
|------|------|------|
| `name` | 是 | skill 标识，小写字母/数字/连字符，与目录名一致 |
| `description` | 是 | ≤ 1024 字符，描述用途与触发场景，含具体关键词 |
| `keywords` | 是 | YAML 字符串数组，3-20 个，小写术语词；用于 coderAgent 判断相关性 |
| `license` | 否 | 许可证名称或引用 |
| `compatibility` | 否 | 环境要求说明 |
| `metadata` | 否 | 任意 key-value 元数据 |

frontmatter 示例：

```yaml
---
name: anti-patterns
description: 项目在反复出现的错误模式、踩坑记录、禁止事项方面的长期知识。
keywords:
  - anti-patterns
  - 反模式
  - 踩坑
  - scope-creep
license: MIT
---
```

### 渐进式披露

- SKILL.md 主文件建议 ≤ 500 行；超长内容拆到 `references/` 子目录。
- 目录结构建议：`SKILL.md`（主文件）+ `scripts/`（可执行脚本）+ `references/`（补充文档）+ `assets/`（模板/资源）。

## 扩展机制

新增 skills 分类时（如 `security/`、`performance/`、`migrations/`）需同步以下位置，确保单一事实来源：

1. **目录创建**：在 `.kilo/skills/<新分类>/` 下创建 SKILL.md，遵循现有 2 个分类的模板结构，并在 frontmatter 维护 `keywords` 数组
2. **本文件分类表**：在「Skills 分类规范」表格中增加一行（分类、目录、存放内容、示例）
3. **kilo.json coderAgent.prompt**（如显式提及分类）：更新分类列表
4. **新增条目模板（可选）**：若新分类需要特殊字段，在「条目模板」章节追加分类专属模板说明

变更后必须读取上述全部位置确认一致。

废弃分类时：保留目录但在 SKILL.md 顶部加 `> [DEPRECATED] 本分类已废弃，迁移到 <新分类>` 标注，半年后由维护者删除。

## 约束

1. **禁止编造**：只写入经 checker、reviewer 或实际运行验证过的经验；标记为 `[SPECULATIVE]` 的内容不得写入。
2. **禁止重复**：同一规则只在一处完整维护，其他位置使用引用。发现重复时合并。
3. **项目级优先**：只对某个项目成立的信息写入该项目 `.kilo/skills/`；全局规则留在本仓库的 `.kilo/instructions/`。
4. **可追溯**：每条经验应能追溯到具体任务或验证证据（如 PR、commit、测试报告）。
5. **定期清理**：每季度 review 一次 skills 文件，删除过时或已被框架/工具内置的条目。
