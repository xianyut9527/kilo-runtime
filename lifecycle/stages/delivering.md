---
description: 生命周期阶段 DELIVERING — 交付。闭环确认、变更回顾/分析回顾、经验沉淀、task_context 归档、分支收尾。
executor: conductor        # conductor 内建主槽，不经 mount 挂载
model_capability: fast-reasoning
token_budget: 6000
---

# lifecycle/stages/delivering

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（DELIVERING → DONE 经 MEMORY_WRITE_COMPLETE 门禁边）。

## 输入

- `task_context.intent_type`（EXECUTION / INQUIRY，决定交付内容）
- EXECUTION：所有已完成单元的变更摘要 + 验收映射表 + 验证报告
- INQUIRY：完整分析结论 + 证据清单 + 引用来源 + 维度覆盖说明 + 局限声明
- 正向验证报告 + 反向审计报告（T2+）
- 侧向验证报告（T2+）+ 审查报告（T1+ 统一 full）
- 强制流程日志（完整生命周期节点）
- 本次任务中引用的 fact_id / failure_id 列表
- task_context.json（完整任务上下文）

## 交付内容（按 intent_type 分支）

### EXECUTION 模式交付

#### 1. 闭环确认（验收 → 实现位置 → 验证证据 → 状态）

```
| 验收标准 | 实现位置 | 验证证据 | 状态 |
|----------|----------|----------|------|
```

#### 2. 变更回顾
- **改了什么**：文件列表 + 函数/模块变更摘要
- **为什么改**：根因或需求来源
- **影响范围**：调用方、下游模块、API 消费者
- **清理调试代码**：确认无 console.log / debugger / 临时文件残留

### INQUIRY 模式交付

#### 1. 分析闭环确认（结论 → 证据 → 来源 → 质量）

```
| 结论要点 | 证据/推理 | 引用来源 | 验证状态 |
|----------|-----------|----------|----------|
```

#### 2. 分析回顾
- **核心结论**：用 ≤3 句话概括回答用户原始问题的核心结论
- **维度覆盖**：按 analysis_gate 预设维度逐项确认是否覆盖
- **证据清单**：所有引用的文件、代码片段、配置项、外部资料的完整清单
- **引用来源可信度**：标注每个来源的时效性（如"基于 v2.1 版本""基于 2026-07 最新配置"）
- **分析局限**：诚实声明分析的边界（如"未读取运行时日志""基于静态推断""未覆盖性能实测"）
- **偏见自检**：是否考虑了反面证据？是否存在确认偏误？

#### 3. 经验沉淀（INQUIRY 同样必走）
- 分析框架可复用性：本次分析的结构/方法是否可以沉淀为可复用 pattern？
- 常见误区：用户在该领域常犯的错误/误解
- 模型校准：本次分析中哪些模型表现更优/更差

### 通用交付（两种模式均适用）

#### 3. 经验沉淀（sqlite 优先，md 仅作索引兜底）

**T1+ 必走「收尾自检」硬门**；**T0/INQUIRY 命中"价值信号"时同样必走**（见 `agent/conductor.md` §记忆编排 T0/INQUIRY 条款）：
- M4：去重 — 查询 `fact_store` 是否已有同类记录
- M5：新经验写入 — INSERT `fact_store`（Pattern confidence=0.6，AntiPattern=0.5）
- M6：反馈 — `[memory:helpful=...]` / `[memory:misleading=...]`（无反馈显式 `[memory:helpful=none]`）
- M7：`failure_db` 写入（如有失败案例）
- M8：`dispatch_log` 写入 + `model_calibration` 更新

> 未执行 → `[MISSING_MEMORY_WRITE]` 阻塞交付。

### 交付门禁不可跳过

- `DELIVERING → DONE` 由 `transition-check.mjs` 的 `MEMORY_WRITE_COMPLETE` gate 守卫。`memory_write_status` 必须为 `OK` 或 `DEGRADED`，或 `memory_write_complete === true`。`MISSING` 或其他任意值均会被拒绝，报 `[MISSING_MEMORY_WRITE]`。
- 任何从 DELIVERING 出发的 transition 必须满足 `task_context.current_stage === 'DELIVERING'` 的阶段顺序硬门，防止未进入 DELIVERING 直接跳到 DONE。

#### 4. 分支收尾协议（仅 EXECUTION）
1. git status 清理（无未 staged 调试代码）
2. 单提交对应单定级单元
3. 告知用户分支去向，不擅自 push 合并
4. worktree 隔离清理（如适用）

## 输出信号

```yaml
status_signal: "DONE"
transition_context:
  intent_type: "EXECUTION" | "INQUIRY"
  units_completed: int
  memory_write_status: "OK" | "DEGRADED" | "MISSING"
quality_gate:
  acceptance_map_verified: true | false    # EXECUTION
  analysis_summary_complete: true | false  # INQUIRY
  evidence_list_complete: true | false     # INQUIRY
  memory_write_complete: true | false
  branch_cleanup_done: true | false       # EXECUTION
```

## 路由规则（边定义见 graph.yaml）

- `status_signal: DONE` + 所有 quality_gate 通过 → 终态节点 `DONE`（生命周期结束）
- `memory_write_status: MISSING` → `[MISSING_MEMORY_WRITE]` 阻塞，回到 `DELIVERING` 补充
- `memory_write_status: DEGRADED`（memory.db 不存在）→ 不阻塞，输出提示后继续
- INQUIRY 模式下不执行分支收尾协议（无代码变更）

## 记忆提示即时输出

- 召回：`🧠 [memory:recall] 注入 fact=X + context=Y | ~Nk tokens`
- 写入：`💾 [memory:write] fact_store AP-XXX hit N→N+1 | dispatch_log +1`
- ID 必带：fact_id / failure_id / dispatch_id 不可省略
