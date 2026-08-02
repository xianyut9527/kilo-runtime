---
name: subagent-driven-development
description: 在当前会话内执行实现计划（任务大多独立）时加载。委派包方法学、4 状态信号、隔离执行。T1+ 默认模式。
keywords: [subagent, dispatch, status-signal, delegation, 委派, 状态信号]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/subagent-driven-development/SKILL.md
  rewrite_ratio: 0.6
---

# 子 Agent 驱动的开发

## 何时触发

- 已有实现计划
- 任务大多独立
- 在当前会话内执行（不切到并行 session）
- 想用"任务-审查-修复"循环保证质量

**不触发**：
- 无计划 → 先 brainstorming/writing-plans
- 任务强耦合 → 手动执行或先 brainstorm
- 跨并行 session → 用 executing-plans

## 核心原则

**新子 agent per task + 任务审查（spec 合规 + 代码质量）+ 全分支终审 = 高质量、快迭代**

子 agent **不继承**父会话上下文/历史——你精确构造它需要的部分。

## 委派包 5 字段（强制）

| 字段 | 内容 | 反模式 |
|------|------|--------|
| goal | 单一可验 | "顺便修 X" |
| context_anchor | 文件:行号/UID、接口契约、先前任务产物 | "看下这块" |
| key_files | 入口/测试路径 | — |
| acceptance_criteria | 一条命令/检查可证伪 | "代码更好" |
| known_failures | 已试方案+失败原因 | 漏传=重复踩坑 |

## 4 状态信号（强制顶部标注）

| 信号 | 含义 | 处理 |
|------|------|------|
| `DONE` | 完成，验收满足，验证通过 | 进 verifier |
| `DONE_WITH_CONCERNS` | 完成但有遗留风险 | 附风险说明进 verifier |
| `NEEDS_CONTEXT` | 缺必要上下文 | 停止，回传 conductor |
| `BLOCKED` | 不可解阻塞 | 停止，升级 conductor |

**缺失状态信号 = `[MISSING_STATUS_SIGNAL]` FAIL。**

## 任务循环

```
dispatch implementer → 实现/测试/自审/提交 → 写 diff → dispatch task reviewer
spec✅+quality✅ → 标记完成
否 → dispatch fix → re-review → 标记完成
```

## 模型选择

- 机械（1-2 文件、明确 spec）→ 便宜
- 集成/判断（多文件、模式匹配、调试）→ 标准
- 架构/设计 → 最强
- 审查 → 按 diff 规模/风险选
- **派单必须显式指定 model**（不指定 = 继承 = 隐性最贵）

## 关键约束

连续执行（不任务间问）/ 每任务 fresh agent / spec+quality 都必查 / 不重派已完成 / 派单不贴历史 / 不预先判定 / implementer 自审+task 审查+全分支终审 三者独立

## Plan 偏差检测（pre-flight）

派 Task 1 前**一次性**扫描 plan：任务互相矛盾或与 Global Constraints 冲突？plan 显式要求但审查 rubric 当缺陷？发现 → **批量**问用户。干净 → 不评论继续。

## 状态信号处理

**DONE_WITH_CONCERNS**：读关切再审。正确性/范围先处理；观察（"文件大了"）记下进审。**NEEDS_CONTEXT**：补上下文重派。**BLOCKED**：上下文问题补+重派；任务需推理→强模型；任务太大→拆；plan 错→升级用户。**绝不**忽略升级或同模型盲重试。

## Block 状态升级硬规则（避免盲重试循环）

**禁止盲重试**：同一 subagent 同一任务连续 2 次 `BLOCKED`/`NEEDS_CONTEXT` → **立即停止派发**，升级 conductor 决策。

**升级决策树**（按 BLOCKED 原因选择）：

| 原因分类 | 升级动作 |
|----------|----------|
| 上下文不足（文件权限/环境变量/依赖版本） | conductor 补全上下文后换模型重派（避免同模型盲试） |
| 任务需求推理（设计/架构判断） | 换强模型（默认升级到 planner 模型档位） |
| 任务过大（spec 包含 3+ 独立子目标） | 拆任务为多个 subagent 并行 |
| plan 错（与现有代码/契约冲突） | **立即升级用户**，不在 subagent 层继续 |
| subagent 自报"部分完成" | 视为 BLOCKED，**禁止**接受"80% 完成"（部分完成 = 未完成） |
| 连续 2 轮 BLOCKED 后仍"再试一次" | `[BLIND_RETRY]` 红旗，立即升级用户 |

**反盲重试红旗**（输出含以下词立即 STOP）：
"再试一次""换个说法重派""同模型再跑一次""应该能成""或许换行号试试"

## 红旗（Never）

main/master 直实现（无显式用户同意）/ 跳审查或接受缺 verdict / 未修复 issue 继续 / 平行派多 implementer / 让 subagent 读整 plan / 忽略 subagent 提问 / 接受"差不多"（spec ❌ = 未完成）/ 用自审替代审查 / 告诉审查忽略什么 / 无 diff 派审查（先生成 review-package）/ 审查有 Critical/Important 时跳下一任务 / 重派 ledger 已完成任务

## 反模式

串行手动+大上下文传递 / 审查走过场只跑测试不查 spec / 无 ledger 导致重派已完成 / 同模型盲重试 / 审查无 review-package / 单 fixer 一 finding（应一 fixer 接所有）/ plan 矛盾不报

## 进度 Ledger（防上下文压缩丢失）

启动时 `cat .superpowers/sdd/progress.md`。任务完成追加：`Task N: complete (commits <base7>..<head7>, review clean)`。压缩后信任 ledger + `git log`。

## 文件化交接

- **Task brief**：`scripts/task-brief PLAN_FILE N` 提取到唯一路径
- **Report file**：brief→report，implementer 写完整报告回传仅状态/commits/单行测试汇总
- **Review package**：`scripts/review-package BASE HEAD` 生成 diff 传 reviewer
- **不直接粘贴**：所有内容以文件传递

## 详细参考

- 原文：https://github.com/obra/superpowers/tree/main/skills/subagent-driven-development/SKILL.md
- 关联：`dispatching-parallel-agents` / `verification-before-completion` / `using-git-worktrees` skills
