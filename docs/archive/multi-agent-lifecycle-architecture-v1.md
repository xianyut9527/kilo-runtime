# 多智能体协作生命周期架构（历史档案 v1）

> **历史档案**：本文档已废弃。**当前架构请参考 `docs/ARCHITECTURE.md` + `docs/conductor-full-spec.md`**。本文仅作 v1→v2 迁移历史记录保留。
> **保留原因**：v2.x 设计门产物；v3.x 后被 conductor-full-spec.md 取代，本文件归档保留。

---

# 多智能体协作生命周期架构（v2.x 原文）

# 多智能体协作生命周期架构

> **历史档案**：本文档为 v1→v2 迁移期间设计稿，**当前架构见 `docs/ARCHITECTURE.md`**。本文件只保留迁移历史，新内容请加到 ARCHITECTURE.md。

> **状态**：设计门产物，已落地；当前结构以 `lifecycle/graph.yaml` 为单一真相来源
> **作者**：coderAgent architect 设计门
> **日期**：2026-07-27
> **替代**：当前"单 coderAgent 走 8 阶段状态机 + capabilities 能力插件"实现
> **更新（v6）**：阶段 ID 已语义化（`INIT`→`INIT` 等），过渡态编号（S02/S06/S10/S12/S14）已消灭并转为 graph 边；阶段文件迁至 `lifecycle/stages/`，智能体契约合入 `agent/*.md` frontmatter（v6 单源：manifest 与行为文件合二为一，不再有 `lifecycle/agents/*.yaml`）。
> **更新（v6.1）**：`lifecycle/capabilities.yaml` 已删除（纯声明性配置无机械校验），能力倾向人类可读版见 `docs/model-registry.md`；`graph.yaml` 不再重复声明 convergence（`config.yaml` 为唯一真相）；阶段文件 `stage_id` 字段废弃（从文件名派生节点 ID）；`agent/*.md` frontmatter `capabilities_required` 字段已删除。本文引用已同步更新；§6 文件迁移表为历史档案，保留原始路径与角色名。

---

## 0. 核心转变一句话

> 从"单 agent 切换能力插件走状态机"转变为"编排者按生命周期阶段加载独立职能智能体，智能体间共享任务上下文，多视角交叉验证循环确认直到收敛"。

---

## 1. 智能体清单设计

### 设计原则
- **按职能划分独立智能体**，每个智能体有独立 prompt、独立模型、独立 context window
- **编排者不亲自执行**，只负责生命周期流转、智能体加载、上下文传递、门禁管理
- **按定级动态加载**：T0 仅加载 1-2 个智能体，T2 加载全部
- **可插拔**：新增智能体只需在 kilo.json 注册 + agent/ 新增文件 + lifecycle 阶段声明

### 智能体清单（9 个职能智能体 + 1 个编排者）

| ID | 智能体名 | 职责 | 对应生命周期阶段 | 模型绑定 | mode | prompt 锚点 |
|----|----------|------|------------------|----------|------|-------------|
| 0 | **conductor** | 工作流编排者：意图判定、定级、阶段流转、智能体加载调度、上下文传递、门禁管理 | 全阶段（不亲自执行） | `kilo.json` `agent.conductor.model` | primary | `agent/conductor.md` |
| 1 | **planner** | 规划智能体：设计门、方案设计、单元 DAG 拆分、验收点定义、全量扫描清单 | PLANNING | `kilo.json` `agent.planner.model` | subagent | `agent/planner.md` |

| 3 | **coder** | 编码智能体：按方案实现代码、输出验收映射表+三件套、状态信号 | EXECUTING | `kilo.json` `agent.coder.model` | subagent | `agent/coder.md` |
| 4 | **verifier** | 正向验证智能体：按验收标准逐条验证、L1/L2/L3 分层、5元组证据、独立重跑 | QUALITY（verify hook） | `kilo.json` `agent.verifier.model` | subagent | `agent/verifier.md` |
| 7 | **reviewer** | 静态代码审查智能体：阅读代码审查安全编码模式/架构/简化/SCOPE_CREEP 四视角 | QUALITY（review hook） | `kilo.json` `agent.reviewer.model` | subagent | `agent/reviewer.md` |


