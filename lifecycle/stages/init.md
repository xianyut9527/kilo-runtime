---
description: 生命周期阶段 INIT — 意图判定 + 任务定级。合并原 INTENT + SIZING，conductor 内建一步完成。
executor: conductor        # conductor 内建主槽，不经 mount 挂载
model_capability: fast-reasoning
token_budget: 6000
---

# lifecycle/stages/init

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（单一真相来源），本文件只定义执行逻辑。
> 执行元数据（executor / model_capability / token_budget）见 frontmatter；本阶段为 conductor 内建（executor 声明），无 required_roles。

## 输入

- 用户原始请求（自然语言或命令）
- 当前项目上下文（技术栈、最近修改、活跃分支）
- 会话历史（compaction 后保留的锚点）

## 处理流程

### 1. 意图判定

按 `core.md` §意图分类执行：
- **咨询类**（`INQUIRY`）：主输出信息（方案/分析/脚本验证结论）；tier 决定流程深度，**可能含脚本/方案/文档等辅助产物**。
- **执行类**（`EXECUTION`）：涉及文件修改、代码生成、配置变更。进入定级。

显式输出判定结论：必须在输出顶部显式标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。

### 2. 任务定级（INQUIRY 默认 T1，EXECUTION 按 T0/T1/T2）

按 `workflow-core.md` 决策树执行：

```
T0: ≤2 行改动 / 单一文件 / 无跨模块影响 / 无测试/类型检查需求
     → 直达执行，无设计门，无审查

T1: 多文件但单一目标 / 有测试需求 / 需简单验证
     → 短设计门（1-3 句）→ 设计门角色 → 编码角色 → 验证角色 → 审查角色(full)

T2: 多模块影响 / 需架构决策 / 有需求扩散风险 / 需完整 DAG
     → 完整设计门 → 单元 DAG → 设计门角色 → 编码角色 → 验证角色 → 审查角色(full)
```

定级完成后，conductor 按 `lifecycle/config.yaml` 的 `tier_defaults` + 用户覆盖（prompt 显式声明）写入 `task_context.config.agents` + `review_mode` + `custom_overrides`。

### 安全门禁（v6 框架稳定化，2026-08-09）

INIT 阶段必跑：

- **bash-guard pre-dispatch 预检**：conductor 委派任何 task 前经 `pre-dispatch --bash-cmd` 钩子（如有 bash 命令），命中 → exit 2 阻断
- **scan-encoding baseline**：若修改过文件，先扫 `node scripts/scan-encoding.mjs <files>` 确认起点编码干净
- 详见 `agent/conductor.md` 铁律 #9 step 0c

## 输出信号

```yaml
status_signal: "DONE" | "NEEDS_CONTEXT"
transition_context:
  intent_type: "INQUIRY" | "EXECUTION"
  tier: "T0" | "T1" | "T2"
  project: "string"
  keywords: ["string"]
quality_gate:
  intent_clear: true | false  # 是否已明确区分咨询/执行
  sizing_rationale: "string"  # 定级理由（强制输出）
```

## 路由规则（边定义见 graph.yaml）

- `T0`（任何 intent） → `EXECUTING`（极速通道，无设计门/验证/审查）
- `T1/T2`（任何 intent） → `PLANNING`（设计门）

## 硬规则

1. **task_context 强制初始化**：进入 INIT 前必须先执行 `node scripts/task-context.mjs init <task_id>`。未初始化直接流转 → `[PROCESS_VIOLATION]`。
2. **流转必裁判**：INIT → 下一节点前必须执行 `node scripts/transition-check.mjs <task_id> --from INIT --to <NEXT>`，exit 0 才允许流转。
3. **显式输出判定结论**：输出顶部必须标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。
4. **强制写入 intent_type + tier**：判定完成后必须执行 `node scripts/task-context.mjs set <task_id> intent.intent_type '<INQUIRY|EXECUTION>' --agent conductor` 和 `node scripts/task-context.mjs set <task_id> sizing.tier '<T0|T1|T2>' --agent conductor`。未写入合法值时，transition-check.mjs 将拒绝流转。
5. **SIZING 机械应用 config**：定级后必须执行 `node scripts/task-context.mjs apply-tier <task_id> <Tn> --agent conductor`，从 `lifecycle/config.yaml` tier_defaults 机械写入 `config.agents` + `review_mode`。禁止手工 `set config.agents.*`。

## 降级处理

- 用户请求模糊且无法澄清 → 输出 `[INTENT: AMBIGUOUS]` + 澄清问题，等待用户回复。
- 项目上下文缺失（新会话无 compaction 锚点）→ 基于 `kilo.json` 和 `AGENTS.md` 推断，标注 `[CONTEXT_INFERRED]`。
