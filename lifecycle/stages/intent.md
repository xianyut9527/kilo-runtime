---
description: 生命周期阶段 INTENT — 意图判定。接收用户输入，判定咨询类/执行类，输出类型信号。
executor: conductor        # conductor 内建主槽，不经 mount 挂载
model_capability: fast-reasoning
token_budget: 4000
---

# lifecycle/stages/intent

> 通用规则由运行时注入的 `core.md` 提供。流转关系见 `lifecycle/graph.yaml`（单一真相来源），本文件只定义执行逻辑。
> 执行元数据（executor / model_capability / token_budget）见 frontmatter；本阶段为 conductor 内建（executor 声明），无 required_roles；非内建阶段的必配角色契约见各自 stages frontmatter `required_roles`。

## 输入

- 用户原始请求（自然语言或命令）
- 当前项目上下文（技术栈、最近修改、活跃分支）
- 会话历史（compaction 后保留的锚点）

## 处理流程

1. **M1 记忆召回**（必选，`memory.db` 存在时）：注入 `project_context`（项目级安全约束/技术栈）+ 相关 `fact_store`（confidence ≥ 0.7 + hit_count ≥ 2）+ `failure_db`（resolved 同类失败）。咨询类同样需要——分析质量依赖项目积累，不得跳过。
2. **语义解析**：提取用户请求中的动词（"改"、"加"、"查"、"解释"、"对比"）和对象（文件、模块、配置、概念）。
3. **类型判定**：按 `core.md` §意图分类执行：
   - **咨询类**（`INQUIRY`）：只分析、不改文件、不调用修改性工具。输出分析结论即可。
   - **执行类**（`EXECUTION`）：涉及文件修改、代码生成、配置变更。进入 `SIZING`。
4. **显式输出判定结论**：必须在输出顶部显式标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。

## 输出信号

```yaml
status_signal: "DONE" | "NEEDS_CONTEXT"
transition_context:
  intent_type: "INQUIRY" | "EXECUTION"
  project: "string"
  keywords: ["string"]
quality_gate:
  intent_clear: true | false  # 是否已明确区分咨询/执行
```

## 路由规则（边定义见 graph.yaml）

- **v2.1 变更**：INQUIRY 不再直通 DONE，而是与 EXECUTION 同样进入 `SIZING` 定级，走完整闭环提升质量：
  - `INQUIRY` → `SIZING` → `PLANNING`（分析门）→ `QUALITY`（分析结论验证）→ `DELIVERING`（记忆沉淀）→ `DONE`
   - T0 咨询快答：`SIZING` → `DELIVERING`（跳过 PLANNING/QUALITY）
   - T1/T2 咨询分析：`SIZING` → `PLANNING`（分析门）→ `QUALITY` → `DELIVERING`
- `EXECUTION` → `SIZING`（任务定级）
- `NEEDS_CONTEXT` → 回传用户请求补充信息，不推进
- 旧路由 `INQUIRY → DONE`（直接结束）已移除，全部咨询走闭环

## 硬规则

1. **task_context 强制初始化**：进入 INTENT 前必须先执行 `node scripts/task-context.mjs init <task_id>`。未初始化直接流转 → `[PROCESS_VIOLATION]`（transition-check.mjs 会明确拦截并提示 init）。
2. **流转必裁判**：INTENT → SIZING 前必须执行 `node scripts/transition-check.mjs <task_id> --from INTENT --to SIZING`，exit 0 才允许流转。
3. **显式输出判定结论**：输出顶部必须标注 `[INTENT: INQUIRY]` 或 `[INTENT: EXECUTION]`。
4. **强制写入 intent_type**：判定完成后必须执行 `node scripts/task-context.mjs set <task_id> intent.intent_type '<INQUIRY|EXECUTION>' --agent conductor`。未写入合法 intent_type 时，transition-check.mjs 将拒绝任何从 INTENT 出发的流转，报 `[PROCESS_VIOLATION]`。

## 降级处理

- 用户请求模糊且无法澄清 → 输出 `[INTENT: AMBIGUOUS]` + 澄清问题，等待用户回复。
- 项目上下文缺失（新会话无 compaction 锚点）→ 基于 `kilo.json` 和 `AGENTS.md` 推断，标注 `[CONTEXT_INFERRED]`。
