# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。
>
> **路径解析语义**：本文件运行时位于全局配置根目录 ~/.config/kilo/（Windows: C:\Users\<用户名>\.config\kilo\）。本文件内所有被引用路径（agent/*.md、lifecycle/、.kilo/instructions/*.md、docs/）均以**全局配置根目录**为解析基准，不以当前项目工作目录为基准。
>
> **Overlay 规则**：项目级同名文件覆盖全局版（如项目根有 `agent/` 目录则优先用项目级）；项目级不存在的文件自动回落到全局配置根目录读取。
> 通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件作为**唯一全局指令入口**，只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类、安全约束、资源与生命周期管理
> - `.kilo/instructions/skills-lifecycle.md` — skill 能力扩展治理（按需引用，不自动注入）
> - `.kilo/instructions/reflection.md` — 反思与错误恢复规则
> - `.kilo/instructions/coding-engineering.md` — 编码工程化标准（设计模式、组件化、反模式检测、落地流程；按需引用）
> - `.kilo/instructions/byte-level-verify.md` — byte-level 验证 SOP（反 subagent 虚报）
> - `.kilo/instructions/workflow-reference.md` — 工作流参考（small_model 触发、需求扩散与同类点扫描）
> - `.kilo/instructions/output-schema.md` — 统一交付输出规范（最小公共字段、PASS/FAIL 结论、覆盖矩阵与标记语言）
> - `.kilo/instructions/security-checklist.md` — 安全与性能检测项清单（SECURITY_GAP 标记）
> - `agent/*.md` — 各智能体工作说明书 + frontmatter 生命周期声明（v6 单源：mount/task_context/isolation/gate 合入 frontmatter）。**不在此枚举智能体清单**——新增智能体 = 丢 `agent/<name>.md` + `kilo.json` 绑模型，零改框架。注册清单见 `node scripts/lifecycle-doctor/index.mjs`
> - `lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯图，语义 ID）+ 阶段执行逻辑（状态机主线索）
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）
> - `docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考）
> - `knowledge-base/index.md` + `knowledge-base/fixes/*.md` — 跨项目故障-根因-修复经验库（相对路径 `knowledge-base/`，解析基准为全局根 `~/.config/kilo/`，任何项目 findUp 读到同一份，非项目级；细则见 reflection.md）
>
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。
> 以上路径如无特别说明，均从全局配置根目录 `~/.config/kilo/` 解析；项目级同名文件覆盖全局版（overlay 语义），项目级不存在时自动回落全局。

## 强制编排锚点（每个项目启动时自动加载）

本文件只列锚点名称与规则来源，细则不重复写入。所有智能体必须遵守：

1. **意图判定优先**：先按 `core.md` 判定「咨询类 / 执行类」；intent 参与路由与产物形态标记。
2. **执行类两阶段定级**：阶段 A 预估 → planner 设计门 → 阶段 B 校准 → 强制流程日志（T0=2 节点；T1+=5 阶段；T1 按强度分流，判定见 `init.md §2b`）。
3. ~~定级两阶段化~~：已并入锚点 2。
4. **单元闭环**：T1+ 拆可验证小单元，每单元独立 implementation → verification → repair 闭环（来源 `workflow-detail.md §A`）。
5. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL（标记见 `output-schema.md §标记表`）。
6. **SCOPE_CREEP**：verification 能力 L2 反向核对 diff，命中即 `[SCOPE_CREEP]` FAIL（标记见 `output-schema.md §标记表`）。
7. **自验无效**：智能体不得以自身验证替代 verifier 客观验证。
8. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停（标记见 `output-schema.md §标记表`）。
9. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
10. **组件化与重复模式治理**：同一实现模式跨文件/模块出现时按 `core.md`「组件化优先」+ `workflow-core.md`「组件化 SOP」执行，禁止复制粘贴。UI 与非 UI 同等适用。
11. **生命周期驱动**：按 `lifecycle/graph.yaml` DAG + `lifecycle/stages/*.md` 驱动状态流转，按 `agent/*.md` frontmatter `mount` 路由加载智能体，模型绑定 `kilo.json`。装配自检 `node scripts/lifecycle-doctor/index.mjs`。
12. **委派并行优先策略**：挂载点激活智能体 ≥2 且无 `after` 依赖时，单条响应并行发起多个 `task`（须为该响应最后动作）。细则见 `agent/conductor.md §全局默认并行策略`。
13. **工程化防 abort 门禁**：运行时机械强制，完整 step 0/1/2 + 并行安全边界见 `agent/conductor.md` 铁律 #9，本文件不重复展开。
14. **EXECUTING 逐单元派发**：conductor 按 `plan.task_dag.units` 逐单元派发 task（委派包见 `agent/conductor.md` 铁律 #6），禁止批量派发。
15. **搜索四层阶梯纪律**：L0 文档 → L1 Glob → L2 窄搜（include 限定）→ L3 广搜（全仓 Grep 无 include 视为违规）→ L4 MCP 图谱/索引；跳级标 `[SEARCH_LADDER_VIOLATION]`（见 `workflow-core.md §Trace-First + §MCP 优先`）。
16. **当前会话优先策略**：保持上下文连贯，避免自动开新会话。配套要求（阈值单源见 `lifecycle/config.yaml`）：
    - 主动 compaction：上下文超阈值时主动 `/compact` / `<leader>c`，不等被动触发
    - 严格委派包：单次 dispatch prompt 上限见 `lifecycle/config.yaml` `dispatch_prompt_threshold`
    - subagent 返回超角色上限 → `[RETURN_OVER_LIMIT]` 重派（分档见 `output-schema.md §返回超限约束`）
    - worktree 兜底保留：仅在主会话 context 撑爆时作为防 abort 最后防线，不主动禁用
