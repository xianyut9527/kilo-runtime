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

- task_context.intent_type (EXECUTION / INQUIRY, determines delivery content)
- EXECUTION: All completed unit change summaries + acceptance map + verification report
- INQUIRY: Complete analysis conclusion + evidence list + citation + dimension coverage + limitation statement
- Forward verification report + review report (T1+ unified full)
- Mandatory flow log (complete lifecycle nodes)
- task_context.json (complete task context)

## Delivery Content (by intent_type branch)

### EXECUTION Mode Delivery

#### 1. Closed-loop Confirmation (acceptance -> implementation location -> verification evidence -> status)

`
| Acceptance Criteria | Implementation Location | Verification Evidence | Status |
|---------------------|------------------------|----------------------|--------|
`

#### 2. Change Summary (what / why / impact scope)

- File-level change list (with diff summary)
- Architecture impact description
- Rollback strategy (if needed)

#### 3. Branch Wrap-up

- git status (untracked files / modified files)
- commit suggestion (single commit corresponds to single tiered unit)
- branch destination (keep / merge / delete)

---

### INQUIRY Mode Delivery

#### 1. Conclusion First

- One-sentence core conclusion
- Confidence statement (high / medium / low)

#### 2. Evidence Support

- Citation sources (docs / code / data)
- Key findings list

#### 3. Limitation Statement

- Uncovered dimensions
- Assumption conditions
- Suggested follow-up actions

---

## Output Constraints

- token_budget: 4000 (output limit, not input)
- Format: Markdown, tables for comparable dimensions
- Forbidden: Omit verification evidence, omit negative findings, unverified assertions
