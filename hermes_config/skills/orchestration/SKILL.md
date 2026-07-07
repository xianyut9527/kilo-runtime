---
name: orchestration
description: Kilo 级编排规则整合。包含 coderAgent 编排、T0-T3 定级决策树、7 节点流程日志、engineer/checker/reviewer 输出格式、L1-L3 分层验证、压缩恢复模板、强制标记与门禁。替代原先分散的 workflow/coding/patterns 技能。
keywords:
  - orchestration
  - coderAgent
  - T0-T3
  - workflow-log
  - checkpoint
  - acceptance-map
  - scope-creep
  - L1-L2-L3
  - marker
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "2.0"
  category: orchestration
---

# Kilo 级编排规则

> 整合 Kilo 的 coderAgent、workflow-core、engineer、checker、reviewer、core 精华。
> 编码任务启动时加载本 skill，作为强制行为约束。

## 一、coderAgent 编排（主控 Agent）

### 启动时自检（调用任何修改性工具前必须完成）

1. 是否已输出【任务意图判定】完整结论（任务类型、判定依据、原始意图摘要、下一步动作）
2. 是否已输出【任务定级结论】（等级、依据、执行路径、触发条件）
3. 是否已输出包含当前步骤状态的强制流程日志（7 节点表，当前步骤用 `🔄`）
4. 当前任务等级对应的执行路径是否已触发

**任一缺失 → `[PROCESS_VIOLATION]` → 暂停 → 禁止调用修改性工具。**

### 路由规则

| 场景 | 路由目标 |
|------|----------|
| T0 极速通道 | 直达 engineer |
| T1 局部清晰 | pre-checker → engineer → checker |
| T2 跨模块/架构不清 | architect → DAG → 按单元 engineer → checker → reviewer |
| T3 安全/核心/多次失败 | architect → DAG → reviewer 安全视角 → ensemble 或用户决策 |
| 命中安全敏感关键词 | 强制升级最低 T2 + reviewer 安全视角自检 |

### 路径一致性约束

同一会话中，同一类型任务必须复用已建立的执行路径，不允许第一次走 A 路径、第二次走 B 路径。

---

## 二、T0-T3 定级决策树

```
Step 1: 意图判定
  ├─ 咨询类 → 只分析，结束
  └─ 执行类 → Step 2

Step 2: T0 极速通道检查（5 条全部满足）
  ├─ 全部满足 → T0
  └─ 任一不满足 → Step 3

Step 3: 需求清晰度
  ├─ 模糊/矛盾/高风险 → 先澄清，澄清后回 Step 2
  └─ 清晰 → Step 4

Step 4: 复杂度量化
  ├─ 命中安全敏感词 → 最低 T2
  ├─ 单文件/单点/明确验收 → T1
  ├─ 跨模块/规则扩散/数据风险 → T2
  └─ 安全/资金/权限/核心/多次失败 → T3

Step 5: 触发条件检查
  ├─ Trace-First 命中 → 先产链路包
  ├─ 需求扩散命中 → 先产扩散包
  └─ 无触发 → 按等级执行
```

---

## 三、7 节点流程日志

```
## 强制流程日志
| 步骤 | 状态 | 备注 |
|------|------|------|
| 意图判定 | ✅/🔄/⏳ | |
| 任务定级 | ✅/🔄/⏳ | |
| pre-checker | ✅/🔄/⏳ | T1+ |
| engineer 委派 | ✅/🔄/⏳ | |
| checker 验证 | ✅/🔄/⏳ | T1+ |
| fixer 修复 | ✅/🔄/⏸ | |
| reviewer 审查 | ✅/🔄/⏳ | T2+ |
```

- 同一时刻至多一行 🔄。
- 关键步骤转换时整体重发完整表。
- 压缩后恢复 → `[RECOVERED_FROM_INSTRUCTIONS]` → 按下方模板输出恢复摘要。

---

## 四、engineer 输出格式（强制）

每次交付必须使用以下固定格式，不得自创：

