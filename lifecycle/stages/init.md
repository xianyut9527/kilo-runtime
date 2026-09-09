---
description: 生命周期阶段 INIT — 意图判定 + 任务定级。合并原 INTENT + SIZING，conductor 内建一步完成。
executor: conductor        # conductor 内建主槽，不经 mount 挂载
token_budget: 6000
---

# lifecycle/stages/init

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（单一真相来源），本文件只定义执行逻辑。
> 执行元数据（executor / token_budget）见 frontmatter；本阶段为 conductor 内建（executor 声明），无 required_roles。

## 输入

- 用户原始请求（自然语言或命令）
- 当前项目上下文（技术栈、最近修改、活跃分支）
- 会话历史（compaction 后保留的锚点）

## 处理流程

### 1. 意图判定

**意图分类**（本节是唯一定义源，AGENTS.md 锚点 1 指向此处）：
- **咨询类**（`INQUIRY`）：主输出信息（方案/分析/脚本验证结论）；tier 决定流程深度，**可能含脚本/方案/文档等辅助产物**。
- **执行类**（`EXECUTION`）：涉及文件修改、代码生成、配置变更。进入定级。

显式输出判定结论：必须在输出顶部显式标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。

### 2. 任务定级（INQUIRY 默认 T1，EXECUTION 按 T0/T1/T2）

INQUIRY 定级判据：
- **单点事实问答**（查一个值/确认一个事实/读一个文件）→ **T0 直通**（M1 极速，省设计门/编码角色）
- **多维度分析**（对比/权衡/方案评估/跨文件综合）→ **T1**（经 PLANNING 出分析方案后直通 DELIVERING）


定级完成后，conductor 按 `lifecycle/config.yaml` 的 `tier_defaults` + 用户覆盖（prompt 显式声明）写入 `task_context.config.agents` + `custom_overrides`。
按 `workflow-detail.md §A.4` 决策树执行：

```
T0: 仅无逻辑性修改（文案/注释/小样式/格式/命名/删除） / 单文件 / 无跨模块影响 / 无测试/类型检查需求
     → 第一硬门：涉及任何逻辑性修改 → 立即禁止 T0，最低 T1
     → 机械兜底：scripts/delivery-audit.mjs#checkT0Eligibility 扫描 intent.raw 逻辑指示词 + sizing.key_files 逻辑路径 glob，命中即 WARN 阻断 T0 直通（transition-check.mjs INIT 出口校验）
     → 覆盖出口（仅限确属机械微改而词表误命中时）：同一 batch 内写 `config.custom_overrides.tier=T0`，该键存在即放过 T0 出口门（同时也会跳过 T1→T2 安全升级，故敏感域禁用此出口）
     → 直达执行，无设计门，无审查

T1: 1-5 文件 / 单模块 / 有明确验收标准 / 无扩散触发词 — 普通任务默认档
     → 短设计门（1-3 句）→ 设计门角色 → 编码角色 → 验证角色

T2: 跨模块 / 5+ 文件 / 规则扩散 / 安全敏感词 / 机制·契约变更 — 任一命中即升 T2
     → 完整设计门 → 单元 DAG → 设计门角色 → 编码角色 → 验证角色 → 审查角色(full)
```



### 2b. T1 强度判定（EXECUTION + tier==T1 时必做）

按 `lifecycle/config.yaml` 的 `t1_strength_signals` 四维度判定表输出三档 `sizing.t1_strength`：

| 维度 | high | medium | low |
| --- | --- | --- | --- |
| 决策分支数 | >=3 | 1-2 | 0 |
| 状态耦合 | 跨组件状态依赖 | 单模块 | 无 |
| 契约影响 | API/配置/文件格式变更 | 无 | 无 |
| 新增机制 | 新抽象/新协议 | 无 | 无 |

三档定义：
- **high** = 任一维度命中机制信号（分支>=3 / 跨组件状态耦合 / 契约变更 / 新增机制）→ 走完整设计门（INIT→PLANNING）
- **medium** = 1-2 分支单模块、无契约影响 → INIT→EXECUTING 直通
- **low** = "非常明确任务"：改动点唯一 + 验收标准用户显式给出 + 无信号词命中 → INIT→EXECUTING 直通

**机械写入**：作为硬规则 4 的一次 batch 中的 `sizing.t1_strength` 键落盘，不单独开一个命令回合。

**防低判兜底**：`intent.raw` 命中 `t1_strength_signals.strength_escalation_words`（机制/契约/状态耦合/多分支等信号词）而 conductor 声明 `low` → transition-check 强制升 `high`（写脚本在 U3，此处声明规则）。

**"非常明确任务"显式定义**：改动点唯一 + 验收标准用户显式给出 + 无信号词命中 → 判 `low`。

### 安全门禁（v6 框架稳定化，2026-08-09）

INIT 阶段必跑：

- **bash-guard pre-dispatch 预检**：conductor 委派任何 task 前经 `pre-dispatch --bash-cmd` 钩子（如有 bash 命令），命中 → exit 2 阻断
- **scan-encoding baseline**：若修改过文件，先扫 `node "${KILO_CONFIG_DIR}/scripts/scan-encoding.mjs" <files>` 确认起点编码干净
- 详见 `agent/conductor.md` 铁律 #9 step 0c

## 输出信号

