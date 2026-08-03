# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类（咨询类/执行类）、安全约束、资源与生命周期管理
> - `.kilo/instructions/workflow-core.md` — 执行类任务定级（T0–T2）、单元闭环、门禁、交付、强制流程日志、需求扩散、Trace-First、MCP/委派包、知识沉淀
> - `.kilo/instructions/skills-lifecycle.md` — skill 能力扩展治理（编写规范、回写触发、发现位置；按需引用，不自动注入）
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 各智能体的详细工作说明书 + frontmatter 生命周期声明（v6 单源：mount/task_context/isolation/gate 等字段合入 frontmatter，manifest 与行为文件合二为一，bootstrap 扫 frontmatter 自动注册）。**不在此枚举智能体清单**——新增智能体 = 丢一个 `agent/<name>.md` + `kilo.json` 绑模型，零改框架。当前注册清单见 `node scripts/lifecycle-doctor.mjs` 输出
> - `lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯图，语义 ID）+ 阶段执行逻辑（状态机主线索）
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）
> - `docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考，无机器可读副本）
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

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
11. **生命周期驱动**：所有执行类任务按 `lifecycle/graph.yaml` DAG（纯拓扑，零智能体名——稳定大框架）+ `lifecycle/stages/*.md` 阶段文件（执行逻辑 + frontmatter `required_roles` 必配角色契约）驱动状态流转，按文件路由（`agent/*.md` frontmatter `mount`：at/order/when/on_fail）加载智能体（v6 单源：manifest 合入 frontmatter；新增智能体 = 丢 .md + kilo.json 绑模型，零改框架），模型绑定在 `kilo.json` `agent.<name>.model`（能力倾向参考 `docs/model-registry.md` 人类维护，无机械校验）。装配自检：`node scripts/lifecycle-doctor.mjs`。
12. **委派并行优先策略**：挂载点激活智能体 ≥2 且无 `after` 依赖时，必须在单条响应消息中并行发起多个 `task` 工具调用（官方并发模式）。有 `after` 的按拓扑排序串行；task 发起瞬间到该并行组全部 result 返回前，禁止输出任何文字、禁止调用任何其他工具；task 调用组必须是该响应的最后一个动作。`Tool execution aborted` 出现即视为会话断开，按节点 on_fail 派发（来源：`agent/conductor.md` §全局默认并行策略）。
13. **工程化防 abort 门禁**（替代纯文字 prompt 约束，运行时机械强制；来源：`agent/conductor.md` 铁律 #9）：conductor 每次 task dispatch 前先执行 `task-context.mjs set <task_id> dispatch_pending.prompt_chars <N> --agent conductor` 写入待派 prompt 字符数，再执行 `task-context.mjs dispatch-prompt-check <task_id>` 校验单次委派规模（未写入 pending → exit 1 审计失败；prompt 超 `config.dispatch_prompt_threshold` 缺省 3000 或 file_count 超限 → exit 2 阻断）；随后必须执行 `task-context.mjs size-check`（task_context 字符数 > `config.size_check_threshold` 缺省 120000 → exit 2 → **先提取核心摘要压缩 task_context（保留 intent/sizing/config/current_stage/quality.verdict/dispatch_log/status，清空 execution/verification/plan/fixing_history 细节），重测 size-check，仍超限才 `[CONTEXT_UNSAFE]` 强制切 agent_manager worktree**）；并行 dispatch 前对每个待派发 task 逐个 size-check，dispatch 后按各 task 结果返回顺序逐个执行 `task-context.mjs log-dispatch`（记录 agent/mode/stage，transition-check provenance gate 在 PLANNING→EXECUTING / EXECUTING→QUALITY / QUALITY→DELIVERING 边校验必经智能体是否派发过——缺则 `[PROCESS_VIOLATION]`）；task 返回 >4000 字符 → `overload_count++`，`>=3` → 同样先摘要压缩，仍超限才切 agent_manager worktree。委派智能体原则上都是核心摘要，禁止传文件具体内容（来源：`agent/conductor.md` 铁律 #6）。四连门禁（step 0b dispatch-prompt-check 事前审计 + step 0a size-check + step 1 log-dispatch 事后 provenance + step 2 累计 overload_count）把"防 abort"从文字铁律升级为脚本强制的机械门禁。主会话 read 局部化（offset/limit 分段，禁整文件 read）。
