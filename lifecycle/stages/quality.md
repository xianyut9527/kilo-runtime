---
description: 生命周期阶段 QUALITY — 质量保障（响应式 Hooks 阶段）。合并原 CHECKING + REVIEWING + FIXING，内部 hooks 自动循环。支持 EXECUTION 模式（代码验证）和 INQUIRY 模式（分析结论验证）。
model_capability: strict-verification
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 必配：verifier（verify hook）；reviewer（review hook）
# 可选：反向审计角色（verify hook, T1+）；侧向验证角色（review hook, T1+）；修复角色（fix hook, auto-trigger）
required_roles: [verifier, reviewer]
---

# lifecycle/stages/quality

> v2 响应式 Hooks 架构核心阶段。合并原 `CHECKING` + `REVIEWING` + `FIXING`，数据驱动自动循环。
> **v2.1 模式切换**：QUALITY 按 `task_context.intent_type` 在「代码验证（execution）」与「分析结论验证（analysis）」间自动切换。hook 类型和循环结构不变，验证/审查标准按模式适配。
> **v2.2 四视角独立子槽**：QUALITY 四视角（正向验证 / 反向审计 / 静态审查 / 侧向验证）是 **4 个独立子槽**，非 hook 链。conductor 通过 `task` 串行 dispatch（T1/T2，逐个串行；size-check 前置门不过或 `overload_count >= 3` 时切 `agent_manager` `mode: worktree` 兜底），T3 默认 AM local 并行，task 串行为降级。AM local 并行时视角只返回 verdict 文本，conductor 串行收口写 task_context。子槽无共享状态、无顺序依赖，各自独立产出 verdict，conductor 收齐后做机械 AND 汇总。hook 链定义 QUALITY 容器内自动循环逻辑，子槽定义每个 hook 阶段内并发/串行的 agent 实例化方式——两维度正交。
> **v2.3 隔离违规回退**：视角越权写（修改文件/写入 task_context 非自身字段）→ 标 `[ISOLATION_BREAK]` → 回退 worktree 重验 + `git diff` 比对确认无污染。
> 流转关系见 `lifecycle/graph.yaml`；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 设计理念

QUALITY 不是"一个阶段做三件事"，而是**一个响应式容器，内部 hooks 按数据变化自动触发**：

- `code/analysis` 变化 → 自动触发 **verify hooks**
- `verify_result` 变化 → 自动触发 **review hooks**（全 PASS）或 **fix hooks**（FAIL）
- `code/analysis` 修复后 → `code/analysis` 变化 → 自动重新触发 **verify hooks**
- conductor **不需要手动回流**，框架自动管理循环

### 自动循环

```
code/analysis 就绪 → verify hooks 串行启动
  → 任一 FAIL → fix hooks（trigger: onFail）→ 重新 verify
  → 全 PASS → review hooks 串行启动（trigger: afterPass）
    → 任一 FAIL → fix hooks → 重新 verify
    → 全 PASS → quality_verdict=PASS → DELIVERING
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

## Hooks 挂载

> 各 hook 智能体的 frontmatter 声明见 `agent/verifier.md`、`agent/reverse-auditor.md`、`agent/reviewer.md`、`agent/side-checker.md`、`agent/fixer.md`。编排规则见 `graph.yaml` 头注释 + `stages/README.md`。

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
# 履行反向审计角色的智能体（默认 T1+ 加载）
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "execution.analysis", "intent"]
    when: "config.agents.reverse_auditor"
    # after: [verifier] 使反向审计角色在 verifier 完成后串行启动（详见 conductor.md §全局默认串行策略）
```

**触发时机**：在 verifier 完成后串行启动（after: [verifier]）。

#### EXECUTION 模式反向审计职责（`agent/reverse-auditor.md` 挂载 verify hook, after: [verifier]）
- 从产物反推需求满足度 / 假设审计 / 隐性遗漏检测 / 过度实现检测
- 输出 `reverse_result: PASS | FAIL | N/A`

