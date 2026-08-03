---
description: 生命周期阶段 QUALITY — 质量保障（响应式 Hooks 阶段）。内部 hooks 自动循环：verify → fix(onFail) → verify，review afterPass。
model_capability: strict-verification
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 必配：verifier（verify hook）；reviewer（review hook）；fixer（fix hook, auto-trigger）
required_roles: [verifier, reviewer, fixer]
---

# lifecycle/stages/quality

> v2 响应式 Hooks 架构核心阶段。流转关系见 `lifecycle/graph.yaml`（纯拓扑，QUALITY → DELIVERING）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 设计理念

QUALITY 不是"一个阶段做三件事"，而是**一个响应式容器，内部 hooks 按数据变化自动触发**：

- `code` 变化 → 自动触发 **verify hooks**
- `verify_result` 变化 → 自动触发 **review hooks**（全 PASS）或 **fix hooks**（FAIL）
- `code` 修复后 → `code` 变化 → 自动重新触发 **verify hooks**
- conductor **不需要手动回流**，框架自动管理循环

```
QUALITY 容器内自动循环（hook 类型定义顺序，无绝对编号）：
  code 就绪 → verify hooks 串行启动（hook: verify）
    → 任一 FAIL → fix hooks（hook: fix, trigger: onFail）→ code 变化 → 重新 verify
    → 全 PASS → review hooks 串行启动（hook: review, trigger: afterPass）
      → 任一 FAIL → fix hooks（同一修复角色，trigger: onFail）→ code 变化 → 重新 verify
      → 全 PASS → quality_verdict=PASS → 离开 QUALITY → DELIVERING
```

## 输入

> **视角物理隔离**：verify hooks 只读 `plan + execution.code + forbidden_files + acceptance_criteria`，**禁止读 `execution.quality / fixing_history`**。review hooks 只读 `execution.code + plan + acceptance_criteria + project_context`，**禁止读 `execution.quality` 的报告结论**。fix hooks 读取 `execution.quality.issues + fixing_history`。

- 编码角色输出的完整代码产物（`execution.code`：diff + changes + acceptance_map）
- 原始验收标准清单
- 设计门方案（T1+，用于核对范围）
- 原始意图（用于核对范围）
- project_context（审查 hook 用）

## Hooks 挂载（内部自动编排）

> **编排规则**：hook 类型（`verify` / `fix` / `review`）定义执行顺序，不需要绝对编号。同 hook 类型默认串行启动。需要顺序时声明 `after: [agent-name]`（相对依赖）。框架对 `after` 做拓扑排序，检测环依赖报错。

### hook: verify — 验证 hooks

```yaml
# agent/verifier.md
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "plan"]
```

**触发时机**：当 `execution.code` 或 `plan` 变化时自动执行。

**验证职责**：
- L1 语法/编译/格式/编码验证
- L2 逻辑/边界/范围验证（含 SCOPE_CREEP）
- L3 覆盖/安全/架构验证（仅 T2）
- 输出 `forward_result: PASS | FAIL`

### hook: fix — 修复 hooks（条件触发）

```yaml
# agent/fixer.md
mount:
  - at: QUALITY
    hook: fix
    trigger: onFail        # 当任一 verify/review hook 返回 FAIL 时触发
    deps: ["execution.quality.issues"]
```

**触发时机**：`execution.quality.issues` 字段非空时自动触发（任一 verify 或 review hook FAIL）。

**修复职责**：
- 读取 `issues` 列表（含来源 hook、严重度、证据）
- 定向修复，输出修复后的 `execution.code`
- **修复后自动触发**：`code` 变化 → verify hooks 重新执行

**自动循环语义**（框架自动处理）：

