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
| **结论** | 任务最终状态 | 输出最前部 | PASS/FAIL/有条件通过/未完成/降级交付[QUALITY_CB]（枚举见 §结论枚举） |
| **阻塞问题** | 未解决 blocker 列表 | 结论后 | [严重|警告] [文件:位置] [问题] → [建议] | 证据:[片段] |
| **证据片段** | 命令输出/代码路径/测试结果 | 紧跟所属字段 | | 证据: 前缀，≤200 字符 |
| **覆盖矩阵** | 验收标准映射表 | coder 强制 | 验收标准 | 实现位置 | 验证方式 | 验收命令 | 边界覆盖 | 状态 |

## §结论枚举（verdict/状态，单一 SSOT）

> 唯一枚举源。conductor.md §10.2 末尾总结与 DELIVERING 阶段末尾总结一律引用本节，禁止在 agent 定义 / 阶段模板中展开第二套枚举。

| verdict/状态 | 含义 | 适用 agent |
|------|------|-----------|
| PASS | 全部验收通过 | 任意 |
| FAIL | 验收未过 / 回归 | verifier/fixer/coder |
| 有条件通过 | 验收通过但含遗留风险 | reviewer |
| 未完成 | 未达完成线 | coder |
| 降级交付 [QUALITY_CB] | 熔断后降级交付 | conductor |
| DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED | 通用状态信号 | coder |

写法规则：全大写下划线分隔；就近引用；路径 文件:行号；空值写 无。

## 各 agent 输出骨架与结构化格式（强制并行）

为提高解析稳定性，conductor 按以下格式解析。格式错误 → [MALFORMED_OUTPUT] 重试。结构化格式与最小骨架并行不替代。

### 通用状态信号（所有格式必提取其一）

- DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
- 提取失败 → [MISSING_STATUS_SIGNAL]

### coder — XML + 骨架

```xml
<dispatch-result>
  <status>DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED</status>
  <files><file path="src/foo.ts" action="modified">摘要</file></files>
  <changes><change file="src/foo.ts" lines="10-25">说明</change></changes>
  <test-result>PASS|FAIL|SKIPPED</test-result>
  <concerns>风险点</concerns>
</dispatch-result>
```

骨架：需求理解 / 变更摘要 / 验收映射表（强制）/ 验证 / 遗留风险 / 前提条件（必填：等待 verifier 验证）

### verifier — JSON + 骨架

```json
{"verdict":"PASS|FAIL","findings":[{"severity":"ERROR|WARNING|INFO","file":"src/foo.ts","line":10,"message":"","confidence":"HIGH|MEDIUM|LOW"}],"scope_check":{"expected_files":[],"actual_files":[],"scope_creep":false}}
```

骨架：验证结论 / 动态验证 / 覆盖检查 / 阻塞问题

### reviewer — JSON 摘要 + markdown（双格式并行，conductor 优先 JSON）

```json
{"risk":"LOW|MEDIUM|HIGH","perspectives":{"security":"通过|问题","architecture":"通过|问题","simplification":"通过|问题"},"approval":"APPROVE|REQUEST_CHANGES","comments":[]}
```

骨架：审查结论 / 专审视角（安全/架构/简化）/ 问题清单

### fixer — JSON + 骨架

```json
{"strategy":"修复策略","files_changed":[],"root_cause":{"layer":"执行层|方法层|需求层","same_symptom":false,"fix_location":"src/foo.ts:10"}}
```

骨架：修复策略 / 修复结果 / 根因回传（强制）

## 输出自检规则（conductor 执行）

agent 返回后、下游前，conductor 必须自检：

### v2.4 Preflight（#10 — agent 输出前自检）

核心：自检从"事后 parser"前移到"agent 输出前"（省 1 roundtrip，token ~20-30%）。prompt 内嵌模板：

```
[PREFLIGHT_CHECK]
- 状态信号: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED（必填）
- 验收映射表: 5 列齐全（验收标准 | 实现位置 | 验证方式 | 边界覆盖 | 状态）
- 已读取文件清单: 实际 read 的路径列表，禁止虚构
- JSON/XML 标签: 全部闭合 + 必需字段存在
- 标记语言: 全大写下划线分隔
[/PREFLIGHT_CHECK]
```

流程：1 内嵌模板（缺→conductor 补）→ 2 含 [PREFLIGHT_CHECK]（缺→[PREFLIGHT_MISSED] 不阻断）→ 3 conductor 双重校验（preflight 过但 schema 败→[MALFORMED_OUTPUT]）→ 4 happy path 直接下游。与事后 parser 并存：preflight 1st defense，parser 2nd defense。