#### INQUIRY 模式反向审计职责
- **需求追溯**：分析结论是否回答了用户原始问题？是否存在"答非所问"或"过度延伸"？
- **假设审计**：分析中是否隐含了未验证的假设？
- **隐性遗漏**：是否有用户没说但应该考虑的角度？对照 failure_db 同类失败模式
- **过度分析**：是否引入了与问题无关的维度？
- 输出 `reverse_result: PASS | FAIL | N/A`

### hook: fix — 修复 hooks（条件触发，`agent/fixer.md`）

**触发时机**：`execution.quality.issues` 非空时自动触发（任一 verify/review FAIL）。

#### EXECUTION 模式修复职责
- 读取 `issues` 列表，定向修复，输出修复后的 `execution.code`
- **修复后自动触发**：`code` 变化 → verify hooks 重新执行

#### INQUIRY 模式修复职责
- 定向补充/修正分析，输出修复后的 `execution.analysis`
- **INQUIRY 约束**：修复角色只修改分析文本/结论，**禁止调用修改性工具**

### hook: review — 审查 hooks（条件触发，`agent/reviewer.md`）

**触发时机**：`forward_result == 'PASS' && reverse_result in ['PASS','N/A']` 后自动执行。

#### EXECUTION 模式审查职责（`agent/reviewer.md`）
- 安全视角审查 / 架构视角审查 / 简化视角审查 / SCOPE_CREEP 视角审查
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

#### INQUIRY 模式审查职责
- **清晰度审查**：结论是否按预设维度组织？
- **结构化审查**：是否遵循了 conclusion_framework？有无离题？
- **可验证性审查**：结论是否足够具体，可以被后续验证/证伪？
- **偏见再审查**：从 reviewer 独立视角检查是否存在 verifier 遗漏的偏见
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

#### EXECUTION 模式侧向验证职责（`agent/side-checker.md` 挂载 review hook, after: [reviewer]）
- 边界条件实测 / 安全漏洞可利用性验证 / 性能影响实测 / 兼容性验证
- 输出 `side_result: PASS | FAIL | N/A`

#### INQUIRY 模式侧向验证职责
- **极端值测试**：问题换极端情况，结论是否仍成立？
- **反事实测试**：关键假设不成立时结论如何变化？
- **来源可信度验证**：引用资料是否最新、权威？
- 输出 `side_result: PASS | FAIL | N/A`

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

## 收敛熔断

- QUALITY 总轮次 ≥ `max_total_cycles` → CIRCUIT_BREAKER（由 `transition-check.mjs` 按 `quality.round` 判定）
- CIRCUIT_BREAKER → 流转到 DELIVERING（带降级标记 `[QUALITY_CB]`）

## 硬规则

1. **自动循环，不手动回流**：conductor 不得手动设置 `quality.issues` 来触发 fix hooks
2. **deps 变化才触发**：verify hooks 只在 deps 字段变化时重新执行；无变化不重复浪费 token
3. **视角隔离不变**：verify 不见 review 结论，review 不见 verify 结论，fix 只读 issues
4. **fix 后必须重 verify**：fix 产出新 code/analysis 后必须重新 verify，不可直接跳到 review
5. **不跳过 review**：即使 verify 连续 FAIL 后最终 PASS，也必须经过 review 才能离开 QUALITY
6. **CIRCUIT_BREAKER 不阻塞交付**：熔断后流转到 DELIVERING，但标记 `[QUALITY_CB]`
7. **INQUIRY 模式编码禁令**：修复角色禁止调用修改性工具，只输出修正后的分析文本
8. **离开 QUALITY 硬门**：必须写入 `quality.verdict` ∈ {PASS, CIRCUIT_BREAKER}，缺则 `[MISSING_QUALITY_VERDICT]` 拒绝流转
