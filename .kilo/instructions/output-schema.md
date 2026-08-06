---
name: output-schema
description: 统一交付输出规范 — 最小公共字段与标记语言
keywords: output-schema, deliverable, marker, verdict
---

# Output Schema

## 最小公共字段

所有 agent 交付输出必须包含：

| 字段 | 含义 | 位置 | 取值 |
|------|------|------|------|
| **结论** | 任务最终状态 | 交付文本最前部 | `PASS` / `FAIL` / `有条件通过` / `未完成` / `通过` / `不通过` |
| **阻塞问题** | 未解决的 blocker 列表 | 结论之后 | `[严重/警告] [文件:位置] [问题] → [建议] \| 证据:[片段]` |
| **证据片段** | 命令输出、代码路径、测试结果 | 紧跟所属字段 | `\| 证据:` 前缀，≤200 字符 |
| **覆盖矩阵** | 验收标准映射表 | coder 强制 | `验收标准 \| 实现位置 \| 验证方式 \| 验收命令 \| 边界覆盖 \| 状态` |

## 结构化输出格式（强制）

为提高解析稳定性，conductor 必须按以下格式解析各 agent 输出。格式错误 → 标记 `[MALFORMED_OUTPUT]` 要求重试。

### coder 输出格式（XML）
```xml
<dispatch-result>
  <status>DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED</status>
  <files>
    <file path="src/foo.ts" action="modified">变更摘要</file>
  </files>
  <changes>
    <change file="src/foo.ts" lines="10-25">具体修改说明</change>
  </changes>
  <test-result>PASS|FAIL|SKIPPED</test-result>
  <concerns>如有 DONE_WITH_CONCERNS，列出风险点</concerns>
</dispatch-result>
```

### verifier 输出格式（JSON）
```json
{
  "verdict": "PASS|FAIL",
  "findings": [
    {
      "severity": "ERROR|WARNING|INFO",
      "file": "src/foo.ts",
      "line": 10,
      "message": "问题描述",
      "suggestion": "修复建议",
      "confidence": "HIGH|MEDIUM|LOW"
    }
  ],
  "scope_check": {
    "expected_files": ["src/foo.ts"],
    "actual_files": ["src/foo.ts", "src/bar.ts"],
    "scope_creep": false
  }
}
```

### reviewer 输出格式（markdown 主输出 + JSON 摘要同步）

> reviewer 实际采用**双格式并行**：markdown 便于人工阅读，JSON 摘要便于 conductor 自动解析。
> conductor 优先解析 JSON 摘要；JSON 缺失则回退解析 markdown。
```json
{
  "risk": "LOW|MEDIUM|HIGH",
  "perspectives": {
    "security": "通过|问题",
    "architecture": "通过|问题",
    "simplification": "通过|问题"
  },
  "approval": "APPROVE|REQUEST_CHANGES",
  "comments": []
}
```

### fixer 输出格式（JSON）
```json
{
  "strategy": "修复策略摘要",
  "files_changed": ["src/foo.ts"],
  "root_cause": {
    "layer": "执行层|方法层|需求层",
    "same_symptom": false,
    "fix_location": "src/foo.ts:10"
  }
}
```

## 各 agent 最小骨架（与结构化格式并行，不替代）

### coder
```
## 需求理解
## 变更摘要
## 验收映射表（强制）
## 验证
## 遗留风险
## 前提条件（必填）
等待 verifier 验证
```

### verifier
```
## 验证结论
## 动态验证
## 覆盖检查
## 阻塞问题
```

### reviewer
```
## 审查结论
## 专审视角
- 安全: [通过/有问题/未涉及]
- 架构: [通过/有问题/未涉及]
- 简化: [通过/有问题/未涉及]
## 问题清单
```

### fixer
```
## 修复策略
## 修复结果
## 根因回传（强制）
```

## 输出自检规则（conductor 必须执行）

agent 返回后、进入下游流程前，conductor 必须按以下规则自检：

### v2.4 Preflight 校验（#10 — agent 输出前自检）

> **核心思想**：把自检从"事后 parser"前移到"agent 输出前"。agent 必须在 prompt 内嵌 preflight 模板，输出前先自检 schema 合规性。这样比事后 parser 失败重试节省 1 个 roundtrip（稳定性 +++，token 节省 ~20-30%）。

#### Preflight 模板（agent 在 prompt 内强制）

