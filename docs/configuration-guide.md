# 配置指南（快速上手）

> **目标读者**：需要新增/修改智能体、调整生命周期流转、绑定模型、定制定级行为的人。
> **设计理念**：文件制自动注册路由——丢一个文件即自动注册，类似 Next.js/Nuxt 文件路由。同一信息不在多处重复声明。反对"傻傻一个个配"——按定级批量声明组合。
> **版本**：v6.1 单源（manifest 合入 `agent/*.md` frontmatter，`capabilities.yaml` 已删除——能力匹配靠人类维护 `docs/model-registry.md`）

---

## 0. 30 秒速查：我要做什么？

| 我要… | 改哪个文件 | 不动什么 |
|--------|-----------|---------|
| 新增一个智能体 | ① `agent/<name>.md`（含 frontmatter）② `kilo.json` `agent.<name>` 绑定模型 | `graph.yaml`（除非新增必配角色） |
| 改某智能体的模型 | `kilo.json` `agent.<name>.model` | 其他全不动 |
| 改某智能体的挂载点/读写边界 | `agent/<name>.md` frontmatter | `kilo.json`、`graph.yaml` |
| 新增一个生命周期阶段 | ① `graph.yaml` 加 node + edges ② `lifecycle/stages/<name>.md` 写执行逻辑（文件名派生节点 ID） | `agent/*.md`（除非要挂载新智能体） |
| 改阶段流转条件 | `graph.yaml` edges 的 `when`/`gate` | 其他全不动 |
| 调整定级默认加载哪些智能体 | `lifecycle/config.yaml` `tier_defaults` | `agent/*.md`、`graph.yaml` |
| 新增一个模型 | `kilo.json` `provider.hx.models`（能力倾向可同步记入 `docs/model-registry.md` 供人类参考） | `agent/*.md` |
| 临时禁用某智能体 | `lifecycle/config.yaml` `overrides.disabled_agents` | `agent/*.md`、`kilo.json` |
| 改熔断阈值 | `lifecycle/config.yaml` `convergence`（**唯一真相**） | 其他全不动 |

---

## 1. 文件全景图

```
kilo_config/
├── kilo.json                              # 模型绑定（agent.<name>.model）+ provider 模型清单
├── agent/                                 # 智能体行为文件（一智能体一文件，frontmatter 自注册）
│   ├── conductor.md                       #   编排者（type: primary，内建执行，无 mount）
│   ├── multiModel.md                      #   T3 子图编排者（type: lifecycle_provider，无 mount）
│   ├── planner.md                         #   规划（mount: PLANNING）
│   ├── coder.md                           #   编码（mount: EXECUTING）
│   ├── verifier.md                        #   正向验证（mount: CHECKING + MM_CHECKING + MM_FCHECK）
│   ├── reverse-auditor.md                 #   反向审计（mount: CHECKING, when: ...）
│   ├── side-checker.md                    #   侧向验证（mount: REVIEWING, when: ...）
│   ├── reviewer.md                        #   静态审查（mount: REVIEWING）
│   ├── fixer.md                           #   修复（mount: FIXING, when: ...）
│   ├── coder-a.md                         #   multiModel 逻辑推理派（mount: MM_EXECUTING）
│   ├── coder-b.md                         #   multiModel 安全边界派（mount: MM_EXECUTING）
│   ├── coder-c.md                         #   multiModel 代码生成派（mount: MM_EXECUTING）
│   └── synthesizer-fusion.md              #   融合编辑（mount: MM_FUSING, when: ...）
├── lifecycle/
│   ├── graph.yaml                         # 主生命周期 DAG（节点 + 边 + 流转条件）
│   ├── multimodel-graph.yaml              # T3 子图 DAG（含 diversity_rule 多样化硬规则）
│   ├── config.yaml                        # 定级默认组合 + 用户覆盖 + 熔断阈值（唯一真相）
│   └── stages/                            # 阶段执行逻辑（一阶段一文件，文件名派生节点 ID）
│       ├── intent.md                      #   意图判定 → INTENT
│       ├── sizing.md                      #   任务定级 → SIZING
│       ├── planning.md                    #   设计门 → PLANNING
│       ├── executing.md                   #   实现 → EXECUTING
│       ├── checking.md                    #   正向+反向验证 → CHECKING
│       ├── fixing.md                      #   修复 → FIXING
│       ├── reviewing.md                   #   侧向+审查 → REVIEWING
│       └── delivering.md                  #   交付（记忆写入 + 分支收尾）→ DELIVERING
├── docs/
│   ├── configuration-guide.md             # ← 本文件
│   ├── multi-agent-lifecycle-architecture.md  # 架构设计文档（历史 + 现状）
│   ├── model-registry.md                  # 模型能力倾向人类可读版（人工维护）
│   └── memory-ops-reference.md            # 记忆操作 SQL 模板
└── validate-config.mjs                    # 配置校验脚本（29 项检查）
```

