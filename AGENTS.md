# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类（咨询类/执行类）、安全约束、资源与生命周期管理
> - `.kilo/instructions/workflow-core.md` — 执行类任务定级（T0–T3）、单元闭环、门禁、交付、强制流程日志、需求扩散、Trace-First、MCP/委派包、知识沉淀
> - `.kilo/instructions/skills-lifecycle.md` — skills 生命周期管理 + 社区技能发现 + Hermes 迁移
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 各智能体的详细工作说明书 + frontmatter 生命周期声明（v6 单源：mount/task_context/isolation/gate 等字段合入 frontmatter，manifest 与行为文件合二为一，bootstrap 扫 frontmatter 自动注册）。**不在此枚举智能体清单**——新增智能体 = 丢一个 `agent/<name>.md` + `kilo.json` 绑模型，零改框架。当前注册清单见 `node scripts/lifecycle-doctor.mjs` 输出
> - `lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯图，语义 ID）+ 阶段执行逻辑（状态机主线索）
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）
> - `lifecycle/multimodel-graph.yaml` — T3 子图 DAG + diversity_rule 多样化硬规则
> - `docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考，无机器可读副本）
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

## 强制编排锚点（每个项目启动时自动加载）

本文件只列锚点名称与规则来源，细则不重复写入。所有智能体必须遵守：

1. **意图判定优先**：任何任务先按 `core.md` 判定「咨询类 / 执行类」。咨询类任务只分析、不改文件、不调用修改性工具；执行类任务才进入后续流程。
2. **执行类两阶段定级**：阶段 A 预估（决策树估 T0-T3）→ planner 设计门 → 阶段 B 校准（实际 unit DAG 复核）→ 强制流程日志（T0 = 2 节点；T1+ = 8 节点；T1+ review_mode 统一 full 四视角，无 lightweight 档）→ 修改性工具（来源：`workflow-core.md`）。
3. ~~定级两阶段化~~：已并入锚点 2。
4. **单元闭环**：T1+ 任务拆为可验证小单元，每单元独立引入 implementation 能力 → verification 能力 → repair 能力闭环（来源：`workflow-core.md`）。
5. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL。
6. **SCOPE_CREEP**：verification 能力 L2 反向核对 diff，命中即 FAIL。
7. **自验无效**：智能体不得以自身验证替代 verifier 客观验证。
8. **memory / skills / 自进化合规**：`.kilo/memory/` 模块（v2.6）由该目录内 README.md / AGENTS.md 统一管理，conductor **按模块入口按需注入**，不硬编码规则。
   - 模块入口：`.kilo/memory/README.md`（公共 API 文档）
   - 模块对 agent 入口：`.kilo/memory/AGENTS.md`（运行时注入）
   - 主通道：`python scripts/memory.py`（stdlib sqlite3 封装，跨平台免安装）；sqlite3 CLI 为可选替代。优先用 `exec-file`/`query`/`exec` 子命令操作 `${HOME}/.config/kilo-data/memory.db`（SQL 模板见 `docs/memory-ops-reference.md`）
   - skill 使用频次写入 SQLite `skill_usage_events` 表，禁止 md append（v2.5 铁律）
   - 兼容策略文件：`.kilo/memory/memory-strategy.md`（保留为指针文件，便于 `strategy: "memory-strategy.md"` 仍可命中）
   - skills 的加载由 `skill` 工具触发（按需），不受本条约束。AGENTS.md 回写与经验回写（经闭环验证）不受影响
   - **生命周期驱动后**：记忆写入是 conductor 在 `DELIVERING` 阶段的内建职责（调用 `python scripts/memory.py`），SQL 模板见 `docs/memory-ops-reference.md`
9. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停。
10. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
11. **组件化与重复模式治理**：同一实现模式（UI 样式/布局/交互、后端逻辑、数据访问、错误处理、日志、配置读取、第三方集成等）跨文件/模块出现时，按 `core.md` + `workflow-core.md` + `component-driven-fixes` skill 执行，禁止逐处复制粘贴式补丁。UI 与非 UI 同等适用，不人为割裂。
12. **生命周期驱动**：所有执行类任务按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名——稳定大框架）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 必配角色契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount`：at/order/when/on_fail）加载智能体（v6 单源：manifest 合入 frontmatter；新增智能体 = 丢 .md + kilo.json 绑模型，零改框架），模型绑定在 `kilo.json` `agent.<name>.model`（能力倾向参考 `docs/model-registry.md` 人类维护，无机械校验）。装配自检：`node scripts/lifecycle-doctor.mjs`。
13. **委派稳定性硬门（防 Tool execution aborted，最高优先级）**：一次只发起一个 `task`，禁止同一响应内并行发起多个 task；task 发起瞬间到 result 返回前，禁止输出任何文字、禁止调用任何其他工具（bash/read/edit/grep/glob 等一律禁止），task 调用必须是该响应的最后一个动作；违者触发 Tool execution aborted，必须立即自纠为串行；并行仅限 Agent Manager worktree 承载（T3 multiModel 走 worktree 隔离），`task` 工具永远串行（来源：`agent/conductor.md` §全局默认串行策略）。
14. **委派包体积硬门（防 context 撑爆 abort，与锚点 13 同级）**：委派包 prompt ≤1500 字符（生成时自检纪律，`prompt-gate.mjs` 仅作手动复核工具，不进入运行时链路）；**返回契约**——subagent 只返回 ≤2000 字符结构化摘要（verdict+证据 file:line+关键结论），禁止完整报告/长表/复述文件内容（来源：`agent/conductor.md` 铁律 #6 返回契约 + 各 agent 返回契约段）；主会话 read 局部化（offset/limit 分段，禁整文件 read）。根因实证：task 返回 4-10K 字符 × N 次 + read 全量输出 → 主会话历史 471KB ≈ 13.8 万 tokens → 每轮请求逼近 200K 上限 → `Tool execution aborted`。
