# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md` 与各 `agent/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类（咨询类/执行类）、安全约束、资源与生命周期管理
> - `.kilo/instructions/workflow-core.md` — 执行类任务定级（T0–T3）、单元闭环、门禁、交付、强制流程日志
> - `.kilo/instructions/workflow-reference.md` — 详细参考：需求扩散、Trace-First、MCP/委派包、知识沉淀
> - `.kilo/instructions/skills-lifecycle.md` — memory / skills / feedback 的生命周期管理
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 各 agent 的详细工作说明书
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

## 强制编排锚点（每个项目启动时自动加载）

本文件只列锚点名称与规则来源，细则不重复写入。所有智能体必须遵守：

1. **意图判定优先**：任何任务先按 `core.md` 判定「咨询类 / 执行类」。咨询类任务只分析、不改文件、不调用修改性工具；执行类任务才进入后续流程。
2. **执行类三段开场白**：意图判定 → 任务定级 → 强制流程日志（≥7 节点），然后才可调用修改性工具（来源：`workflow-core.md`）。
3. **定级前置**：执行类任务按 `workflow-core.md` 决策树定级 T0 / T1 / T2 / T3；命中安全敏感关键词 → 最低 T2。
4. **单元闭环**：T1+ 任务拆为可验证小单元，每单元独立 engineer → checker → fixer 闭环（来源：`workflow-core.md`）。
5. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL。
6. **SCOPE_CREEP**：checker L2 反向核对 diff，命中即 FAIL。
7. **自验无效**：智能体不得以自身验证替代 checker 客观验证。
8. **memory / skills 合规**：任务启动加载 `MEMORY.md` + `USER.md`；经验回写必须经闭环验证，禁止 LLM 自动编造规则写入长期文档。
9. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停。
10. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
