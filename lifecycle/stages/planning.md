---
description: 生命周期阶段 PLANNING — 设计门。T1-high / T2 编码前必须经过 planner 输出方案+验收点+DAG（T1 low/medium 直通不经本阶段）。
model_capability: deep-reasoning
token_budget: 12000
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
# 角色名 = 智能体文件名（去 .md）或其 frontmatter 显式 role 字段；
# bootstrap/doctor 校验：每个角色 ≥1 个智能体 mount 覆盖本阶段主槽，缺一 → [ASSEMBLY_FAIL]
required_roles: [planner]
---

# lifecycle/stages/planning

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

> **直通分流**：T1 low/medium 直通不经本阶段（见 `lifecycle/graph.yaml` INIT→EXECUTING 直通边）；本阶段服务 T1-high 与 T2。

## 输入

- `INIT` 输出的 intent_type + tier + review_mode
- 用户请求（完整需求 + 约束）
- 项目技术栈上下文
- 相关代码文件（由智能体按需读取）

## 处理流程

1. **项目上下文确认**：读取 AGENTS.md / kilo.json / 入口目录，确认技术栈与约束。
2. **澄清问题**（T2 完整规划必做）：模糊术语（用户/账户/任务/会话）逐一精确定义。
3. **方案提议**：每个重要决策列 2-3 个可选方案，给出推荐。
4. **重复模式扫描**（UI 与非 UI 同等适用，必做）：全量扫描同类实现模式 → 组件化/共享抽象方案 → 无法组件化的例外理由。
5. **需求扩散评估**：识别同类入口、状态、校验、提交、回显路径 → 覆盖矩阵。
6. **任务 DAG**：按依赖排序，标注可并行/必须串行，每单元含目标+关键文件+验收标准。
7. **风险与应对**：列出已知风险及缓解策略。

## 输出信号

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"
transition_context:
  tier: "T1" | "T2"
  design_gate_type: "short" | "full"
  units: [{ unit_id, goal, key_files, forbidden_files, token_budget, dependencies, acceptance_criteria, verification_method }]
scan_coverage: "full" | "partial" | "N/A"
componentization_plan: "yes" | "no" | "N/A"
extension_points:
  - domain: "string"
    mechanism: "string"
    rationale: "string"
forbidden_files: ["string"]
```

## 安全门禁（v6 框架稳定化，2026-08-09）

PLANNING 阶段需在 `plan.task_dag.units[]` 每单元加：

- `safety_checks: ["scan-encoding", "bash-guard", "encoding-safety"]`（每个 unit 完工时必跑项）
- 范围涉及编码/Shell/中文文件时，planner 必把 `scripts/scan-encoding.mjs` + `scripts/bash-guard.mjs` 写入 `unit.acceptance_criteria`
- 反事故：subagent 不带 safety_checks 的 plan = planner 漏算，reflux 重做
## premise_audit（每个 unit 必填，写不出 = 不可 dispatch）

> **目的**：把"我假设 X"提前到可证伪的形态，杜绝"想当然设计"。LLM 的"应该这样吧"在编码前必须落地为可机械回放的命令。

**每条 `plan.task_dag.units[i]` 必含 `premise_audit`**（5 字段）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `existence_cmd` | string | L3 广搜命令字面量（`grep` / `glob`），用于验证"项目里是否已有同类" |
| `existence_result` | object | **新增** — 记录 `existence_cmd` 实际跑过的结果，绝结 LLM 写假命令字面量。必含 3 子字段：`cmd`（实际跑的命令）、`stdout_key`（≤200 字关键输出）、`hit_count`（命中数） |
| `falsifiable_test` | string | 关键前提 + 验证方法（< 30s 可证伪） |
| `user_hints` | string[] | 用户 prompt 中含的常识暗示（grep "应该有/不是有/对吧"）；允许 `["(none)"]` 显式声明无 |
| `alternatives` | string[] | 替代方案 ≥ 2；只有 1 个 = 高风险 |

**validator 规则**（transition-check PLANNING→EXECUTING 边）：
- 缺 `premise_audit` → `[MISSING_PREMISE_AUDIT]`
- 缺 `existence_cmd` → `[MISSING_EXISTENCE_CMD]`
- 缺 `existence_result` → `[MISSING_EXISTENCE_RESULT]`
- `falsifiable_test` 空 → `[MISSING_FALSIFIABLE_TEST]`
- `user_hints` 数组空 → `[MISSING_USER_HINTS]`
- `alternatives.length < 2` → `[FEW_ALTERNATIVES]`

**反例**（拒绝）：
```json
{
  "id": "U1",
  "goal": "加 403 跳转"
  // 缺 premise_audit → 拒绝
}
```

**正例**：
```json
{
  "id": "U1",
  "goal": "无权限时跳独立页面",
  "key_files": ["src/router/guards.ts"],
  "premise_audit": {
    "existence_cmd": "grep -rn 403 src/views/*.vue",
    "existence_result": {
      "cmd": "grep -rn 403 src/views/*.vue",
      "stdout_key": "src/views/403/index.vue:1: <template>...</template>",
      "hit_count": 1
    },
    "falsifiable_test": "读 views/403/router.js meta.requireAuth=false 字段值（短路第1步 return true，不死循环）",
    "user_hints": ["系统不是有 403 页面吗"],
    "alternatives": ["跳 /403（推荐，语义清晰）", "默默 redirect defaultPath", "弹 toast 提示"]
  }
}
```

## 路由规则（边定义见 graph.yaml）

- `PLANNING → EXECUTING`：方案输出后流转，仅 T1-high / T2 生效（T1 low/medium 直通不经本阶段，见 graph.yaml INIT→EXECUTING 直通边）

## 硬规则

- ❌ "太简单不需要设计" — 简单任务正是未审视假设造成返工的高发区。
- ❌ 未包含重复模式扫描清单就放行（UI 与非 UI 同等要求）。
- ❌ 主槽智能体自验方案通过并自行进入下一阶段。

