---
name: plan-execution
description: 计划执行追踪与变更管理。coderAgent 执行 architect DAG 时必须加载此 skill。
keywords: [plan, execution, tracking, todo, DAG]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/executing-plans/SKILL.md
  rewrite_ratio: 0.5
---

# 计划执行追踪

## 何时触发

- T2+ 任务 architect 输出完整规划后
- 单元 DAG 开始执行前
- 执行过程中发现计划偏差时

## 执行前 Critical Review

coderAgent 在启动第一个单元前必须：

1. **重新审阅计划**：对照实际代码，确认 DAG 中的文件路径、依赖关系、验收标准仍然有效。
2. **标记疑问**：任何不确定的文件/依赖/验收标准，标记 `[PLAN_QUESTION]`。
3. **澄清阻塞**：有 `[PLAN_QUESTION]` 必须先澄清，不基于假设推进。
4. **生成 todo**：将 DAG 转为结构化 todo 列表，每条含：单元ID、目标、状态、阻塞项。

## Todo 状态规范

| 状态 | 含义 |
|------|------|
| ⏳ pending | 未开始 |
| 🔄 in_progress | 执行中 |
| ✅ completed | 通过 checker |
| ❌ blocked | 遇 blocker 停止 |
| ⚠️ deviation | 发现计划偏差 |

## 遇 Blocker 即停规则（来源：superpowers/executing-plans）

以下情况必须停止，不猜测、不绕过：

- 缺失依赖（文件不存在、接口未实现、环境未配置）
- 测试失败且原因不明
- 指令不清（验收标准含糊、关键文件路径不确定）
- 实际代码与计划假设严重不符（影响 2+ 单元）

停止时输出：
```
[BLOCKED]
- 单元ID:
- 阻塞原因:
- 已尝试:
- 需要澄清:
```

## 计划偏差处理

执行中发现实际与计划不符：

1. **标记**：todo 状态改为 `⚠️ deviation`，输出 `[PLAN_DEVIATION]`。
2. **评估**：影响范围（单单元 / 多单元 / 核心验收标准）。
3. **决策**：
   - 单单元微调 → 更新 todo，继续执行。
   - 多单元或核心标准受影响 → 重新过设计门 `[DESIGN_GATE_REVIEW]`。

## 进度同步

coderAgent 在每个单元完成后更新 todo，输出当前进度快照：

```
## 执行进度
| 单元ID | 状态 | 备注 |
|--------|------|------|
```

> 不输出"我应该继续吗？"，用户要求执行计划就执行到底。仅在 BLOCKED 时停止。

## 反模式

- `[PLAN_ANTI_PATTERN_SKIP_REVIEW]`：不审阅计划直接执行。
- `[PLAN_ANTI_PATTERN_GUESS_BLOCKER]`：遇 blocker 猜测绕过。
- `[PLAN_ANTI_PATTERN_ACCUMULATE_VERIFY]`：多个单元后才统一验证。
