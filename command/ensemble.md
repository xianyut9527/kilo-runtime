---
description: 多模型并行执行命令。扫描 agent 目录动态调度所有 enabled 的 Executor，触发完整的 Ensemble Workflow：并行分发 → 合并 → 审查 → 修复闭环。
agent: ensemble
subtask: true
---

启动 Ensemble Workflow 多模型并行编排：

1. 扫描 .kilocode/agent/*.md：
   - 收集所有 mode: subagent 且 enabled: true 的 executor agent
   - 从 frontmatter 读取 worktree、model 字段
2. 动态创建对应数量的 git worktree（每个 enabled executor 一个）。
3. 并行调用所有 enabled Executor Subagent：
   - 对每个 enabled executor 执行 `Task @<agent>`
   - 例如：Task @executor-dp（worktree: dp）、Task @executor-mm（worktree: minimax）
4. 收集所有 Executor 的 git diff。
5. Task @synthesizer 合并多版本代码。
6. Task @checker 审查合并结果。
7. 若 FAIL，Task @fixer 修复 → 重新 Checker（最多 3 轮）。
8. PASS 后 apply 到主分支，**不自动 commit**，由用户手动提交，清理所有 worktree。

需求原文：$ARGUMENTS
