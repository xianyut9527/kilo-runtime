---
description: 生命周期阶段 QUALITY — 质量保障（响应式 Hooks 阶段）。合并原 CHECKING + REVIEWING + FIXING，内部 hooks 自动循环。支持 EXECUTION 模式（代码验证）和 INQUIRY 模式（分析结论验证）。
model_capability: strict-verification
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 必配：verifier（verify hook）；reviewer（review hook）
# 可选：反向审计角色（verify hook, T2+）；侧向验证角色（review hook, T2+）；修复角色（fix hook, auto-trigger）
required_roles: [verifier, reviewer]
---

# lifecycle/stages/quality

> v2 响应式 Hooks 架构核心阶段。合并原 `CHECKING` + `REVIEWING` + `FIXING`，数据驱动自动循环。
> **v2.1 模式切换**：QUALITY 阶段根据 `task_context.intent_type` 在「代码验证（execution）」与「分析结论验证（analysis）」之间自动切换。hook 类型和循环结构不变，但验证/审查标准按模式适配。
> **v2.2 四视角独立子槽**：QUALITY 四视角（正向验证 / 反向审计 / 静态审查 / 侧向验证）是 **4 个独立子槽**，非 hook 链。每个子槽由 conductor 通过 `task` 工具**串行主通道**独立 dispatch（T1/T2，逐个串行，遵守零输出硬门；**size-check 前置门**不过或 `overload_count >= 3` 时强制切 `agent_manager` `mode: worktree` 兜底，见 conductor.md 铁律 #6 pre-dispatch 硬门），T3 经 `agent_manager` `mode: worktree`（独立 worktree 隔离）。子槽之间无共享状态、无顺序依赖，各自独立产出 verdict。conductor 收齐 4 个 verdict 后做机械 AND 汇总。这与 hook 链（verify→fix→review→fix 循环）是正交的两个维度：hook 链定义 QUALITY 容器内的自动循环逻辑，子槽定义每个 hook 阶段内并发/串行的 agent 实例化方式。
> 流转关系见 `lifecycle/graph.yaml`（纯拓扑，QUALITY → DELIVERING）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 设计理念

QUALITY 不是"一个阶段做三件事"，而是**一个响应式容器，内部 hooks 按数据变化自动触发**：

- `code/analysis` 变化 → 自动触发 **verify hooks**
- `verify_result` 变化 → 自动触发 **review hooks**（全 PASS）或 **fix hooks**（FAIL）
- `code/analysis` 修复后 → `code/analysis` 变化 → 自动重新触发 **verify hooks**
- conductor **不需要手动回流**，框架自动管理循环

### 为什么不用 `order` 绝对编号

~~旧设计用 `order: 10/20/30/40` 绝对编号排序智能体~~。这与 React/Vue hooks 的设计哲学矛盾：

| React hooks | 旧 `order` 系统 | 新 `after` 系统 |
|-------------|----------------|-----------------|
| `useEffect` 按声明顺序执行，无编号 | `order: 10` 绝对坐标 | `hook` 类型定义阶段顺序 |
| `useEffect(fn, [deps])` deps 变化才执行 | 无 deps 机制 | `deps: [field]` 响应式触发 |
| 插入新 hook 只写一行，不碰其他代码 | `order: 15` 要知道前后编号 | `after: [agent]` 只引用前驱 |
| 同类 hook 隐含串行/顺序语义 | 靠数字碰巧相同实现并行 | `hook: verify` 默认串行启动组（详见 agent/conductor.md §全局默认串行策略） |

**核心原则**：hook 类型（`verify` / `fix` / `review`）**本身就定义了执行顺序**——`verify → fix → review → fix` 循环是框架内置的，不需要数字重复表达。同 hook 类型默认按 `agent/conductor.md` §智能体加载规则串行启动（无 `after` 时默认串行，按 agent 文件名字典序逐个启动，遵守零输出硬门）；需要顺序时声明 `after: [agent-name]`。仅 `graph.yaml` 声明 `parallel: true` 的节点（如 T3 子图 `MM_EXECUTING`）保留最大并行语义。详见 `agent/conductor.md` §智能体加载规则。

