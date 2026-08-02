# lifecycle/stages — 阶段执行逻辑导航

> **本目录只是执行逻辑文档，不是图结构**。流转关系（节点/边/条件/门禁）的单一真相来源是 `lifecycle/graph.yaml`。修改流转不要改本目录，改 graph.yaml。

## 目录结构

```
lifecycle/
├── graph.yaml              # 主 DAG：纯拓扑（节点 id/type/executor/on_fail + 边 + 流转条件）——稳定大框架，零智能体名
├── config.yaml             # 定级差异化开关 + 用户覆盖 + 熔断阈值 + hooks 级熔断（唯一真相）
└── stages/                 # 阶段语义（本目录，文件名派生节点 ID）：执行逻辑 + frontmatter required_roles 契约
    ├── intent.md           # INTENT        — conductor 内建
    ├── sizing.md           # SIZING        — conductor 内建
    ├── planning.md         # PLANNING      — required_roles: [planner]
    ├── executing.md        # EXECUTING     — required_roles: [coder]
    ├── quality.md          # QUALITY       — v2 响应式 Hooks 阶段；required_roles: [verifier, reviewer]
    ├── parallel_execution.md  # PARALLEL_EXECUTION — conductor 内建（T3 worktree 端到端副本竞赛）
    ├── synthesizing.md     # SYNTHESIZING  — conductor 内建（T3 选优合并）
    └── delivering.md       # DELIVERING    — conductor 内建
```

## 阶段索引

| 阶段 ID | 文件 | 必配角色 | `on_fail` | 质量门禁 |
|---------|------|----------|-----------|----------|
| INTENT | `intent.md` | conductor 内建 | `pause` | 类型明确 |
| SIZING | `sizing.md` | conductor 内建 | `pause` | T0-T3 准确 + 写入 `config.agents` 差异化开关 |
| PLANNING | `planning.md` | `planner` | `escalate` | post:PLANNING 挂载点审查（`on_fail: abort` 中止流转） |
| EXECUTING | `executing.md` | `coder` | `retry_once` | 验收映射表 + 三件套 |
| **QUALITY** | `quality.md` | `verifier` + `reviewer`（hooks 自动挂载） | `escalate` | hooks 全 PASS |
| PARALLEL_EXECUTION | `parallel_execution.md` | conductor | `escalate` | 3 worktree 副本完成 |
| SYNTHESIZING | `synthesizing.md` | conductor | `pause` | champion 选优 |
| DELIVERING | `delivering.md` | conductor 内建 | `pause` | `[MISSING_MEMORY_WRITE]` 检查 |

> **QUALITY 阶段内部 hooks**（详见 `quality.md`）：hook 类型定义执行顺序 `verify → fix → review → fix` 自动循环；同 hook 类型默认串行启动（无 `after` 时）；熔断阈值 `config.yaml hooks.quality.max_total_cycles`。

## 文件路由挂载机制（唯一挂载方式）

**挂载点命名空间（派生，零声明——节点存在即挂载点存在）**：

| 挂载点 | 触发时机 |
|------|----------|
| `on:bootstrap` | 装配完成后、INTENT 前（任务启动挂载点） |
| `pre:<STAGE>` | 阶段主槽执行前 |
| `<STAGE>` | 阶段主槽（阶段本体；`executor:` 内建阶段由 conductor 占据） |
| `post:<STAGE>` | 阶段主槽执行后、edges 流转前 |
| `on:done` | DELIVERING 完成后、DONE 前（收尾挂载点） |

**frontmatter 声明（每个智能体 .md 自注册，可挂载一个或多个点）**：

```yaml
mount:
  - at: QUALITY                   # 挂载点（命名空间派生）
    hook: verify                   # hook 类型：verify | review | fix（定义执行顺序，不需要编号）
    deps: ["execution.code", "plan"]  # 数据依赖：这些字段变化时自动触发
    after: [other-agent]           # 可选：在指定 agent 之后执行（相对依赖，类似 React hooks 声明顺序）；省略 = 串行启动组成员
    trigger: onChange              # 触发时机：onChange（默认）| afterPass | onFail
    when: "config.agents.reverse_auditor"  # 可选：条件挂载
    on_fail: degrade               # 可选：abort|warn|skip|degrade
```

- **`hook` 类型**：`verify`（验证）/ `review`（审查）/ `fix`（修复）；定义执行顺序，不需要绝对编号。
- **`after` 语义**：声明在哪些 agent 之后执行（类似 React hooks 声明顺序）；省略 = 串行组成员。框架自动 topo-sort，检测环依赖报错。
- **`when` 条件**：`config.agents.<key>` 由 conductor 在 SIZING 按 `lifecycle/config.yaml` 的 `tier_defaults` + 用户显式覆盖写入；无 `when` = 恒定挂载（图拓扑可达即加载——推荐默认，新增智能体零配置）。
- **必配角色校验**：阶段必配角色契约在 `stages/<id>.md` frontmatter `required_roles`；角色名 = 智能体文件名（去 .md）或其 frontmatter 显式 `role` 字段。bootstrap/doctor 静态预演——无智能体在该主槽履行该角色 → `[ASSEMBLY_FAIL]`。**graph.yaml 永不出现角色名/智能体名**。