```
[PREFLIGHT_CHECK]
- 状态信号: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED（必填）
- 验收映射表: 5 列齐全（验收标准 | 实现位置 | 验证方式 | 边界覆盖 | 状态）
- 已读取文件清单: 实际 read 的路径列表，禁止虚构
- JSON/XML 标签: 全部闭合 + 必需字段存在
- 标记语言: 全大写下划线分隔
[/PREFLIGHT_CHECK]
```

#### Preflight 流程

| 阶段 | 行为 | 失败处理 |
|---|---|---|
| 1. agent prompt 内嵌 preflight 模板 | 强制 agent 输出前自检 | 模板缺失 → conductor 在委派包补充 |
| 2. agent 输出含 `[PREFLIGHT_CHECK]` 块 | 形式合规 | 缺失 → `[PREFLIGHT_MISSED]`，不阻断 |
| 3. conductor 解析 preflight + schema | 双重校验 | preflight 通过但 schema 失败 → `[MALFORMED_OUTPUT]`（同 v2.3 行为） |
| 4. happy path | preflight + schema 都通过 → 直接进入下游 | 节省 1 次重试 roundtrip |

#### 与事后自检的关系

| 机制 | 时机 | 价值 |
|---|---|---|
| v2.3 事后 parser（§JSON 输出自检） | agent 输出后 | 防 typo / schema 漂移 |
| **v2.4 preflight（§Preflight 校验）** | agent 输出前 | 防 80% 已知错误；省 roundtrip |

两者并存：preflight 是 1st defense；事后 parser 是 2nd defense。

### JSON 输出自检（verifier / reviewer / fixer）

1. **语法检查**：尝试定位 JSON 代码块并解析。`JSON.parse` 失败 → `[MALFORMED_OUTPUT]`
2. **必需字段检查**：
   - verifier：`verdict`, `findings`, `scope_check` 必须存在
   - reviewer：`risk`, `perspectives`, `approval` 必须存在
   - fixer：`strategy`, `root_cause` 必须存在
3. **枚举值检查**：`verdict` 必须是 PASS/FAIL；`risk` 必须是 LOW/MEDIUM/HIGH
4. **失败处理**：
   - 第 1 次失败 → 要求 agent 用更严格格式重输出（明确提示"请用纯 JSON，不要额外解释"）
   - 第 2 次失败 → `[MALFORMED_OUTPUT]` 升级 reviewer 人工处理

### XML 输出自检（coder）

1. **标签检查**：输出必须包含 `<dispatch-result>`, `<status>`, `<files>`, `<changes>`
2. **状态信号检查**：`<status>` 内容必须是 `DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED` 之一
3. **失败处理**：同 JSON 自检（最多重试 1 次 → 升级）

### 通用状态信号提取

无论 agent 使用何种格式，conductor 必须能提取以下状态之一：
- `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`
- 提取失败 → `[MISSING_STATUS_SIGNAL]`

### 自检失败标记

| 标记 | 触发条件 | 处理 |
|------|----------|------|
| `[MALFORMED_OUTPUT]` | JSON/XML 格式错误，重试 1 次后仍失败 | 升级 reviewer |
| `[MISSING_STATUS_SIGNAL]` | 无法提取 DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED | 要求 agent 显式输出状态 |
| `[PREFLIGHT_MISSED]` | v2.4 agent 输出未含 `[PREFLIGHT_CHECK]` 块 | 不阻断，仅记 warn；conductor 提示 agent 后续补 |

## 标记语言

| 标记 | 含义 | 使用 agent |
|------|------|-----------|
| `[PASS]` / `[FAIL]` | 验证通过/失败 | verifier |
| `[通过]` / `[有条件通过]` / `[不通过]` | 审查结论 | reviewer |
| `[MISSING_ACCEPTANCE_MAP]` | 验收映射表缺失 | verifier |
| `[FAKE_CONTEXT]` | 已读取文件清单虚假 | verifier |
| `[SCOPE_CREEP]` | diff 中超范围改动 | verifier |
| `[PROCESS_VIOLATION]` | 流程跳步 | 任意 |
| `[CHECKPOINT_MISSED]` | 编码前检查点未执行 | 任意 |
| `[CIRCUIT_BREAKER]` | 连续 3 次无法收敛 | 任意 |
| `[SECURITY_GAP_*]` | 安全检测项未通过 | verifier |
| `[PERF_GAP_*]` | 性能检测项未通过 | verifier |
| `[MISSING_STATUS_SIGNAL]` | coder/coder 未输出状态信号 | verifier |
| `[NEEDS_REVIEW]` | fixer 连续 2 轮同症状，需升级 reviewer | fixer |
| `[PLAN_DEVIATION]` | 执行中计划偏差 | planner/conductor |
| `[PLAN_REVIEW_MISS]` | T2（plan-reviewer tiers 含 T2）编码前未经方案审查（task_context.plan_review.verdict ≠ PASS）；T1（tiers 不含 T1）不触发 | verifier |
| `[BLOCKED]` | coder/coder 遇阻塞需升级 | coder/coder |
| `[NEEDS_CONTEXT]` | coder/coder 缺少上下文 | coder/coder |
| `[DONE_WITH_CONCERNS]` | 完成功能但有遗留风险 | coder/coder |