### JSON / XML 输出自检

- JSON：定位代码块并 JSON.parse 失败 → [MALFORMED_OUTPUT]。必需字段：verifier=verdict/findings/scope_check；reviewer=risk/perspectives/approval；fixer=strategy/root_cause。枚举：verdict∈PASS/FAIL；risk∈LOW/MEDIUM/HIGH。第 1 次失败→要求更严格重输出；第 2 次→[MALFORMED_OUTPUT] 升级 reviewer。
- XML（coder）：必含 <dispatch-result>/<status>/<files>/<changes>；<status> ∈ DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED。失败处理同 JSON（重试 1 次→升级）。

### 自检失败标记

| 标记 | 触发 | 处理 |
|------|------|------|
| [MALFORMED_OUTPUT] | JSON/XML 格式错误，重试 1 次仍失败 | 升级 reviewer |
| [MISSING_STATUS_SIGNAL] | 无法提取状态信号 | 要求显式输出 |
| [PREFLIGHT_MISSED] | 缺 [PREFLIGHT_CHECK] 块 | 不阻断，记 warn |

## 标记语言

本表是**跨角色常用标记的索引**，不是穷举清单：部分标记按域就近定义（带 `*` 的通配条目已覆盖整族），在对应文档里查其完整语义与处置动作，**不得因为本表没列出就认为该标记不存在**：

- 安全/性能检测项 → `security-checklist.md`（`[SECURITY_GAP_*]` / `[PERF_GAP_*]` 逐项）
- 知识库命中/未命中 → `reflection.md`（`[KB_HIT]` / `[KB_MISS]`，由 `scripts/kb.mjs` exit code 驱动）
- 编排异常 → `agent/conductor.md` §异常处理派发表（见本文件末尾「编排异常标记」节）
- 阶段/定级/意图**前缀标注**（`[STAGE: …]` / `[TIER: Tn]` / `[INTENT: …]`）→ 各自阶段文档；它们是状态声明而非异常标记，不列入下表

| 标记 | 含义 | 使用 agent |
|------|------|-----------|
| [PASS]/[FAIL] | 验证通过/失败 | verifier |
| [通过]/[有条件通过]/[不通过] | 审查结论 | reviewer |
| [MISSING_ACCEPTANCE_MAP] | 验收映射表缺失 | verifier |
| [FAKE_CONTEXT] | 已读取文件清单虚假 | verifier |
| [SCOPE_CREEP] | diff 超范围改动 | verifier |
| [PROCESS_VIOLATION] | 流程跳步 | 任意 |
| [CHECKPOINT_MISSED] | 编码前检查点未执行 | 任意 |
| [CIRCUIT_BREAKER] | 连续 3 次无法收敛 | 任意 |
| [SECURITY_GAP_*]/[PERF_GAP_*] | 安全/性能未通过 | verifier |
| [MISSING_STATUS_SIGNAL] | 未输出状态信号 | verifier |
| [NEEDS_REVIEW] | fixer 连续 2 轮同症状升级 reviewer | fixer |
| [PLAN_DEVIATION] | 执行计划偏差 | planner/conductor |
| [PLAN_REVIEW_MISS] | T2 编码前方案未审（plan_review.verdict≠PASS） | verifier |
| [BLOCKED]/[NEEDS_CONTEXT]/[DONE_WITH_CONCERNS] | coder 状态 | coder |


## §返回契约（subagent 返回格式 SSOT）

> 8 agent description/body 末尾"输出契约..."句唯一源。契约：返回 ≤ 角色上限结构化摘要（verdict + 证据 file:line + 关键结论，分档见 §返回超限约束）；禁止 完整报告/长表格/复述文件内容——完整 finding 落 task_context（verification.forward/review/reverse），返回只放摘要+指针；超限处理见 §返回超限约束。

指针化位置（实测 16 处指向 .kilo/instructions/output-schema.md §返回契约：7 处 frontmatter description 末 + 9 处 body 内；实测 11 处 body ## 返回契约 段）。

可选字段 **recovery_budget**（单行 JSON，非必填）：仅在有 retry/overload 活动时附，格式 `recovery_budget:{"overload":n,"retry":n,"cycles":n}`，供 conductor 事后计数与 dispatch_log budget 条目对齐。

### §证据契约（必填，机械可回放）

> LLM 的"X 完成"必须配可机械回放证据，不接受纯 narrative。verdict: PASS 无 evidence[] 视为 [INSUFFICIENT_EVIDENCE]，conductor 拒绝流转。