## 扩展指南（插拔式，文件制自动注册）

| 场景 | 操作 |
|------|------|
| **新增智能体** | ① 丢 `agent/<name>.md`（行为 + frontmatter `mount` 声明 + task_context 读写）② `kilo.json` 加 `agent.<name>.model`——**两步搞定，graph.yaml / config.yaml / stages / 脚本全都不动**（WRITE_MATRIX 自动派生；超时回退 stage_default_s；无 when = 恒定挂载拓扑可达即加载） |
| 新增"同阶段按 tier 差异化"的可选视角 | 丢 agent 文件（mount 带 `when: "config.agents.<key>"`）+ `config.yaml tier_defaults` 各 tier 加开关一行 |
| 引入新角色并设为某阶段必配 | 丢 agent 文件 + 该阶段 `stages/<id>.md` frontmatter `required_roles` 加一行（阶段语义变化，内聚；**graph.yaml 仍不动**） |
| 多智能体履行同一角色 | 新 agent frontmatter 显式 `role: <角色名>`（缺省 role = 文件名）；required_roles 校验按 role 匹配 |
| 挂载到任意阶段 | frontmatter `mount` 加一条 `{at: <STAGE>}`（主槽）或 `pre:<STAGE>` / `post:<STAGE>`；启动/收尾：`on:bootstrap` / `on:done`；可选视角加 `on_fail: degrade` |
| 一槽挂载多个 | 多个 agent .md frontmatter 声明同一 `at` + `hook`；都省略 `after` 默认串行启动 |
| 调整执行顺序 | frontmatter mount 条目声明 `after: [agent-name]`（相对依赖，只引用前驱；框架自动 topo-sort） |
| 新增阶段 | ① 丢 `lifecycle/stages/<name>.md`（frontmatter + 文件名派生节点 ID）② `graph.yaml` 加 node + edges——三挂载点自动派生 |
| 改阶段失败策略 | `graph.yaml` 节点 `on_fail` 字段改值（abort/retry_once/degrade/escalate/pause） |
| 改超时预算 | `lifecycle/config.yaml` `timeouts` 段：`per_agent_s` 调单智能体预算（缺省回退 stage_default_s），`per_tier_multiplier` 调定级系数 |
| 禁用智能体 | `config.yaml` `overrides.disabled_agents` 加名字（若使某 `required_roles` 角色无履行者 → `[ASSEMBLY_FAIL]`） |
| 换模型 | 改 `kilo.json agent.<name>.model`（能力倾向参考 `docs/model-registry.md` 人工维护，无机械校验） |
| 改定级差异化开关 | 改 `config.yaml` `tier_defaults` |
| **装配自检** | `node scripts/lifecycle-doctor.mjs [--verbose]`——改完任何 lifecycle/agent 配置后跑一遍，全 PASS 才算完 |

## 核心原则

1. **图与执行分离 + 三层正交**：graph.yaml 纯拓扑（零智能体名，稳定大框架）；stages/*.md 阶段语义（输入/处理/输出 + `required_roles` 契约）；agent/*.md 智能体（行为 + 挂载）。增删智能体不动框架。
2. **一智能体一文件（v6 单源）**：智能体的行为描述与生命周期声明（mount/task_context/isolation/gate）合入 `agent/<name>.md` frontmatter，manifest 与行为文件合二为一——丢一个 .md 即自动注册，类似 Next.js/Nuxt 文件路由。
3. **语义 ID**：阶段/节点 ID 用语义名（INTENT/SIZING/…），禁止数字前缀——插入不存在占号。
4. **质量门禁不可跳过**：hooks 全 PASS、`[MISSING_MEMORY_WRITE]` 都是硬门。
5. **挂载点派生零声明**：节点存在即挂载点存在（`pre:`/主/`post:` + `on:bootstrap`/`on:done`），graph 无需声明挂载点。
6. **顺序自包含**：`after: [agent-name]` 在 agent .md frontmatter 自己的文件里，只引用前驱 agent 名——改顺序只动一个文件（类似 React hooks 声明顺序，非绝对编号）。
7. **权限派生化**：task_context 写权限矩阵（WRITE_MATRIX）由 `scripts/task-context.mjs` 从 frontmatter 自动派生；安全硬门（verification 双字段仅 verifier、quality 双字段仅 hooks 写入、quality.round 仅 conductor）保留脚本硬编码——插拔自由与框架安全不变量分离。
8. **装配可机检**：`scripts/lifecycle-doctor.mjs` 是 `[ASSEMBLY_FAIL]` 校验的可执行实现——配置健康有机械化守卫，不靠人工核对。