### 模型选择策略（v3.1 方案1：模型统一在 kilo.json）


| 智能体 | 能力需求（registry 别名） | 理由 |
|--------|--------------------------|------|
| conductor | `fast-reasoning` / 通用 reasoning | 200K 上下文容纳全流程编排 |
| planner | `deep-reasoning` | 架构分析、长上下文、复杂推理最强 |

| coder | `code-generation` | Code-tuned，编码专精 |
| verifier | `strict-verification` | 安全敏感、边界敏感、逻辑审查强 |
| reviewer | `deep-reasoning` | 架构视角审查需要强 reasoning |
| fixer | `code-generation` | 代码修复需要编码能力 |

> **v3.1 视角物理隔离原则**：仅靠独立 context window 不足以防止确认偏误——各验证智能体的**输入接口字段**必须物理隔离（详见 §视角物理隔离）。

### kilo.json agent 配置（示例结构）

```json
{
  "default_agent": "conductor",
  "agent": {
    "conductor": {
      "mode": "primary",
      "model": "<见 kilo.json 实际绑定>"
    },
      "mode": "primary",
      "model": "<见 kilo.json 实际绑定>"
    },
      "mode": "subagent",
      "model": "<见 kilo.json 实际绑定>"
    },
    "planner":     { "mode": "subagent", "model": "<见 kilo.json>" },
    "coder":       { "mode": "subagent", "model": "<见 kilo.json>", "prompt": "..." },
    "verifier":    { "mode": "subagent", "model": "<见 kilo.json>", "prompt": "..." },
    "reviewer":        { "mode": "subagent", "model": "<见 kilo.json>", "prompt": "..." },
    "fixer":           { "mode": "subagent", "model": "<见 kilo.json>", "prompt": "..." }
  }
}
> 注：此为结构示例，模型 ID 实际绑定以仓库 `kilo.json` 为单一真相来源（v3.1 方案1）。
```

