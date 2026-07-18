---
name: anti-patterns-coordination
description: 协调类反模式（coordination 主题）。多组件、多 agent、跨文件引用一致性相关的反复出现错误。
keywords: [coordination, linkage, deletion-residue, rename, subagent, 关联遗漏, 引用断链]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式 — coordination 主题

> 覆盖跨组件 / 跨 agent 引用一致性、配置字段外部消费者、函数重命名遗漏。
> 来源：原 `anti-patterns/SKILL.md` 拆分；保留 AP-004 / AP-006 / AP-007 / AP-010 / AP-012 / AP-013 全部条目。

## 主题条目表

| ID | 标题 |
|----|------|
| AP-004 | 子智能体返回空结果未升级（Reviewer / Architect 任务异常） |
| AP-006 | 关联功能遗漏（改了A漏了B的返工模式） |
| AP-007 | Agent 删除遗漏执行主体引用（规则断链） |
| AP-010 | 删除配置字段前未确认外部消费者 |
| AP-012 | 引用化前未确认目标文件覆盖完整性 |
| AP-013 | 重命名函数时遗漏内部调用同步 |

---

### AP-004: 子智能体返回空结果未升级（Reviewer / Architect 任务异常）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（reviewer 阶段）
**验证状态**: ⚠️ 单次发生（本任务，未跨会话复现；未来若再次发生则升级为 MEMORY）
**最近更新**: 2026-06-24

**描述**:
当 `task` 工具委派的子智能体（reviewer / architect / checker）连续 2 次返回空 `task_result` 时，coderAgent 直接"内联执行"该子智能体的职责。这违反 workflow-core.md 的"T3 / 多轮失败 → 升级 ensemble"约束。

**上下文**:
- 子智能体返回空可能是 prompt 过长 / context 超限 / 模型路由问题
- 内联执行等于跳过独立验证环节
- 必须标记 `[SUBAGENT_RETURNED_EMPTY]` 并升级

**示例（错的）**:
```text
reviewer 委派 1 次 → 空结果
reviewer 委派 2 次 → 空结果
[直接做内联检查]
```

**示例（对的）**:
```text
reviewer 委派 1 次 → 空结果，标记 [SUBAGENT_RETURNED_EMPTY]
reviewer 委派 2 次（精简 prompt） → 空结果
[升级到 ensemble 或拆细任务]
```

**验证方式**:
- 子智能体返回空时必须显式记录
- 2 次失败后必须升级，不能直接内联
- 必要时重启子智能体而非合并职责

**相关条目**:
- AP-003 流程跳步

---

### AP-006: 关联功能遗漏（改了A漏了B的返工模式）

**类型**: 反模式
**添加时间**: 2026-06-25
**来源任务**: kilo_config 配置优化（关联功能遗漏治理）
**验证状态**: 已验证
**最近更新**: 2026-06-25

**描述**:
修改功能 A 时只改了最直观的一处代码，未同步搜索和修改与 A 共享同一规则/常量/接口的关联功能 B/C/D，导致后续任务或用户反馈中发现行为不一致，被迫返工。

**上下文**:
- 反复出现的返工模式：改了前端校验规则，后端接口没同步；改了枚举定义，数据库迁移没做；改了配置项，文档没更新
- 根因：engineer 只关注"我要改什么"，不关注"什么依赖我改的东西"
- 已在 core.md 编码前检查点、engineer prompt、pre-checker 第5条、checker L2 增强核查中建立多层防线

**示例（错的）**:
```text
需求：将订单状态 "pending" 改为 "awaiting_payment"
engineer 修改：只改了 OrderService.createOrder() 中的赋值
遗漏：
- OrderQueryController.listOrders() 的 SQL WHERE 条件
- OrderStatusEnum 的枚举定义
- 前端订单列表页的显示映射
- 数据迁移脚本（存量订单状态）
```

**示例（对的）**:
```text
需求：将订单状态 "pending" 改为 "awaiting_payment"
engineer 执行：
1. 搜索 "pending" 在项目中的全部引用（grep/IDE）
2. 确认每个引用处是否需要同步调整
3. 产出调用方搜索摘要：
   - OrderService.createOrder() → 同步修改
   - OrderQueryController.listOrders() → SQL WHERE 同步修改
   - OrderStatusEnum → 枚举值同步修改
   - 前端订单列表 → 显示映射同步修改
   - 数据迁移脚本 → 新增 ALTER 语句
4. 全部纳入本次 diff 后交付
```

**验证方式**:
- engineer 交付检查清单中必须包含调用方搜索摘要
- pre-checker 检查清单第5条 `[MISSING_LINKAGE]` 标记
- checker L2 增强核查确认摘要存在
- 发现一次返工 → 按 skills-lifecycle.md 触发 AP-006 回写

**相关条目**:
- patterns/SKILL.md#PAT-001（关联功能评估检查清单）
- core.md#编码前强制检查点（第3条搜索确认）

---

### AP-007: Agent 删除遗漏执行主体引用（规则断链）

**类型**: 反模式
**添加时间**: 2026-06-30
**来源任务**: kilo_config 优化升级（reviewer 审查 workflow-core.md 与 reviewer.md 执行主体矛盾）
**验证状态**: 已验证
**最近更新**: 2026-06-30