### 信息归属表（单一真相原则）

| 信息 | 唯一声明位置 | 其他位置只能引用，不得重复声明 |
|------|-------------|------------------------------|
| 智能体行为 + 生命周期路由 | `agent/<name>.md` frontmatter | `conductor.md` 矩阵表是派生展示 |
| 模型绑定 | `kilo.json` `agent.<name>.model` | agent .md 不写模型 ID |
| 模型能力倾向 | `docs/model-registry.md`（人类维护） | 无机器可读副本（v6.1 删除 `capabilities.yaml`，无机械校验） |
| 图结构（节点/边/流转） | `lifecycle/graph.yaml` | `stages/*.md` 只写执行逻辑，不重复图结构 |
| 定级→智能体组合 | `lifecycle/config.yaml` `tier_defaults` | `conductor.md` 不硬编码组合 |
| 熔断阈值 | `lifecycle/config.yaml` `convergence`（唯一真相） | `graph.yaml` 不再重复声明 |
| 多样化硬规则 | `lifecycle/multimodel-graph.yaml` `diversity_rule` | `docs/model-registry.md` 是人类可读说明 |

---

## 2. agent/*.md frontmatter 字段详解

每个智能体文件以 YAML frontmatter（`---` 块）开头，分两部分：
- **Kilo 原生字段**：`description`/`mode`/`hidden`/`color`/`steps`/`permission`/`subagent_type`
- **生命周期字段**（`# ---- 生命周期元数据 ----` 注释分隔）：`type`/`mount`/`task_context`/`isolation`/`gate`/`diversity_role`/`subgraph`/`handoff`/`invariants`/`forbid_write`

### 完整字段参考（以 verifier.md 为例）

```yaml
---
# ===== Kilo 原生字段 =====
description: 正向验证智能体。按验收标准逐条验证...
mode: subagent              # primary | subagent
hidden: true                # subagent 通常 hidden:true（不在 /agents 列表显示）
color: "#F59E0B"            # UI 颜色标签
steps: 80                   # 最大步数
permission:                 # 工具权限
  bash: allow
  read: allow
  edit: deny                # verifier 只读不写（只验证不修复）
  task: deny                # subagent 不得再派 subagent
  glob: allow
  grep: allow
subagent_type: verifier     # task 工具的 subagent_type 参数值

# ===== 生命周期字段（bootstrap 扫此部分自动注册）=====

# type：智能体类型（决定是否经 mount 挂载）
#   primary            - 编排者，内建执行，不经 mount（conductor）
#   lifecycle_provider - 特殊 primary，自带子图（multiModel）
#   (省略)             - subagent，由编排者经 task 工具按 mount 挂载启动
# verifier 是 subagent，省略 type

# 模型绑定在 kilo.json agent.<name>.model；能力倾向参考 docs/model-registry.md 人类维护
# bootstrap 不做能力匹配机械校验

# mount：挂载点声明（可挂一个或多个点）
#   每个条目是一个挂载点，字段：
#     at       挂载点名称（派生自 graph.yaml 节点，见下方"挂载点命名空间"）
#     when     可选条件挂载（对照 task_context.config.agents.<key> 求值）
#              省略 = 必加载（但受阶段可达性约束——T0 不经过 CHECKING，verifier 自然不加载）
#     order    可选顺序号（同挂载点升序执行）；省略 = 并行组成员
#     on_fail  可选失败策略（abort|warn|skip）；pre:/post:/on: 默认 warn
mount:
  - at: CHECKING               # 无条件：CHECKING 仅 T1+ 可达（可达性即开关）
  - at: MM_CHECKING            # 一智能体可挂载多槽（同时在 multiModel 子图挂载）
  - at: MM_FCHECK

# task_context：读写边界声明（bootstrap 注入上下文切片 + 运行时强制隔离）
#   read        可读的 task_context 切片
#   write       可写的 task_context 切片
#   forbid_write 禁写切片（即使 write 声明了也会被过滤）
task_context:
  read: [plan, execution.diffs, execution.changes, execution.acceptance_map, forbidden_files]
  write: [verification.forward]      # execution.verification 唯一写入者（写入边界硬门）

# isolation：视角物理隔离声明（防止确认偏误）
#   forbid_read  禁止读取的 task_context 切片（即使 task_context.read 声明了也会被过滤）
isolation:
  forbid_read: [execution.verification, fixing_history]   # 视角物理隔离

# gate：本智能体输出须通过的质量门禁（对应 graph.yaml edge 的 gate 字段）
# 仅 synthesizer-fusion（FUSION_SELF_CHECK_10）使用
# gate: FUSION_SELF_CHECK_10
---
```