> **subagent 智能体不在 kilo.json 中声明**：planner/coder/verifier 等职能智能体通过 conductor 的 `task` 工具按需启动（`subagent_type` 参数指向对应 agent/*.md），不需要在 kilo.json 注册。这与 Kilo 的 subagent 机制一致——只有 primary agent 需要在 kilo.json 声明。

---

## 2. 生命周期阶段 → 智能体加载映射（可插拔规则）

### 设计：frontmatter `mount` 文件路由（v6.0，唯一挂载机制）

智能体在**自身 `agent/<name>.md` frontmatter** 中声明挂载点，可挂载一个或多个点；新增/调整智能体不需要改阶段文件——丢文件即注册，类似文件制自动路由：

```yaml
# agent/verifier.md frontmatter 片段
description: 正向验证智能体...
mode: subagent
# 模型绑定在 kilo.json agent.verifier.model；能力倾向参考 docs/model-registry.md
mount:
  - at: QUALITY                  # 主挂载点（v2 响应式 Hooks 阶段）
    hook: verify
# mount 可选字段：order（同挂载点执行顺序，升序数字；省略=并行组）
#                 when（条件挂载）/ on_fail（abort|warn|skip|degrade）
```

**挂载点命名空间（派生，零声明——节点存在即挂载点存在）**：

| 挂载点 | 触发时机 |
|------|----------|
| `on:bootstrap` | 装配完成后、INIT 前 |
| `on:done` | DELIVERING 完成后、DONE 前 |

必配角色契约在 **stages/<id>.md frontmatter `required_roles`**（阶段语义内聚，单源声明）——graph.yaml 纯拓扑，零智能体名/角色名：

```yaml
# lifecycle/graph.yaml 节点（纯拓扑：无角色名）
- id: QUALITY
  type: stage
  on_fail: escalate
```

```yaml
# lifecycle/stages/quality.md frontmatter
required_roles: [verifier]       # 主挂载点必须覆盖（无 agent frontmatter 挂载 → [ASSEMBLY_FAIL]）
```

> 角色名 = 智能体文件名（去 .md）或其 frontmatter 显式 `role` 字段（多智能体同角色）。路由目标不需要知道谁挂上来——校验由 bootstrap / `scripts/lifecycle-doctor.mjs` 静态预演。**增删智能体永不改 graph.yaml**；仅引入"新角色作为某阶段必配"时才动该阶段 stages 文件 frontmatter 一行（阶段语义变化，内聚）。
>
> conductor 内建阶段（INIT + DELIVERING）声明 `executor: conductor`，主挂载点由内建逻辑占据，不经 `task` 启动。v7 修复后 DELIVERING 回归内建模式。

### 可插拔机制（启动期装配 / bootstrap）

#### 装配与运行时
2. 同挂载点按 `hook` 类型分组 + `after` 相对依赖拓扑排序（同 hook 类型默认并行，无 after 依赖时单条消息并行发起；需要顺序时声明 after，有 after 按拓扑串行）；校验各阶段 `required_roles` 被主挂载点注册覆盖
3. 装配 resolved 视图：`{ mountPoint → [{ agent, model, hook, after, trigger, deps, when, on_fail }]（已排序/分组）}` + edges 表；运行时查表，零重复解析
4. 进入节点 N：`pre:N` → 主挂载点（并行组 + after 拓扑序，或 executor 内建）→ `post:N` → 按 edges + when/gate 流转；装配后立即执行 `on:bootstrap`，入 DONE 前执行 `on:done`
5. 每个智能体启动时按 frontmatter `task_context.read` 注入上下文切片（见第 3 章）；完成后按 `task_context.write` 收回结果

#### 可扩展规则（文件制自动注册）
- **新增智能体**：丢 `agent/<name>.md`（行为 + frontmatter `mount` 挂载声明，v6 单源）+ `kilo.json` 加模型绑定——**两步搞定，graph.yaml / config.yaml / stages / 脚本全不动**（WRITE_MATRIX 自动派生；超时回退默认值；无 `when` = 恒定挂载，图拓扑可达即加载）；仅引入"新角色作某阶段必配"时才在该阶段 stages frontmatter `required_roles` 加一行
- **挂载任意阶段 / 多点挂载 / 调整顺序**：只改 frontmatter `mount`（`at` 选挂载点；多条目即多点挂载；`after` 声明相对依赖，只引用前驱 agent 名，零改其他文件）
- **插入中间阶段**：`graph.yaml` 加 node（type/executor/on_fail，纯拓扑）+ 改 edges + 丢一个 `stages/<name>.md`（frontmatter：执行元数据 + 非内建阶段需 `required_roles`）——语义 ID 无数字编号，三挂载点自动派生
- **禁用/替换/换模型**：`lifecycle/config.yaml` 的 `overrides.disabled_agents` / `model_overrides` / `condition_overrides` 改一行（禁用使 `required_roles` 角色无履行者 → `[ASSEMBLY_FAIL]`）
- **装配自检**：改完任何 lifecycle/agent 配置跑 `node scripts/lifecycle-doctor.mjs`——全 PASS 才算完

### 按定级的智能体加载矩阵（唯一声明处：`lifecycle/config.yaml` tier_defaults）

| 阶段 | T0 | T1 | T2 |
|------|----|----|----|
| INIT | conductor | conductor | conductor |
| QUALITY（verify hook） | — | verifier | verifier |
| QUALITY（fix hook） | — | fixer（auto-trigger） | fixer（auto-trigger） |
| QUALITY（review hook, 审查） | — | reviewer | reviewer |

> **T0 直达**：conductor 直接加载 coder 执行，无 planner/verifier/reviewer，与现有 workflow-core.md §T0 直达一致。
>
> **post:PLANNING 钩子（定级挂载 tiers）**：post:PLANNING 挂载点可挂载方案审查等后处理智能体（plan-reviewer `tiers: [T2]`——T2 挂载）——on_fail: abort 可中止进入 EXECUTING。它属文件路由挂载机制（mount 声明定级挂载字段而非 tier_defaults 定级组合），故不在上表按定级列出；T0 不经 PLANNING，图拓扑天然限定仅 T1/T2 触发，tiers 再按 sizing.tier 过滤命中（T1 关闭、T2 开启）。

---

## 3. 共享上下文机制设计


#### 第一层：任务级共享上下文 `task_context.json`


**结构**：

```json
{
  "task_id": "task-20260727-001",
  "created_at": "2026-07-27T01:00:00Z",
  "updated_at": "2026-07-27T01:30:00Z",
  "intent": {
    "type": "EXECUTION",
    "keywords": ["lifecycle", "multi-agent"],
    "original_request": "用户原始请求摘要"
  },
  "sizing": {
    "level": "T2",
    "calibrated_level": "T2",
    "rationale": "跨模块，5+文件"
  },
  "plan": {
    "approach": "方案概述",
    "acceptance_criteria": ["标准1", "标准2"],
    "unit_dag": [
      {"unit_id": "U1", "files": ["a.md"], "deps": [], "status": "DONE"},
      {"unit_id": "U2", "files": ["b.md"], "deps": ["U1"], "status": "PENDING"}
    ],
    "scan_checklist": ["全量同类点扫描清单"],
    "forbidden_files": ["禁止触碰的文件"]
  },
  "plan_review": {
    "verdict": "PASS",
    "issues": []
  },
  "execution": {
    "current_unit": "U2",
    "completed_units": ["U1"],
    "diffs": {
      "U1": {"files": ["a.md"], "summary": "变更摘要", "acceptance_map": {...}}
    }
  },
  "verification": {
    "forward": {"verdict": "PASS", "evidence": [...]},
    "review": {"verdict": "PASS", "perspectives": {...}}
  },
  "fixing_history": [
    {"round": 1, "issue": "...", "fix": "...", "verifier_result": "PASS"}
  ],
    "facts_used": ["AP-006", "PAT-001"],
    "context_used": ["PC-001"]
  },
  "status": "EXECUTING",
  "convergence": {
    "round": 2,
    "max_rounds": 3,
    "circuit_breaker": false
  }
}
```

#### 读写规则

| 智能体 | 读取 | 写入 |
|--------|------|------|
| planner | intent/sizing/plan_review | plan |

| verifier | plan/execution.diffs[current_unit] | verification.forward |
| reviewer | plan/execution/verification | verification.review |
| fixer | verification(issues)/plan/forbidden_files | fixing_history/execution.diffs |

#### 注入机制
- conductor 启动智能体时，将 `task_context.json` 的相关章节作为 `task` 工具 prompt 的一部分注入
- 智能体完成后，返回结构化结果，conductor 更新 `task_context.json`
- **不重复从 0 开始**：每个智能体都能看到前序阶段的完整上下文（方案、已完成单元、验证结果、失败历史）


> 以下五表清单中 fact_store 与 model_calibration 已废弃，现以 graph.yaml 为单一真相源。

- ~~`fact_store`：跨任务经验模式（PATTERN/ANTIPATTERN/RECIPE/WARNING）~~
- `failure_db`：失败案例
- `dispatch_log`：任务调度记录
- ~~`model_calibration`：模型能力校准~~
- `project_context`：项目级用户偏好/安全约束


---

## 4. 交叉验证协议设计

### 四视角交叉验证

| 视角 | 智能体 | 验证方向 | 核心问题 |
|------|--------|----------|----------|
| **正向验证** | verifier | 验收标准 → 产物 | 产物是否满足每条验收标准？L1/L2/L3 分层验证 |
| **审查** | reviewer | 架构/简化/SCOPE_CREEP | 架构合理性、可简化、安全、范围蔓延 |

### 正向验证（verifier）— 复用现有 verification.md 逻辑
- L1（语法/编译/格式/编码）
- L2（逻辑/边界/范围/SCOPE_CREEP）
- L3（覆盖/安全/架构，T2）
- 5 元组证据（命令/参数/exit code/stdout/stderr）
- 独立重跑，禁止信任传递

1. **需求追溯**：从产物反推，列出原始需求的每一点，确认是否被覆盖
2. **假设审计**：列出实现中隐含的假设，验证每个假设是否成立
3. **隐性遗漏检测**：检查是否有"用户没说但应该做"的部分被遗漏
4. **过度实现检测**：检查是否有"用户没要求但做了"的部分（与 SCOPE_CREEP 互补，SCOPE_CREEP 看 diff 范围，反审看语义范围）

1. **边界条件**：空输入、极大输入、并发、错误路径
2. **安全扫描**：注入、越权、敏感信息泄漏
3. **性能影响**：时间复杂度、内存、I/O
4. **兼容性**：向后兼容、跨平台、跨版本

### 审查（reviewer）— 复用现有 review.md 四视角
- 安全视角
- 架构视角
- 简化视角
- SCOPE_CREEP 视角

### 组合判定规则（v3.1 机械汇总 + convergence-auditor）

```
全视角 verdict 字段 AND 运算 → quality_verdict=PASS → 离开 QUALITY → DELIVERING
任一视角 verdict=FAIL → 自动触发 fix hooks（QUALITY 内部循环）
  ├─ verifier FAIL → fixer 按验收标准修复 → code 变化 → 自动 re-verify
  └─ reviewer FAIL → fixer 按审查建议修复 → code 变化 → 自动 re-verify
warning（非 blocker）→ 标记但放行，写入 task_context 供后续参考
```

> **不采用投票制**：每个视角都是硬门，任一 FAIL 都必须修复。不存在"多数通过则放行"——质量不打折。
> **v3.1 机械汇总原则（反自验）**：conductor 同时承担编排（写入 task_context）与组合判定。为防止"自写自判"的确认偏误，组合判定必须是**机械汇总**——只读取各视角独立输出的 `verdict` 字段做 AND 运算，不做主观判定、不重新解读证据、不补判。任一视角的 FAIL 由该视角智能体独立给出，conductor 不得推翻或降级。
> **v3.1 convergence-auditor 反向校验**（T2+ 可选硬门）：QUALITY 阶段收齐各视角 verdict 后，conductor 内建轻量校验步骤，反推三项：
> 1. 每个视角智能体是否真的独立执行（检查 task_context.verification.{forward,review} 是否各有独立 evidence）
> 2. 是否存在信任传递（grep 智能体输出是否含"coder 说的对""verifier 已 PASS"等措辞）
> 3. evidence 是否为本轮 fresh（不得复用前序阶段声明）
> 任一项不满足 → `[TRUST_TRANSFER]`，整阶段降级为 FAIL，重跑该视角。

### v3.1 视角物理隔离（反确认偏误 / 反从众偏误）

> **核心问题**：独立 context window 不足以防止确认偏误——如果反向/侧向/审查视角的**输入接口字段**包含前序阶段的结论，模型会锚定"正向已 PASS"而倾向不再质疑，产生从众偏误。物理隔离要求各验证智能体的输入字段**不含**前序阶段结论。

| 智能体 | 应输入 | 应隔离（禁止注入） | 隔离理由 |
|--------|--------|--------------------|----------|
| verifier | plan + execution.diffs/changes/forbidden_files + acceptance_criteria | execution.verification / fixing_history | 任何 coder/fixer 自验声明产生信任传递 |
| fixer | blockers + original_diff + forbidden_files + fixing_history | verification.* / execution.verification | 修复不得被前序结论锚定；自验声明不入 context 污染下一轮 verifier |
| coder（输出） | — | 禁止写入 execution.verification | 自验声明由 verifier 独立重跑，不入 context |
| fixer（输出） | — | 禁止写入 execution.verification | 修复后自验声明由 verifier 独立重跑，不入 context |

> **写入边界硬门**：`execution.verification` 字段只能由 verifier 智能体写入。coder/fixer 自验结果只保留在智能体本地输出，不得写入 task_context。违反 → `[TRUST_TRANSFER]`。
> **校验机制**：`lifecycle-doctor.mjs` 自动校验视角物理隔离规则，check27 校验模型硬编码反查。

---

## 5. 循环确认机制设计

### QUALITY 内部 hooks 循环流程（v2 响应式）

```
EXECUTING（coder）
  │
  ▼
QUALITY（响应式 Hooks 容器）
  │
  ├─ verify hooks（默认并行，无 after 依赖）
  │   ├─ verifier（正向）──┐
  │   └─ （各自独立 context）──┘
  │   │
  │   ▼ 全 PASS？
  │   ├─ 是 → review hooks
  │   └─ 否 → fix hooks → code 变化 → 自动 re-verify（循环）
  │
  ├─ review hooks（trigger: afterPass，保留串行场景）
  │   ├─ reviewer（审查）──┐
  │   └─ （各自独立 context）──┘
  │   │
  │   ▼ 全 PASS？
  │   ├─ 是 → quality_verdict=PASS → DELIVERING
  │   └─ 否 → fix hooks → code 变化 → 自动 re-verify（循环回到 verify hooks）
  │
  └─ 熔断：quality.round >= hooks.quality.max_total_cycles → quality_verdict=CIRCUIT_BREAKER → DELIVERING（带降级标记）
```

### 收敛条件

| 条件 | 动作 |
|------|------|
| 全视角 PASS | 收敛，进入下一阶段 |
| fixer 连续 2 轮同症状 | 升级：标记 `[NEEDS_REVIEW_ESCALATION]`，reviewer 介入做根因分析 |
| 累计循环 ≥ 3 轮 | `[CIRCUIT_BREAKER]`，停止，输出选项等用户决策 |
| fixer 修复后验证仍 FAIL 3 次 | `[CIRCUIT_BREAKER]`，停止 |

### 循环计数
- `task_context.quality.round` 每次进入 QUALITY 时 +1
- `task_context.quality.max_rounds` 默认 3（来源：`lifecycle/config.yaml` `hooks.quality.max_total_cycles`）

---

## 6. 文件结构迁移方案

### 保留（不变）
- `.kilo/instructions/core.md` — 通用基线
- `.kilo/instructions/workflow-core.md` — T0-T2 定级 + 门禁（术语映射注释需更新）
- `kilo.json` `skills.paths` — skill 能力扩展运行时发现入口（仓库不预置 skill 源文件，运行时从项目级 `.kilo/skills/` 与社区源 `~/.agents/skills` 发现）
- `lifecycle-doctor.mjs` — 主体保留，新增检查项
- `install.sh` / `install.ps1` — 不变

### 修改

> **历史迁移档案**：以下表格记录的是 v2.x 时代从 `coderAgent` 迁移到 `orchestrator` 的原始动作清单，作为历史档案保留原 `orchestrator` 字样。该角色后续已再次改名为 `conductor`（v3.3，避免与 kilo 内置 agent 重名）；当前架构中以 `conductor` 为唯一编排者智能体名。详见本文件 §1 智能体清单表与 `agent/conductor.md`。

| 文件 | 修改内容 |
|------|----------|
| `kilo.json` | `coderAgent` → `orchestrator`；prompt 锚点更新 |
| `agent/coderAgent.md` | 重命名为 `agent/orchestrator.md`；更新为多智能体编排逻辑 |
| `agent/lifecycle/README.md` | 状态机图更新：每阶段标注加载的智能体；组合规则更新 |
| `agent/lifecycle/01-intent.md` | frontmatter 加 `agents: [orchestrator]` |
| `agent/lifecycle/02-sizing.md` | frontmatter 加 `agents: [orchestrator]` |
| `agent/lifecycle/03-design.md` | frontmatter 加 `agents: [planner]`；引用改为 planner 智能体 |
| `agent/lifecycle/04-implementation.md` | frontmatter 加 `agents: [coder]` |
| `agent/lifecycle/07-repair.md` | frontmatter 加 `agents: [fixer]` |
| `agent/lifecycle/08-delivering.md` | frontmatter 加 `agents: [orchestrator]`；task_context 归档逻辑 |
| `agent/models/registry.md` | 按阶段选择策略表更新为按智能体选择 |
| `AGENTS.md` | 锚点更新：`coderAgent` → `orchestrator`；新增多智能体协作锚点 |
| `README.md` | 目录树更新：agent/ 结构变更 |
| `CONFIG_CHANGE_CHECKLIST.md` | agent 引用更新 |
| `.kilo/instructions/workflow-core.md` | 术语映射注释更新：角色名 → 智能体名 |

### 新建

| 文件 | 内容 |
|------|------|
| `agent/orchestrator.md` | 编排者智能体（从 coderAgent.md 演化） |
| `agent/planner.md` | 规划智能体（从 capabilities/architecture-design.md 演化） |
| `agent/coder.md` | 编码智能体（从 capabilities/implementation.md 演化） |
| `agent/verifier.md` | 正向验证智能体（从 capabilities/verification.md 演化） |
| `agent/reviewer.md` | 静态代码审查智能体（从 capabilities/review.md 演化） |
| `agent/fixer.md` | 修复智能体（从 capabilities/repair.md 演化） |
| `docs/multi-agent-lifecycle-architecture.md` | 本设计文档 |

### 删除

| 文件 | 理由 |
|------|------|
| `agent/coderAgent.md` | 重命名为 orchestrator.md |
| `agent/capabilities/` 目录 | 不再需要 |


### lifecycle-doctor.mjs 新增检查

| 检查项 | 说明 |
|--------|------|
| check23 | 智能体文件完整性：`agent/` 下所有声明 `mount` 的智能体 .md 文件存在 |
| check24 | lifecycle 阶段文件 `agents` frontmatter 字段声明的智能体全部存在 |
| check25 | task_context 读写规则一致性：lifecycle 阶段文件声明的智能体在 `agent/` 下有对应 .md |

---

## 7. 与现有 workflow-core.md / core.md 的兼容

### 保留

| 现有机制 | 保留状态 |
|----------|----------|
| T0-T2 定级 | ✅ 完全保留，两阶段定级不变 |
| 8 节点强制流程日志 | ✅ 保留，节点名从"能力插件"改为"智能体" |
| 安全敏感模块识别 | ✅ 完全保留 |
| 单元 DAG | ✅ 完全保留，planner 智能体产出 |
| Circuit Breaker | ✅ 完全保留 |
| skill 能力扩展发现 | ✅ 保留，由 `kilo.json` `skills.paths` 声明运行时发现路径（项目级 + 社区源），仓库不预置 skill 源 |

### 修改

| 现有机制 | 修改内容 |
|----------|----------|
| 强制流程日志"能力插件"列 | 改为"智能体"列 |
| review_mode 决策表 | T0→none，T1→正向+审查，T2→正向+反向+侧向+审查 |

### 新增

| 新机制 | 说明 |
|--------|------|
| task_context 共享上下文 | 新增，见第 3 章 |
| 交叉验证组合判定 | 新增四视角组合规则 |

---

## 8. 风险和权衡

### 多智能体的开销

| 开销类型 | 评估 | 缓解 |
|----------|------|------|
| Token 成本 | 每个智能体独立 context window，总 token 是单 agent 的 3-5 倍 | T0/T1 不启动全部智能体；task_context 只注入相关章节 |
| 延迟 | 并行启动多个智能体降低 wall-clock 延迟（官方 task 工具并发模式；有 after 依赖链仍串行） | T0/T1 按需加载，减少不必要启动 |
| 上下文传递损耗 | task_context 摘要可能丢失细节 | task_context 结构化字段 + 关键原文保留 |

### 共享上下文的同步风险

| 风险 | 缓解 |
|------|------|
| 并发读写冲突 | conductor 是唯一写入者，智能体只读 + 返回结构化结果由 conductor 写入 |
| 上下文过大 | task_context 只保留结构化摘要 + 关键证据，不保留完整对话 |

### 何时用多智能体 vs 单 agent

| 定级 | 智能体数量 | 理由 |
|------|-----------|------|
| T0 | 2（conductor + coder） | ≤2 行改动，conductor 委派 coder 执行，跳 PLANNING/QUALITY 极速通道 |
| T1 | 3-4（conductor + planner + coder + verifier + reviewer） | 单模块，正向验证+审查足够 |

### 降级策略

| 触发条件 | 降级策略 |
|----------|----------|
| 某智能体启动失败 | conductor 标记 `[AGENT_UNAVAILABLE]`，跳过该视角，记录降级 |
| 多个智能体不可用 | 降级为单 conductor 模式 + 标记 `[DEGRADED_SINGLE_AGENT]` |
| task_context 读写失败 | 降级为信号传递模式（当前实现） + 标记 `[CONTEXT_SHARING_DEGRADED]` |

---

> **已归档**：本文档原始的"实现单元 DAG"（U1-U12）与"审核检查清单"已迁移至 `docs/archive/multi-agent-lifecycle-architecture-v1.md`，作为 v1→v2 迁移的历史执行参考。当前架构落地清单请参考 `lifecycle/graph.yaml` + `agent/*.md` frontmatter。


---

## 附录 A：v1 原始实现单元 DAG（历史档案）

| 单元 | 内容 | 依赖 | 验收标准 |
|------|------|------|----------|
| U1 | kilo.json 更新：coderAgent → conductor | 无 | kilo.json 合法 + validator PASS |
| U2 | agent/ 新建 8 个智能体 .md 文件 | U1 | 8 文件存在 + frontmatter 合规 |
| U3 | agent/coderAgent.md 重命名为 conductor.md + 内容更新 | U2 | 引用一致 |
| U4 | agent/capabilities/ 合并到智能体文件 + 删除目录 | U2,U3 | capabilities/ 不存在 + validator PASS |
| U5 | agent/lifecycle/*.md frontmatter 加 agents 字段 + 内容更新 | U2,U4 | 8 阶段文件 agents 字段完整 |
| U6 | agent/lifecycle/README.md 状态机图更新 | U5 | 状态图标注智能体 |
| U7 | agent/models/registry.md 更新为按智能体选择 | U2 | 模型矩阵更新 |
| U8 | AGENTS.md + README.md + CONFIG_CHANGE_CHECKLIST.md 更新 | U3,U5 | 索引一致 |
| U9 | workflow-core.md 术语映射注释更新 | U3,U5 | 角色名 → 智能体名 |
| U10 | lifecycle-doctor.mjs 新增 check23/24/25 | U2,U5 | 25/25 PASS |
| U12 | task_context 机制文档化（conductor.md 中定义读写规则） | U3 | conductor.md 含 task_context 章节 |

---

## 附录 B：v1 审核检查清单

- [ ] 智能体清单是否符合"规划/编码/检查等独立智能体"意图
- [ ] 交叉验证四视角是否覆盖"正向/反向/侧向/审查"
- [ ] task_context 共享机制是否满足"不重复从0开始"
- [ ] 可插拔机制是否满足"自定义决定加载哪些智能体"
- [ ] T0-T2 定级保留是否影响兼容性
- [ ] 文件迁移方案是否可接受（8 个 capabilities 删除 + 8 个 agent 新建）
- [ ] 降级策略是否足够

> **用户审核通过后，按 U1-U12 单元 DAG 依次委派 engineer 执行，每单元 verifier 验证 + reviewer 审查。**
