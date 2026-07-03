---
name: anti-patterns
description: 本 SKILL 存放项目在反复出现的错误模式、踩坑记录、禁止事项方面的长期知识。由 skills-writer 根据验证后的经验写入。
keywords:
  - anti-patterns
  - pitfalls
  - mistakes
  - forbidden
  - dont-do
  - recurring-error
  - scope-creep
  - frontmatter
  - consumer-confirmation
  - 引用化
  - validate-config
  - 函数重命名
  - 占位符
  - template-variable
  - 反模式
  - 踩坑
  - 错误
  - 禁止
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式

> 本文件存放本项目在反复出现的错误模式、踩坑记录、禁止事项方面的长期知识。
> 由 skills-writer 根据验证后的经验写入，禁止手动编造未经验证的内容。
> 新增条目请参考 `.kilo/instructions/skills-lifecycle.md` 的条目模板。

## 条目列表

### AP-001: Edit 工具 BOM 污染（json/csv/yaml 解析失败）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（kilo.json 修改）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
在 Windows 环境下使用 Edit 工具修改 UTF-8 文本文件（特别是 `kilo.json` / `*.yaml` / `*.csv`）时，工具偶尔会向文件写入 UTF-8 BOM（`EF BB BF`），导致严格的 `JSON.parse` / YAML 解析器报错。

**上下文**:
- 任何用 Edit 工具改 JSON/YAML 配置文件后必须做 BOM 检测
- `JSON.parse(fs.readFileSync(...))` 会因 BOM 失败
- 严格的 YAML 解析器同样会失败

**示例（错的）**:
```javascript
// 直接读取 → 失败
const obj = JSON.parse(fs.readFileSync('kilo.json', 'utf8'));
// SyntaxError: Unexpected token in JSON at position 0
```

**示例（对的）**:
```javascript
// 检测并剥离 BOM
let buf = fs.readFileSync('kilo.json');
if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
  buf = buf.subarray(3);
}
const obj = JSON.parse(buf.toString('utf8'));
```

**验证方式**:
- `node -e "let b=require('fs').readFileSync('p'); console.log(b[0]===0xEF?'BOM':'no-BOM')"`
- 在修改后必须跑 `JSON.parse` 验证

**相关条目**:
- AP-005 编码根因（同一 Windows 编码问题）

---

### AP-002: 软约束 vs 硬门禁（规则存在 ≠ 规则被遵守）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: kilo_config 编码规范治理（多次会话）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
把核心规则（如"Windows 编码"、"安全输入校验"、"禁止自验"）放在 `.kilo/instructions/*.md` 的嵌套子条款里，agent 在复杂任务中读到大量其他指令，核心规则被淹没，**规则存在但不被遵守**。

**上下文**:
- 任何被多次违反的规则几乎都位于嵌套位置
- 同一规则放平级位置 + "违反视为方法层错误" 显著提升遵守率
- agent 不会在每个文件操作前都重读 instruction

**示例（错的）**:
```markdown
## 文件操作规范
### 必需使用 Shell 处理内容时的编码要求
- Windows 需设置 `[Console]::OutputEncoding` ...
```
（嵌套太深，agent 看不到）

**示例（对的）**:
```markdown
## 流程强制基线
1. 禁止跳步
2. 过程可追溯
3. **Windows 编码永久化**（违反视为方法层错误，必须修）
4. 自验无效
5. 交付必审
```
（平级 + 显式违反后果）

**验证方式**:
- 在 coderAgent prompt 顶部嵌入核心规则
- 用 `core.md` 的"流程强制基线"位置作为唯一权威源
- 每违反 1 次 = 1 次反模式反馈

**相关条目**:
- AP-005 编码根因

---

### AP-003: pre-checker FAIL 修正后未再过 pre-checker

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（pre-checker 阶段）
**验证状态**: ⚠️ 单次发生（本任务，未跨会话复现；未来若再次发生则升级为 MEMORY）
**最近更新**: 2026-06-24

**描述**:
pre-checker 输出 FAIL 后，coderAgent 修正了单元 DAG，但未再次调用 pre-checker 验证，直接进入 engineer 阶段。这是**跳步违规**，违反 workflow-core.md 的"pre-checker FAIL → 修正后必须 PASS 才能推进"约束。

**上下文**:
- 任何"修正后未复验"的情况都属于跳步
- 修正内容可能引入新问题
- 流程日志必须显式记录复验节点

**示例（错的）**:
```text
pre-checker | ❌ FAIL | 缺 3 个单元
[直接修正]
[直接进入 engineer，不复验]
```

**示例（对的）**:
```text
pre-checker | ❌ FAIL | 缺 3 个单元
[修正]
pre-checker (复验) | ✅ PASS
engineer 委派 | ✅ 已完成
```

**验证方式**:
- 流程日志中"pre-checker"节点必须出现 2 次（首次 + 复验）
- 第二次必须为 ✅ PASS

**相关条目**:
- AP-004 Reviewer 升级失败

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

### AP-005: PowerShell 5.1 GBK 编码根因（中文乱码源头）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: kilo_config 编码规范治理（多次会话，2026-06-07 专题）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
Windows 中文系统下，PowerShell 5.1（`powershell.exe`）默认输出编码为系统活动代码页 936（GBK/GB2312），而非 UTF-8。所有通过 shell 工具读 / 写的中文内容都会触发乱码或编码错误。

