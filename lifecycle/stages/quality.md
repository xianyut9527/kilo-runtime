---
description: 生命周期阶段 QUALITY — 质量保障（响应式 Hooks 阶段）。合并原 CHECKING + REVIEWING + FIXING，内部 hooks 自动循环。
model_capability: strict-verification
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 必配：verifier（verify hook）；reviewer（review hook）
# 可选：反向审计角色（verify hook, T2+）；侧向验证角色（review hook, T2+）；修复角色（fix hook, auto-trigger）
required_roles: [verifier, reviewer]
---

# lifecycle/stages/quality

> v2 响应式 Hooks 架构核心阶段。合并原 `CHECKING` + `REVIEWING` + `FIXING`，数据驱动自动循环。
> 流转关系见 `lifecycle/graph.yaml`（纯拓扑，QUALITY → DELIVERING）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 设计理念

QUALITY 不是"一个阶段做三件事"，而是**一个响应式容器，内部 hooks 按数据变化自动触发**：

- `code` 变化 → 自动触发 **verify hooks**
- `verify_result` 变化 → 自动触发 **review hooks**（全 PASS）或 **fix hooks**（FAIL）
- `code` 修复后 → `code` 变化 → 自动重新触发 **verify hooks**
- conductor **不需要手动回流**，框架自动管理循环

### 为什么不用 `order` 绝对编号

~~旧设计用 `order: 10/20/30/40` 绝对编号排序智能体~~。这与 React/Vue hooks 的设计哲学矛盾：

| React hooks | 旧 `order` 系统 | 新 `after` 系统 |
|-------------|----------------|-----------------|
| `useEffect` 按声明顺序执行，无编号 | `order: 10` 绝对坐标 | `hook` 类型定义阶段顺序 |
| `useEffect(fn, [deps])` deps 变化才执行 | 无 deps 机制 | `deps: [field]` 响应式触发 |
| 插入新 hook 只写一行，不碰其他代码 | `order: 15` 要知道前后编号 | `after: [agent]` 只引用前驱 |
| 同类 hook 隐含串行/顺序语义 | 靠数字碰巧相同实现并行 | `hook: verify` 默认并行组 |

**核心原则**：hook 类型（`verify` / `fix` / `review`）**本身就定义了执行顺序**——`verify → fix → review → fix` 循环是框架内置的，不需要数字重复表达。同 hook 类型默认并行（视角隔离场景保持并行；`after` 声明显式依赖顺序）。仅 `graph.yaml` 声明 `parallel: true` 的节点（如 T3 子图 `MM_EXECUTING`）保留并行语义。

```
QUALITY 容器内自动循环（hook 类型定义顺序，无绝对编号）：
  code 就绪 → verify hooks 并行（hook: verify，无 after = 全局默认并行，按 agent 文件名字典序同时启动）
    → 任一 FAIL → fix hooks（hook: fix, trigger: onFail）→ code 变化 → 重新 verify
    → 全 PASS → review hooks 并行（hook: review, trigger: afterPass，无 after = 全局默认并行，按 agent 文件名字典序同时启动）
      → 任一 FAIL → fix hooks（同一 fixer，trigger: onFail）→ code 变化 → 重新 verify
      → 全 PASS → quality_verdict=PASS → 离开 QUALITY → DELIVERING
```

## 输入

> **视角物理隔离**：verify hooks 只读 `plan + execution.code + forbidden_files + acceptance_criteria`，**禁止读 `execution.quality / fixing_history`**。review hooks 只读 `execution.code + plan + acceptance_criteria + project_context`，**禁止读 `execution.quality` 的报告结论**。fix hooks 读取 `execution.quality.issues + fixing_history`。

- 编码角色输出的完整代码产物（`execution.code`：diff + changes + acceptance_map）
- 原始验收标准清单
- 设计门方案（T1+，用于核对范围）
- 原始意图（反向审计 hook 用，**不传 plan**）
- project_context（审查 hook 用）

## Hooks 挂载（内部自动编排）

> **编排规则**：hook 类型（`verify` / `fix` / `review`）定义执行顺序，不需要绝对编号。同 hook 类型默认并行（视角隔离场景保持并行）。需要顺序时声明 `after: [agent-name]`（相对依赖，类似 React hooks 的声明顺序）。框架对 `after` 做拓扑排序，检测环依赖报错。

### hook: verify — 验证 hooks（并行组）

```yaml
# agent/verifier.md
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "plan"]
    # 无 after = 并行组成员（按 agent 文件名字典序同时启动）
```

**触发时机**：当 `execution.code` 或 `plan` 变化时自动执行。

**职责**：
- L1 语法/编译/格式/编码验证
- L2 逻辑/边界/范围验证（含 SCOPE_CREEP）
- L3 覆盖/安全/架构验证（仅 T2/T3）
- 输出 `forward_result: PASS | FAIL`

```yaml
# 履行反向审计角色的智能体（默认 T2+ 加载）
mount:
  - at: QUALITY
    hook: verify
    deps: ["execution.code", "intent"]
    when: "config.agents.reverse_auditor"
    # after: [verifier] 已废弃。当前配置：reverse-auditor 与 verifier 并行启动（无 after），见 agent/reverse-auditor.md
```

**触发时机**：与 verifier 并行启动（无 after，默认并行策略）。

**职责**：
- 从产物反推需求满足度
- 假设审计
- 隐性遗漏检测
- 过度实现检测
- 输出 `reverse_result: PASS | FAIL | N/A`