### 挂载点命名空间（派生，零声明）

挂载点由 `graph.yaml` 节点自动派生——节点存在即挂载点存在，无需在别处声明：

| 挂载点格式 | 含义 | 典型用途 |
|-----------|------|---------|
| `on:bootstrap` | 装配完成后、INTENT 前 | 任务启动钩子 |
| `on:done` | DELIVERING 完成后、DONE 前 | 收尾钩子 |
| `pre:<NODE>` | 节点主槽执行前 | 前置准备 |
| `<NODE>` | 节点主槽（阶段本体） | 阶段核心执行者 |
| `post:<NODE>` | 节点主槽执行后、edges 流转前 | 后置处理 |

> **主槽占用规则**：`executor: conductor` 或 `executor: multiModel` 的节点，主槽由编排者内建占据，外部智能体只能挂 `pre:`/`post:`。其他节点主槽由 `mount: at: <NODE>` 的智能体填充。

### order 与并行

- 同挂载点多个智能体 **默认并行**（不声明 order）
- 声明 `order: <数字>` 则按升序执行；加新智能体用中间号（如 15 插在 10/20 间）零改其他文件
- **视角隔离场景必须并行**（如 3 个 coder、verifier + reverse-auditor），不得声明 order

---

## 3. 场景演练

### 场景 A：新增一个智能体

**需求**：新增一个 `security-auditor` 智能体，在 REVIEWING 阶段做安全专项审计，仅 T2+ 加载。

**步骤**：

1. **创建行为文件** `agent/security-auditor.md`：

```yaml
---
description: 安全审计智能体。专项检查安全编码模式、权限边界、敏感数据流。只审计不修复。
mode: subagent
hidden: true
color: "#EF4444"
steps: 80
permission:
  bash: allow
  read: allow
  edit: deny
  task: deny
  glob: allow
  grep: allow
subagent_type: security-auditor

# ---- 生命周期元数据 ----
# 模型绑定在 kilo.json agent.security-auditor.model；能力倾向参考 docs/model-registry.md

mount:
  - at: REVIEWING
    when: "config.agents.security_auditor"     # 条件挂载

task_context:
  read: [execution.diffs, plan, project_context]
  write: [verification.security]               # 新切片

isolation:
  forbid_read: [verification.forward, verification.reverse, verification.review]
---

# security-auditor

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 智能体定位
...
```

2. **kilo.json 绑定模型**：

```json
"security-auditor": {
  "mode": "subagent",
  "model": "hx/glm-5.2",
  "prompt": "安全审计智能体..."
}
```

3. **config.yaml 加定级开关**（在 `tier_defaults` 的 T2/T3 加一行）：

```yaml
T2:
  agents:
    ...
    security_auditor: true      # ← 加这一行
```

4. **运行校验**：`node validate-config.mjs`

**不需要动**：`graph.yaml`（REVIEWING 节点已存在，挂载点派生即可用）、其他 agent .md。

> 如果该智能体是 REVIEWING 的**必配**角色（而非可选），才需要在 `graph.yaml` REVIEWING 节点 `required: [reviewer, security-auditor]` 加一行。

---

### 场景 B：新增一个生命周期阶段

**需求**：在 EXECUTING 和 CHECKING 之间加一个 `UNIT_TEST` 阶段。

**步骤**：

1. **graph.yaml 加节点 + 边**：

```yaml
nodes:
  ...
  - id: UNIT_TEST
    type: stage
    # 阶段文件路径自动派生：stages/unit-test.md（文件名 = 节点 ID 小写）
    required: [tester]          # 如果有必配智能体

edges:
  ...
  # 改原边 EXECUTING→CHECKING 为 EXECUTING→UNIT_TEST→CHECKING
  - from: EXECUTING
    to: UNIT_TEST
    when: "tier in ['T1','T2']"
  - from: UNIT_TEST
    to: CHECKING
    when: "unit_test_result == 'PASS'"
  - from: UNIT_TEST
    to: FIXING
    when: "unit_test_result == 'FAIL'"
```

