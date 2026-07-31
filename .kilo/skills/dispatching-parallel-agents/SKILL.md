---
name: dispatching-parallel-agents
description: 面对 2+ 独立任务（无共享状态、无顺序依赖）时加载本 skill。3 个 executor 隔离原则、委派包结构（goal/context_anchor/acceptance_criteria/known_failures）、synthesizer 汇总、越界检测。
keywords: [parallel, agents, dispatch, isolation, synthesizer, 并行, 委派]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/dispatching-parallel-agents/SKILL.md
  rewrite_ratio: 0.6
---

# 并行委派 Agents

## 何时触发

- 3+ 测试文件失败，根因不同
- 多子系统独立破损
- 每个问题可在无其他问题上下文下理解
- 问题间无共享状态
- 修复一个不会修好其他

**不触发**：
- 失败相关（修一个可能修其他）
- 需要完整系统状态
- 探索性调试（不知道哪里坏）
- 共享状态（agent 会互相干扰）

## 核心原则

独立问题域 = 一个 agent 一个，并发执行。

## 决策树

```
多个失败？ → 独立？ → 可并行？ → 平行委派
                ↓否(相关)    ↓否(共享)
              单 agent     串行委派
                 串行调查
```

## 3 个 Executor 隔离原则

| 原则 | 含义 | 违反后果 |
|------|------|----------|
| 互不可见 | executor 不知道彼此存在 | 互相干扰、抢资源 |
| 独立上下文 | 不继承父会话历史 | 上下文污染、跑题 |
| 不可自封 | 不得宣告最终结论 | 越权、合成器失真 |

**synthesizer 角色**：executor 互不知，synthesizer 汇总，禁止 executor 自行总结。

## 委派包结构

每个 agent 必须收到一个**完整、自包含、聚焦**的委派包：

```markdown
## goal（单一）
一句话：解决 X

## context_anchor（精确）
- 文件:行号 / 符号 UID
- 关键依赖接口
- 相关测试位置

## acceptance_criteria（可验）
1. [可一条命令证伪/证实]
2. [...]

## known_failures（透明）
- 已试过 [方案] 失败原因：[…]
- 避免 [陷阱]

## 边界声明（强制）
禁止触碰：[文件/模块清单]
越界 → [SCOPE_CREEP]
```

## 委派 prompt 质量清单

| 差 | 好 |
|------|------|
| "修所有测试" | "修 agent-tool-abort.test.ts 的 3 个失败" |
| "修竞态" + 无上下文 | 贴错误消息 + 测试名 |
| 无约束 | "禁止改 production code" |
| "修一下" | "返回根因 + 改动清单" |

## 同响应多调用 = 并行

```text
[响应 1]
task(general-purpose, "修 agent-tool-abort.test.ts")
task(general-purpose, "修 batch-completion.test.ts")
task(general-purpose, "修 tool-approval-race.test.ts")
# 三者并发
```

每响应一个 = 串行。**同一响应多个 task 工具调用 = 并行**。

## 汇总协议（synthesizer）

1. 读取每个 agent 的 summary
2. 验证修复无冲突（diff 比对）
3. 跑全量测试套件
4. 抽查（agent 可能犯系统性错误）
5. 报告实际状态，**不盲信** agent "成功"

## 越界检测

- diff 范围超出委派包声明的"禁止触碰"清单 → `[SCOPE_CREEP]`
- agent 自封 DONE/完成 → 强制重新走 verification-before-completion
- agent 修改了其他无关文件 → 回滚 + 重新委派

## 红旗（Red Flags）

- agent 之间能"看到"对方输出
- 委派包没有 acceptance_criteria
- context_anchor 含糊（"看下这块"）
- synthesizer 由某个 executor 兼任
- agent 报告"成功"但未跑验证
- 多 agent 改同一文件（共享状态）

## 反模式

- **太宽泛**："修所有 bug" → agent 迷失
- **无上下文**："修竞态" → 不知在哪
- **无约束**：agent 顺手重构一切
- **输出含糊**："修一下" → 不知改了什么
- **串行伪装并行**：跨响应发出 task 调用
- **信任代理**："agent 说成功" → 必须独立验证

## 与 subagent-driven-development 的区别

- **dispatching-parallel-agents**：单次响应多委派，并发解决独立问题
- **subagent-driven-development**：顺序任务流，每任务后审查，闭环 plan 执行

## 详细参考

- 原文：https://github.com/obra/superpowers/tree/main/skills/dispatching-parallel-agents/SKILL.md
- 关联：`.kilo/skills/subagent-driven-development/SKILL.md`
- 关联：`.kilo/skills/verification-before-completion/SKILL.md`（agent 报告必验证）
