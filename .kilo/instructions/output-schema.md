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
| **覆盖矩阵** | 验收标准映射表 | coder 强制 | `验收标准 \| 实现位置 \| 验证方式 \| 边界覆盖 \| 状态` |

## 结构化输出格式（强制）

为提高解析稳定性，orchestrator 必须按以下格式解析各 agent 输出。格式错误 → 标记 `[MALFORMED_OUTPUT]` 要求重试。

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

> reviewer 实际采用**双格式并行**：markdown 便于人工阅读，JSON 摘要便于 orchestrator 自动解析。
> orchestrator 优先解析 JSON 摘要；JSON 缺失则回退解析 markdown。
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

## 输出自检规则（orchestrator 必须执行）

agent 返回后、进入下游流程前，orchestrator 必须按以下规则自检：

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
| 1. agent prompt 内嵌 preflight 模板 | 强制 agent 输出前自检 | 模板缺失 → orchestrator 在委派包补充 |
| 2. agent 输出含 `[PREFLIGHT_CHECK]` 块 | 形式合规 | 缺失 → `[PREFLIGHT_MISSED]`，不阻断 |
| 3. orchestrator 解析 preflight + schema | 双重校验 | preflight 通过但 schema 失败 → `[MALFORMED_OUTPUT]`（同 v2.3 行为） |
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

无论 agent 使用何种格式，orchestrator 必须能提取以下状态之一：
- `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`
- 提取失败 → `[MISSING_STATUS_SIGNAL]`

### 自检失败标记

| 标记 | 触发条件 | 处理 |
|------|----------|------|
| `[MALFORMED_OUTPUT]` | JSON/XML 格式错误，重试 1 次后仍失败 | 升级 reviewer |
| `[MISSING_STATUS_SIGNAL]` | 无法提取 DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED | 要求 agent 显式输出状态 |
| `[PREFLIGHT_MISSED]` | v2.4 agent 输出未含 `[PREFLIGHT_CHECK]` 块 | 不阻断，仅记 warn；orchestrator 提示 agent 后续补 |

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
| `[PLAN_DEVIATION]` | 执行中计划偏差 | planner/orchestrator |
| `[DESIGN_GATE_PASS]` / `[DESIGN_GATE_MISS]` | 设计门通过/未过 | planner/orchestrator |
| `[BLOCKED]` | coder/coder 遇阻塞需升级 | coder/coder |
| `[NEEDS_CONTEXT]` | coder/coder 缺少上下文 | coder/coder |
| `[DONE_WITH_CONCERNS]` | 完成功能但有遗留风险 | coder/coder |
| `[MISSING_FIXER_WRITE]` | fixer 完成后未写 dispatch_log.error_code | orchestrator（evolution.md §1.5）|
| `[MISSING_MEMORY_WRITE]` | T1+ 任务收尾未按 SQL 模板写入 dispatch_log / fact_store / failure_db / model_calibration 任一项 | orchestrator（workflow-core.md §收尾自检）|
| `[MEMORY_LAYER_HOLLOW]` | memory.db 表结构齐全但 dispatch_log/fact_store 全空行，疑似 sqlite 层空跑 | validate-config.mjs check17 |
| `[MULTIMODEL_DEGRADED]` | multiModel 触发限流降级为单 coder | orchestrator（workflow-core.md multiModel 并发配额）|
| `[MULTIMODEL_ABANDONED]` | multiModel 累计 3 次失败，放弃融合 | orchestrator（workflow-core.md multiModel 并发配额）|

**写法规则**：全大写，下划线分隔；就近引用；路径格式 `文件:行号`；空值显式写 `无`。
