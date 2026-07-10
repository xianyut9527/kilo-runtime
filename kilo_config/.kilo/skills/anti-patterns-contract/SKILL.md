---
name: anti-patterns-contract
description: 契约类反模式（contract 主题）。agent 权限、运行时能力边界相关的反复出现错误。
keywords: contract, permission, capability, frontmatter, 权限, 越权, 契约
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式 — contract 主题

> 覆盖 agent 权限与职责契约一致性、运行时能力反推相关的反复出现错误。
> 来源：原 `anti-patterns/SKILL.md` 拆分；保留 AP-008、AP-011 全部条目。

## 主题条目表

| ID | 标题 |
|----|------|
| AP-008 | Agent Frontmatter 权限与职责不一致（越权风险） |
| AP-011 | 由校验代码反推运行时能力 |

---

### AP-008: Agent Frontmatter 权限与职责不一致（越权风险）

**类型**: 反模式
**添加时间**: 2026-06-30
**来源任务**: kilo_config 优化升级（reviewer 审查 agent frontmatter 权限越界）
**验证状态**: 已验证
**最近更新**: 2026-06-30

**描述**:
agent 文件的 YAML frontmatter 中 `permission.edit` 允许的路径范围，与其正文中声明的"写入职责"契约不一致。正文声明"不直接编辑"，但 frontmatter 却授予了对应文件的 edit 权限，造成权限敞口：agent 虽按契约不会主动写，但框架按其 frontmatter 配置认为它有权写入，存在越权风险。

**上下文**:
- `permission.edit` 是运行时行为门禁，决定框架是否允许该 agent 修改指定路径
- 正文中的"写入职责"是设计契约，决定该 agent 应该（或不应该）做什么
- 两者矛盾时：框架信任 frontmatter（行为门禁），agent 按契约自我约束（软约束）
- 误授权限在复杂任务或 prompt 溢出时可能被绕过

**示例（错的）**:
```yaml
# 某 subagent frontmatter
permission:
  edit:
    - src/**/*.ts          # 有权限
---
# 正文职责：
# > 本 agent 只审查不修复，不直接编辑源码
# 矛盾：frontmatter 授予了正文声明不做的权限
```

**示例（对的）**:
```yaml
# 某 subagent frontmatter
permission:
  edit: []                 # 只读 agent，不授予编辑权限
---
# 正文职责：
# > 本 agent 只审查不修复
# 一致：frontmatter 权限 = 正文声明的实际写入范围
```

**示例（对的）**:
```yaml
# agent/foo.md frontmatter
permission:
  edit:
    - .kilo/log/*.jsonl    # 只允许追加 log
    # 不授予 SKILL.md / MEMORY.md 编辑权限
---
# 正文职责：
# > foo 评估后由 coderAgent 中转写入
# > 自身只追加 log
# 一致：frontmatter 权限 = 正文声明的实际写入范围
```

**验证方式**:
- 对每个 agent 文件，对比 frontmatter `permission.edit` 与正文中所有"写入"相关声明（"写入"、"编辑"、"追加"、"修改"、"创建"等关键词）
- 正文声明不做的事，frontmatter 不得授权
- 发现不一致时：优先缩 frontmatter 权限到正文声明的实际写入范围
- reviewer 安全视角自检必须包含此项核对

**相关条目**:
- AP-002 软约束 vs 硬门禁（规则存在 ≠ 规则被遵守，同源权限与契约不一致陷阱）

---

### AP-011: 由校验代码反推运行时能力

**类型**: 反模式
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（T2）
**验证状态**: 已验证
**最近更新**: 2026-07-03

**描述**:
看到校验脚本对某个占位符做了字符串替换（如 `{name}`），就反推运行时框架也支持任意模板变量，进而设计"提取公共模板变量"方案。实际上校验脚本的替换可能是自检专用，运行时 prompt 为静态字符串。

**上下文**:
- kilo.json 中 14 个 agent prompt 重复字面句，原计划提取 `{common_rules}` 模板变量；pre-checker 指出 kilo.json schema 仅支持静态 prompt，`{name}` 替换仅 validate-config.mjs 自身使用。

**示例（错的）**:
```text
"把 `通用规则见 core.md` 提取为 `{common_rules}` 变量" → 运行时 prompt 原样发送给模型，造成角色混乱。
```

**示例（对的）**:
```text
冗余字面句直接删除，依赖 AGENTS.md findUp 运行时注入通用规则。
```

**验证方式**:
- 在 README/examples/实际运行中验证框架是否支持目标占位符；不支持时直接删除字面句。

**相关条目**:
- （无）

---

## 条目模板（新增参考）

```markdown
### AP-{NNN}: {条目标题}

**类型**: 反模式
**添加时间**: {YYYY-MM-DD}
**来源任务**: {任务名}
**验证状态**: {已验证 / ⚠️ 单次发生}
**最近更新**: {YYYY-MM-DD}

**描述**:
{一句话说明}

**上下文**:
- {触发场景 1}
- {触发场景 2}

**示例（错的）**:
{code 或 text}

**示例（对的）**:
{code 或 text}

**验证方式**:
- {验证命令或检查项}

**相关条目**:
- {AP-XXX 标题}
```