```
QUALITY 容器内自动循环（hook 类型定义顺序，无绝对编号）：
  code/analysis 就绪 → verify hooks 串行启动（hook: verify，无 after = 默认串行，按 agent 文件名字典序逐个启动；遵守零输出硬门）
    → 任一 FAIL → fix hooks（hook: fix, trigger: onFail）→ code/analysis 变化 → 重新 verify
    → 全 PASS → review hooks 串行启动（hook: review, trigger: afterPass，无 after = 默认串行，按 agent 文件名字典序逐个启动；遵守零输出硬门）
      → 任一 FAIL → fix hooks（同一修复角色，trigger: onFail）→ code/analysis 变化 → 重新 verify
      → 全 PASS → quality_verdict=PASS → 离开 QUALITY → DELIVERING
```

## 输入

> **视角物理隔离**：verify hooks 只读 `plan + execution.code + forbidden_files + acceptance_criteria`（EXECUTION 模式）或 `plan + execution.analysis + forbidden_files + conclusion_framework`（INQUIRY 模式），**禁止读 `execution.quality / fixing_history`**。review hooks 只读 `execution.code/analysis + plan + acceptance_criteria/conclusion_framework + project_context`，**禁止读 `execution.quality` 的报告结论**。fix hooks 读取 `execution.quality.issues + fixing_history`。

### EXECUTION 模式输入
- 编码角色输出的完整代码产物（`execution.code`：diff + changes + acceptance_map）
- 原始验收标准清单
- 设计门方案（T1+，用于核对范围）
- 原始意图（反向审计 hook 用，**不传 plan**）
- project_context（审查 hook 用）

### INQUIRY 模式输入
- 分析角色输出的完整分析产物（`execution.analysis`：结论摘要 + 证据清单 + 引用来源 + 维度覆盖）
- 分析门输出的结论框架（conclusion_framework，T1+）
- 原始问题与边界定义（反向审计 hook 用，**不传 plan**）
- project_context（审查 hook 用）

### execution.analysis 结构定义

```yaml
execution:
  analysis:
    conclusion_summary: "string"       # 分析结论摘要
    evidence:                          # 证据清单
      - { file: "string", line: int, snippet: "string", relevance: "string", source: "string" }
    dimensions_covered: ["string"]     # 已覆盖的分析维度
    dimensions_missing: ["string"]     # 未覆盖的分析维度
    bias_flags: ["string"]             # 偏见标记（如 confirmatory_bias / selection_bias）
    confidence: "HIGH" | "MEDIUM" | "LOW"  # 置信度
```

## Hooks 挂载（内部自动编排）

> **编排规则**：hook 类型（`verify` / `fix` / `review`）定义执行顺序，不需要绝对编号。同 hook 类型默认按 `agent/conductor.md` §智能体加载规则串行启动（无 `after` 时默认串行，按 agent 文件名字典序逐个启动，遵守零输出硬门）。需要顺序时声明 `after: [agent-name]`（相对依赖，类似 React hooks 的声明顺序）。框架对 `after` 做拓扑排序，检测环依赖报错。

### hook: verify — 验证 hooks（串行启动组，无 after 时默认串行）

```yaml
# agent/verifier.md
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "execution.analysis", "plan"]
    # 无 after = 默认串行（按 agent 文件名字典序逐个启动；遵守零输出硬门）
```

**触发时机**：当 `execution.code` / `execution.analysis` 或 `plan` 变化时自动执行。

#### EXECUTION 模式验证职责
- L1 语法/编译/格式/编码验证
- L2 逻辑/边界/范围验证（含 SCOPE_CREEP）
- L3 覆盖/安全/架构验证（仅 T2/T3）
- 输出 `forward_result: PASS | FAIL`

#### INQUIRY 模式验证职责（分析结论验证）
- **A1 事实准确性**：引用的文件路径、函数名、配置值是否真实存在？是否有虚假引用（`[FAKE_CONTEXT]`）？
- **A2 引用完整性**：每个结论是否有足够的证据支撑？关键结论是否有直接引用（文件:行号/代码片段）？
- **A3 维度覆盖**：是否遗漏了分析门预设的某个维度？是否回答了用户问题的所有方面？
- **A4 偏见检测**：是否存在确认偏误（只引用支持自己观点的证据）？是否考虑了反面证据？
- **A5 逻辑一致性**：结论之间是否存在矛盾？推理链条是否完整（前提→论据→结论）？
- 输出 `forward_result: PASS | FAIL`

```yaml
# 履行反向审计角色的智能体（默认 T2+ 加载）
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "execution.analysis", "intent"]
    when: "config.agents.reverse_auditor"
    # after: [verifier] 使反向审计角色在 verifier 完成后串行启动，避免 verify 组内并发 task 触发底层执行器 Tool execution aborted（遵守零输出硬门），见 agent/reverse-auditor.md
```

