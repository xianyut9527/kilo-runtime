# lifecycle/stages — 阶段执行逻辑导航

> **本目录只含阶段执行逻辑与 `required_roles` 契约。流转关系（节点/边/条件/门禁）的单一真相来源是 `lifecycle/graph.yaml`。扩展指南见 `CONFIG_CHANGE_CHECKLIST.md`。**

## 目录结构

| 文件 | 阶段 | 说明 |
|------|------|------|
| `intent.md` | INTENT | conductor 内建 |
| `sizing.md` | SIZING | conductor 内建 |
| `planning.md` | PLANNING | required_roles: [planner] |
| `executing.md` | EXECUTING | required_roles: [coder] |
| `quality.md` | QUALITY | v2 响应式 Hooks；required_roles: [verifier, reviewer] |
| `parallel_execution.md` | PARALLEL_EXECUTION | conductor 内建（T3 worktree 并行） |
| `synthesizing.md` | SYNTHESIZING | conductor 内建（T3 选优合并） |
| `delivering.md` | DELIVERING | conductor 内建 |