2. **创建阶段文件** `lifecycle/stages/unit-test.md`（文件名派生节点 ID `UNIT_TEST`，写执行逻辑：输入/处理/输出信号）

3. **如果有新智能体**：按场景 A 创建 `agent/tester.md` + kilo.json 绑定

4. **运行校验**：`node validate-config.mjs`

---

### 场景 C：新增一个模型

**需求**：新增 `hx/qwen-3` 模型，打算用于 coder（倾向 code-generation）。

**步骤**：

1. **kilo.json provider.hx.models 加模型清单**：

```json
"qwen-3": {
  "name": "qwen-3",
  "reasoning": true,
  "limit": { "context": 200000, "output": 16384 }
}
```

2. **（可选）docs/model-registry.md 加能力倾向记录**（供人类选模型参考，无机械校验）：

```markdown
| hx/qwen-3 | code-generation, deep-reasoning | qwen | qwen-3 |
```

3. **绑定到智能体**（改 kilo.json `agent.<name>.model`）：

```json
"coder": {
  "model": "hx/qwen-3",    // ← 改这里
  ...
}
```

4. **运行校验**：`node validate-config.mjs`

**不需要动**：`agent/coder.md`、`graph.yaml`、`config.yaml`。

> v6.1 起 `capabilities.yaml` 已删除，bootstrap 不做能力匹配机械校验。能力倾向是 `docs/model-registry.md` 的人工维护参考，选模型时人类对照即可。

---

### 场景 D：调整定级默认组合

**需求**：让 T1 也加载 reverse-auditor（默认 T1 不加载）。

**步骤**：只改 `lifecycle/config.yaml`：

```yaml
tier_defaults:
  T1:
    agents:
      ...
      reverse_auditor: true      # ← 从 false 改为 true
```

**不需要动**：`agent/reverse-auditor.md`（mount 的 when 已对照 config.agents.reverse_auditor）、`graph.yaml`。

---

### 场景 E：临时禁用某智能体

**需求**：临时禁用 side-checker（所有定级都不加载）。

**步骤**：只改 `lifecycle/config.yaml`：

```yaml
overrides:
  disabled_agents: [side-checker]    # ← 加这里
```

> 如果该智能体是某节点 `required` → [ASSEMBLY_FAIL]（必配角色不能禁用）。side-checker 不是 required，可以禁用。

---

### 场景 F：改熔断阈值

**需求**：把单点修复熔断从 5 轮改为 3 轮。

**步骤**：改 `lifecycle/config.yaml`（**唯一真相**）：

```yaml
convergence:
  max_rounds: 3                # ← 从 5 改为 3
  max_total_rounds: 7
```

`graph.yaml` 不再重复声明 convergence（v6.1 删除展示副本）。

---

## 4. graph.yaml 字段详解

```yaml
# 节点字段
nodes:
  - id: PLANNING               # 节点 ID（大写蛇形语义名，禁数字前缀）
                                #   type: stage 的节点，执行逻辑文件路径自动派生：stages/<id 小写>.md
                                #   （PLANNING → stages/planning.md），无需 stage 字段
  - id: PLANNING
    type: stage                # virtual | stage | subgraph | terminal
    executor: conductor        # 内建执行者（conductor/multiModel）；声明后主槽不经 task 启动外部智能体
    required: [planner]        # 主槽必配角色列表（结构层不变量）；无 agent 挂载该角色 → [ASSEMBLY_FAIL]
    provider: multiModel       # subgraph 节点的子图提供者（对应 agent type: lifecycle_provider）
    graph: multimodel-graph.yaml  # subgraph 节点的子图 DAG 文件
    note: 人类可读说明         # 可选

# 边字段
edges:
  - from: PLANNING             # 起始节点 ID
    to: EXECUTING              # 目标节点 ID
    when: "tier in ['T1','T2']"  # 流转条件（对照 task_context 求值）；省略 = 无条件
    gate: MEMORY_WRITE_COMPLETE  # 可选：质量门禁（硬门，如 DELIVERING→DONE 记忆写入门）；省略 = 无门禁
    note: 人类可读说明         # 可选
```

### 节点类型

| type | 含义 | 有无阶段文件 | 挂载智能体 |
|------|------|------------|-----------|
| `virtual` | 占位（START） | 无 | 无 |
| `stage` | 阶段节点 | 有（`stages/<id 小写>.md`，文件名派生） | 有（主槽 + pre/post） |
| `subgraph` | 子图入口 | 无（子图有自己的 DAG） | 经 provider 路由 |
| `terminal` | 终态（DONE） | 无 | 无 |