**触发时机**：在 verifier 完成后串行启动（after: [verifier]）。

#### EXECUTION 模式反向审计职责
- 从产物反推需求满足度
- 假设审计
- 隐性遗漏检测
- 过度实现检测
- 输出 `reverse_result: PASS | FAIL | N/A`

#### INQUIRY 模式反向审计职责
- **需求追溯**：分析结论是否回答了用户原始问题？是否存在"答非所问"或"过度延伸"？
- **假设审计**：分析中是否隐含了未验证的假设（如"假设当前版本是稳定的"）？
- **隐性遗漏**：是否有用户没说但应该考虑的角度？对照 failure_db 同类失败模式。
- **过度分析**：是否存在"为了分析而分析"，引入了与问题无关的维度？
- 输出 `reverse_result: PASS | FAIL | N/A`

> **新增 verify hook 智能体**：声明 `hook: verify` 即自动加入串行启动组。如需在某个 agent 之后执行，加 `after: [agent-name]`——只引用前驱，无需知道编号。

### hook: fix — 修复 hooks（条件触发）

```yaml
# agent/fixer.md
mount:
  - at: QUALITY
    hook: fix
    trigger: onFail        # 当任一 verify/review hook 返回 FAIL 时触发
    deps: ["execution.quality.issues"]
    # 单一挂载条目覆盖 verify FAIL 和 review FAIL（trigger: onFail 响应所有 FAIL 信号）
```

**触发时机**：`execution.quality.issues` 字段非空时自动触发（任一 verify 或 review hook FAIL）。

#### EXECUTION 模式修复职责
- 读取 `issues` 列表（含来源 hook、严重度、证据）
- 定向修复，输出修复后的 `execution.code`
- **修复后自动触发**：`code` 变化 → verify hooks 重新执行

#### INQUIRY 模式修复职责
- 读取 `issues` 列表
- 定向补充/修正分析，输出修复后的 `execution.analysis`（补充遗漏证据、修正错误事实、调整偏见结论）
- **修复后自动触发**：`analysis` 变化 → verify hooks 重新执行
- **INQUIRY 约束**：修复角色只修改分析文本/结论，**禁止调用修改性工具**（edit/write/create/delete）。

**自动循环语义**（框架自动处理）：

```js
// 伪代码：框架内部循环逻辑（hook 类型定义顺序，无绝对编号）
while (round < config.hooks.quality.max_total_cycles) {
  // Step 1: verify hooks 串行启动（hook: verify 组，默认串行策略，详见 agent/conductor.md §全局默认串行策略）
  const verifyResults = await runSerially(
    agentsWithHook('verify').map(a => () => a.run(executionCodeOrAnalysis, plan))
  );
  // verifier → reverseAuditor?（条件加载，after: [verifier] 串行）

  if (verifyResults.some(r => r.verdict === 'FAIL')) {
    // Step 2: fix hooks（hook: fix, trigger: onFail）
    const issues = collectIssues(verifyResults);
    executionCodeOrAnalysis = await runFixHooks(issues);
    // code/analysis 变化 → 循环继续
    continue;
  }

  // Step 3: review hooks 串行启动（hook: review 组，trigger: afterPass，无 after = 默认串行，按 agent 文件名字典序逐个启动；遵守零输出硬门）
  const reviewResults = await runSerially(
    agentsWithHook('review').map(a => () => a.run(executionCodeOrAnalysis, plan))
  );
  // reviewer → sideChecker?（条件加载，after: [reviewer] 串行）

  if (reviewResults.some(r => r.verdict === 'FAIL')) {
    // Step 4: fix hooks（同一修复角色，trigger: onFail 响应所有 FAIL）
    const issues = collectIssues(reviewResults);
    executionCodeOrAnalysis = await runFixHooks(issues);
    // code/analysis 变化 → 循环回到 Step 1
    continue;
  }

  // 全部 PASS
  quality_verdict = 'PASS';
  break;
}

if (round >= config.hooks.quality.max_total_cycles) {
  quality_verdict = 'CIRCUIT_BREAKER';
}
```

### hook: review — 审查 hooks（条件触发，verify 全 PASS 后，串行启动组）

```yaml
# agent/reviewer.md
mount:
  - at: QUALITY
    hook: review
    trigger: afterPass       # 当 verify hooks 全 PASS 后触发
    deps: ["execution.code", "execution.analysis", "plan"]
    # 无 after = 默认串行（按 agent 文件名字典序逐个启动；遵守零输出硬门）
```

