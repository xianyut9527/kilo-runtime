# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md` 与各 `agent/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类（咨询类/执行类）、安全约束、资源与生命周期管理
> - `.kilo/instructions/workflow-core.md` — 执行类任务定级（T0–T3）、单元闭环、门禁、交付、强制流程日志、需求扩散、Trace-First、MCP/委派包、知识沉淀
> - `.kilo/instructions/skills-lifecycle.md` — skills 生命周期管理 + 社区技能发现 + Hermes 迁移
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 各 agent 的详细工作说明书
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

## 强制编排锚点（每个项目启动时自动加载）

本文件只列锚点名称与规则来源，细则不重复写入。所有智能体必须遵守：

1. **意图判定优先**：任何任务先按 `core.md` 判定「咨询类 / 执行类」。咨询类任务只分析、不改文件、不调用修改性工具；执行类任务才进入后续流程。
2. **执行类两阶段定级**：阶段 A 预估（决策树估 T0-T3）→ architect 设计门 → 阶段 B 校准（实际 unit DAG 复核，命中升级条件则 review_mode lightweight→full）→ 强制流程日志（T0 = 2 节点；T1+ = 8 节点）→ 修改性工具（来源：`workflow-core.md`）。
3. ~~定级两阶段化~~：已并入锚点 2。
4. **单元闭环**：T1+ 任务拆为可验证小单元，每单元独立 engineer → checker → fixer 闭环（来源：`workflow-core.md`）。
5. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL。
6. **SCOPE_CREEP**：checker L2 反向核对 diff，命中即 FAIL。
7. **自验无效**：智能体不得以自身验证替代 checker 客观验证。
8. **memory / skills / 自进化合规**：`.kilo/memory/` 模块（v2.6）由该目录内 README.md / AGENTS.md / policy/*.md 统一管理，coderAgent **按模块入口按需注入**，不硬编码规则。
   - 模块入口：`.kilo/memory/README.md`（公共 API 文档）
   - 模块对 agent 入口：`.kilo/memory/AGENTS.md`（运行时注入）
   - 主通道：bash + `sqlite3` CLI 直连 `${HOME}/.config/kilo-data/memory.db`（命令模板见 `.kilo/memory/policy/bash_sqlite_template.md`）；备用通道 `memory-mcp`（v3.0）已在 kilo.json 预埋 `enabled:false`，启用前须 `node test.js` + `node test-stability.js` 双绿
   - skill 使用频次写入 SQLite `skill_usage_events` 表，禁止 md append（v2.5 铁律）
   - 兼容策略文件：`.kilo/memory/memory-strategy.md`（保留为指针文件，便于 `strategy: "memory-strategy.md"` 仍可命中）
   - skills 的加载由 `skill` 工具触发（按需），不受本条约束。AGENTS.md 回写与经验回写（经闭环验证）不受影响。
9. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停。
10. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
11. **组件化与重复模式治理**：UI/样式/行为问题跨页面/组件出现时，按 `core.md` + `workflow-core.md` + `component-driven-fixes` skill 执行，禁止逐页复制粘贴式补丁。
