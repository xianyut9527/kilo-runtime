# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> **路径解析语义**：本文件通过 `findUp` 自动发现，运行时位于全局配置根目录 ~/.config/kilo/（Windows: C:\Users\<用户名>\.config\kilo\）。本文件内所有被引用路径（agent/*.md、lifecycle/、.kilo/instructions/*.md、docs/）均以**全局配置根目录**为解析基准，不以当前项目工作目录为基准。
>
> **Overlay 规则**：项目级同名文件覆盖全局版（如项目根有 `agent/` 目录则优先用项目级）；项目级不存在的文件自动回落到全局配置根目录读取。
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类（咨询类/执行类）、安全约束、资源与生命周期管理
> - `.kilo/instructions/skills-lifecycle.md` — skill 能力扩展治理（编写规范、回写触发、发现位置；按需引用，不自动注入）
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 各智能体的详细工作说明书 + frontmatter 生命周期声明（v6 单源：mount/task_context/isolation/gate 等字段合入 frontmatter，manifest 与行为文件合二为一，bootstrap 扫 frontmatter 自动注册）。**不在此枚举智能体清单**——新增智能体 = 丢一个 `agent/<name>.md` + `kilo.json` 绑模型，零改框架。当前注册清单见 `node scripts/lifecycle-doctor/index.mjs` 输出
> - `lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯图，语义 ID）+ 阶段执行逻辑（状态机主线索）
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）
> - `docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考，无机械可读副本）
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。
> 以上路径如无特别说明，均从全局配置根目录 `~/.config/kilo/` 解析；项目级同名文件覆盖全局版（overlay 语义），项目级不存在时自动回落全局。

## 强制编排锚点（每个项目启动时自动加载）

本文件只列锚点名称与规则来源，细则不重复写入。所有智能体必须遵守：

1. **意图判定优先**：任何任务先按 `core.md` 判定「咨询类 / 执行类」。咨询类任务只分析、不改文件、不调用修改性工具；执行类任务才进入后续流程。
2. **执行类两阶段定级**：阶段 A 预估（决策树估 T0-T2）→ planner 设计门 → 阶段 B 校准（实际 unit DAG 复核）→ 强制流程日志（T0 = 2 节点(INIT→EXECUTING)；T1+ = 5 阶段(INIT→PLANNING→EXECUTING→QUALITY→DELIVERING)；T1+ review_mode 统一 full）→ 修改性工具（来源：`workflow-core.md`）。
3. ~~定级两阶段化~~：已并入锚点 2。
4. **单元闭环**：T1+ 任务拆为可验证小单元，每单元独立引入 implementation 能力 → verification 能力 → repair 能力闭环（来源：`workflow-core.md`）。
5. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL。
6. **SCOPE_CREEP**：verification 能力 L2 反向核对 diff，命中即 FAIL。
7. **自验无效**：智能体不得以自身验证替代 verifier 客观验证。
8. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停。
9. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
10. **组件化与重复模式治理**：同一实现模式（UI 样式/布局/交互、后端逻辑、数据访问、错误处理、日志、配置读取、第三方集成等）跨文件/模块出现时，按 `core.md`「组件化优先 / 重复模式拦截」+ `workflow-core.md`「重复模式修复 / 组件化 SOP」执行，禁止逐处复制粘贴式补丁。UI 与非 UI 同等适用，不人为割裂。
11. **生命周期驱动**：所有执行类任务按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名——稳定大框架）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 必配角色契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount`：at/order/when/on_fail）加载智能体（v6 单源：manifest 合入 frontmatter；新增智能体 = 丢 .md + kilo.json 绑模型，零改框架），模型绑定在 `kilo.json` `agent.<name>.model`（能力倾向参考 `docs/model-registry.md` 人类维护，无机械校验）。装配自检：`node scripts/lifecycle-doctor/index.mjs`。
12. **委派并行优先策略**：挂载点激活智能体 ≥2 且无 `after` 依赖时，必须在单条响应消息中并行发起多个 `task` 工具调用（官方并发模式）。有 `after` 的按拓扑排序串行；task 发起瞬间到该并行组全部 result 返回前，禁止输出任何文字、禁止调用任何其他工具；task 调用组必须是该响应的最后一个动作。`Tool execution aborted` 出现即视为会话断开，按节点 on_fail 派发（来源：`agent/conductor.md` §全局默认并行策略）。
13. **工程化防 abort 门禁**（替代纯文字 prompt 约束，运行时机械强制）：**来源：`agent/conductor.md` 铁律 #9**。完整 step 0/1/2 + 并行安全边界见铁律 #9 本体，本文件不重复展开。
14. **EXECUTING 逐单元派发**：EXECUTING 阶段 conductor 按 `plan.task_dag.units` 逐单元派发 task，每单元独立 goal / acceptance_criteria / forbidden_files / token_budget（完整委派包六条见 agent/conductor.md 铁律#6）；单元依赖按 DAG 拓扑排序，同层无依赖单元默认按铁律 #11 并行组规则并行 dispatch；禁止批量派发整个 EXECUTING 段（来源：`agent/conductor.md` §EXECUTING 逐单元派发）。
15. **搜索四层阶梯纪律**（来源：workflow-core.md §Trace-First + §MCP 优先）：执行类任务信息检索必须按 L0 文档（先读 agent/*.md / instructions/*.md / lifecycle/*.md 锚点）→ L1 Glob（按文件名/路径模式精确定位）→ L2 窄搜（Grep 带 include 限定文件类型或路径前缀，目标 ≤3 文件）→ L3 广搜（Grep 全仓仅在前三阶梯无果、且明确知晓调用方后使用，**全仓 Grep 无 include 视为违规**——必须 include 限定目录/扩展名）→ L4 MCP 图谱/索引（业务仓库默认走 MCP 图谱/索引能力替代暴力文本搜索；Kilo 框架不绑定任何特定实现——具体工具由当前环境的 MCP 决定，未启用图谱的仓库回退 L3 广搜）阶梯递进；阶梯跳级（绕过 L2 直接全仓 Grep，或已索引仓库首选 Grep 而非图谱）标 [SEARCH_LADDER_VIOLATION]。
16. **当前会话优先策略**：保持上下文连贯，避免自动开新会话。配套要求：
    - 主动 compaction：上下文超过 8 万字符时主动 `/compact` / `<leader>c`，不等被动触发
    - 严格委派包：单次 dispatch prompt ≤ 6000 字符（已配阈值的 80% 安全线）
    - subagent 返回 ≤ 4000 字符：超限立即 `[RETURN_OVER_LIMIT]` 重派，不叠加主会话
    - worktree 兜底保留：仅在主会话 context 撑爆时作为防 abort 最后防线，不主动禁用