### executor vs mount

- `executor: conductor` 的节点：主槽由 conductor 内建执行，外部智能体只能挂 `pre:`/`post:`
- `executor: multiModel` 的节点：同上
- 未声明 `executor` 的节点：主槽由 `mount: at: <NODE>` 的智能体填充（按 required 校验必配角色）

---

## 5. config.yaml 字段详解

```yaml
# tier_defaults：按定级 T0/T1/T2/T3 声明加载哪些智能体
# conductor 在 SIZING 阶段把对应 tier 的 agents 表写入 task_context.config.agents
# agent frontmatter 的 mount[].when 对照 config.agents.<key> 求值
tier_defaults:
  T0:
    agents:
      coder: true              # 布尔开关
    review_mode: none          # none | full
  T1:
    agents:
      planner: true
      coder: true
      verifier: true
      reviewer: true
      fixer: true
      reverse_auditor: false   # T2+ 才开
      side_checker: false      # T2+ 才开
      synthesizer_fusion: false  # 仅 T3
    review_mode: full
  T3:
    provider: multiModel       # T3 交给子图
    agents:
      synthesizer_fusion: true
    review_mode: full

# overrides：用户/环境覆盖（默认全空 = 全量自动发现注册）
overrides:
  disabled_agents: []          # 全局禁用的智能体名列表
  model_overrides: {}          # 覆盖 kilo.json 模型绑定
  condition_overrides: {}      # 强制覆盖 config.agents 开关

# convergence：收敛熔断阈值（唯一真相）
convergence:
  max_rounds: 5                # FIXING 单点熔断
  max_total_rounds: 7          # CHECKING+REVIEWING 累计全局熔断
```

### tier_defaults.agents 的 key 命名规则（自动派生）

key 是智能体文件名的 **下划线形式**（`reverse-auditor.md` → `reverse_auditor`），与 `config.agents.<key>` 求值路径一致。无需手写映射表，自动派生：

| agent 文件名 | config.agents key |
|-------------|-------------------|
| reverse-auditor.md | reverse_auditor |
| side-checker.md | side_checker |
| synthesizer-fusion.md | synthesizer_fusion |
| coder-a / coder-b / coder-c | （不单独开关，由 T3 provider 隐含） |
| coder / planner / verifier / reviewer / fixer | 同名（单词名直接用） |

---

## 6. multimodel-graph.yaml 字段详解（T3 子图）

```yaml
provider: multiModel          # 子图提供者
entry: MM_INIT                # 子图入口节点
exit: MM_ARCHIVED             # 子图出口节点

nodes:
  - id: MM_EXECUTING
    required: [coder-a, coder-b, coder-c]   # 3 coder 必配
    parallel: true                           # 并行执行（视角隔离）

# 多样化硬规则（v6.1 从原 capabilities.yaml 迁移至此——仅本子图使用）
diversity_rule:
  applies_to: [coder-a, coder-b, coder-c]
  dimensions:
    vendor: required         # 模型提供者两两不同
    architecture: required   # 模型架构两两不同
  on_violation: DIVERSITY_VIOLATION
```

### diversity_rule 校验逻辑

bootstrap 校验 coder-a/b/c 在 kilo.json 绑定模型的 `(vendor, architecture)` 两两不同。vendor/architecture 来源：`docs/model-registry.md` 人工维护（无机器可读副本）。违反 → `[DIVERSITY_VIOLATION]`。

> 人工对照流程：打开 `docs/model-registry.md` §模型清单，确认 coder-a/b/c 绑定的模型在"厂商"和"架构"两列两两不同。

---

## 7. task_context 切片清单

以下切片可在 agent frontmatter 的 `task_context.read`/`write`/`forbid_write` 和 `isolation.forbid_read` 中引用：