**上下文**:
- 仅影响 Windows + PowerShell 5.1（不含 pwsh 7 / WSL）
- 影响所有 `bash` 工具调用
- install.ps1 已写入 `$PROFILE` 永久修复

**示例（错的）**:
```powershell
# 默认状态下
[Console]::OutputEncoding  # 输出 GB2312
Get-Content .\中文文件.md  # 显示乱码
```

**示例（对的）**:
```powershell
# 永久化（已写入 install.ps1）
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
```

**验证方式**:
- 跑 `[Console]::OutputEncoding.WebName` 应返回 `utf-8`
- install.ps1 第 70-106 行已实施

**相关条目**:
- AP-001 BOM 污染（同源 Windows 编码问题）
- AP-002 软约束（编码规则被淹没）

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

### AP-008: Agent Frontmatter 权限与职责不一致（越权风险）

**类型**: 反模式
**添加时间**: 2026-06-30
**来源任务**: kilo_config 优化升级（reviewer 审查 experience-ranker frontmatter 权限越界）
**验证状态**: 已验证
**最近更新**: 2026-06-30

**描述**:
agent 文件的 YAML frontmatter 中 `permission.edit` 允许的路径范围，与其正文中声明的"写入职责"契约不一致。正文声明"不直接编辑，委派 skills-writer"，但 frontmatter 却授予了对应文件的 edit 权限，造成权限敞口：agent 虽按契约不会主动写，但框架按其 frontmatter 配置认为它有权写入，存在越权风险。

**上下文**:
- `permission.edit` 是运行时行为门禁，决定框架是否允许该 agent 修改指定路径
- 正文中的"写入职责"是设计契约，决定该 agent 应该（或不应该）做什么
- 两者矛盾时：框架信任 frontmatter（行为门禁），agent 按契约自我约束（软约束）
- 误授权限在复杂任务或 prompt 溢出时可能被绕过

**示例（错的）**:
```yaml
# agent/experience-ranker.md frontmatter
permission:
  edit:
    - .kilo/memory/MEMORY.md         # 有权限
    - .kilo/skills/**/*.md            # 有权限
---
# 正文职责：
# > experience-ranker 不直接编辑 SKILL.md/MEMORY.md 正文，
# > 委派 skills-writer 执行写入
# 矛盾：frontmatter 授予了正文声明不做的权限
```

**示例（对的）**:
```yaml
# agent/experience-ranker.md frontmatter
permission:
  edit:
    - .kilo/experience/log/*.jsonl    # 只允许追加 feedback log
    # 不授予 SKILL.md / MEMORY.md 编辑权限
    # 写入正文必须通过委派 skills-writer
---
# 正文职责：
# > experience-ranker 评估经验后将结果委派 skills-writer 写入
# > 自身只追加 feedback log
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

### AP-009: 多单元工作区 SCOPE_CREEP 全量 diff 误判

**类型**: 反模式
**添加时间**: 2026-07-03
**来源任务**: kilo_config 全仓冗余清理（T2）
**验证状态**: 已验证（checker 复验 + reviewer 总体验收确认）
**最近更新**: 2026-07-03

**描述**:
T2 任务拆为多个单元在同一工作区顺序执行时，各单元改动累积但未提交。若 checker 使用不正确的 git diff 范围进行 SCOPE_CREEP 检测，会把历史提交残留或前置单元已 PASS 的合法变更误判为当前单元的 SCOPE_CREEP。

两种常见错误：
1. **`git diff HEAD~1` 全量比对** — 与上一次 commit 比，会把历史提交的合法变更（如前置单元已提交的修改）也算入当前单元的 scope。
2. **`git diff HEAD` / `git diff --stat` 全量比对** — 与当前 HEAD 比，会把同一工作区中前置单元已 PASS 但未提交的累积改动误判。

**上下文**:
- 多单元 DAG 在同一工作区顺序执行时常见；checker 的 L2 反向核对应以"本单元声明文件"为边界，而非整个工作区或整个提交历史。
- 判断依据：先用 `git status --short` 确认实际工作区改动，用 `git diff -- <本单元文件>` 限定当前单元。

**示例（错的）**:
```text
# 错误 1：比对上一次 commit
git diff HEAD~1 → 列出 skills/ 缩减、dp provider 删除（历史提交）→ 判 FAIL

# 错误 2：比对整个工作区
git diff --stat → 同时列出 core.md（来自单元 A）、kilo.json（来自单元 B）→ 判 FAIL
```

**示例（对的）**:
```text
git status --short                    # 先确认工作区实际改动
git diff -- kilo.json                  # 仅比对当前单元声明文件
# 前置单元残留单独记录为"已知未提交变更"
```

**验证方式**:
- checker 复验时限定 `git diff -- <本单元文件>`，不使用 `git diff HEAD~1` 或 `git diff --stat` 全量范围。
- 先用 `git status --short` 确认工作区实际改动文件，确认当前单元文件集合。
- 全量 diff 仅用于单元 G 总体验收。

**相关条目**:
- AP-003（pre-checker FAIL 修正后未复验）

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

## 回写指引

当本次任务产生值得沉淀的经验时：
1. 确认经验已通过 checker/reviewer 验证。
2. 根据经验主题选择本文件或其他分类文件。
3. 按上方条目模板格式追加到文件末尾。
4. 确保不与其他条目重复；若相关，在"相关条目"中建立链接。
