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
│   ├── planner.md                         #   规划（mount: PLANNING）
│   ├── coder.md                           #   编码（mount: EXECUTING）
│   ├── reviewer.md                        #   静态审查（mount: QUALITY hook:review）
│   ├── fixer.md                           #   修复（mount: QUALITY hook:fix, auto-trigger）
├── lifecycle/
│   ├── graph.yaml                         # 主生命周期 DAG（节点 + 边 + 流转条件）
│   ├── config.yaml                        # 定级默认组合 + 用户覆盖 + 熔断阈值（唯一真相）
│   └── stages/                            # 阶段执行逻辑（一阶段一文件，文件名派生节点 ID）
│       ├── intent.md                      #   意图判定 → INIT
│       ├── sizing.md                      #   任务定级 → INIT
│       ├── planning.md                    #   设计门 → PLANNING
│       ├── executing.md                   #   实现 → EXECUTING
│       ├── quality.md                      #   响应式 Hooks → QUALITY（合并原 CHECKING+REVIEWING+FIXING）
│       └── delivering.md                  #   交付（分支收尾）→ DELIVERING
├── docs/
│   ├── configuration-guide.md             # ← 本文件
│   ├── conductor-full-spec.md             # conductor 完整设计规范（多智能体架构历史）
│   ├── model-registry.md                  # 模型能力倾向人类可读版（人工维护）
└── lifecycle-doctor/index.mjs             # 配置校验脚本（56 项检查）
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

---

## 2. agent/*.md frontmatter 字段详解

每个智能体文件以 YAML frontmatter（`---` 块）开头，分两部分：
- **Kilo 原生字段**：`description`/`mode`/`hidden`/`color`/`steps`/`permission`/`subagent_type`

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
#   (省略)             - subagent，由编排者经 task 工具按 mount 挂载启动
# verifier 是 subagent，省略 type

# 模型绑定在 kilo.json agent.<name>.model；能力倾向参考 docs/model-registry.md 人类维护
# bootstrap 不做能力匹配机械校验

# mount：挂载点声明（可挂一个或多个点）
#   每个条目是一个挂载点，字段：
#     at       挂载点名称（派生自 graph.yaml 节点，见下方"挂载点命名空间"）
#     when     可选条件挂载（对照 task_context.config.agents.<key> 求值）
#              省略 = 必加载（但受阶段可达性约束——T0 不经过 QUALITY，verifier 自然不加载）
#     hook     v2 响应式 Hooks 专用：verify | fix | review（QUALITY 阶段内部挂载）
#     trigger  v2 hook 触发条件：onFail（FAIL 时）| afterPass（全 PASS 后）| onChange（deps 变化，默认）
#     deps     v2 hook 依赖声明：deps 变化时自动触发该 hook（类似 useEffect deps）
#     after    可选相对依赖（声明在哪些 agent 之后执行）；省略 = 与同 hook 类型其他 agent 并行（按 agent 文件名字典序组织并行组，单条消息并行发起）
#              v2 废弃 order 数字编号，改用 hook 类型内置顺序 + after 相对依赖
mount:
  - at: QUALITY                # v2 响应式 Hooks 阶段（合并原 CHECKING+REVIEWING+FIXING）
    deps: [execution.code, plan]

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
---
```

### 挂载点命名空间（派生，零声明）

挂载点由 `graph.yaml` 节点自动派生——节点存在即挂载点存在，无需在别处声明：

| 挂载点格式 | 含义 | 典型用途 |
|-----------|------|---------|
| `on:bootstrap` | 装配完成后、INIT 前 | 任务启动钩子 |
| `on:done` | DELIVERING 完成后、DONE 前 | 收尾钩子 |
| `pre:<NODE>` | 节点主槽执行前 | 前置准备 |
| `<NODE>` | 节点主槽（阶段本体） | 阶段核心执行者 |
| `post:<NODE>` | 节点主槽执行后、edges 流转前 | 后置处理 |


### 顺序与并行

- 同挂载点 / 同 hook 类型多个智能体 **默认并行**（省略 `after`，按 agent 文件名字典序组织为并行组，单条消息并行发起；有 `after` 的按拓扑排序串行）
- v2 不再使用 `order: <数字>` 绝对编号；QUALITY 内部顺序由 `hook` 类型内置定义：`verify → fix → review → fix`
- 需要控制同 hook 内相对顺序时，声明 `after: [agent-name]`（只引用前驱，零改其他文件）

---

## 3. 场景演练

### 场景 A：新增一个智能体

**需求**：新增一个 `security-auditor` 智能体，在 QUALITY review hook 做安全专项审计，仅 T2+ 加载。

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
  - at: QUALITY
    hook: review                    # v2 响应式 Hooks：review hook
    when: "config.agents.security_auditor"     # 条件挂载

task_context:
  read: [execution.diffs, plan, project_context]
  write: [verification.security]               # 新切片

isolation:
  forbid_read: [verification.forward, verification.review]
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

3. **config.yaml 加定级开关**（在 `tier_defaults` 的 T2 加一行）：

```yaml
T2:
  agents:
    ...
    security_auditor: true      # ← 加这一行
