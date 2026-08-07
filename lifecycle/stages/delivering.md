---
description: DELIVERING 阶段主槽 — conductor 内建输出最终交付报告
model_capability: fast-reasoning
token_budget: 4000
executor: conductor  # 新增：类比 init.md
---

# conductor 内建阶段（DELIVERING 与 INIT 同构，main slot 由 conductor 占据，不经 task 启动）

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（DELIVERING → DONE 无 gate）。

## 输入

- `task_context.intent_type`（EXECUTION / INQUIRY，决定交付内容）
- EXECUTION：所有已完成单元的变更摘要 + 验收映射表 + 验证报告
- INQUIRY：完整分析结论 + 证据清单 + 引用来源 + 维度覆盖说明 + 局限声明
- 正向验证报告 + 审查报告（T1+ 统一 full）
- 强制流程日志（完整生命周期节点）
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
- **维度覆盖**：按预设维度逐项确认是否覆盖
- **证据清单**：所有引用的文件、代码片段、配置项、外部资料的完整清单
- **引用来源可信度**：标注每个来源的时效性
- **分析局限**：诚实声明分析的边界
- **偏见自检**：是否考虑了反面证据？是否存在确认偏误？

### 通用交付（两种模式均适用）

#### 3. 分支收尾协议（仅 EXECUTION）
1. git status 清理（无未 staged 调试代码）
2. 单提交对应单定级单元
3. 告知用户分支去向，不擅自 push 合并
4. worktree 隔离清理（如适用）

> **T0 直达前置**：T0 任务绕过 QUALITY 直达 DELIVERING，须在 EXECUTING 阶段完成轻量验证（`scan-encoding.mjs` 通过 + `encoding_clean: true` + `no_debug_leftovers: true`，见 `executing.md` 路由规则）。DELIVERING 接收 T0 产物时默认信任前置已通过；若 EXECUTING 输出 `DONE_WITH_CONCERNS` 则已回流 QUALITY 兜底，不会直达。

## 交付排版规范（铁律 #10）

> 用户反馈 DELIVERING 回复质量不足（没 Claude Code 级信息密度+视觉层次）。本规范强制 conductor 输出格式。

### 1. 结论先行（Inverted Pyramid）
- **第一条消息的第一句 = 最终 verdict**（PASS / FAIL / 有条件通过 / 降级交付）
- **禁止**先铺陈背景、过程、数据再出结论
- **格式**：`## ✅ 结论`（大标题）+ 一句话 verdict + 下接 `---` 分隔线

### 2. 视觉层次（Visual Hierarchy）
- **第一层**：`##` 大标题（结论/变更/证据/收尾），只用 emoji + 文字，不超过 4 个一级标题
- **第二层**：`###` 子标题（按信息类型分组），每段 ≤5 行
- **第三层**：表格只用于**可比较的维度数据**（如验收映射表、对比矩阵），禁止把流程步骤/说明放进表格
- **引导视线**：用 `> **` 引用块标关键警告/待决策；用 `---` 分隔线切分信息块；用 emoji（✅❌⚠️📋🔧）替代纯文字标记
- **禁止**：连续 >3 个表格、连续 >5 行 bullet、无分隔线的长篇段落

### 3. 信息密度铁律（Information Density）
- **每段 ≤5 行**，每行 ≤80 字符（终端友好）
- **关键数据前置**：数字、文件路径、commit SHA、命令行证据 → 放在段落**最前**（"commit `abc1234` 修复了..." 而非 "修复了... commit abc1234"）
- **删除冗余**：不重复 task_context 已有信息（如完整 transition_log）；只列**用户需要决策**的内容
- **禁止 narrative-only**："X 已完成" → 必须配 `file:line` + `cmd/exit` 证据
- **超限处理**：DELIVERING 输出 > 4000 字符 → 先压缩到 "结论 + 变更摘要 + 待决策" 三段，再超限 → 输出 "报告已落盘 `<file>`" 替代全文

### EXECUTION 模式排版模板（强制）

```
## ✅ 结论
[一句话 verdict，含完成度百分比/降级标记]

---

## 📋 闭环确认
| 验收标准 | 实现位置 | 验证证据 | 状态 |
| ... | ... | ... | ... |
（≤4 行，不要完整映射表，只列**用户关心的关键项**）

---

## 🔧 变更摘要
- **改了什么**：3 句话 + 文件列表（path + line count）
- **为什么改**：1 句话根因
- **影响范围**：≤3 个下游模块/调用方
- **清理确认**：无 console.log / debugger / 临时文件残留

---

## ⚠️ 待用户决策
1. [决策项 A] — 建议：...
2. [决策项 B] — 建议：...
（没有则不写本段）

---

## 🏁 分支收尾
- git status：[clean / X files modified]
- commit：`abc1234`（单提交对应单定级单元）
- 分支去向：未推送 / 未合并
- worktree：已清理 / 保留
```

### INQUIRY 模式排版模板（强制）

```
## ✅ 结论
[≤3 句话核心回答]

---

## 📋 证据清单
- [文件/来源 1] → [关键结论]
- [文件/来源 2] → [关键结论]

---

## ⚠️ 分析局限
[诚实声明边界]
```

## 输出信号

```yaml
status_signal: "DONE"
transition_context:
  intent_type: "EXECUTION" | "INQUIRY"
  units_completed: int
quality_gate:
  acceptance_map_verified: true | false    # EXECUTION
  analysis_summary_complete: true | false  # INQUIRY
  evidence_list_complete: true | false     # INQUIRY
  branch_cleanup_done: true | false       # EXECUTION
```

## 路由规则（边定义见 graph.yaml）

- `status_signal: DONE` + 所有 quality_gate 通过 → 终态节点 `DONE`（生命周期结束）
- INQUIRY 模式下不执行分支收尾协议（无代码变更）