每条 evidence 必含 3 字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| cmd | string | 实际执行命令字符串（与 transcript 1:1） |
| exit | number | 命令退出码（0=成功） |
| stdout_key | string | 关键输出片段（≤200 字，人工核对） |

反例（拒绝）：已验证（无 evidence）/ transition-check PASS（无 exit+stdout）。正例：

```yaml
evidence:
  - cmd: "grep -n 'X 风格' agent/coding-engineering.md"
    exit: 1
    stdout_key: ""
  - cmd: "node ${KILO_CONFIG_DIR}/scripts/lifecycle-doctor/index.mjs"
    exit: 0
    stdout_key: "SUMMARY: <n> PASS / 0 FAIL / 0 WARN"
```

conductor 拒绝条件：verdict:PASS 但 evidence <1 条→retry；cmd 缺失→[MISSING_CMD]；exit 缺失/非数字→[MISSING_EXIT]；stdout_key 缺失→[MISSING_STDOUT_KEY]。

## §byte-level 验证（强制，012 新增）

> 反 subagent 虚报（三次子代理虚报教训，历史见 knowledge-base/）：subagent 报告基于"自己意图"。byte_level 是 verifier/fixer 委派包与 verification.forward 的强化证据。

### 字段定义（8 元组 = 3 必填 + 扩展）

每条 evidence 必含 3 必填字段（transition-check 机械门禁校验：cmd/exit/stdout_key），byte_level 8 元组为扩展（可选增强，不替代 3 必填）：

```json
{
  "cmd":"实际跑的命令字符串(完整可回放)",
  "exit":0,
  "stdout_key":"命令输出关键摘要(≤50 字符)",
  "hit_count":"数字(精确匹配数)",
  "file":"文件路径(相对项目根)",
  "line":"L行号(从 1 开始)",
  "before_sha":"改前 SHA256 前 8 字符",
  "after_sha":"改后 SHA256 前 8 字符",
  "note":"本条 evidence 说明(可选,≤100 字符)"
}
```

### verifier verification.forward 必含 byte_level 对象

```json
{"verdict":"PASS","byte_level":{"files_modified":[],"critical_lines":[{"file":"file1","line":12,"before":"...","after":"..."}],"before_sha":{"file1":"abc12345"},"after_sha":{"file1":"def67890"}},"evidence":[8 元组 × n]}
```

### 委派包必含 byte_level_required

每次 task 委派（coder/verifier/fixer）必含：byte_level_required: true + return_contract.byte_level schema 必填。

### 5 必做（违反任 1 → verdict 必 FAIL）

1. Get-Content L 行精确索引 2. git diff --stat 3. SHA256 before/after 对比 4. grep 严格匹配 5. 二次读确认（SSOT 全 5 必做见 `.kilo/instructions/byte-level-verify.md §2`）；8 元组 evidence 见 §4

### 6 反模式（禁）

见 .kilo/instructions/byte-level-verify.md §3。

### 与 §证据契约 关系

§证据契约 = 通用 evidence（cmd/exit/stdout_key）；§byte-level = 8 元组扩展（+file/line/SHA256 + byte_level 对象）；byte-level 是证据契约强化版。

### transition-check 校验（按实际实现）

transition-check.mjs 在 QUALITY→DELIVERING 边校验 verification.forward.evidence，每条必含 3 字段，缺则 [MISSING_EVIDENCE_FIELD] exit 1：
- cmd 必非空字符串；exit 必为数字（0/非0）；stdout_key 必非空字符串。
- evidence 数组必 ≥1 条，否则 [INSUFFICIENT_EVIDENCE]（任何 verdict 的最低机械硬门）。byte-level 验证场景（byte_level_required: true）建议 ≥3 条以覆盖 5 必做步骤。

## §返回超限约束（返回契约 §防 abort）

### 返回上限按角色分档

| 角色类 | agent | 返回字符上限 |
|--------|-------|-------------|
| 执行类 | coder, fixer | 4000 |
| 规划类 | planner, plan-reviewer | 4000 |
| 验证类 | verifier | 6000 |
| 审查类 | reviewer, reverse-auditor | 8000 |
| 分析类 | analyst-1, analyst-2, analyst-3, analyst-synthesizer, analyst-critic | 4000 |

本表是角色返回硬上限的唯一真相源（single source of truth），其他文档引用本表不得复制数值。


### 证据字符预算（证据要求 vs 返回红线 的物理解）

> 证据契约（3 必填）+ byte-level（8 元组）+ 验收映射表（5 列）叠加后，单条返回易超角色上限。本小节给各证据元素设字符预算，保证最小合法展开远低于 6000 上限。

