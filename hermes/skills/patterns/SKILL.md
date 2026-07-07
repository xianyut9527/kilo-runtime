---
name: patterns
description: 本 SKILL 存放项目在可复用的实现范式、最佳实践、推荐写法方面的长期知识。由 coderAgent 在交付阶段根据验证后的经验写入。
keywords:
  - patterns
  - best-practice
  - implementation-pattern
  - reusable
  - coding-style
  - guideline
  - 模式
  - 最佳实践
  - 实现范式
  - 可复用
  - config-dedup
  - runtime-injection
  - prompt-minimal
  - 全局配置
  - 运行时注入
  - 配置去重
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 代码模式

> 本文件存放本项目在可复用的实现范式、最佳实践、推荐写法方面的长期知识。
> 由 coderAgent 在交付阶段根据验证后的经验写入，禁止手动编造未经验证的内容。
> 新增条目请参考 `.kilo/instructions/skills-lifecycle.md` 的条目模板。

## 条目列表

### PAT-001: 关联功能评估检查清单

**类型**: pattern
**添加时间**: 2026-06-25
**来源任务**: kilo_config 配置优化（关联功能遗漏治理）
**验证状态**: 已验证
**最近更新**: 2026-06-25

**描述**:
修改任何函数、常量、枚举或接口后，必须执行本检查清单，确认关联功能已同步调整，避免"改了A漏了B"的返工。

**上下文**:
- 适用于所有涉及功能修改的编码任务
- 特别适用于 T1 及以上任务（T0 极速通道中 engineer 编码前检查点仍生效）
- 由 engineer 在编码后执行，由 checker 在 L2 验证中核查

**检查清单**:

1. **调用方搜索**: 修改的函数/常量/枚举/接口在项目中还有哪些调用方？这些调用方是否需要同步调整？
2. **平行实现搜索**: 同类功能在其他模块是否有平行实现（如不同 controller 处理同一业务规则）？是否也需要同步修改？
3. **三层同步检查**: UI 层、接口层、数据层是否都涉及同一规则？若只改了其中一层，其他层是否遗漏？
4. **配置/枚举/状态复用检查**: 修改的配置项、枚举值、状态定义是否在多处被引用？引用处是否需要同步更新？

**验证方式**:
- engineer 交付检查清单中必须汇报本清单的执行结果
- checker L2 验证时核查清单是否被填写、发现项是否已处理
- 发现 `[MISSING_LINKAGE]` 标记时，必须补充搜索并修正

**相关条目**:
- anti-patterns/SKILL.md#AP-006（关联功能遗漏反模式）

---

### PAT-002: 全局配置去重与运行时注入模式

**类型**: pattern
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（通用规则去重与 AGENTS.md 锚点化）
**验证状态**: 已验证
**最近更新**: 2026-07-03

**描述**:
`kilo.json` 中的 `agent.*.prompt` 应只保留最小角色标识或防 compaction 锚点关键词；所有通用规则由运行时自动注入的 `.kilo/instructions/core.md` + `workflow-core.md` + `reflection.md` 提供；`AGENTS.md` 只列锚点和规则来源，不展开细则。

**上下文**:
- `kilo.json` 中 15 个 agent prompt 初始有 14 个重复 `"你是 X。完整职责见 agent/X.md。"` 字面句，coderAgent.prompt 硬编码完整流程链，造成第二事实来源与 `.kilo/instructions/*.md` 可能不一致。
- 长任务中重复字面句占用 token 且易被压缩冲掉；去重后 14 个 subagent prompt 缩减为纯 agent 名，coderAgent prompt 仅保留 11 个锚点关键词。

**示例（错的）**:
```json
{
  "agents": {
    "engineer":   { "prompt": "你是 engineer。完整职责见 agent/engineer.md。" },
    "checker":    { "prompt": "你是 checker。完整职责见 agent/checker.md。" },
    "reviewer":   { "prompt": "你是 reviewer。完整职责见 agent/reviewer.md。" },
    // ... 共 14 个重复相同结构的 prompt
    "coderAgent": { "prompt": "你是...（硬编码完整流程链 2000+ token）" }
  }
}
```

**示例（对的）**:
```json
{
  "agents": {
    "engineer":   { "prompt": "engineer" },
    "checker":    { "prompt": "checker" },
    "reviewer":   { "prompt": "reviewer" },
    // ... 14 个 subagent 仅保留 agent 名
    "coderAgent": { "prompt": "你是...（11 个锚点关键词，规则全由指令注入）" }
  }
}
```
且所有 `agent/*.md` 顶部声明统一为：
```markdown
> 通用规则由运行时注入的 core.md、workflow-core.md 和 reflection.md 提供。
```

**验证方式**:
- 执行 `grep -r "完整职责见 agent" kilo.json` 应返回 0 条结果。
- `node validate-config.mjs` 全部检查项 PASS。
- 所有 `agent/*.md` 顶部声明一致引用运行时注入。

**相关条目**:
- anti-patterns/SKILL.md#AP-011（由校验代码反推运行时能力）
- anti-patterns/SKILL.md#AP-012（引用化前确认目标覆盖完整性）

---

## 回写指引

当本次任务产生值得沉淀的经验时：
1. 确认经验已通过 checker/reviewer 验证。
2. 根据经验主题选择本文件或其他分类文件。
3. 按上方条目模板格式追加到文件末尾。
4. 确保不与其他条目重复；若相关，在"相关条目"中建立链接。