> **新增 verify hook 智能体**：声明 `hook: verify` 即自动加入并行组。如需在某个 agent 之后执行，加 `after: [agent-name]`——只引用前驱，无需知道编号。

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

**职责**：
- 读取 `issues` 列表（含来源 hook、严重度、证据）
- 定向修复，输出修复后的 `execution.code`
- **修复后自动触发**：`code` 变化 → verify hooks 重新执行

**自动循环语义**（框架自动处理）：

```js
// 伪代码：框架内部循环逻辑（hook 类型定义顺序，无绝对编号）
while (round < config.hooks.quality.max_total_cycles) {
  // Step 1: verify hooks 并行（hook: verify 并行组，全局默认并行策略）
  const verifyResults = await runParallel(
    agentsWithHook('verify').map(a => () => a.run(code, plan))
  );
  // verifier → reverseAuditor?（条件加载，无 after = 并行）

  if (verifyResults.some(r => r.verdict === 'FAIL')) {
    // Step 2: fix hooks（hook: fix, trigger: onFail）
    const issues = collectIssues(verifyResults);
    code = await runFixHooks(issues);
    // code 变化 → 循环继续
    continue;
  }

  // Step 3: review hooks 并行（hook: review 并行组，trigger: afterPass）
  const reviewResults = await runParallel(
    agentsWithHook('review').map(a => () => a.run(code, plan))
  );
  // reviewer → sideChecker?（条件加载，无 after = 并行）

  if (reviewResults.some(r => r.verdict === 'FAIL')) {
    // Step 4: fix hooks（同一 fixer，trigger: onFail 响应所有 FAIL）
    const issues = collectIssues(reviewResults);
    code = await runFixHooks(issues);
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

### hook: review — 审查 hooks（条件触发，verify 全 PASS 后，并行组）

```yaml
# agent/reviewer.md
mount:
  - at: QUALITY
    hook: review
    trigger: afterPass       # 当 verify hooks 全 PASS 后触发
    deps: ["execution.code", "plan"]
    # 无 after = 并行组成员（按 agent 文件名字典序同时启动）
```

**触发时机**：`forward_result == 'PASS' && (reverse_result in ['PASS','N/A'])` 后自动执行。

**职责**：
- 安全视角审查
- 架构视角审查
- 简化视角审查
- SCOPE_CREEP 视角审查
- 输出 `review_result: PASS | CONDITIONAL_PASS | FAIL`

```yaml
# 履行侧向验证角色的智能体（默认 T2+ 加载）
mount:
  - at: QUALITY
    hook: review
    trigger: afterPass
    deps: ["execution.code", "project_context"]
    when: "config.agents.side_checker"
    # after: [reviewer] 已废弃。当前配置：side-checker 与 reviewer 并行启动（无 after），见 agent/side-checker.md
```

**触发时机**：与 reviewer 并行启动（无 after，默认并行策略）。

**职责**：
- 边界条件实测
- 安全漏洞可利用性验证
- 性能影响实测
- 兼容性验证
- 输出 `side_result: PASS | FAIL | N/A`

> **新增 review hook 智能体**：声明 `hook: review` 即自动加入并行组。如需在某个 agent 之后执行，加 `after: [agent-name]`。

## 响应式数据流

```yaml
# task_context.quality（新增字段，框架自动管理）
quality:
  round: 0                    # 当前 QUALITY 轮次
  max_rounds: 7               # 来源：config.yaml hooks.quality.max_total_cycles
  status: "running"           # running | passed | failed | circuit_breaker
  
  # verify 结果（hook: verify 钩子产出）
  verify:
    forward:
      result: "PASS" | "FAIL"
      l1_pass: true | false
      l2_pass: true | false
      l3_pass: true | false | "N/A"
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
    max_verify_retries: 5      # verify 失败重试上限（替代原 max_rounds）
    max_review_retries: 3    # review 失败重试上限
    max_total_cycles: 7        # QUALITY 总轮次上限（替代原 max_total_rounds）
    auto_fix: true             # 自动触发 fix hooks（false = 人工确认后修复）
```

**熔断规则**：
- verify FAIL 连续 `max_verify_retries` 次 → CIRCUIT_BREAKER
- review FAIL 连续 `max_review_retries` 次 → CIRCUIT_BREAKER
- QUALITY 总轮次 ≥ `max_total_cycles` → CIRCUIT_BREAKER
- CIRCUIT_BREAKER 时 `quality_verdict = 'CIRCUIT_BREAKER'` → 流转到 DELIVERING（带降级标记）

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

- `quality_verdict == 'PASS'` → DELIVERING
- `quality_verdict == 'CIRCUIT_BREAKER'` → DELIVERING（带降级标记 `[QUALITY_CB]`）
- T1 路径：侧向验证角色不加载，反向审计角色不加载
- T2/T3 路径：全 hooks 加载

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
2. **deps 变化才触发**：verify hooks 只在 `execution.code` 或 `plan` 变化时重新执行；无变化时不重复浪费 token
3. **视角隔离不变**：verify hooks 不见 review hooks 结论，review hooks 不见 verify hooks 结论，fix hooks 只读 issues 不读结论
4. **fix 后必须重 verify**：fix hooks 产出新 code 后，必须重新经过 verify hooks，不可直接跳到 review
5. **不跳过 review**：即使 verify 连续 FAIL 后最终 PASS，也必须经过 review hooks 才能离开 QUALITY
6. **CIRCUIT_BREAKER 不阻塞交付**：熔断后流转到 DELIVERING，但标记 `[QUALITY_CB]`，由用户决策是否继续