**触发时机**：`forward_result == 'PASS' && (reverse_result in ['PASS','N/A'])` 后自动执行。

#### EXECUTION 模式审查职责
- 安全视角审查
- 架构视角审查
- 简化视角审查
- SCOPE_CREEP 视角审查
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

#### INQUIRY 模式审查职责
- **清晰度审查**：结论是否按预设维度组织？每个结论是否有明确的前因后果？
- **结构化审查**：是否遵循了分析门输出的 conclusion_framework？有无离题？
- **可验证性审查**：结论是否足够具体，可以被后续验证/证伪？还是过于模糊？
- **偏见再审查**：从 reviewer 独立视角检查是否存在 verifier 遗漏的偏见。
- **安全/敏感信息审查**：分析中是否意外暴露了密钥、Token、密码或敏感配置？
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

```yaml
# 履行侧向验证角色的智能体（默认 T2+ 加载）
mount:
  - at: QUALITY
    hook: review
    trigger: afterPass
    deps: ["execution.code", "execution.analysis", "project_context"]
    when: "config.agents.side_checker"
    # after: [reviewer] 使侧向验证角色在 reviewer 完成后串行启动，避免 review 组内并发 task 触发底层执行器 Tool execution aborted（遵守零输出硬门），见 agent/side-checker.md
```

**触发时机**：在 reviewer 完成后串行启动（after: [reviewer]）。

#### EXECUTION 模式侧向验证职责
- 边界条件实测
- 安全漏洞可利用性验证
- 性能影响实测
- 兼容性验证
- 输出 `side_result: PASS | FAIL | N/A`

#### INQUIRY 模式侧向验证职责
- **极端值测试**：如果用户的问题换一个极端情况（如"项目规模扩大10倍""完全没有文档"），分析结论是否仍然成立？
- **反事实测试**：如果某个关键假设不成立，结论会如何变化？
- **来源可信度验证**：引用的外部资料/文档是否是最新的？是否来自权威来源？
- **遗漏证据检测**：是否有重要的反方证据被忽略？
- 输出 `side_result: PASS | FAIL | N/A`

> **新增 review hook 智能体**：声明 `hook: review` 即自动加入串行启动组。如需在某个 agent 之后执行，加 `after: [agent-name]`。

## 响应式数据流

```yaml
# task_context.quality（新增字段，框架自动管理）
quality:
  round: 0                    # 当前 QUALITY 轮次
  max_rounds: 4               # 来源：config.yaml hooks.quality.max_total_cycles（当前值 4；脚本不可读时回退 7）
  status: "running"           # running | passed | failed | circuit_breaker
  
  # verify 结果（hook: verify 钩子产出）
  verify:
    forward:
      result: "PASS" | "FAIL"
      # EXECUTION 模式
      l1_pass: true | false
      l2_pass: true | false
      l3_pass: true | false | "N/A"
      # INQUIRY 模式
      a1_facts: true | false           # 事实准确性
      a2_sources: true | false         # 引用完整性
      a3_coverage: true | false        # 维度覆盖
      a4_bias: true | false           # 偏见检测
      a5_logic: true | false           # 逻辑一致性
      issues: [{ source, severity, tag, file, line, message, evidence }]
    reverse:
      result: "PASS" | "FAIL" | "N/A"
      issues: [...]
  
  # review 结果（hook: review 钩子产出）
  review:
    result: "PASS" | "CONDITIONAL_PASS" | "FAIL"
    risk: "LOW" | "MEDIUM" | "HIGH"
    issues: [{ severity, tag, file, line, message, suggestion, evidence }]
  side:
    result: "PASS" | "FAIL" | "N/A"
    issues: [...]
  
  # fix 结果（hook: fix 钩子产出）
  fix:
    round: 0
    last_fix_source: "verify" | "review"
    same_symptom_recurring: true | false
    issues_fixed: [...]
    issues_remaining: [...]
  
  # 组合判定（框架自动计算）
  verdict: "PASS" | "FAIL" | "CIRCUIT_BREAKER"
```

## 收敛熔断（内置到 QUALITY）

```yaml
# lifecycle/config.yaml hooks 段
hooks:
  quality:
    max_total_cycles: 4        # QUALITY 总轮次上限（唯一熔断阈值；4 轮修不好=方案/需求有问题，escalate 到人）
    auto_fix: true             # 自动触发 fix hooks（false = 人工确认后修复）
```

