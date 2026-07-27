# lifecycle/stages — 阶段执行逻辑导航

> **本目录只是执行逻辑文档，不是图结构**。流转关系（节点/边/条件/门禁）的单一真相来源是 `lifecycle/graph.yaml`（T3 子图：`lifecycle/multimodel-graph.yaml`）。修改流转不要改本目录，改 graph.yaml。

## 目录结构

```
lifecycle/
├── graph.yaml              # 主 DAG：节点（含 required 必配角色）+ 边 + 流转条件（纯图，无执行逻辑）
├── multimodel-graph.yaml   # T3 multiModel 子图 DAG + diversity_rule 多样化硬规则
├── config.yaml             # 定级默认智能体组合 + 用户覆盖 + 熔断阈值（唯一真相）
└── stages/                 # 阶段执行逻辑（本目录，文件名派生节点 ID）
    ├── intent.md           # INTENT        — conductor 内建
    ├── sizing.md           # SIZING        — conductor 内建
    ├── planning.md         # PLANNING      — graph required: planner
    ├── executing.md        # EXECUTING     — graph required: coder
    ├── checking.md         # CHECKING      — graph required: verifier（+reverse-auditor 可选）
    ├── reviewing.md        # REVIEWING     — graph required: reviewer（+side-checker 可选）
    ├── fixing.md           # FIXING        — graph required: fixer
    └── delivering.md       # DELIVERING    — conductor 内建

agent/                      # 智能体行为文件 + 生命周期声明（v6 单源：manifest 已合入 frontmatter）
├── conductor.md            # frontmatter: type:primary / forbid_write
├── multiModel.md           # frontmatter: type:lifecycle_provider / subgraph / handoff / invariants
├── planner.md              # frontmatter: mount: PLANNING + task_context + gate
├── coder.md                # frontmatter: mount: EXECUTING + task_context
├── verifier.md             # frontmatter: mount: CHECKING+MM_CHECKING+MM_FCHECK + isolation
└── ...                     # 每个智能体一个 .md，丢文件即注册（类似 Next.js 文件路由）
```

## 阶段索引

| 阶段 ID | 文件 | 必配角色（graph.yaml `required`） | 质量门禁 |
|---------|------|-----------------------------------|----------|
| INTENT | `intent.md` | conductor 内建 | 类型明确 |
| SIZING | `sizing.md` | conductor 内建 | T0-T3 准确 + 写入 `config.agents` |
| PLANNING | `planning.md` | `planner` | `[DESIGN_GATE_PASS]` |
| EXECUTING | `executing.md` | `coder` | 验收映射表 + 三件套 |
| CHECKING | `checking.md` | `verifier`（+ `reverse-auditor` 可选） | 正向+反向 PASS |
| REVIEWING | `reviewing.md` | `reviewer`（+ `side-checker` 可选） | 侧向+审查四视角通过 |
| FIXING | `fixing.md` | `fixer` | 根因确认 + 验证通过 |
| DELIVERING | `delivering.md` | conductor 内建 | `[MISSING_MEMORY_WRITE]` 检查 |

## 文件路由挂载机制（唯一挂载方式）

**挂载点命名空间（派生，零声明——节点存在即挂载点存在）**：

| 挂载点 | 触发时机 |
|------|----------|
| `on:bootstrap` | 装配完成后、INTENT 前（任务启动挂载点） |
| `pre:<STAGE>` | 阶段主槽执行前 |
| `<STAGE>` | 阶段主槽（阶段本体；`executor:` 内建阶段由 conductor/multiModel 占据） |
| `post:<STAGE>` | 阶段主槽执行后、edges 流转前 |
| `on:done` | DELIVERING 完成后、DONE 前（收尾挂载点） |

> 子图节点（MM_*）同样派生 `pre:`/主/`post:` 三挂载点。

**frontmatter 声明（每个智能体 .md 自注册，可挂载一个或多个点）**：

