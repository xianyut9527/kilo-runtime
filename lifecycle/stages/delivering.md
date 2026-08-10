---
description: DELIVERING phase main slot - conductor built-in output final delivery report
model_capability: fast-reasoning
token_budget: 4000
executor: conductor
pre_gate:
  - script: "node scripts/flow-audit.mjs TASK_ID"
    exit: 0
    on_fail: "[FLOW_AUDIT_FAIL] Block DELIVERING output, fallback to missing stages"
  - script: "node scripts/bash-guard.mjs LAST_BASH"
    exit: 0
    on_fail: "[BASH_WRITE_BLOCKED] Last bash command contains write intent, block delivery and alert"
# pre_gate is post-hoc audit (after-the-fact), real-time interception requires Kilo framework upgrade (tool call layer auto-insert gate).
# Current solution = config layer hardening + audit fallback, maximum available solution.
---

# conductor built-in phase (DELIVERING same as INIT, main slot occupied by conductor, no task launch)

> General rules injected by runtime core.md and workflow-core.md. Flow see lifecycle/graph.yaml (DELIVERING -> DONE no gate).

## Input

- task_context.intent_type (EXECUTION / INQUIRY, determines delivery content) - sole data source
- EXECUTION: All completed unit change summaries + acceptance map + verification report
- INQUIRY: Complete analysis conclusion + evidence list + citation + dimension coverage + limitation statement
- Forward verification report + review report (T1+ unified full)
- Mandatory flow log (complete lifecycle nodes)
- task_context.json (complete task context)

## Delivery Content (by intent_type branch)

### EXECUTION Mode Delivery

## 结论
**PASS** - [一句话 verdict + 完成度，≤3 句]

## 做了什么
| 验收标准 | 实现位置 | 验证证据 | 状态 |
| --- | --- | --- | --- |
| ... | path/to/file.ts:42 | 5 元组证据 | PASS |
- 改了什么：[diff 文件清单]
- 为什么：[需求/验收来源]
- 影响范围：[LOW/MEDIUM/HIGH]
- 清理：无 console.log / debugger / 临时文件残留

## 下一步
- git status：[clean/dirty]
- commit 建议：[单提交对应单定级单元]
- 分支去向：[保留/合并/PR]（不擅自 commit/push）
- worktree 清理：[如适用]

## 局限
> [遗留风险 / 已知未覆盖点，无则省略本段]

### INQUIRY Mode Delivery

## 结论
**[≤3 句加粗核心回答]**

## 证据
| 结论要点 | 证据/推理 | 引用来源 | 验证状态 |
| --- | --- | --- | --- |
| ... | ... | file:line / 文档锚点 | PASS/WARN |

## 局限
> [未覆盖维度 / 假设条件，无则省略]

## Output Constraints

- token_budget: 4000 (output limit, not input)
- Format: Markdown, tables for comparable dimensions only (acceptance map / evidence table); no emoji status markers, use PASS/FAIL/WARN
- Forbidden: Omit verification evidence, omit negative findings, unverified assertions
- evidence goes to tables / quote blocks, not前置 to conclusion; no narrative-only; compress over-limit to 结论 + 做了什么 + 下一步
- acceptance map missing -> tag [MISSING_ACCEPTANCE_MAP]; quality_gate FAIL -> final status DONE_WITH_CONCERNS