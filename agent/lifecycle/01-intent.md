---
description: 生命周期阶段 01 — 意图判定。接收用户输入，判定咨询类/执行类，输出类型信号。
stage_id: S01_INTENT
agents:
  - conductor
previous_stage: S00_START
next_stage: S03_SIZING
---

# lifecycle/01-intent

> 通用规则由运行时注入的 `core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S01_INTENT` |
| **上一阶段** | `S00_START`（会话初始化） |
| **下一阶段** | `S02_INTENT_DONE`（判定完成）→ `S03_SIZING` |
| **加载智能体** | `conductor`（内建，无需 task 启动） |
| **模型偏好** | `registry:fast-reasoning`（轻量、低延迟） |
| **token 预算** | ≤ 4000 |

## 输入

- 用户原始请求（自然语言或命令）
- 当前项目上下文（技术栈、最近修改、活跃分支）
- 会话历史（compaction 后保留的锚点）

## 处理流程

1. **M1 记忆召回**（必选，`memory.db` 存在时）：注入 `project_context`（项目级安全约束/技术栈）+ 相关 `fact_store`（confidence ≥ 0.7 + hit_count ≥ 2）+ `failure_db`（resolved 同类失败）。咨询类同样需要——分析质量依赖项目积累，不得跳过。
2. **语义解析**：提取用户请求中的动词（"改"、"加"、"查"、"解释"、"对比"）和对象（文件、模块、配置、概念）。
3. **类型判定**：按 `core.md` §意图分类执行：
   - **咨询类**（`INQUIRY`）：只分析、不改文件、不调用修改性工具。输出分析结论即可。
   - **执行类**（`EXECUTION`）：涉及文件修改、代码生成、配置变更。进入 `S03_SIZING`。
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

## 路由规则

- `INQUIRY` → 直接回答；若命中"价值信号"（见 `agent/conductor.md` §记忆编排），回答完成后执行轻量 M4-M8 记忆写入，再进入 `S17_DONE`；未命中 → 直接 `S17_DONE`。
  - **默认路径**：INQUIRY 默认由 conductor **内建直接回答**，无需 `task` 启动外部智能体。
  - **可插拔入口**：用户可在 prompt 显式声明外挂咨询智能体，或经 `task_context.config.agents.custom_overrides` 声明（如领域顾问型 agent），conductor 判定 INQUIRY 后经 `task` 工具加载该智能体作答。
  - **约束**：无论内建还是外挂，INQUIRY 路径**全程禁止修改性工具**（见 `core.md` §意图分类）；外挂智能体必须是 `agent/` 下已存在的 subagent（frontmatter `mode: subagent`）。
  - **frontmatter 保持**：本阶段 `agents: [conductor]` 不变——条件表达式不适用于咨询类动态命名场景，外挂入口走 `custom_overrides` 通道而非阶段文件条件加载。
- `EXECUTION` → 进入 `S03_SIZING`（任务定级）。
- `NEEDS_CONTEXT` → 回传用户请求补充信息，不推进。

## 降级处理

- 用户请求模糊且无法澄清 → 输出 `[INTENT: AMBIGUOUS]` + 澄清问题，等待用户回复。
- 项目上下文缺失（新会话无 compaction 锚点）→ 基于 `kilo.json` 和 `AGENTS.md` 推断，标注 `[CONTEXT_INFERRED]`。