```js
// 伪代码：框架内部循环逻辑（hook 类型定义顺序，无绝对编号）
while (round < config.hooks.quality.max_total_cycles) {
  // Step 1: verify hooks 串行启动
  const verifyResults = await runSerially(
    agentsWithHook('verify').map(a => () => a.run(executionCode, plan))
  );

  if (verifyResults.some(r => r.verdict === 'FAIL')) {
    // Step 2: fix hooks（hook: fix, trigger: onFail）
    const issues = collectIssues(verifyResults);
    executionCode = await runFixHooks(issues);
    // code 变化 → 循环继续
    continue;
  }

  // Step 3: review hooks 串行启动（hook: review, trigger: afterPass）
  const reviewResults = await runSerially(
    agentsWithHook('review').map(a => () => a.run(executionCode, plan))
  );

  if (reviewResults.some(r => r.verdict === 'FAIL')) {
    // Step 4: fix hooks（同一修复角色，trigger: onFail 响应所有 FAIL）
    const issues = collectIssues(reviewResults);
    executionCode = await runFixHooks(issues);
    // code 变化 → 循环回到 Step 1
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

### hook: review — 审查 hooks（条件触发，verify 全 PASS 后）

```yaml
# agent/reviewer.md
mount:
  - at: QUALITY
    hook: review
    trigger: afterPass       # 当 verify hooks 全 PASS 后触发
    deps: ["execution.code", "plan"]
```

**触发时机**：`forward_result == 'PASS'` 后自动执行。

**审查职责**：
- 安全视角审查
- 架构视角审查
- 简化视角审查
- SCOPE_CREEP 视角审查
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

## 响应式数据流

```yaml
# task_context.quality（新增字段，框架自动管理）
quality:
  round: 0                    # 当前 QUALITY 轮次
  max_rounds: 4               # 来源：config.yaml hooks.quality.max_total_cycles
  status: "running"           # running | passed | failed | circuit_breaker
  
  # verify 结果（hook: verify 钩子产出）
  verify:
    forward:
      result: "PASS" | "FAIL"
      l1_pass: true | false
      l2_pass: true | false
      l3_pass: true | false | "N/A"
      issues: [{ source, severity, tag, file, line, message, evidence }]
  
  # review 结果（hook: review 钩子产出）
  review:
    result: "PASS" | "CONDITIONAL_PASS" | "FAIL"
    risk: "LOW" | "MEDIUM" | "HIGH"
    issues: [{ severity, tag, file, line, message, suggestion, evidence }]
  
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
  review_result: "PASS" | "CONDITIONAL_PASS" | "FAIL"
  issues:
    verify: [{ source, severity, tag, message, evidence }]
    review: [{ severity, tag, message, evidence }]
  circuit_breaker_reason: "string"  # 熔断原因
```

## 路由规则（边定义见 graph.yaml）

- `quality_verdict == 'PASS'` → DELIVERING
- `quality_verdict == 'CIRCUIT_BREAKER'` → DELIVERING（带降级标记 `[QUALITY_CB]`）

## 硬规则

1. **自动循环，不手动回流**：conductor **不得**手动设置 `quality.issues` 来触发 fix hooks；只有 hooks 返回 FAIL 才自动触发
2. **deps 变化才触发**：verify hooks 只在 `execution.code` 或 `plan` 变化时重新执行；无变化时不重复浪费 token
3. **视角隔离不变**：verify hooks 不见 review hooks 结论，review hooks 不见 verify hooks 结论，fix hooks 只读 issues 不读结论
4. **fix 后必须重 verify**：fix hooks 产出新 code 后，必须重新经过 verify hooks，不可直接跳到 review
5. **不跳过 review**：即使 verify 连续 FAIL 后最终 PASS，也必须经过 review hooks 才能离开 QUALITY
6. **CIRCUIT_BREAKER 不阻塞交付**：熔断后流转到 DELIVERING，但标记 `[QUALITY_CB]`，由用户决策是否继续
7. **离开 QUALITY 硬门**：进入下阶段前必须写入 `quality.verdict` ∈ {PASS, CIRCUIT_BREAKER}。缺 verdict 时 transition-check.mjs 报 `[MISSING_QUALITY_VERDICT]` 拒绝流转，确保 T1/T2 不能绕过 QUALITY。

