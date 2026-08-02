# Guardrails（Kilo 专属硬约束速查）

> 通用编码习惯说教已删除。仅保留 Kilo 框架运行时独有的硬约束。

1. **委派稳定性硬门（防 Tool execution aborted）**：一次只发起一个 `task`，禁止同一响应内并行发起多个 task；task 调用必须是该响应最后一个动作（`AGENTS.md` 锚点 12）。
2. **委派包体积硬门（防 context 撑爆 abort）**：委派包 prompt ≤1500 字符，subagent 返回 ≤2000 字符结构化摘要，主会话 read 局部化（`AGENTS.md` 锚点 13）。
3. **agent.prompt 非手动维护**：单源 = `agent/*.md` frontmatter `description`；`install.ps1` 调用 `sync-agent-prompt.mjs` 自动生成 `kilo.json` `agent.*.prompt`。禁止手工编辑（`AGENTS.md` 锚点 14）。
4. **生命周期架构 + hooks 挂载机制不可变**：禁止擅自删除/重命名 `lifecycle/graph.yaml` 节点或 edges；禁止绕过 `lifecycle/stages/*.md` frontmatter `required_roles` 必配角色契约；禁止擅自修改 `mount` 挂载命名空间（`AGENTS.md` 锚点 15）。
5. **硬 token 预算**：每个循环设上限（per_loop_max=160K，per_agent_prompt_max=1500，per_agent_return_max=2000）。
6. **禁止凭记忆维护系统状态**：把派生上下文持久化到 task_context。
7. **禁止给进程/服务超过其需要的权限**：最小权限原则。
8. **不要在代码里硬编码密钥**。
