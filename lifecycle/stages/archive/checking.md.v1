---
description: 生命周期阶段 CHECKING — 验证。正向验证 + 反向审计（条件加载），多视角交叉验证，只验证不修复。
model_capability: strict-verification
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
required_roles: [verifier]
---

# lifecycle/stages/checking

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。本阶段主槽必配角色：正向验证（`required_roles: [verifier]` 角色）；可选视角（反向审计）由 `config.agents` 开关条件挂载。

## 输入

> **视角物理隔离**：正向验证视角只读 `plan + execution.diffs/changes/acceptance_map + forbidden_files + acceptance_criteria`，**禁止读 `execution.verification / fixing_history`**。反向审计视角只读 `intent + execution.diffs/changes/acceptance_map`，**禁止读 `plan`**。

- 编码角色输出的变更摘要 + 验收映射表（**不含编码角色自验声明**）
- 原始验收标准清单
- diff（`git diff` 或实际文件变更）
- 设计门方案（T1+，仅正向验证角色用于核对范围）
- 原始意图（反向审计角色用，**不传 plan**）

## 双视角交叉验证（正向验证 + 反向审计，条件并行）

### 正向验证（必配角色）
按验收标准逐条验证产物，L1/L2/L3 分层，5 元组证据，独立重跑。详见 `agent/verifier.md`（履行正向验证角色的智能体）。

### 反向审计（条件加载）
从产物反推是否满足原始需求，追溯假设，发现隐性遗漏和过度实现。详见 `agent/reverse-auditor.md`（履行反向审计角色的智能体，默认 T2 加载）。

> 两者并行执行，各自独立 context window，不互相参考。组合判定：任一 FAIL → FIXING。

## 分层验证（正向验证角色）

### L1（语法/编译/格式/编码）
- 运行测试、构建、类型、Lint
- 编码扫描（`node scripts/scan-encoding.mjs`）：检测 UTF-8 BOM / U+FFFD / GBK 残留
- 无法运行 → `[VERIFY_PENDING]`

### L2（逻辑/边界/范围）
- 逐条验收标准读取代码路径，确认实现、分支、错误路径
- 需求扩散覆盖矩阵完整性
- 重复模式/局部补丁拦截：扫描同类实现模式（UI 与非 UI 同等适用，不限于样式/布局/交互）
- 范围越界（`SCOPE_CREEP`）：diff 中存在验收标准未声明的改动
- 流程合规：核对强制流程日志是否完整
- 状态信号合规：核对编码角色输出是否包含 `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED`

### L3（覆盖/安全/架构，仅 T2/T3）
- API 兼容性（`gitnexus_api_impact`）
- 安全/性能检测（`security-checklist.md` L1-L3）
- 跨文件/模块重复模式反向 grep 验证旧模式命中数=0（UI 与非 UI 同等适用）
- 范围越界（`SCOPE_CREEP`）：diff 中存在验收标准未声明的改动（T1+ 也在此核对）

## 证据验收协议

1. **枚举声明**：列出编码角色输出的每条完成/通过/修复声明。
2. **本轮重跑**：对每条声明，本轮重新运行证明命令（不复用编码角色输出）。
3. **完整读取**：读 stdout+stderr+exit code 全文，不截断。
4. **声明 → 证据比对**：声明"通过"→ exit code=0 且无新失败；声明"修复"→ 原失败转绿且无回归。
5. **附证据结论**：每条声明输出"声明 X / 证据 Y / 结论 [证实|证伪|未验证]"。

> 任何声明无本轮 fresh 证据 → `[UNVERIFIED]`，整体验证结论 FAIL。

## 输出信号

```yaml
status_signal: "PASS" | "FAIL" | "VERIFY_PENDING"
transition_context:
  unit_id: "string"
  l1_pass: true | false
  l2_pass: true | false
  l3_pass: true | false | "N/A"
quality_gate:
  forward_result: "PASS" | "FAIL"     # 正向验证角色
  reverse_result: "PASS" | "FAIL" | "N/A"  # 反向审计角色（条件加载，未加载时 N/A）
  unverified_items: ["string"]
  blockers: [{ source, severity, file, line, message }]
```

## 路由规则（边定义见 graph.yaml）

- `PASS`（正向+反向全 PASS）→ T1+ 进入 `REVIEWING`（统一 full 四视角）；T0 不经过此阶段
- `FAIL`（任一视角 FAIL）→ 进入 `FIXING`（修复阶段）
- `VERIFY_PENDING` → 标记后进入 `FIXING` 或升级人工决策

## FAIL 条件清单

- `[MISSING]` / `[UNVERIFIED]` / `[PARTIAL_IMPLEMENTATION]` / `[REGRESSION]`
- `[MISSING_ACCEPTANCE_MAP]` / `[FAKE_CONTEXT]` / `[ENCODING_VIOLATION]`
- `[PLAN_REVIEW_MISS]`（T1+ 编码前未过方案审查）
- `[PROCESS_VIOLATION]` / `[PATH_DEVIATION]`
- `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`
- `[SCOPE_CREEP]` / `[TRUST_TRANSFER]`
- 命中 `security-checklist.md` 任一检测项