**写法规则**：全大写，下划线分隔；就近引用；路径格式 `文件:行号`；空值显式写 `无`。



## §返回契约（subagent 返回格式 SSOT）

> **8 agent description/body 末尾“输出契约...”句的唯一源。** 修改此处即可同步 8 agent 指针化位置。

**契约**：
- **返回 ≤ 角色上限结构化摘要**：`verdict` + 证据 `file:line` + 关键结论（角色上限分档见下文 §返回超限约束）
- **禁止项**：完整报告 / 长表格 / 复述文件内容--完整 finding 落 task_context（`verification.forward`/`verification.review`/`verification.reverse`），返回消息只放摘要+指针
- **超限处理**：见下文 §返回超限约束 段（返回契约 §防 abort 机制）

**指针化位置**（8 agent）：
- 9 个 agent frontmatter `description` 末：`输出契约见 .kilo/instructions/output-schema.md §返回契约`
- 8 个 agent body 末 `## 返回契约` 段：`输出契约见 .kilo/instructions/output-schema.md §返回契约`


### §证据契约（subagent 返回必填，机械可回放）

> **核心原则**：LLM 写的"X 完成了"必须配可机械回放的证据，不接受纯 narrative 断言。`verdict: PASS` 无 `evidence[]` 视为 `[INSUFFICIENT_EVIDENCE]`，conductor 必须拒绝流转。

**每条 evidence 必含 3 字段**：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `cmd` | string | 实际执行的命令字符串（与 transcript 1:1 对应） |
| `exit` | number | 命令退出码（0=成功，非 0=失败） |
| `stdout_key` | string | 关键输出片段（≤200 字，用于人工核对） |

**反例（拒绝）**：
- "已验证 L2 description 已改" ← 无 evidence
- "transition-check PASS" ← 无 exit code + stdout
- "lifecycle-doctor 全过" ← 无 "60 PASS / 0 FAIL / 0 WARN" 字符串

**正例**：

```yaml
evidence:
  - cmd: "rg -n 'claude code 风格' agent/delivery.md"
    exit: 1
    stdout_key: "" # 空输出 = 0 命中
  - cmd: "node scripts/lifecycle-doctor.mjs"
    exit: 0
    stdout_key: "SUMMARY: 60 PASS / 0 FAIL / 0 WARN"
```

**conductor 拒绝条件**（铁律 #6.5 配套）：
- `verdict: PASS` 但 `evidence` 数组 < 1 条 → 立即 retry
- `evidence[].cmd` 缺失或为空 → `[MISSING_CMD]`
- `evidence[].exit` 缺失或非数字 → `[MISSING_EXIT]`
- `evidence[].stdout_key` 缺失 → `[MISSING_STDOUT_KEY]`

## 返回超限约束（返回契约 §防 abort）

### 返回上限按角色分档

| 角色类 | agent | 返回字符上限 |
|--------|-------|-------------|
| 执行类 | coder, fixer | 4000 |
| 规划类 | planner, plan-reviewer | 4000 |
| 验证类 | verifier | 6000 |
| 审查类 | reviewer, reverse-auditor | 8000 |
| 交付类 | delivery | 4000 |

所有 subagent 返回内容 **≤ 角色上限**（结构化摘要：verdict + 证据 file:line + 关键结论）。
**禁止**：完整报告 / 长表 / 复述文件内容--完整 finding 落 task_context（`verification.forward` / `verification.review` / `verification.reverse`），返回消息只放摘要+指针。分档放宽是给 finding 多的审查类留余量，非鼓励写满。

超限后果链：
  返回 > 角色上限 → 主会话历史膨胀 → 后续 task 调用 Tool execution aborted（cbbbf83 根因形态）

闭环机制（conductor 端）：
  - `overload_count++`（task-context.mjs set）--判定基准为「角色返回上限」，非全局 4000
  - overload_count < 3：继续使用（接受一次回退）
  - overload_count ≥ 3：先提取核心摘要压缩 task_context，仍超限才切 agent_manager worktree

详细 step 0/1/2 实现见 `agent/conductor.md` 铁律 #9。