```

4. **运行校验**：`node scripts/lifecycle-doctor/index.mjs`

**不需要动**：`graph.yaml`（QUALITY 节点已存在，挂载点派生即可用）、其他 agent .md。

> 如果该智能体是 QUALITY review hook 的**必配**角色（而非可选），才需要在 `stages/quality.md` frontmatter `required_roles` 加一行。

---

### 场景 B：新增一个生命周期阶段

**需求**：在 EXECUTING 和 QUALITY 之间加一个 `UNIT_TEST` 阶段。

**步骤**：

1. **graph.yaml 加节点 + 边**：

```yaml
nodes:
  ...
  - id: UNIT_TEST
    type: stage
    # 阶段文件路径自动派生：stages/unit-test.md（文件名 = 节点 ID 小写）
    # required_roles 在 stages/unit-test.md frontmatter 声明

edges:
  ...
  # 改原边 EXECUTING→QUALITY 为 EXECUTING→UNIT_TEST→QUALITY（T1-T2 都需单元测试）
  - from: EXECUTING
    to: UNIT_TEST
    when: "tier in ['T1','T2']"
  - from: UNIT_TEST
    to: QUALITY
    when: "unit_test_result == 'PASS'"
  - from: UNIT_TEST
    to: QUALITY
    when: "unit_test_result == 'FAIL'"
    # 注意：v2 中 CHECKING/REVIEWING/FIXING 已合并入 QUALITY，FAIL 时也进入 QUALITY（fix hooks 自动触发）
```

2. **创建阶段文件** `lifecycle/stages/unit-test.md`（文件名派生节点 ID `UNIT_TEST`，写执行逻辑：输入/处理/输出信号）

3. **如果有新智能体**：按场景 A 创建 `agent/tester.md` + kilo.json 绑定

4. **运行校验**：`node scripts/lifecycle-doctor/index.mjs`

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

4. **运行校验**：`node scripts/lifecycle-doctor/index.mjs`

**不需要动**：`agent/coder.md`、`graph.yaml`、`config.yaml`。

> v6.1 起 `capabilities.yaml` 已删除，bootstrap 不做能力匹配机械校验。能力倾向是 `docs/model-registry.md` 的人工维护参考，选模型时人类对照即可。

---

### 场景 D：调整定级默认组合


**步骤**：只改 `lifecycle/config.yaml`：

```yaml
tier_defaults:
  T1:
    agents:
      ...
```


---

### 场景 E：临时禁用某智能体


**步骤**：只改 `lifecycle/config.yaml`：

```yaml
overrides:
```


---

### 场景 F：改熔断阈值

**需求**：把单点修复熔断统一为 3 轮（与 config.yaml max_total_cycles 一致）。

**步骤**：改 `lifecycle/config.yaml`（**唯一真相**）：

```yaml
hooks:
  quality:
    max_total_cycles: 3          # ← 从 7 改为 3（唯一熔断阈值，替代原 max_verify_retries/max_review_retries 死配置）
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
    required: [planner]        # 主槽必配角色列表（结构层不变量）；无 agent 挂载该角色 → [ASSEMBLY_FAIL]
    note: 人类可读说明         # 可选

# 边字段
edges:
  - from: PLANNING             # 起始节点 ID
    to: EXECUTING              # 目标节点 ID
    when: "tier in ['T1','T2']"  # 流转条件（对照 task_context 求值）；省略 = 无条件
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
- 未声明 `executor` 的节点：主槽由 `mount: at: <NODE>` 的智能体填充（按 required 校验必配角色）

---

## 5. config.yaml 字段详解

