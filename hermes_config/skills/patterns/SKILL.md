---
name: patterns
description: Hermes 项目可复用的实现范式、最佳实践、推荐写法。由 agent 在交付阶段根据验证后的经验写入。
keywords:
  - patterns
  - best-practice
  - implementation-pattern
  - reusable
  - coding-style
  - guideline
  - linkage-check
  - 模式
  - 最佳实践
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: knowledge
---

# 代码模式

> 存放 Hermes 项目中可复用的实现范式与最佳实践。
> 由 agent 在交付阶段写入，禁止编造未经验证的内容。

## 条目列表

### PAT-001: 关联功能评估检查清单

**描述**：修改函数、常量、枚举或接口后，必须执行本检查清单，确认关联功能已同步调整，避免"改了A漏了B"的返工。

**检查清单**：
1. **调用方搜索**：修改对象在项目中还有哪些调用方？是否需要同步调整？
2. **平行实现搜索**：同类功能在其他模块是否有平行实现？是否也需要修改？
3. **三层同步检查**：UI 层、接口层、数据层是否都涉及同一规则？
4. **配置/枚举/状态复用检查**：修改项是否在多处被引用？引用处是否同步更新？

**验证方式**：
- engineer 交付检查清单中必须汇报执行结果
- checker L2 核查清单是否被填写、发现项是否已处理

**相关条目**：anti-patterns/SKILL.md#AP-006

---

### PAT-002: 配置去重与单一事实来源

**描述**：不要在多个地方重复相同规则字面句。通用规则应集中到 `SOUL.md` / `.hermes.md` / skills 中，子代理 prompt 只保留角色锚点关键词。

**示例（错的）**：
```markdown
# engineer.md
你是 engineer，必须执行以下 10 条流程...
# checker.md
你是 checker，必须执行以下 10 条流程...
```

**示例（对的）**：
```markdown
# SOUL.md
## 强制流程日志
...
## 质量门禁
...

# engineer.md
> 通用规则由 SOUL.md、.hermes.md 和 skills 注入。
> 你是 engineer，负责实现。
```

**验证方式**：
- 搜索重复规则字面句
- 长任务中观察是否因重复字面句被压缩冲掉

---

## 回写指引

产生值得沉淀的经验时：
1. 确认已通过 checker/reviewer 验证
2. 按条目模板追加
3. 在"相关条目"中建立链接