| 切片 | 写入者 | 语义 |
|------|--------|------|
| `intent` | conductor | 原始需求解析 |
| `sizing` | conductor | 任务定级结果 |
| `config` | conductor | 智能体开关组合 |
| `config.agents` | conductor | 各智能体布尔开关 |
| `plan` | planner | 设计方案 |
| `plan.subtasks` | planner/multiModel | 子任务拆分 |
| `execution` | coder/fixer | 执行产物 |
| `execution.diffs` | coder/fixer | 变更 diff |
| `execution.changes` | coder | 变更清单 |
| `execution.acceptance_map` | coder | 验收映射表 |
| `execution.mm_outputs` | coder-a/b/c | multiModel 3 份输出 |
| `execution.fused_output` | synthesizer-fusion | 融合后输出 |
| `execution.verification` | verifier | 验证结论（写入边界硬门：唯一写入者） |
| `verification.forward` | verifier | 正向验证结论 |
| `verification.reverse` | reverse-auditor | 反向审计结论 |
| `verification.side` | side-checker | 侧向验证结论 |
| `verification.review` | reviewer | 审查结论 |
| `verification.security` | (示例) security-auditor | 安全审计结论 |
| `forbidden_files` | conductor | 边界声明 |
| `fixing_history` | fixer | 修复历史 |
| `memory_injection` | conductor | 记忆召回注入 |
| `project_context` | conductor | 项目级安全约束/技术栈 |
| `acceptance_criteria` | planner | 验收标准 |
| `task_context.intent` | conductor | 原始需求（isolation 用） |
| `model_identities` | (系统) | 模型身份（isolation 用） |

### 写入边界硬门

`execution.verification` 字段**只能由 verifier 智能体写入**。coder/fixer 自验结果只能保留在智能体本地输出，不得写入 task_context。违反 → `[TRUST_TRANSFER]`。

---

## 8. 校验脚本

```bash
node validate-config.mjs
```

29 项检查覆盖：
- graph.yaml 节点/边引用完整性
- agent frontmatter 字段完整性 + mount 挂载点存在性
- graph 节点 required 角色被 agent mount 覆盖
- config.yaml tier_defaults 结构
- 残留 `lifecycle/agents/` 目录检测（防回退）
- 残留 `stage_id` / `capabilities_required` 字段检测（防回退）
- README 目录树一致性
- ... 等

**部署前必须全绿**（check17 环境问题除外）。

---

## 9. 常见错误诊断

| 错误码 | 含义 | 排查 |
|--------|------|------|
| `[ASSEMBLY_FAIL]` | 启动期装配失败 | 跑 `node scripts/lifecycle-doctor.mjs --verbose` 定位：agent frontmatter mount / stages required_roles 覆盖 / kilo.json 模型绑定 |
| `[DIVERSITY_VIOLATION]` | 3 coder 模型不满足多样化 | 检查 kilo.json coder-a/b/c 模型的 (vendor, architecture) 是否两两不同（对照 docs/model-registry.md） |
| `[PROCESS_VIOLATION]` | 流程违规（跳步/越权写） | 检查是否跳过必经阶段 / 是否越权写 execution.verification |
| `[TRUST_TRANSFER]` | 信任传递 | 检查验证智能体是否引用了其他视角结论而非独立验证 |
| `[SCOPE_CREEP]` | 越界修改 | 检查 coder/fixer 是否改了 forbidden_files 之外的文件 |
| `[CIRCUIT_BREAKER]` | 熔断 | 单点 5 轮 / 全局 7 轮，需人工决策 |
| `[MISSING_MEMORY_WRITE]` | 记忆写入缺失 | DELIVERING 阶段未执行 M4-M8 |

---

## 10. 设计理念总结

1. **文件制自动注册**：丢一个 `agent/<name>.md` 文件即自动注册，bootstrap 扫 frontmatter 发现——类似 Next.js 文件路由
2. **文件名派生**：`stages/planning.md` 自动派生节点 ID `PLANNING`，`reverse-auditor.md` 自动派生 config key `reverse_auditor`——无需手写映射表
3. **单一真相**：每条信息只在一处声明，其他位置只能引用；`capabilities.yaml` 因纯声明无机械校验已删除
4. **按定级批量声明**：`config.yaml` `tier_defaults` 一次声明整个组合，不"傻傻一个个配"
5. **零重复解析**：bootstrap 装配完成后生成 resolved 视图缓存，运行时查表
6. **语义 ID**：节点 ID 语义命名（`INTENT`/`CHECKING`），禁数字前缀——插入中间节点不存在"占号"问题
7. **order 自包含排序**：加新智能体用中间号（15 插在 10/20 间）零改其他文件
8. **视角物理隔离**：`isolation.forbid_read` 防止确认偏误——各验证智能体不见其他视角结论
9. **写入边界硬门**：`execution.verification` 唯一写入者，反自验
10. **机械汇总判定**：conductor 组合判定只读各视角 verdict 做 AND 运算，不主观判定
11. **可插拔**：新增智能体只需 ① agent .md ② kilo.json 绑定 ③ config.yaml 开关（可选）