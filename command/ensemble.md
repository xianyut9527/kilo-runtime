---
description: 多模型并行执行命令。扫描 agent 目录动态调度所有 enabled 的 Executor，触发完整的 Ensemble Workflow：并行分发 → 多版本对比选取 → 快速验证 → 异常修复 → 交付。
agent: ensemble
subtask: true
---

启动 Ensemble Workflow 多模型并行编排：

1. 扫描 .kilo/agent/*.md：
   - 收集所有 mode: subagent 且 enabled: true 的 executor agent
   - 从 frontmatter 读取 worktree、model 字段
2. 动态创建对应数量的 git worktree（每个 enabled executor 一个）。
3. 并行调用所有 enabled Executor Subagent：
   - 对每个 enabled executor 执行 `Task @<agent>`
   - 例如：Task @executor-dp（worktree: dp）、Task @executor-mm（worktree: minimax）
   - 各 executor 收到的任务包包含：《需求锚定文档》+《范围锁定附录》+《任务特征摘要》
4. ensemble 主控直接对比各 executor 返回的 diff + 自测结果：
   - 对比维度：测试通过率 > 修改聚焦度 > 代码膨胀度 > 自我定位对齐度
   - 仅一个通过 → 直接采纳
   - 多个通过且 diff 一致 → 直接采纳
   - 多个通过但 diff 冲突 → 选取更优版本，或 Task @synthesizer 简单融合
   - 全部未通过 → 选取最接近通过的版本
5. 快速验证：运行测试/构建/类型检查/lint + 范围检查 + 聚焦度扫描。
6. 若验证失败，Task @fixer 精准修复 → 重新验证（最多 1 轮）。
7. 仍不通过 → 上报阻塞原因。
8. PASS 后 apply 到当前本地分支，**不自动 commit**，由用户手动提交，清理所有 worktree。

需求原文：$ARGUMENTS
