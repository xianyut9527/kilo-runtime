---
description: DELIVERING phase main slot - conductor built-in output final delivery report
token_budget: 4000 # token_budget 仅用于 executor 调度预算，非输出长度限制；DELIVERING 输出不设上限
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
- Forward verification report + review report (T1+ EXECUTION unified full; INQUIRY 直通无 verification/review)
- Mandatory flow log (complete lifecycle nodes)
- task_context.json (complete task context)

## Delivery Content (by intent_type branch)

Content is organized naturally by intent_type, not by fixed section templates. Structure follows the material, not a rigid skeleton.

### EXECUTION Mode Delivery

Organize the delivery around the completed work: lead with the verdict and completion level, then the acceptance map (criterion → implementation → verification evidence → status), then the change summary (what changed, why, impact scope, cleanup state), then residual risks. Sections appear only when the material warrants them; omit empty ones.

### INQUIRY Mode Delivery

Organize the delivery around the analysis: lead with the core answer, then the evidence table (conclusion point → evidence/reasoning → citation → verification status), then uncovered dimensions / assumptions as limitations. Sections appear only when the material warrants them; omit empty ones.

### Universal Bottom Lines (both modes)

1. **节点/等级标识**：输出首部必须携带三行标识，格式遵循 conductor.md 铁律 #10.1 Format A 单一源（TIER/STAGE/STATUS 三行 + `formatTriple` 渲染），禁止自造第二套格式；标识必须与 task_context 的 sizing.tier / current_stage / status 一致。
2. **末尾总结**：输出末尾必须给出 verdict 总结段落（结论枚举见 .kilo/instructions/output-schema.md §结论枚举；EXECUTION = verdict + 完成度；INQUIRY = 核心回答），不悬空、不开放式结尾。
3. **经验沉淀（硬规则）**：凡「验证/审查能力 FAIL 经修复转 PASS」的任务，conductor 收尾必须执行 `node "${KILO_CONFIG_DIR}/scripts/kb.mjs" add --symptoms "<症状词>" --name "<一句话经验>" --category <编排|方法|执行|需求>` 沉淀教训，随后 `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" set <task_id> execution.kb_write '{"fx":"FX-0NN"}' --agent conductor` 写回执（add 输出的实际编号）；未沉淀或未写回执 → transition-check DELIVERING→DONE 以 `[MISSING_KB_WRITE]` 阻断；无 FAIL 无需写。

### 排版与输出自由

- 输出长度不限制：不设 4000 字符上限，模型返回全部内容直接输出，不截断、不压缩、不降级。
- 允许任意 Markdown 排版：表格、mermaid、emoji、状态标签、代码块、引用块等均可按需使用，不做格式限制。
- 排版由各智能体按 output-schema.md §返回契约自行组织，不退回固定章节模板。

### 保留项（来自 output-schema.md，非 DELIVERING 独有）

- acceptance map 缺失 → 标 [MISSING_ACCEPTANCE_MAP]。
- quality_gate FAIL → 最终状态 DONE_WITH_CONCERNS（状态枚举见 .kilo/instructions/output-schema.md §结论枚举）。