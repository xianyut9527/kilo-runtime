---
description: 生命周期阶段 07 — 修复。定向修复 verifier/reverse-auditor/side-checker/reviewer 指出的阻塞问题。
stage_id: S11_FIXING
agents:
  - fixer
previous_stage: S09_CHECKING
next_stage: S09_CHECKING
---

# lifecycle/07-repair

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S11_FIXING` |
| **上一阶段** | `S09_CHECKING`（verifier/reverse-auditor FAIL）或 `S13_REVIEWING`（side-checker/reviewer FAIL） |
| **下一阶段** | `S12_FIX_PASS` → `S09_CHECKING`（重新验证） |
| **加载智能体** | `fixer`（`agent/fixer.md`，T1+ 加载） |
| **模型偏好** | `registry:code-generation`（快速修复） |
| **token 预算** | ≤ 8000 |

## 输入

- verifier/reverse-auditor/side-checker/reviewer 给出的阻塞问题清单（含证据片段 + 可操作修复建议）
- 原始 diff
- 验收标准清单
- 失败模式分类（确定性/间歇性、回归/新缺陷、局部/系统性）
- `task_context.convergence.total_rounds / max_total_rounds`（全局熔断计数，fixer **只读**，禁止修改）

## 处理流程

1. **只修阻塞问题**：对应证据，不扩大范围。
2. **假设驱动调试循环**：
   - 写下可证伪的根因假设
   - 预测：改 P 点后症状应消失；改 Q 点（无关点）后症状应保留
   - 验证：改 P 点跑验证；症状消失后，再改无关点确认不会"治表"
   - 证伪/确认：P 点有效且 Q 点无效 → 根因确认
3. **组件化回退**：`[PARTIAL_IMPLEMENTATION]` / `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]` 必须回到 `component-driven-fixes` 决策树重走全量扫描 + 组件化/共享抽象方案 + 防复发产物。
4. **修复后回溯**：确认相关验收标准和调用方无回归。
5. **运行全部可用验证**：变差时回滚并上报 `[ROLLBACK]`。

## 输出信号

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED"
transition_context:
  fix_round: int
  root_cause_layer: "execution" | "method" | "demand"
  same_symptom_recurring: true | false
quality_gate:
  verification_pass: true | false
  rollback_needed: true | false
```

## 路由规则

- `DONE` → 回到 `S09_CHECKING`（重新验证）
- `BLOCKED` / 连续 2 轮同症状 → 停止修复，升级 reviewer 或人工决策
- 同一状态循环 ≥3 次（单点熔断）→ `[CIRCUIT_BREAKER]` → 停止修复
- S09+S13 累计进入次数 ≥ max_total_rounds(7)（全局熔断）→ `[CIRCUIT_BREAKER]` → 停止修复

## 硬规则

- 修复后同样适用 coder 的「完成声明三件套」（命令+exit code+关键输出片段）。
- 连续 2 轮假设都证伪 → 不再换假设，升级 reviewer 并标记方法层失败。
- `[PARTIAL_IMPLEMENTATION]` 必须回到需求扩散包补齐同类点，不得只治症状。