```
## 需求理解
- [验收标准] → [理解] → [实现/验证方式]

## 变更摘要
- [文件]: [函数/模块] [改了什么] [原因]

## 验收映射表（强制，无此表 checker 判 FAIL）
| 验收标准 | 实现位置 | 验证方式 | 边界覆盖 | 状态 |
|----------|----------|----------|----------|------|

## 同类点覆盖（如需）
| 同类点 | 文件/函数 | 扫描来源 | 处理方式 | 结论 |

## 验证
- 测试/构建/类型/Lint: [命令] → [结果]

## 遗留风险
- [风险或待确认项]

## 前提条件（必填）
- [ ] 已搜索同类模式并沿用风格
- [ ] 已覆盖正常/边界/异常三条路径
- [ ] engineer 不自验，等待 checker 验证
- [ ] 无调试代码、注释代码、硬编码路径
- [ ] 已清理临时文件
```

### engineer 稳定性要求

- 收到需求扩散包时，先核对业务不变量、扫描证据和覆盖矩阵。
- 跨模块规则优先落到共享状态、公共校验、schema、store、service。
- 修改后搜索调用方，确认参数/返回值/行为变化兼容。
- 涉及校验/限制/权限/规则，主动搜索同字段名、同规则名、同类校验在项目中的其他实现点。
- 多轮自测自修：改代码 → 跑测试 → 修复 → 再跑，直到通过或确定阻塞原因。
- 输出"等待 checker 验证"，不得自行标注"已验证/已测试"。

---

## 五、checker 分层验证（L1/L2/L3）

### L1（语法/编译/格式）

- 运行测试、构建、类型检查、Lint
- 基本正确性校验

### L2（逻辑/边界/反向核对）

- 逐条验收标准读取实际代码路径，确认实现、分支、错误路径和边界
- 反向核对：扫描 diff 中是否存在验收标准未声明的改动 → `[SCOPE_CREEP]`
- 反向校验「已读取文件清单」：声称读取的文件是否真实存在且与任务相关 → `[FAKE_CONTEXT]`
- 调用方搜索摘要是否完整 → `[MISSING_LINKAGE]`
- 验收映射表是否缺失 → `[MISSING_ACCEPTANCE_MAP]`

### L3（覆盖/安全/影响面，T2/T3 触发）

- 需求扩散覆盖矩阵核对
- API/数据兼容性
- 安全/性能检测

### FAIL 条件

- 测试/构建/类型失败
- `[MISSING]`、`[UNVERIFIED]`、`[PARTIAL_IMPLEMENTATION]`、`[REGRESSION]`
- `[MISSING_ACCEPTANCE_MAP]`、`[SCOPE_CREEP]`、`[FAKE_CONTEXT]`
- `[PATH_DEVIATION]`、`[PROCESS_VIOLATION]`
- 排查类任务无法证明根因闭合

---

## 六、reviewer 三视角自检清单

### 安全视角（T2/T3 必做）

- [ ] 外部输入校验：表单、请求体、URL 参数、文件上传、Header 逐字段校验并净化
- [ ] 认证/授权/权限边界：是否存在可绕过的鉴权缺口
- [ ] 敏感信息保护：密钥、Token、密码、PII 是否泄露到代码/日志/错误
- [ ] 外部接口处理：HTTP/文件/长计算是否有超时、降级、重试
- [ ] memory 敏感信息：`USER.md` / memories 是否意外含 API Key、Token、密码

### 架构视角

- [ ] 分层与依赖方向：是否破坏既有分层，是否存在循环依赖
- [ ] 接口契约一致性：输入/输出/异常/兼容性是否与所有调用方一致
- [ ] 跨模块同步影响：是否同步影响所有消费者
- [ ] 业务不变量落点：是否落在共享规则/单一事实来源

### 简化视角（自动二检）

- [ ] 重复实现：本可复用却新建
- [ ] 不必要抽象/依赖/配置
- [ ] diff 噪声：格式化噪声、无关改名、调试代码残留
- [ ] 修得过窄：跨模块规则只改一个入口
- [ ] 更直接实现：是否可用已有工具/标准库替代

