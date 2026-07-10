---
name: anti-patterns-process
description: 流程类反模式（process 主题）。规则放置、跳步、SCOPE_CREEP 检测等流程执行相关的反复出现错误。
keywords: process, soft-rule, skip-step, scope-creep, flow, 流程, 跳步, 软约束
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式 — process 主题

> 覆盖规则设计、流程合规、SCOPE_CREEP 检测的反复出现错误。
> 来源：原 `anti-patterns/SKILL.md` 拆分；保留全部 AP-002、AP-003、AP-009 条目。

## 主题条目表

| ID | 标题 |
|----|------|
| AP-002 | 软约束 vs 硬门禁（规则存在 ≠ 规则被遵守） |
| AP-003 | pre-checker FAIL 修正后未再过 pre-checker |
| AP-009 | 多单元工作区 SCOPE_CREEP 全量 diff 误判 |

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
