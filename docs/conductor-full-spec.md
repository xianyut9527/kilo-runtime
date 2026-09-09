# conductor 完整规范（设计文档）

> 本文件是 `agent/conductor.md` 的完整设计规范，供人类维护参考。
> `agent/conductor.md` 只保留铁律 + 核心编排规则（精简版），本文件包含所有设计细节、派发表、示例、结构说明。
> 运行时 conductor 只读 `agent/conductor.md`；本文件不被运行时注入，仅供人类阅读。

## 双源声明

> `agent/conductor.md` 是 conductor 行为规范的主源（铁律 + 编排逻辑）。`kilo.json` `agent.conductor.prompt` 在 v6 已清空，改为 frontmatter description 派生——conductor.md 正文即运行时注入的主源。

## 三层正交（举一反三扩展点）

- **Layer 0（行为规范主源）**：`agent/conductor.md`——铁律 + 流程细节 + 编排逻辑，权威完整。加铁律改本文件 + prompt 同步。
- **Layer 2（运行时探针）**：`node scripts/lifecycle-doctor/index.mjs --runtime`——扫描活跃 task_context，注册式检测项（`runtimeChecks.push(fn)`）。加检测只 push 一行。
- **Layer 3（状态断言）**：`node scripts/task-context.mjs assert <task_id> <type>`——compaction 恢复后自检。加断言只往 `ASSERTIONS` 对象加一个键。

## 核心转变

| 旧模式                             | 新模式                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 单 agent 切换能力插件走状态机      | 编排者按阶段加载独立职能智能体                                                                                           |
| 硬编码 9 个 subagent               | 智能体经 `agent/*.md` frontmatter `mount` 文件路由自注册：任意挂载点、任意数量、`hook` 类型定序 + `after` 声明相对依赖（自包含，无跨文件编号引用） |
| 阶段间靠 PASS/FAIL 信号传递        | task_context.json 共享上下文 + 信号传递                                                                                  |
| 单向 verifier→fixer 循环           | 正向/反向/侧向/审查四视角交叉验证循环                                                                                    |
| 数字编号阶段（S01/S03…，插入占号） | 语义 ID 阶段（INIT/…），图结构集中在 `lifecycle/graph.yaml`                                                     |

## 启动期装配（bootstrap）

> **指针**：完整机制 + 校验脚本见 `agent/conductor.md` §铁律（启动期装配 + 挂载点机制）。本节只保留设计决策 + 校验项示例。

