---
name: requesting-code-review
description: 任务完成、实现主要功能、合并前必须加载本 skill 主动请求代码评审。翻译自 obra/superpowers，保留核心方法学并适配 kilo 中文语境。
keywords: [review, code-review, requesting, subagent, 评审, 委派]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/requesting-code-review/SKILL.md
  rewrite_ratio: 0.6
---

# 请求代码评审

在问题级联前，委派代码评审 subagent 进行审查。评审者获取精确构建的上下文，而非你的会话历史。这能让评审者聚焦于工作产物，并保留你的上下文以便继续工作。

**核心原则：** 尽早评审，频繁评审。

## 何时请求评审

**强制场景：**
- subagent 驱动开发中，每个任务完成后
- 完成主要功能后
- 合并到 main 之前

**可选但有价值：**
- 卡住时（获取新视角）
- 重构前（基线检查）
- 修复复杂 bug 后

## 如何请求

**1. 获取 git SHA：**
```bash
BASE_SHA=$(git rev-parse HEAD~1)
HEAD_SHA=$(git rev-parse HEAD)
```

**2. 委派代码评审 subagent：**

派发一个 `general-purpose` subagent，使用 code-reviewer 模板。

**占位符：**
- `{DESCRIPTION}` - 所做工作的简要总结
- `{PLAN_OR_REQUIREMENTS}` - 应该做什么
- `{BASE_SHA}` - 起始 commit
- `{HEAD_SHA}` - 结束 commit

**3. 处理反馈：**
- Critical 问题：立即修复
- Important 问题：继续前修复
- Minor 问题：记录到后续处理
- 评审者错误时：有理有据地反驳

## 示例

```
[刚完成任务 2：添加验证函数]

获取 SHA：
BASE_SHA=a7981ec
HEAD_SHA=3df7661

[派发代码评审 subagent]
DESCRIPTION: 新增 verifyIndex() 和 repairIndex()，覆盖 4 种问题类型
PLAN_OR_REQUIREMENTS: docs/superpowers/plans/deployment-plan.md 任务 2
BASE_SHA: a7981ec
HEAD_SHA: 3df7661

[Subagent 返回]：
优势：架构清晰，有真实测试
问题：
  Important：缺少进度指示器
  Minor：报告间隔使用魔数 100
评估：可继续

[修复进度指示器]
[继续任务 3]
```

## 工作流集成

**Subagent 驱动的开发：**
- 每个任务后评审
- 在问题复合前捕获
- 修复后再进入下一任务

**执行计划：**
- 每个任务后或自然检查点处评审
- 获取反馈，应用，继续

**临时开发：**
- 合并前评审
- 卡住时评审

## 红旗

**禁止：**
- 因为"很简单"而跳过评审
- 忽略 Critical 问题
- 未修复 Important 问题就继续
- 对有效技术反馈争论不休

**评审者错误时：**
- 用技术推理反驳
- 展示代码/测试证明其有效
- 请求澄清