**描述**:
删除某个 agent 后，只清理 `agent/*.md` 和 `kilo.json` 中的定义，但未 grep 搜索该 agent 在所有 `instructions/*.md` 和 `agent/*.md` 中的**执行主体引用**（如 `AGENTS.md` 表格、`workflow-core.md` 路由规则、其他 agent 文档中的委派引用），导致出现"规则断链"：workflow-core.md 中要求调用已删除的 agent，运行时无法执行。

**上下文**:
- agent 定义分三层：自身 `.md` 文件 → `kilo.json` 注册 → 其他文档的执行引用
- 删除时只清理前两层，第三层必然残留
- 残留引用表现为运行时无效调用、子 agent 返回空、流程中断
- 必须全仓 grep 搜索三项：agent 名称（含中文别名）、agent 缩写、`agent/{name}.md` 文件名

**示例（错的）**:
```markdown
# 只做了以下操作：
1. 删除 agent/review-simplification.md
2. 从 kilo.json 移除 review-simplification 定义
# 遗漏了：
# - workflow-core.md 中 "简化视角自检" 调用了 review-simplification
# - reviewer.md 中委派 review-simplification 的引用
# 结果：运行时 workflow-core.md → reviewer → review-simplification 链断裂
```

**示例（对的）**:
```markdown
删除 agent 时必须执行完整清理清单：
1. 删除 agent/{name}.md
2. 从 kilo.json 移除定义
3. 全仓 grep 搜索 {name}（含中文别名、缩写、文件路径），更新所有引用：
   - AGENTS.md 表格
   - workflow-core.md 路由/升级规则
   - instructions/*.md 和 agent/*.md 中的委派/调用
   - 若属于 reviewer 子视角，同步清理 reviewer.md 的调度逻辑
4. 运行 grep 确认无残留引用后提交
```

**验证方式**:
- 删除 agent 后执行：`grep -r "review-simplification" .kilo/ --include="*.md"` 应返回 0 结果（不含被删除文件本身）
- 搜索 agent 的中文别名、缩写确保全覆盖
- 检查 `AGENTS.md` 表格行是否已移除
- 检查 `workflow-core.md` 中涉及该 agent 的路由/升级条件是否已更新

**相关条目**:
- AP-006 关联功能遗漏（同源：改了A漏了B的返工模式）

---

### AP-010: 删除配置字段前未确认外部消费者

**类型**: 反模式
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（T2）
**验证状态**: 已验证
**最近更新**: 2026-07-03

**描述**:
仅凭"当前校验脚本未引用"就判断 frontmatter 字段冗余，可能忽略框架/TUI/CI 等外部消费者。删除后会导致运行时缺失或 UI 异常。

**上下文**:
- agent.md 的 `color` / `hidden` 字段未被 validate-config.mjs 校验，但 CONFIG_CHANGE_CHECKLIST.md 明确要求其为必填，Kilo TUI 也作为外部消费者使用。

**示例（错的）**:
```text
"validate-config.mjs 不读 color/hidden，所以删除" → TUI 渲染异常。
```

**示例（对的）**:
```text
删除前先搜索全局规则、TUI 代码、文档 checklist 中的消费者声明；无消费者时先加入校验再删除。
```

**验证方式**:
- grep 字段名全仓（含 .gitignore / CONFIG_CHANGE_CHECKLIST.md / 安装脚本 / TUI 代码）；确认无外部消费者后再删除。

**相关条目**:
- AP-002

---

### AP-012: 引用化前未确认目标文件覆盖完整性

**类型**: 反模式
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（T2）
**验证状态**: 已验证
**最近更新**: 2026-07-03

**描述**:
把源文件中的多条规则"引用化"到目标文件时，只检查部分条目重复，就全文替换为引用。目标文件可能缺少源文件中的某些条目，导致规则丢失。

**上下文**:
- core.md 安全约束 7 条中 4 条与 security-checklist.md 重复，但输入校验/敏感信息/编码前搜索 3 条目标文件没有；资源约束同理。

**示例（错的）**:
```text
core.md 安全约束整段改为"详见 security-checklist.md" → 丢失 3 条独有规则。
```

**示例（对的）**:
```text
逐条核对，重复的改引用，独有的保留；或先把缺失条目补入目标文件再引用化。
```

**验证方式**:
- 源文件与目标文件逐项 diff，确认目标文件覆盖全部待引用条目。

**相关条目**:
- （无）

---

### AP-013: 重命名函数时遗漏内部调用同步

**类型**: 反模式
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（T2）
**验证状态**: 已验证
**最近更新**: 2026-07-03

**描述**:
为修复编号跳跃而批量重命名函数（check4→check3、check5→check4 等）时，只改了函数定义和主流程调用，漏改了函数内部相互调用（如 A 函数内部调用 B 函数）。

**上下文**:
- validate-config.mjs 中 `check8DocIndex` 内部调用 `check7ReadmeTree`，重命名后应改为 `check7DocIndex` 调用 `check6ReadmeTree`。

**示例（错的）**:
```text
仅 grep-replace 函数定义处的 `check7ReadmeTree` → 内部调用仍指向旧名 → ReferenceError 或逻辑错误。
```

**示例（对的）**:
```text
重命名后全仓 grep 函数名，确认定义处、调用处、内部调用处全部同步；运行脚本验证。
```

**验证方式**:
- `node validate-config.mjs` 全量运行；grep 被重命名函数的所有出现位置（定义、调用、内部调用、注释等）。

**相关条目**:
- AP-006 关联功能遗漏（改了A漏了B的返工模式）

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