会话首个任务进入 INIT 前，conductor 执行一次性装配（结果缓存于会话内存，不落盘）。**架构三层正交**：graph.yaml 纯拓扑（零智能体名）/ stages/<id>.md 阶段语义（含 required_roles 契约）/ agent/*.md 智能体（mount 挂载 + task_context 权限）。机械化校验工具：`node scripts/lifecycle-doctor/index.mjs`（以下全部校验项的可执行实现）。

2. **读注册**：扫描 `agent/*.md` 全部 frontmatter（YAML 头），按 `mount[].at` 把智能体注册进对应挂载点（携带 `hook`/`after`/`when`/`on_fail`）——**文件制自动注册，丢一个 .md 文件即挂载**（manifest 与行为文件合二为一，单源无冗余）。
3. **读契约**：扫描 `lifecycle/stages/*.md` frontmatter 的 `required_roles`（阶段必配角色契约，阶段语义内聚）。
4. **读配置**：`lifecycle/config.yaml`（tier_defaults 差异化开关 + overrides + convergence + timeouts）。
5. **校验**（任一失败 → 启动报错 `[ASSEMBLY_FAIL]`，不进入运行；doctor 脚本可独立预检）：
   - graph.yaml 每条 edge 的 from/to 必须引用已声明 node
   - 每个 frontmatter `mount[].at` 必须命中派生挂载点；`on_fail` ∈ {abort,warn,skip,degrade}
   - graph.yaml 节点 `on_fail`（若声明）∈ {abort, retry_once, degrade, escalate, pause}；未声明按 `config.yaml §on_fail 默认值规则` 求值并写入 resolved 视图
   - graph.yaml 纯拓扑守护：主图节点不得出现 `required` 字段（契约在 stages frontmatter）
   - `config.yaml timeouts` 段：`per_agent_s` 每个键必须有对应 agent 文件（防幽灵键，**单向**——agent 文件可无键，回退 `stage_default_s`）；`per_tier_multiplier` 键 ⊆ {T0,T1,T2}；数值为正数
   - 每个非内建 stage 节点的 `required_roles: [role...]`（stages frontmatter），每角色必须有 ≥1 个智能体（frontmatter `role` ?? 文件名 = 角色名）在该节点主挂载点注册（`when` 求值后 active 覆盖在运行时再校验）
   - `config.yaml overrides.disabled_agents` 不得使某 `required_roles` 角色无履行者 → 报错（禁用了必配角色）
   - > **能力匹配**：无机械校验；模型绑定在 `kilo.json` `agent.<name>.model`，能力倾向参考 `docs/model-registry.md` 人工维护。
6. **解析缓存**：生成 resolved 视图——`{ mountPoint → [ { agent, model, hook, after, when, on_fail } ]（同 hook 类型默认并行组（详见铁律 #11 / §智能体加载规则）；有 after 的按拓扑排序执行，检测环依赖报错）}` + `{ nodeId → on_fail_resolved }` + edges 表 + `{ agent → timeout_s }` 预算表（per_agent_s × tier_multiplier，缺 per_agent_s 回退 stage_default_s）。运行时查表，零重复解析。

> **运行时零解析**：装配完成后，conductor 每进入一阶段只查 resolved 视图：挂载点 → 有序智能体列表 → 按 `tiers`（`sizing.tier ∈ mount[].tiers`）与 `when` 条件（对照 `task_context.config.agents`，非 tier 条件如 feature flag/环境变量）双重求值过滤 → `task` 工具启动。

## 多智能体协作工作流

> 状态机图、阶段索引、扩展指南详见 `lifecycle/graph.yaml` + `lifecycle/stages/README.md`（单一真相来源）。本文件只列编排者视角的关键流转点。

```
INIT（conductor 内建）→ INIT（conductor 内建）
  → T0: EXECUTING [履行 required_roles: [coder] 的智能体] → DELIVERING
  → T1+: PLANNING [履行 required_roles: [planner] 的智能体] → EXECUTING [履行 required_roles: [coder] 的智能体]
         → QUALITY [hooks 自动挂载：verify + review + fix 循环] → DELIVERING（conductor 内建，executor: conductor）
```
> **T1 直通分流**：`t1_strength` low/medium 走 INIT→EXECUTING 直通（跳 PLANNING）；高强度/机制变更走完整设计门。防低判：信号词命中强制升 high（判定见 `lifecycle/stages/init.md §2b`）。

> 智能体名**不出现在上述流程图**中。各阶段加载谁由 `agent/*.md` frontmatter `mount` 自注册决定，stage 文件只声明 `required_roles` 契约。

## task_context 共享机制

### 文件位置

`$env:TEMP/kilo/task_context_<task_id>.json`（Windows）或 `/tmp/kilo/task_context_<task_id>.json`（Unix）

### 读写规则

<!-- matrix-table: none -->

> **单源声明**：以下矩阵由各 `agent/*.md` frontmatter 的 `task_context.read/write/forbid_write` + `isolation.forbid_read` 字段聚合而成，frontmatter 是单一真相。本表仅供人类速查，**编辑时改 frontmatter，不改本表**。写入列用逗号分隔完整路径（机器可校验格式）——`node scripts/lifecycle-doctor/index.mjs` 校验本表与 frontmatter 派生矩阵一致，drift → FAIL。
>
> **不列出全部智能体**：新增智能体只需在 `agent/<name>.md` frontmatter 声明 `task_context` 字段；本表不硬编码清单，运行期由 `task-context.mjs` 自动从 frontmatter 派生 WRITE_MATRIX。人类读者直接阅读各 `agent/<name>.md` frontmatter（单源）。
>
> 本文件经 `matrix-table: none` 标记显式省略人类速查矩阵表（frontmatter 即单一真相），doctor `matrix.drift` 校验识别该标记。

> **写入边界硬门**：`execution.verification` 与 `verification.forward` 字段只能由履行正向验证角色的智能体写入；`quality` 字段由 QUALITY hooks 框架自动管理。各智能体自验结果只能保留在智能体本地输出，**不得写入 task_context**。违反 → `[TRUST_TRANSFER]` / `[PROCESS_VIOLATION]`。

>
> **运行时强制**：读写操作可经 `node scripts/task-context.mjs` 执行。脚本的 WRITE_MATRIX **从各 agent frontmatter `task_context.write` 自动派生**（新增智能体零改脚本），安全硬门（verification 双字段 / quality 字段仅 hooks 写入）保留脚本内硬编码，机械拒绝越权写入。
>
> **单一真相**：各 `agent/*.md` frontmatter 的 `task_context.read/write/forbid_write` 字段是运行时唯一真相；新增智能体只需声明 frontmatter，**无需更新本表**。doctor 校验自动覆盖 drift 检测。

### 注入机制

1. conductor 进入某阶段时，读取 `task_context.json` 的相关章节
2. 用 `task` 工具启动智能体时，将相关章节作为 prompt 的一部分注入
3. 智能体完成后返回结构化结果，conductor 更新 `task_context.json`
4. **不重复从 0 开始**：每个智能体都能看到前序阶段的完整上下文

## compaction 恢复协议（上下文压缩后）

- **触发**：auto-compaction 发生后、下一次启动智能体/流转判断前；
- **机械步骤**：
  1. `node scripts/task-context.mjs get <task_id> status` + `get convergence` + `get verification` 恢复任务状态；
  2. 重读当前阶段 `lifecycle/stages/<当前节点小写>.md`；
  3. 重读 `lifecycle/graph.yaml` 当前节点出边；
  4. 恢复判断以 `task_context` 为准，会话历史仅作参考；
- **锚点**：`kilo.json` `compaction` 配置段（`auto` / `prune` / `tail_turns` / `preserve_recent_tokens` / `reserved`）即本协议的运行时参数；压缩发生后 conductor 必须按本节步骤 1-5 恢复状态后再继续流转。

### task_context 结构（摘要）

```json
{
  "task_id": "...",
  "intent": {...},
  "sizing": {...},
  "config": {
    "agents": {
    },
    "custom_overrides": {}
  },
  "plan": {...},
  "execution": {
    "diffs": [...],
    "changes": [...],
    "acceptance_map": [...]
  },
  "verification": {
    "forward": {...},
    "review": {...}
  },
  "quality": {
    "round": 0,
    "max_rounds": 3,
    "status": "running",
    "verify": { "forward": {} },
    "review": { "result": {} },
    "fix": { "round": 0, "issues_fixed": [], "issues_remaining": [] },
    "verdict": "PENDING"
  },
  "fixing_history": [...],
  "status": "RUNNING" | "PAUSED" | "DEGRADED" | "DONE" | "FAILED",
  "convergence": {
  }
}
```

> **字段语义**：
>
> - `quality.round`：当前 QUALITY hooks 循环轮次（verify→fix→review→fix 自动循环计数），每次 verify/review hooks 触发 fix hooks 后 +1
> - `quality.max_rounds`：QUALITY 总轮次上限（见 `lifecycle/config.yaml` `hooks.quality.max_total_cycles`，当前值为 3），达到即 `[CIRCUIT_BREAKER]`
>


## 智能体加载规则（文件路由驱动）

> **指针**：完整机制 + 并行策略见 `agent/conductor.md` §铁律（铁律 #11 全局默认并行 + 挂载点流程）。本节只保留单智能体加载流程 + 示例。

挂载点是唯一挂载机制。conductor 运行时的执行模型：

 - **装配完成后**立即执行 `on:bootstrap` 挂载点（有 `after` 的按拓扑排序串行执行；无 `after` 的激活智能体按全局默认并行策略组织为并行组、单条消息并行发起，遵守铁律 #6 零输出硬门）
 - **进入节点 N**：
   1. 执行 `pre:N` 挂载点（有 `after` 的按拓扑排序串行执行；无 `after` 的激活智能体按全局默认并行策略组织为并行组、单条消息并行发起；`on_fail: abort` → `[SLOT_ABORT]` 中止进入主槽）

> **全局默认并行策略**（铁律 #11 见上）：任一挂载点（`on:bootstrap`、`pre:N`、`N`、`post:N`、子图节点等）若激活的智能体数量 ≥2，且这些智能体在该挂载点均未声明 `after`（或 `after` 为空），conductor 按 **agent 文件名字典序组织为同一并行组，在单条响应消息中并行发起多个 `task` 工具调用**（官方支持的并发模式：`Launch multiple agents concurrently whenever possible`）。该并行组**共享一个零输出硬门**（遵守铁律 #6：组内全部 result 返回前不得输出文本或调用其他工具）；视角隔离仍物理独立（每个 task 独立 context）。resolved 视图顺序的确定规则：
>   1. 先对声明了 `after` 的智能体做拓扑排序（按依赖链先后串行执行）；
>   2. 未声明 `after` 的智能体按 **agent 文件名字典序** 排列，组织为同一并行组；
>   3. 两种顺序在 resolved 视图中合并为该挂载点的最终启动序列（并行组 + after 拓扑链）。
> **并行安全边界**：详见 `agent/conductor.md` 铁律 #9。
> 

   2. 执行 `N` 主槽（委派或内建）——**主槽逐单元派发**：conductor 不批量派发整个 EXECUTING 段，按 `plan.task_dag.units` 逐单元派发 task，每单元独立 goal + acceptance_criteria + forbidden_files + token_budget；单元依赖按 DAG 拓扑排序；同层无依赖单元默认按并行组规则并行 dispatch（铁律 #11）；有 DAG 依赖的单元按依赖串行。
   3. 执行 `post:N` 挂载点（同 pre 语义）
   4. **机械流转裁判**：流转前必须执行 `node scripts/transition-check.mjs <task_id> --from <当前节点> --to <目标节点>`；
      - exit 0 → 允许流转（`quality.round` 已由框架自动递增，conductor 禁止手工 set convergence/quality 计数字段）；
      - exit 3 → `[CIRCUIT_BREAKER]`，`task_context.status=PAUSED`，输出选项等用户决策；
      - 脚本不可用（文件缺失/异常）→ 降级为人工对照 `graph.yaml` 判断 + 标 `[DEGRADED]`。
- **DELIVERING 完成、入 DONE 前**执行 `on:done` 挂载点

单个智能体的加载流程（每个挂载条目）：

1. 求值挂载条件：先 `tiers`（`sizing.tier ∈ mount[].tiers`，命中才加载），再 `when`（对照 `task_context.config.agents` + `config.yaml overrides.condition_overrides`，非 tier 条件）；无 `when` 且无 `tiers` = 恒定加载
2. 取 frontmatter 所在的 `agent/<name>.md` 行为文件 + 模型（kilo.json 绑定）
3. 按 frontmatter `task_context.read` 注入上下文切片，按 `isolation.forbid_read` 执行视角隔离
4. 查 resolved 视图取 `timeout_s = per_agent_s[<name>] × per_tier_multiplier[<tier>]`（缺 per_agent_s 回退 `stage_default_s`）；`task` 工具启动，记录 start_time
5. **超时守卫**：wall-clock 超过 `timeout_s` 智能体仍未返回 → 标记 `[AGENT_TIMEOUT]`，按当前节点 `on_fail` 派发（见 §异常处理派发表）；`agent_startup_s` 内 task 工具未开始执行 → 同样 `[AGENT_TIMEOUT]`
6. 返回后按 frontmatter `task_context.write` 收回结构化结果；超时/异常也写入 `dispatch_log`（agent_status=timeout/error + duration_ms）

> **智能体名不出现在 graph.yaml 与阶段文件正文**：graph.yaml 是纯拓扑（稳定大框架），阶段文件只有执行逻辑 + frontmatter `required_roles` 契约。新增/替换/排序智能体 = 丢/改 `agent/<name>.md` frontmatter 的 `mount`（`hook` 类型定义阶段内顺序，`after` 调执行顺序，`at` 选挂载点，多条目即多点挂载）——**graph.yaml 与 config.yaml 都不动**；仅当引入"新角色作为某阶段必配"时才动该阶段 stages 文件 frontmatter 的 `required_roles` 一行（阶段语义变化，内聚）。

## 质量门禁管理

| 门禁                            | 位置（graph.yaml 边）  | 处理方式                       |
| ------------------------------- | ---------------------- | ------------------------------ |
| verify hooks PASS               | `QUALITY`              | FAIL → fix hooks 自动触发修复  |
| review hooks PASS（条件加载）  | `QUALITY`              | FAIL → fix hooks 自动触发修复  |
| verify 单点重试 ≥ max_retries   | `QUALITY`              | `[CIRCUIT_BREAKER]` → 人工决策 |
| review 单点重试 ≥ max_retries | `QUALITY`              | `[CIRCUIT_BREAKER]` → 人工决策 |
| QUALITY 总轮次 ≥ max_total_cycles | `QUALITY`              | `[CIRCUIT_BREAKER]` → 人工决策 |

## 交叉验证组合判定

> **机械汇总原则（反自验）**：conductor 同时承担编排（写入 task_context.status 等字段）与组合判定。为防止"自写自判"的确认偏误，组合判定必须是**机械汇总**——只读取各视角智能体独立输出的 `verdict` 字段做 AND 运算，**不做主观判定、不重新解读证据、不补判**。任一视角的 FAIL 由该视角智能体独立给出，conductor 不得推翻或降级。

```
全视角 verdict 字段 AND 运算 → quality_verdict=PASS → 离开 QUALITY → DELIVERING
任一视角 verdict=FAIL → 自动触发 fix hooks（QUALITY 内部自动循环）
  ├─ 正向验证视角 FAIL → fixer 按验收标准修复
  └─ 审查视角 FAIL → fixer 按审查建议修复
warning（非 blocker）→ 标记但放行
```

> **不采用投票制**：每个视角都是硬门，任一 FAIL 都必须修复。
> **convergence-auditor 反向校验**（T2+ 可选硬门）：QUALITY hooks 收齐各视角 verdict 后，conductor 内建一个轻量校验步骤，反推以下三项：
>
> 1. 每个视角智能体是否真的独立执行（检查 task_context.verification.{forward,review} 是否各有独立 evidence）
> 2. 是否存在信任传递（grep 智能体输出是否含"coder 说的对""verifier 已 PASS"等措辞）
> 3. evidence 是否为本轮 fresh（不得复用前序阶段声明）
>    任一项不满足 → `[TRUST_TRANSFER]`，整阶段降级为 FAIL，重跑该视角。
>
> 脚本化执行：`node scripts/trust-transfer-check.mjs <task_id> [--round N]`，任一校验 FAIL 输出 [TRUST_TRANSFER] 并 exit 1。

## 委派方法学（不变）

> **指针**：完整委派包六条 + size-check 见 `agent/conductor.md` §铁律（铁律 #6 委派不亲为 + 铁律 #9 委派规模）。本节只保留核心摘要 + 不变项。

T1+ 任务加载 coder 智能体时，委派包仍必须包含（**核心摘要**，见铁律 #6；禁止传文件内容复述——subagent 有独立 context window 自己读文件）：

- **goal 单一**：一个委派包只解决一个可验证单元
- **context_anchor 精确**：具体文件:行号或符号 UID
- **acceptance_criteria 可验**：每条能用一条命令证实/证伪
- **forbidden_files 边界声明**：越界 → `[SCOPE_CREEP]`
- **验证命令**：每条验收标准对应的可执行验证命令
- **返回契约（按角色分档上限）**：subagent 只返回核心摘要（verdict + 证据 file:line + 关键结论），禁止完整报告/长表/复述文件内容（角色分档见 .kilo/instructions/output-schema.md §返回超限约束）

> **token_budget 单列（单元级调度参数，不进委派包六条）**：每单元 token 预算由 conductor 在逐单元派发时单列（与铁律 #6 六条标准一致）。

委派前安全门见 `agent/conductor.md` 铁律 #9。

## 强制流程日志（T1+，6 节点）

```markdown
## 强制流程日志

| 步骤     | 状态 | 阶段       | 智能体（角色）     | 质量门禁               |
| -------- | ---- | ---------- | ------------------ | ---------------------- |
| 意图判定 | ✅   | INIT     | conductor（内建）  | 类型明确               |
| 任务定级 | ✅   | INIT     | conductor（内建）  | T0-T2 准确             |
| 方案规划 | ✅   | PLANNING   | 履行设计门角色     | 方案输出               |
| 方案审查 | ✅   | post:PLANNING | 履行审查角色    | [PLAN_REVIEW_PASS]    |
| 实现     | ✅   | EXECUTING  | 履行编码角色       | 验收映射表+三件套      |
| 质量保障 | ✅   | QUALITY    | verify hooks（验证角色）→ fix hooks → review hooks（审查角色）→ fix hooks | hooks 全 PASS |
```

> T0 仅需前 2 节点 + EXECUTING→DELIVERING（无验证/审查）；T1/T2 加 QUALITY（verify→fix→review 自动循环，检查 FAIL 即修复，修复后重新检查，直到全部 PASS 才进入 DELIVERING）。具体智能体名由 `agent/*.md` frontmatter `mount` 自注册决定，本表只列角色语义。
>
> **T0 前置硬否决**：T0 快通道判定前须先核验 workflow-detail.md §A.4 Step 1a T0 前置硬否决 4 条（>3 文件 / 跨模块 / 需新增测试 / 安全敏感）+ Step 2 第一硬门（涉及任何逻辑性修改一律最低 T1），任一命中强制升 T1（详见 workflow-detail.md §A.4，不展开）。

## 模型选择

conductor 自身模型见 `kilo.json` `agent.conductor.model`。各职能智能体的模型选择**不在本文件硬编码**，统一由 `kilo.json` `agent.<name>.model` 字段声明。能力倾向与降级规则参考 `docs/model-registry.md` 人工维护。

## 异常处理（阶段级 on_fail 派发）

> 错误处理是 conductor 内建职责，**不是独立流程支线**——用户全程在场，无需 Teardown/Destroy 销毁流程。每个阶段通过 graph.yaml `on_fail` 字段声明失败策略，conductor 捕获异常后查表派发。
>

### 触发条件

| 触发源                                 | 信号                                                         | 说明                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 智能体 wall-clock 超时                 | `[AGENT_TIMEOUT]`                                            | 见 §智能体加载规则 §超时守卫；分启动卡死（agent_startup_s）与执行超时（per_agent_s/stage_default_s） |
| `task` 工具抛异常/启动失败/并发调度被中断（`Tool execution aborted` / `Tool execution cancelled`） | `[AGENT_UNAVAILABLE]`                                        | abort 后会话断开几乎无法重试：**前置杜绝**（见铁律 #9），不尝试重试，直接按节点 on_fail 派发或降级 conductor 内建；区别于超时 |
| 智能体返回 `BLOCKED` / `NEEDS_CONTEXT` | 状态信号                                                     | 需补上下文或升级                                                                                     |
| 跳步/越界/自验污染                     | `[PROCESS_VIOLATION]` / `[SCOPE_CREEP]` / `[TRUST_TRANSFER]` | 即停，不走 on_fail（见 §流程级即停规则）                                                             |

### 派发表（查 graph.yaml `node.on_fail` → 执行对应动作）

| `on_fail` 值 | conductor 动作                                                                                                                                                                                                                                                                                                                                        | 适用场景                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `abort`      | 标 `[STAGE_ABORT]`，停止该阶段，输出当前状态等用户决策                                                                                                                                                                                                                                                                                                | START/DONE/terminal、装配类错误             |
| `retry_once` | **同智能体重跑 1 次**：task 工具开新会话（清空前次上下文，避免同样卡死），prompt 注入"前次超时/异常"信号；重跑仍超时/异常 → 转 `escalate`；重试配额见 `config.yaml retry.agent_timeout_max_retries`                                                                                                                                                   | EXECUTING/PLANNING（coder/planner 偶发卡死） |
| `degrade`    | 跳过该视角，task_context 标 `DEGRADED`，主流程继续；仅可选挂载视角（frontmatter `mount[].on_fail: degrade` 声明）                                                                                                                                                                                                       | 可选视角节点                                |
| `pause`      | 挂起 task_context（status=PAUSED），输出选项等用户决策；不自动 commit/push/merge/reset/rebase                                                                                                                                                                                                                                                         | INIT/DELIVERING 内建阶段           |

> **未声明 `on_fail` 的节点**：按 `config.yaml §on_fail 默认值规则` 求值——required 必配 → escalate；可选挂载 → degrade；executor 内建 → pause；terminal → abort。
> **节点级 vs 挂载点 on_fail**：同名字段两种取值集（节点级 5 值 / 挂载点 3 值），按字段位置区分——节点 `on_fail:` 在节点定义内，`mount[].on_fail:` 在 frontmatter mount 条目内。bootstrap 校验按位置分别校验取值集。

### 流程级即停规则（不走 on_fail 派发）

以下违规由 conductor 主动暂停并修正流程，**不挂起等人**（区别于 `pause`）：

- 发现跳步 → 标记 `[PROCESS_VIOLATION]`，回退到正确阶段重走
- `[SCOPE_CREEP]` / `[TRUST_TRANSFER]` → 标记后回退到违规阶段，按 verifier/reviewer 指出的问题重新执行
- 分支收尾协议违规（未经用户决策直接 commit/push/merge/reset/rebase）→ `[PROCESS_VIOLATION]`，立即告知用户回退命令（`git reset --soft HEAD~1` 保留 staged / `--mixed` 取消 staged），并暂停后续操作

### 熔断叠加规则

`on_fail` 派发与收敛熔断独立但叠加：

- `QUALITY` hooks 循环 `quality.round >= quality.max_rounds` → `[CIRCUIT_BREAKER]` 全局熔断，覆盖 `on_fail: escalate`，直接 pause 等人
- `[AGENT_TIMEOUT]` + `retry_once` 耗尽 → 转 `escalate`，不直接熔断（熔断只看轮次，不看超时）

### 现有规则（保留）

- fix hooks 连续 2 轮同症状 → 升级 reviewer 做根因分析（`escalate` ① 分支的具体实现）
- QUALITY hooks 循环轮次由框架自动计数（`quality.round`），conductor 不得手工 set

### 降级处理（基础设施层，不走 on_fail）

- SQL 失败 → `ERROR`，输出警告行，继续执行
- 某智能体启动失败 → `[AGENT_UNAVAILABLE]`，按节点 `on_fail` 派发（必配 escalate / 可选 degrade）
- 多个智能体不可用 → 降级为单 conductor 模式 + `[DEGRADED_SINGLE_AGENT]`
- task_context 读写失败 → 降级为信号传递模式 + `[CONTEXT_SHARING_DEGRADED]`
- bootstrap 装配失败 → `[ASSEMBLY_FAIL]`，输出具体缺失项（角色/文件/模型能力/on_fail 校验/timeouts 校验），停止进入运行

## 输出

交付包含：

1. **闭环确认**：验收 → 实现位置 → 验证证据 → 状态
2. **变更回顾**：改了什么 / 为什么改 / 影响范围 / 清理调试代码
4. **分支收尾协议**：git status 清理 / 单提交对应单定级单元 / 告知用户分支去向 / worktree 隔离清理

> skill 能力扩展由运行时 `skill` 工具按需加载，不在 conductor 规范中预声明。

## 工具门禁（v6 框架稳定化，2026-08-09）

> 与 `agent/conductor.md` 铁律 #9 step 0c / `scripts/bash-guard.mjs` 的 PS5.1 模式配套。

### 三件套

- `scripts/scan-encoding.mjs` — 编码健康度检测器（BOM / U+FFFD / GBK 残留）
- `scripts/bash-guard.mjs` — bash 命令静态分析拦截器（含 PS5.1 复杂 regex 模式）
- `scripts/lifecycle-doctor/checks/encoding-safety.mjs` — 框架静态装配检查，含 292 项编码安全 check

### 集成位置

- **conductor 铁律 #9 step 0c**：每次 bash dispatch 前必跑 bash-guard；coder 完工 / DELIVERING 前必跑 scan-encoding
- **pre-dispatch `--bash-cmd` 钩子**：`node scripts/task-context.mjs pre-dispatch <id> --bash-cmd "<cmd>"` 一步合并 step 0 + step 0c
- **lifecycle-doctor 静态装配**：每跑必含 encoding-safety check（默认 292 PASS）
- **flow-audit 流程审计**：RUNNING + intent_type=undefined 改为 FAIL（非静默 SKIP）
- **install.ps1 / install.sh**：CriticalFiles 含 3 件套 + post-sync `lifecycle-doctor` 自检

### 反事故教训

- 2026-08 culture-applet 任务：coder 未跑 scan-encoding → AGENTS.md 被 GBK 重新编码 → 6 处 mojibake
- 2026-08 culture-applet 任务：coder 未跑 bash-guard → PS5.1 死循环 → 6000+ 行刷屏
- 教训：把"软规则口头提醒"接进"机械门禁"——subagent 不跑则 framework 拒绝 dispatch