| 证据元素 | 字符预算 |
|---------|---------|
| evidence 单条 | ≤300（cmd ≤80 + stdout_key ≤200 封顶） |
| byte-level 8 元组 note | ≤100 |
| 验收映射表矩阵行 | ≤80 |
| verdict 段 | ≤200 |

最小合法展开（verifier）≈1600-2200 字符 vs 6000 上限 = 2.7x 余量。证据全文超预算时落 task_context，返回只留指针（file:line）。

### hard_limit 事前注入（与 overload_count 事后计数互补）

| 机制 | 时机 | 作用 | 触发条件 |
|------|------|------|----------|
| hard_limit | 事前（委派 prompt 注入） | 生成时控制长度 | return_contract.hard_limit 存在 |
| overload_count | 事后（返回后计数） | 超限熔断 | 返回字符 > 角色上限 |

两者互补非替代。conductor 委派包 SOP 见 .kilo/instructions/conductor-dispatch-sop.md §委派包必含 hard_limit。分档放宽是给 finding 多的审查类留余量，非鼓励写满。

超限后果链：返回 > 上限 → 主会话膨胀 → 后续 task Tool execution aborted（cbbbf83 根因形态）。闭环（conductor 端）：overload_count++（判基=角色上限非全局 4000）；<3 继续用；≥3 先压缩 task_context 仍超限才切 worktree。详细 step 见 agent/conductor.md 铁律 #9。

## 新增错误标签（v6 框架稳定化，2026-08-09）

- [ENCODING_DRIFT]：文件 GBK 重编码 / U+FFFD / BOM 污染，阻断 dispatch 或 coder 完工。来源 scripts/scan-encoding.mjs + checks/encoding-safety.mjs。处理：coder 重做，必 Set-Content -Encoding UTF8 或 fs.writeFileSync 指定 encoding。验证：node "${KILO_CONFIG_DIR}/scripts/scan-encoding.mjs" <file> all pass。
- [PS51_REGEX_RISK]：bash 命令含 PS5.1 复杂 regex（-match/-notmatch 后含 ( [ { (? ）。来源 scripts/bash-guard.mjs PS5.1 模式。处理：改 glob/grep（.kilo/instructions/workflow-core.md §搜索四层阶梯纪律）。验证：node "${KILO_CONFIG_DIR}/scripts/bash-guard.mjs" "<cmd>" exit 0。
- [BASH_WRITE_BLOCKED]：bash 命令含文件写入/修改意图（Set-Content/Out-File/git commit/rm -rf/npm publish 等）。来源 scripts/bash-guard.mjs WRITE_PATTERNS。处理：conductor 不直接改文件，改用 task 委派 coder 或 glob/grep 只读工具。

## 编排异常标记（on_fail 派发链，注册于 agent/conductor.md §异常处理派发表）

> 这 6 个标记一直在运行时文档与脚本退出码中使用，但未在本 SSOT 注册——现补齐，禁止再在其它文件发明同义标记。

- [SLOT_ABORT]：节点 `on_fail=abort` 硬停。处理：不再派发，写 `status=FAILED` + 输出已完成部分与失败点。
- [RETRY]：节点 `on_fail=retry_once`，或 `task-context.mjs post-dispatch` exit 4（timeout 且重试计数 ≤ `timeouts.retry.agent_timeout_max_retries`）。处理：同 agent 新会话重跑，dispatch_log 追加；再失败转 [ESCALATE]。
- [ESCALATE]：`post-dispatch` exit 5（timeout 超重试配额）或节点 `on_fail=escalate`。处理：补派对应角色或换更强模型；无可用角色转 `pause`（`status=PAUSED`）。
- [DEGRADED]：节点 `on_fail=degrade`，或装配自检缺件降级（conductor 铁律 #8）。处理：跳过该视角继续流转 + `status=DEGRADED`；DEGRADED 不豁免 permission。
- [AGENT_TIMEOUT]：wall-clock 超 `timeout_s`（= `per_agent_s × per_tier_multiplier`），或 `agent_startup_s` 内 task 未开始执行。来源 `lifecycle/config.yaml` `timeouts` 段。处理：按**当前节点** `on_fail` 派发。
- [AGENT_UNAVAILABLE]：`Tool execution aborted`（provider 硬 kill，不可恢复）。来源 FX-001。处理：**不重试**，按当前节点 `on_fail` 派发；EXECUTING/QUALITY 无 subagent 可用时只能 `escalate`/`pause`。
