# AGENTS.md

> Kilo 通过 `findUp` 自动发现本文件作为**唯一全局指令入口**。通用规则由 Kilo 运行时自动注入 `core.md` + `workflow-core.md` + `reflection.md`。本文件只列锚点名称与规则来源；细则按需读取 `.kilo/instructions/*.md`、各 `agent/*.md`、`lifecycle/graph.yaml` + `lifecycle/stages/*.md`，不在此重复展开。
> - `.kilo/instructions/core.md` — 通用基线、意图分类、安全约束、资源与生命周期管理；`workflow-core.md` — 执行类任务定级（T0–T3）、单元闭环、门禁、交付、强制流程日志；`reflection.md` — 反思与错误恢复规则
> - `agent/*.md` — 智能体行为 + frontmatter 生命周期声明（v6 单源，丢文件即注册）；`lifecycle/graph.yaml` + `lifecycle/stages/*.md` — 生命周期 DAG（纯拓扑）+ 阶段执行逻辑
> - `lifecycle/config.yaml` — 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）；`docs/model-registry.md` — 模型能力倾向矩阵（人类可读，v6.1 唯一能力参考）
> 仓库维护指南见 `CONFIG_CHANGE_CHECKLIST.md`。

## 强制编排锚点（每个项目启动时自动加载）

1. **意图判定优先**：先按 `core.md` 判定咨询类/执行类；咨询类只分析不改文件。
2. **两阶段定级**：A估T0-T3→planner设计门→B校准；review_mode 统一 full 四视角（`workflow-core.md`）。
3. **单元闭环**：T1+ 拆为可验证小单元，每单元独立 implementation→verification→repair 闭环（`workflow-core.md`）。
4. **验收必附映射表 + 已读取文件清单**：缺则 `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` FAIL。
5. **SCOPE_CREEP**：verification L2 反向核对 diff，命中即 FAIL。
6. **自验无效**：智能体不得以自身验证替代 verifier 客观验证。
7. **memory / skills / 自进化合规**：`.kilo/memory/` 模块由 README.md/AGENTS.md 统一管理，conductor 按模块入口按需注入；主通道 `python scripts/memory.py`；skill 频次写入 SQLite `skill_usage_events` 表，禁止 md append。
8. **流程违规即停**：发现跳步立即标 `[PROCESS_VIOLATION]` 并暂停。
9. **临时文件**：写入 `$env:TEMP` / `/tmp/`，禁止污染项目目录。
10. **组件化与重复模式治理**：同一实现模式 ≥2 处时按 `component-driven-fixes` skill 执行，禁止逐处复制粘贴（UI 与非 UI 同等适用）。
11. **生命周期驱动**：按 `lifecycle/graph.yaml` DAG + `stages/*.md` 阶段文件驱动状态流转，按 `agent/*.md` frontmatter `mount` 文件路由加载智能体；装配自检 `node scripts/lifecycle-doctor.mjs`。
12. **委派稳定性硬门**：一次只发起一个 `task`，禁止并行；task 调用必须是该响应最后一个动作（见 `guardrails.md` #44-#45）。
13. **委派包体积硬门**：委派包 prompt ≤1500 字符，subagent 返回 ≤2000 字符结构化摘要（见 `guardrails.md` #46-#47）。
14. **agent.prompt 非手动维护**：单源 = `agent/*.md` frontmatter `description`；`install.ps1` 调用 `sync-agent-prompt.mjs` 自动生成 `kilo.json` `agent.*.prompt`。禁止手工编辑。
15. **生命周期架构 + hooks 挂载机制不可变**：禁止擅自删除/重命名 graph.yaml 节点/edges；禁止绕过 stages frontmatter `required_roles`；禁止绕过 QUALITY hooks 循环（`verify → fix → review → fix`）。

## Guardrails（负面约束速查）见 .kilo/instructions/guardrails.md。
