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

### PAT-003: Hermes 编辑器接入路径

**描述**：Hermes 接入 VS Code / Trae 等编辑器的三种路径。先探测版本能力，再推荐最小可行路径。

**决策树**：
1. **ACP（首选）**：`hermes acp` → 编辑器装 ACP Client 扩展
2. **MCP（次选）**：`hermes mcp serve` → Cursor/Claude Desktop 等
3. **Web Dashboard（保底）**：`hermes serve --port 9119`

**关键验证**：`hermes serve` 不是 OpenAI API，`/v1/models` 返回 HTML。查 `openapi.json` 确认真实端点。

**相关条目**：anti-patterns/SKILL.md#AP-005

---

### PAT-004: 项目规则必须进版本控制

**描述**：项目流程、编码标准、安全约束、模式/反模式必须写入版本控制，不能只存在个人运行时数据。

**存储边界**：
- 项目流程/标准 → `SOUL.md` / `.hermes.md` / `skills/`（团队同步）
- 个人偏好 → 个人运行时数据（如 SQLite memory）

**ACTION 触发**：发现 SQLite、logs、sessions 中出现项目规则关键词（"SCOPE_CREEP"、"7 节点"、"kilo"等）。

**修复**：识别 → 迁移到版本控制 → 清空个人数据 → 同步验证。

**验证**：`grep -RiE "kilo|SCOPE_CREEP|7 节点" "$LOCALAPPDATA/hermes/"` 应为空。

---

## 回写指引

产生值得沉淀的经验时：
1. 确认已通过 checker/reviewer 验证
2. 按条目模板追加
3. 在"相关条目"中建立链接