**熔断规则**：
- QUALITY 总轮次 ≥ `max_total_cycles` → CIRCUIT_BREAKER（唯一机械熔断阈值，由 `transition-check.mjs` 按 `quality.round` 判定）
- CIRCUIT_BREAKER 时 `quality_verdict = 'CIRCUIT_BREAKER'` → 流转到 DELIVERING（带降级标记 `[QUALITY_CB]`，由用户决策是否继续）

## 输出信号

```yaml
status_signal: "PASS" | "FAIL" | "CIRCUIT_BREAKER"
transition_context:
  unit_id: "string"
  quality_round: int
  verify_pass: true | false
  review_pass: true | false
quality_gate:
  verdict: "PASS" | "FAIL" | "CIRCUIT_BREAKER"
  forward_result: "PASS" | "FAIL"
  reverse_result: "PASS" | "FAIL" | "N/A"
  review_result: "PASS" | "CONDITIONAL_PASS" | "FAIL"
  side_result: "PASS" | "FAIL" | "N/A"
  issues:
    verify: [{ source, severity, tag, message, evidence }]
    review: [{ severity, tag, message, evidence }]
  circuit_breaker_reason: "string"  # 熔断原因
```

## 路由规则（边定义见 graph.yaml）

- `quality_verdict == 'PASS'` → DELIVERING（EXECUTION + INQUIRY 统一出口）
- `quality_verdict == 'CIRCUIT_BREAKER'` → DELIVERING（带降级标记 `[QUALITY_CB]`）
- T1 路径（两种模式）：反向审计角色加载（`config.agents.reverse_auditor` 默认 true）；侧向验证角色默认 false，但 `config.yaml overrides.condition_overrides` 强制 true（防非法跳过硬门，2026-08-01 起生效）
- T2/T3 路径（两种模式）：全 hooks 加载（反向审计 + 侧向验证 + 合成融合）

## 与传统阶段的兼容性

| 旧阶段 | 新 hooks | 说明 |
|--------|---------|------|
| CHECKING | verify hooks（hook: verify） | 语义一致，只是挂载点从 CHECKING 改为 QUALITY |
| REVIEWING | review hooks（hook: review） | 语义一致，触发条件从"阶段入口"改为"verify 全 PASS" |
| FIXING | fix hooks（hook: fix, trigger: onFail） | 语义一致，触发条件从"conductor 手动回流"改为"自动 onFail" |

**迁移说明**：现有 agent/*.md 的 `mount: at: CHECKING/REVIEWING/FIXING` 需要改为 `mount: at: QUALITY` + 新增 `hook` 和 `trigger` 字段。但旧格式仍兼容（框架识别旧 `at: CHECKING` 自动映射到 `at: QUALITY hook: verify`）。

> **v2.1 迁移**：~~`order: 10/20/30/40` 绝对编号~~已废弃，改为 hook 类型定义顺序 + `after` 声明相对依赖。旧 agent frontmatter 中的 `order` 字段会被框架忽略（不报错，但不再影响排序）。

## 硬规则

1. **自动循环，不手动回流**：conductor **不得**手动设置 `quality.issues` 来触发 fix hooks；只有 hooks 返回 FAIL 才自动触发
2. **deps 变化才触发**：verify hooks 只在 deps 中任一引用字段变化时重新执行（deps 语义为"任一字段变化即触发"，非"全部存在"；EXECUTION 模式只写 execution.code，INQUIRY 模式只写 execution.analysis，互不干扰）；无变化时不重复浪费 token
3. **视角隔离不变**：verify hooks 不见 review hooks 结论，review hooks 不见 verify hooks 结论，fix hooks 只读 issues 不读结论
4. **fix 后必须重 verify**：fix hooks 产出新 code/analysis 后，必须重新经过 verify hooks，不可直接跳到 review
5. **不跳过 review**：即使 verify 连续 FAIL 后最终 PASS，也必须经过 review hooks 才能离开 QUALITY
6. **CIRCUIT_BREAKER 不阻塞交付**：熔断后流转到 DELIVERING，但标记 `[QUALITY_CB]`，由用户决策是否继续
7. **INQUIRY 模式编码禁令**：INQUIRY 模式下 QUALITY 全生命周期中，修复角色 **禁止调用修改性工具**。修复角色只输出修正后的分析文本，不输出代码。
8. **离开 QUALITY 硬门**：进入下阶段前必须写入 `quality.verdict` ∈ {PASS, CIRCUIT_BREAKER}。缺 verdict 时 transition-check.mjs 报 `[MISSING_QUALITY_VERDICT]` 拒绝流转，确保 T1/T2/T3 不能绕过 QUALITY。