```yaml
status_signal: "DONE" | "NEEDS_CONTEXT"
transition_context:
  intent_type: "INQUIRY" | "EXECUTION"
  tier: "T0" | "T1" | "T2"
  t1_strength: "low" | "medium" | "high"  # T1 EXECUTION 必填；T0/T2/INQUIRY 可缺省
  project: "string"
  keywords: ["string"]
quality_gate:
  intent_clear: true | false  # 是否已明确区分咨询/执行
  sizing_rationale: "string"  # 定级理由（强制输出）
```

## 路由规则（边定义见 graph.yaml）

- INQUIRY + T0 → `DELIVERING`（M1 直通：纯问答极速，省编码角色/QUALITY）
- INQUIRY + T1/T2 → `PLANNING` → `DELIVERING`（M1：设计门角色出分析方案后直通）
- EXECUTION + T0 → `EXECUTING`（极速通道，无设计门/验证/审查）
- EXECUTION + T1 + t1_strength ∈ {low, medium} → `EXECUTING`（直通，跳过 PLANNING；conductor 补齐 minimal_gate 委派包）
- EXECUTION + T1 + t1_strength == high → `PLANNING`（完整设计门）
- EXECUTION + T2 → `PLANNING`（设计门）

## 硬规则

1. **task_context 强制初始化**：进入 INIT 前必须先执行 `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" init <task_id>`。未初始化直接流转 → `[PROCESS_VIOLATION]`。
2. **流转必裁判**：INIT → 下一节点前必须执行 `node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs" <task_id> --from INIT --to <NEXT>`，exit 0 才允许流转。
3. **显式输出判定结论**：输出顶部必须标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。
4. **判定产物一次 batch 写入**：判定完成后必须用**单条** batch 命令写入（一个 `set` 就是一个独立进程回合，拆成 4~5 次属白耗）：

   ```bash
   node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" set <task_id> --batch '{"intent.raw":"<用户请求原文>","intent.intent_type":"<INQUIRY|EXECUTION>","sizing.tier":"<T0|T1|T2>","sizing.key_files":["<涉及文件路径>"],"sizing.t1_strength":"<low|medium|high>"}' --agent conductor
   ```

   - **`intent.raw` 与 `sizing.key_files` 必写**——它们是 4 个机械门的唯一输入：`checkT0Eligibility`（T0 出口；raw 为空直接 `[PROCESS_VIOLATION]` 阻断）、`apply-tier-auto` 的 T1→T2 安全升级、`checkT1StrengthEligibility` 防低判、`init-gate` 内的 lessons 注入。**后三个门在 raw 为空时不报错，直接静默失效**（误定级会被直接放过）。
   - `sizing.t1_strength` 仅 T1 EXECUTION 必填，其他档从 JSON 中省略该键；无具体文件时 `sizing.key_files` 给 `[]`；原文含引号/换行时改用 `--batch -` 从 stdin 传。
   - batch 是 fail-closed 的：任一路径权限/枚举校验不过则整体拒绝，无部分写入。未写入合法 `intent_type` / `tier` 时，transition-check.mjs 拒绝流转。
   - **引号写法**：JSON 整体用单引号包裹即可（PowerShell 7 与 bash 一致）；**禁止**对内部双引号再加 `\"` 转义——PowerShell 会把反斜杠原样传入 argv，node 侧直接报 `--batch value is not valid JSON`。
   - **用户显式覆盖写这里，且只能写嵌套路径**：需要跳过自动升级或强判时，在同一 batch 里附 `"config.custom_overrides.tier":"T0"` / `"config.custom_overrides.t1_strength":"low"`（仅两个键被代码承认，语义见 `lifecycle/config.yaml` custom_overrides 段）。**根级 `custom_overrides.*` 不在 WRITE_MATRIX 内，写它会直接被拒**——旧版门给的补救建议因此死循环，已修。
5. **SIZING 机械应用 config**：由 `init-gate.mjs` 单进程内的 apply-tier-auto 完成（见 `agent/conductor.md` 铁律 #8）——**定级后不要再单独跑一次 `apply-tier-auto`**（同一 tier 再写一遍，白耗一个回合）。但顺序必须是：**先硬规则 4 的 batch，后 init-gate**（init-gate 内的升级扫描要读 `intent.raw`）。仅 init-gate 不可用（`[DEGRADED]`）时才单点执行 `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" apply-tier-auto <task_id> <Tn> --agent conductor`。禁止手工 `set config.agents.*`。
6. **T1 EXECUTION 必写 t1_strength**：随硬规则 4 的 batch 一并写入。缺失或非法值时 transition-check 阻断流转；`intent.raw` 命中强度信号词而声明 low → 强制升 high。
7. **prior_lessons 注入（INIT 硬规则）**：`intent.prior_lessons` 非空时，conductor 必须在首次执行/修复角色委派包中携带 prior_lessons 摘要（含 lessons 的 code + 摘要文本），供执行阶段规避已知失败模式。本规则仅约束 INIT 侧注入。

## 降级处理

- 用户请求模糊且无法澄清 → 输出 `[INTENT: AMBIGUOUS]` + 澄清问题，等待用户回复。
- 项目上下文缺失（新会话无 compaction 锚点）→ 基于 `kilo.json` 和 `AGENTS.md` 推断，标注 `[CONTEXT_INFERRED]`。