```yaml
# agent/verifier.md frontmatter 片段
mount:
  - at: CHECKING                    # 挂载点（命名空间派生）
    order: 10                       # 可选：同挂载点执行顺序（升序）；省略 = 并行组
    when: "config.agents.verifier"  # 可选：条件挂载（SIZING 写入的开关求值）
    on_fail: warn                   # 可选：abort|warn|skip（pre:/post:/on: 默认 warn）
```

- **同挂载点多个智能体**：多个 agent .md frontmatter 声明同一 `at` 即可；都省略 `order` = 并行组（视角隔离场景必须如此，不得声明 order）。
- **顺序调整**：只改 frontmatter 的 `order` 数字——加新智能体用中间号（如 15 插在 10/20 间），**零改其他文件**。
- **`when` 条件语法**：`config.agents.<key>` 由 conductor 在 SIZING 按 `lifecycle/config.yaml` 的 `tier_defaults` + 用户显式覆盖写入；无 `when` = 必加载。
- **必配角色校验**：graph.yaml 节点 `required: [role...]` 声明该主槽必须覆盖的角色（结构层不变量）；bootstrap/校验器静态预演——无 agent frontmatter 在该主槽挂载该角色 → 装配失败。加可选智能体不碰 graph.yaml；加必配智能体才动一行。

## 扩展指南（插拔式，文件制自动注册）

| 场景 | 操作 |
|------|------|
| 新增智能体 | 丢 `agent/<name>.md`（行为 + frontmatter `mount` 声明挂载点 + order/when）——**一个文件搞定，无需 manifest，无需改任何阶段文件**；若该智能体是某阶段必配角色，graph.yaml 该节点 `required` 加一行 |
| 挂载到任意阶段 | frontmatter `mount` 加一条 `{at: <STAGE>}`（主槽）或 `pre:<STAGE>` / `post:<STAGE>`；启动/收尾：`on:bootstrap` / `on:done` |
| 一槽挂载多个 | 多个 agent .md frontmatter 声明同一 `at`；都省略 `order` 默认并行 |
| 调整执行顺序 | frontmatter mount 条目改 `order` 数字（升序执行；加新智能体用中间号零改其他文件） |
| 新增阶段 | ① 丢 `lifecycle/stages/<name>.md`（frontmatter 只需 description/model_capability/token_budget；文件名派生节点 ID）② `graph.yaml` 加 node（含 `required`）+ edges（语义 ID，无占号问题）——三挂载点自动派生 |
| 禁用智能体 | `config.yaml` `overrides.disabled_agents` 加名字（若为某节点 `required` → `[ASSEMBLY_FAIL]`） |
| 换模型 | 改 `kilo.json agent.<name>.model`（能力倾向参考 `docs/model-registry.md` 人工维护，无机械校验） |
| 改定级默认组合 | 改 `config.yaml` `tier_defaults` |

## 核心原则

1. **图与执行分离**：graph.yaml 只有节点/边/条件/required；stages/*.md 只有输入/处理/输出信号。
2. **一智能体一文件（v6 单源）**：智能体的行为描述与生命周期声明（mount/task_context/isolation/gate）合入 `agent/<name>.md` frontmatter，manifest 与行为文件合二为一——**丢一个 .md 文件即自动注册**，类似 Next.js/Nuxt 文件路由。graph.yaml 节点 `required` 声明结构层必配角色（单源）；bootstrap 负责注册、排序与覆盖校验。路由目标（阶段）不需要知道谁挂上来。
3. **语义 ID**：阶段/节点 ID 用语义名（INTENT/SIZING/…），禁止数字前缀——插入不存在占号。
4. **质量门禁不可跳过**：`[DESIGN_GATE_PASS]`、verifier PASS、reviewer 通过、`[MISSING_MEMORY_WRITE]` 都是硬门。
5. **挂载点派生零声明**：节点存在即挂载点存在（`pre:`/主/`post:` + `on:bootstrap`/`on:done`），graph 无需声明挂载点。
6. **顺序自包含**：order 数字在 agent .md frontmatter 自己的文件里，无跨文件引用——改顺序只动一个文件。