---
name: writing-skills
description: 创建/编辑/部署 skill 前加载。Skill 即 TDD 应用于过程文档。含 frontmatter/description 触发写法/RED-GREEN-REFACTOR 验证。
keywords: [skill, frontmatter, description, tdd-for-docs, 编写, 触发, red-green, 触发词]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/writing-skills/SKILL.md
  rewrite_ratio: 0.6
---

# Skill 编写规范

## 何时触发

- 创建新 skill 文件
- 编辑现有 skill
- 部署前验证 skill 有效性

## Iron Law

```
无失败测试 = 不得写 skill
```

未跑过 baseline 场景看到 agent 违反规则 = 不知道 skill 教什么。适用新 skill 与编辑既有 skill。

## frontmatter 规范

```yaml
---
name: <skill-name>          # 仅字母/数字/连字符
description: <≤1024 字符，第三人称，触发条件而非工作流>
keywords: [tag1, tag2]      # 搜索关键词
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: <url>
---
```

## description 写法（Skill Discovery Optimization）

**铁律：description = 何时使用，而非做什么。**

- 以 "Use when..." 开头
- 描述触发症状/场景/上下文
- **禁止总结工作流**（测试证明：含工作流的 description 会让 agent 跳过正文走捷径）
- 第三人称
- 优先技术无关，必要时显式标注技术栈

```yaml
# 错：总结工作流
description: Use when TDD - write test first, watch fail, write code, refactor

# 对：仅触发条件
description: Use when implementing any feature or bugfix, before writing implementation code
```

## TDD 映射

| TDD 概念 | Skill 创建 |
|----------|------------|
| 测试用例 | subagent 压力场景 |
| 生产代码 | SKILL.md 文档 |
| RED | 缺 skill 时 agent 违反 |
| GREEN | 有 skill 时 agent 遵守 |
| 重构 | 封堵新发现的合理化借口 |

## RED-GREEN-REFACTOR 循环

1. **RED**：跑 baseline 场景，**看着 agent 失败**，记录具体合理化措辞（逐字）
2. **GREEN**：写最小 skill 针对那些具体违反，禁止为假想场景加内容
3. **REFACTOR**：发现新借口 → 加明确反驳 → 重测直到无漏洞

## 何时创建

**创建**：非直觉技术 / 跨项目复用 / 模式广泛适用（项目特定的放 instructions）/ 别人能受益
**不创建**：一次性方案 / 已有官方文档的标准实践 / 项目特定约定 / 可自动化的（自动化 > 文档）

## 何时分拆 vs 合并

**分拆信号**：单文件 >3000 字符 / 内容可独立搜索/触发 / 不同失败模式需不同测试
**合并信号**：总是同时加载 / 同触发条件 / 拆分导致上下文碎片化

## 抗合理化设计

| 技巧 | 用途 |
|------|------|
| 基础原则前置 | "违反字面即违反精神" |
| 合理化表 | 捕获所有借口与反驳 |
| 红旗清单 | agent 自检触发词 |
| 显式封堵例外 | "无例外：…不允许…" |
| SDO 触发词 | description 列入违规前症状 |

## 微观测试 wording（先于完整场景）

1. 单次 fresh-context 样本（API 或单次 subagent）
2. **必须含无指导对照** — 对照未失败则无需写
3. 每变体 5+ 次重复
4. 人工读每条标记（自动计数高估）
5. 方差即指标 — 5 次 5 种解读说明 wording 无约束力

## 反模式

- **叙述性示例**："在 2025-10-03 session 我们发现…" → 太特定
- **多语言稀释**：example-js.js + example-py.py → 一个优秀示例 > 5 个平庸
- **流程图放代码**：用 `dot` 表示步骤可读性差
- **泛化标签**：helper1、step2、pattern3 → 必须有语义
- **文档未测试就部署**：违反 Iron Law
- **批量创建不逐个测试**：每个 skill 必须独立走 RED-GREEN

## Token 效率

- getting-started 类 <150 字
- 高频加载 <200 字
- 其他 <500 字
- 详情移至 --help 或交叉引用（避免 `@` 强制加载，吃 200k 上下文）
## 部署前 checklist

- [ ] RED：跑过 baseline，逐字记录违反
- [ ] GREEN：skill 让 agent 遵守
- [ ] REFACTOR：新借口已封堵
- [ ] frontmatter 6 字段齐，name 与目录名一致
- [ ] description 以 "Use when" 开头，无工作流总结
- [ ] keywords 含错误信息/症状/工具名
- [ ] 单文件 ≤3000 字符（含 frontmatter）

## 详细参考

- 原文：https://github.com/obra/superpowers/tree/main/skills/writing-skills/SKILL.md
- 关联：skills-lifecycle / tdd-execution
