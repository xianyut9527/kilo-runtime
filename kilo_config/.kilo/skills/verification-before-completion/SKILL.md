---
name: verification-before-completion
description: 在宣称任务完成、修复、测试通过、提交代码或创建 PR 之前必须加载本 skill。要求本轮 fresh 验证证据，禁止"应该""大概""看起来"等模糊措辞。证据先于断言，恒为铁律。
keywords: [verification, completion, evidence, gate, red-flag, 验证, 证据]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/verification-before-completion/SKILL.md
  rewrite_ratio: 0.6
---

# 验证后再声明完成

## 何时触发

- 准备输出"完成""通过""修复"等任何变体措辞
- 准备 commit / push / 创建 PR 之前
- 委派给子 agent 之后准备汇总结果
- 切换到下一任务前

## Iron Law（铁律）

```
无 fresh 验证证据 = 不得声明完成
```

本轮未跑验证命令 = 不得声明结果。

## 5 步门禁（IDENTIFY→RUN→READ→VERIFY→CLAIM）

| 步骤 | 动作 | 失败处理 |
|------|------|----------|
| IDENTIFY | 确定能证明该声明的命令 | 找不到命令 → 声明无效 |
| RUN | 完整执行（非局部、非缓存） | 命令报错 → 声明失败 |
| READ | 读全 stdout+stderr+exit code | 截断/跳过 = 撒谎 |
| VERIFY | 输出是否证实声明 | 不符 → 报真实状态 |
| CLAIM | 声明必须附证据 | 缺证据 = 撒谎 |

跳过任一步 = 撒谎，不是验证。

## 常见声明的证明要求

| 声明 | 必需证据 | 不足为证 |
|------|----------|----------|
| 测试通过 | 测试命令 0 失败 | 上次结果、"应该通过" |
| Lint 干净 | Lint 0 错误 | 部分检查、外推 |
| 构建成功 | 构建 exit 0 | Lint 通过、日志好看 |
| Bug 修复 | 原症状测试转绿 | 代码已改、推测已修 |
| 需求满足 | 逐条 checklist 验证 | 测试通过即假定 |

## 红旗（Red Flags）— 立即 STOP

- 使用"应该""大概""似乎""可能"
- 表达满意但未跑验证（"Great""Perfect""Done"）
- 即将 commit/push/PR 未验证
- 信任 agent 报告的"成功"
- 部分验证后外推
- 想着"就这一次"
- 疲倦想收工
- **任何暗示成功的措辞**而无验证证据

## 合理化借口与反驳

| 借口 | 反驳 |
|------|------|
| "这次应该能跑" | RUN 验证 |
| "我有信心" | 信心 ≠ 证据 |
| "就这一次" | 无例外 |
| "Lint 通过了" | Lint ≠ 编译 |
| "Agent 说成功" | 独立验证 |
| "部分检查够了" | 部分证明不了任何事 |

## 反模式

- **声明驱动**：先写"完成"再补证据 → 反过来做：先证据后声明
- **信任传递**：上层 agent 信任下层 agent 的"成功"报告
- **Linter 等于编译**：用 lint 掩盖未跑构建
- **一次跑通 = 修复**：bug 修复必须看原症状测试转绿
- **"精神遵循"**：换措辞规避规则的字面要求

## 回归测试 TDD Red-Green 验证

修复 bug 时必须验证回归测试有效：

```
写测试 → 跑（应通过）→ 回退修复 → 跑（必须失败）→ 恢复修复 → 跑（应通过）
```

若第二步未失败 = 测试无效，重写。

## 详细参考

- 原文：https://github.com/obra/superpowers/tree/main/skills/verification-before-completion/SKILL.md
- 关联：`.kilo/skills/tdd-execution/SKILL.md`（TDD 红绿重构）
- 关联：`agent/checker.md`（客观验证协议）

## Bottom Line

跑命令、读输出、然后声明结果。无可商量。
