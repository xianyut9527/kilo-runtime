# Skills 生命周期管理

> 本文件定义 `.kilo/skills/` 目录下长期知识库的维护规则、触发条件、分类规范和约束。
> 运行时由 coderAgent 按需加载，作为项目特定知识的注入源。

## 设计目标

- 让项目经验从"每次会话后随风消散"变成"可积累、可检索、可复用"的长期资产。
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
委派 skills-writer
    ↓ 读取现有 skills 文件
    ↓ 判断：追加 / 修改 / 新建
写入对应 SKILL.md
    ↓
coderAgent 确认文件内容
```

## Skills 分类规范

| 分类 | 目录 | 存放内容 | 示例 |
|------|------|----------|------|
| 架构与边界 | `architecture/` | 模块划分、依赖方向、跨层限制、新逻辑落点 | "Service 层禁止直接调用 Repository，必须通过 UseCase" |
| 代码模式 | `patterns/` | 可复用的实现范式、最佳实践、推荐写法 | "所有列表查询必须带 LIMIT 和 ORDER BY" |
| 反模式 | `anti-patterns/` | 反复出现的错误、踩坑记录、禁止事项 | "禁止在循环内调用外部 HTTP 接口" |
| 接口契约 | `contracts/` | API/数据/事件的结构、兼容性要求、变更记录 | "UserCreateRequest 的 email 字段改为必填" |
| 测试与回归 | `testing/` | 测试策略、回归约定、验证命令、高风险链路 | "修改 auth 模块后必须跑 integration/auth.spec.ts" |

### 条目模板

每个 SKILL.md 中的条目建议使用以下结构：

```markdown
### {条目标题}

**类型**: pattern / anti-pattern / contract / architecture / testing
**添加时间**: YYYY-MM-DD
**来源任务**: <task_id 或 commit 短哈希>
**验证状态**: 已验证 / 待验证
**最近更新**: YYYY-MM-DD

**描述**: 
一句话描述规则或陷阱。

**上下文**: 
在什么场景下适用或触发。

**示例**:
```代码或配置片段```

**验证方式**:
如何确认该规则被遵守或该陷阱被避免。

**相关条目**:
- [链接到同一项目其他 skill 条目]
```

> **注意**：SKILL.md 顶层（frontmatter）还必须维护 `keywords` 数组，供 skill-retriever 做相关性检索；详细格式与维护责任见「Skill-Retriever 检索机制」章节。条目正文模板不重复 frontmatter 字段。

## Skill-Retriever 检索机制

coderAgent 在任务启动时不再全量扫描 `external_dirs` 下的 SKILL.md，而是通过 skill-retriever 按需检索 top-k：

- **检索信号**：任务描述（用户原始输入 + 任务定级结论 + 关键技术词）。
- **匹配方式**：将任务描述与各 SKILL.md frontmatter 的 `keywords` 数组计算关键词重叠度（BM25 或等价实现），按得分排序取 top-k（默认 k=3）。
- **Override 标签**：任务描述中出现 `#skill:all` 时，切换回全量扫描（用于排查与维护场景，不可在生产任务中依赖此 override）。
- **命中阈值**：所有 SKILL.md 得分均低于阈值时，回退到 description 字段匹配；仍无命中则不加载任何 skill。
- **缓存**：同会话内 top-k 结果缓存到本轮任务生命周期，避免重复检索。

### SKILL.md frontmatter 扩展：keywords 字段

每个 SKILL.md 必须在 frontmatter 顶层维护 `keywords` 数组，供 skill-retriever 做相关性检索：

- **作用**：作为 skill-retriever 的索引锚点；缺失 `keywords` 的 SKILL.md 在按需检索中不可被命中，仅在 `#skill:all` override 下可见。
- **格式**：YAML 字符串数组，元素为小写中文/英文术语词（不含空格、标点、抽象概念）。
- **数量要求**：每个 SKILL.md 至少 3 个，最多不超过 20 个。
- **词条来源**：
  1. 该分类的核心领域词（必含），例如 `architecture` 分类必含 `模块划分`、`依赖方向`、`分层`、`跨层`。
  2. 该分类常见反模式/陷阱关键词（推荐），例如 `architecture` 分类应含 `循环依赖`、`向上调用`。
  3. 任务描述中与该分类高度相关的触发词（可选），便于 BM25 命中。
- **维护责任**：skills-writer 在新增/修改 SKILL.md 时同步更新 `keywords`；reviewer 简化视角自检时检查 `keywords` 是否随条目变化保持一致。
- **去重约束**：跨 SKILL.md 的 `keywords` 允许重叠（相关性是分布式的）；单文件内禁止重复。
- **失效处理**：关键词命中后实际加载的 SKILL.md 仍需符合正常的回写流程与验证闭环，未经验证的条目不得因关键词匹配而绕过 checker。

frontmatter 示例：

```yaml
---
name: architecture
description: 项目级架构与边界知识库
keywords:
  - 模块划分
  - 依赖方向
  - 分层
  - 跨层
  - 循环依赖
  - 向上调用
  - use case
  - repository
---
```

## 扩展机制

新增 skills 分类时（如 `security/`、`performance/`、`migrations/`）需同步以下位置，确保单一事实来源：

1. **目录创建**：在 `.kilo/skills/<新分类>/` 下创建 SKILL.md，遵循现有 5 个分类的模板结构，**并在 frontmatter 维护 `keywords` 数组**
2. **本文件分类表**：在「Skills 分类规范」表格中增加一行（分类、目录、存放内容、示例）
3. **agent/skills-writer.md**：更新「职责」章节"分类决策"步骤中的分类枚举
4. **kilo.json coderAgent.prompt**（如显式提及分类）：更新分类列表
5. **新增条目模板（可选）**：若新分类需要特殊字段，在「条目模板」章节追加分类专属模板说明
6. **skill-index.json 同步**：在 `.kilo/experience/skill-index.json` 的 `skills` 数组中注册新分类（含 `name` + `keywords`），供 skill-retriever 启动期冷启动

变更后必须读取上述全部位置确认一致。同步前禁止 skills-writer 写入新分类。

废弃分类时：保留目录但在 SKILL.md 顶部加 `> [DEPRECATED] 本分类已废弃，迁移到 <新分类>` 标注，半年后由维护者删除。

## 约束

1. **禁止编造**：只写入经 checker、reviewer 或实际运行验证过的经验；标记为 `[SPECULATIVE]` 的内容不得写入。
2. **禁止重复**：同一规则只在一处完整维护，其他位置使用引用。发现重复时合并。
3. **项目级优先**：只对某个项目成立的信息写入该项目 `.kilo/skills/`；全局规则留在本仓库的 `.kilo/instructions/`。
4. **可追溯**：每条经验应能追溯到具体任务或验证证据（如 PR、commit、测试报告）。
5. **定期清理**：每季度 review 一次 skills 文件，删除过时或已被框架/工具内置的条目。