```yaml
# tier_defaults：按定级 T0/T1/T2 声明加载哪些智能体
# conductor 在 INIT 阶段把对应 tier 的 agents 表写入 task_context.config.agents
# agent frontmatter 的 mount[].when 对照 config.agents.<key> 求值；定级挂载可用 mount[].tiers（如 plan-reviewer tiers:[T2]）替代 when 开关，按 sizing.tier 过滤
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
    review_mode: full
  T2:
    agents:
      coder: true
      verifier: true
      reviewer: true
      fixer: true
    review_mode: full

# overrides：用户/环境覆盖（默认全空 = 全量自动发现注册）
overrides:
  disabled_agents: []          # 全局禁用的智能体名列表
  model_overrides: {}          # 覆盖 kilo.json 模型绑定
  condition_overrides: {}      # 强制覆盖 config.agents 开关

# hooks.quality：响应式 Hooks 熔断阈值（v2 唯一真相）
hooks:
  quality:
    max_total_cycles: 3        # QUALITY 总轮次上限（唯一熔断阈值，3 轮修不好=方案/需求有问题）
```

### tier_defaults.agents 的 key 命名规则（自动派生）


| agent 文件名 | config.agents key |
|-------------|-------------------|
| coder / planner / verifier / reviewer / fixer | 同名（单词名直接用） |

---


```yaml

nodes:
    parallel: true                           # 并行执行（视角隔离）

# 多样化硬规则（v6.1 从原 capabilities.yaml 迁移至此——仅本子图使用）
  dimensions:
    vendor: required         # 模型提供者两两不同
    architecture: required   # 模型架构两两不同
```




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
| `execution` | coder/fixer | 执行产物 |
| `execution.diffs` | coder/fixer | 变更 diff |
| `execution.changes` | coder | 变更清单 |
| `execution.acceptance_map` | coder | 验收映射表 |
| `execution.verification` | verifier | 验证结论（写入边界硬门：唯一写入者） |
| `verification.forward` | verifier | 正向验证结论 |
| `verification.review` | reviewer | 审查结论 |
| `verification.security` | (示例) security-auditor | 安全审计结论 |
| `forbidden_files` | conductor | 边界声明 |
| `fixing_history` | fixer | 修复历史 |
| `project_context` | conductor | 项目级安全约束/技术栈 |
| `acceptance_criteria` | planner | 验收标准 |
| `task_context.intent` | conductor | 原始需求（isolation 用） |
| `model_identities` | (系统) | 模型身份（isolation 用） |

### 写入边界硬门

`execution.verification` 字段**只能由 verifier 智能体写入**。coder/fixer 自验结果只能保留在智能体本地输出，不得写入 task_context。违反 → `[TRUST_TRANSFER]`。

---

## 8. 校验脚本

```bash
node scripts/lifecycle-doctor/index.mjs
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
| `[ASSEMBLY_FAIL]` | 启动期装配失败 | 跑 `node scripts/lifecycle-doctor/index.mjs --verbose` 定位：agent frontmatter mount / stages required_roles 覆盖 / kilo.json 模型绑定 |
| `[PROCESS_VIOLATION]` | 流程违规（跳步/越权写） | 检查是否跳过必经阶段 / 是否越权写 execution.verification |
| `[TRUST_TRANSFER]` | 信任传递 | 检查验证智能体是否引用了其他视角结论而非独立验证 |
| `[SCOPE_CREEP]` | 越界修改 | 检查 coder/fixer 是否改了 forbidden_files 之外的文件 |
| `[CIRCUIT_BREAKER]` | 熔断 | 单点 3 轮 / 全局 3 轮，需人工决策 |

---

## 10. 设计理念总结

1. **文件制自动注册**：丢一个 `agent/<name>.md` 文件即自动注册，bootstrap 扫 frontmatter 发现——类似 Next.js 文件路由
3. **单一真相**：每条信息只在一处声明，其他位置只能引用；`capabilities.yaml` 因纯声明无机械校验已删除
4. **按定级批量声明**：`config.yaml` `tier_defaults` 一次声明整个组合，不"傻傻一个个配"
5. **零重复解析**：bootstrap 装配完成后生成 resolved 视图缓存，运行时查表
6. **语义 ID**：节点 ID 语义命名（`INIT`/`QUALITY`），禁数字前缀——插入中间节点不存在"占号"问题
7. **相对依赖排序**：加新智能体用 `after: [agent-name]` 声明前驱，零改其他文件；框架自动拓扑排序，环依赖报错
8. **视角物理隔离**：`isolation.forbid_read` 防止确认偏误——各验证智能体不见其他视角结论
9. **写入边界硬门**：`execution.verification` 唯一写入者，反自验
10. **机械汇总判定**：conductor 组合判定只读各视角 verdict 做 AND 运算，不主观判定
11. **可插拔**：新增智能体只需 ① agent .md ② kilo.json 绑定 ③ config.yaml 开关（可选）