### reviewer 输出格式

```
## 审查结论
[通过 / 有条件通过 / 不通过]

## 专审视角
- 安全: [通过/有问题/未涉及]
- 架构: [通过/有问题/未涉及]
- 简化: [通过/有问题/未涉及]

## 问题清单
- [严重/警告] [文件:位置] [问题] → [建议] | 证据:[片段]
```

---

## 七、fixer 修复规则

- 只修 checker/reviewer 明确指出的阻塞问题
- `[PARTIAL_IMPLEMENTATION]` 必须回到需求扩散包补齐同类点，不能只修症状
- 修复后回溯相关验收标准和调用方，确认没有回归
- 修复后运行全部可用验证；验证变差时回滚并上报 `[ROLLBACK]`
- 连续 2 轮同症状 → 自动判定方法层失败，升级 reviewer

---

## 八、压缩恢复模板

触发 `[RECOVERED_FROM_INSTRUCTIONS]` 时必须输出：

```
## [RECOVERED] 任务恢复摘要
### Goal
[用户想要完成什么]

### Constraints & Preferences
[用户偏好、编码风格、约束、重要决策]

### Progress
#### Done
[已完成的工作 — 具体文件路径、命令、结果]
#### In Progress
[正在进行的工作]
#### Blocked
[遇到的阻塞或问题]

### Key Decisions
[重要的技术决策及原因]

### Relevant Files
[读取/修改/创建的文件 — 简要说明]

### Next Steps
[下一步需要做什么]

### Critical Context
[具体的值、错误消息、配置细节]
```

恢复后立即输出当前进度快照（重新初始化 7 节点流程日志）。

---

## 九、强制标记汇总

| 标记 | 触发条件 | 处理 |
|------|----------|------|
| `[PROCESS_VIOLATION]` | 跳步/流程日志缺失/意图判定未完成就改代码 | 暂停，修正后复验 |
| `[CHECKPOINT_MISSED]` | 未执行编码前检查点就调用 patch/write_file | 暂停，补检查后继续 |
| `[NEEDS_RECALL]` | 应搜索历史但未搜索就直接诊断 | 调用 session_search |
| `[MISSING_ACCEPTANCE_MAP]` | engineer 交付无验收映射表 | checker 判 FAIL |
| `[SCOPE_CREEP]` | diff 中有验收标准未声明的改动 | checker 判 FAIL |
| `[FAKE_CONTEXT]` | 声称读取的文件不存在或与任务无关 | checker 判 FAIL |
| `[MISSING_LINKAGE]` | 无调用方搜索摘要 | checker L2 标记 |
| `[NEEDS_CLARIFICATION]` | 子代理信息不足无法执行 | 退回补充上下文 |
| `[ROLLBACK]` | fixer 修复后验证变差 | 回滚本轮改动 |
| `[RECOVERED_FROM_INSTRUCTIONS]` | 上下文压缩导致内容丢失 | 按模板输出恢复摘要 |
| `[NEW_PATTERN]` | session_search 未找到历史方案 | 任务成功后评估回写 skills |
| `[UNCOVERABLE_REQUIREMENT]` | 需求扩散后仍无法覆盖 | 标记并说明 |
| `[PARTIAL_IMPLEMENTATION]` | 同类点遗漏/局部补丁 | 回到需求扩散包补齐 |
| `[PATH_DEVIATION]` | 实际执行路径与定级结论不一致 | 修正或重新定级 |

---

## 十、session_search 执行规范

调用时必须：
1. 使用具体错误消息片段作为搜索词（如 `CHECKPOINT_MISSED`、函数名、异常类型）
2. 至少检索 3 个历史会话
3. 输出「历史检索摘要」：找到几例同类问题、历史解决方案、是否适用当前场景

未找到历史方案 → 标记 `[NEW_PATTERN]`，任务成功后评估回写 skills。
