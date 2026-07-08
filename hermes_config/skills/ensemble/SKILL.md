---
name: ensemble
description: T2+ 任务多模型 ensemble 触发条件与流程。通过 execute_code 并行调用多模型 API 生成方案，独立 checker 审查择优。
keywords:
  - ensemble
  - multi-model
  - engineer-A
  - engineer-B
  - checker
  - parallel
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: orchestration
---

# Ensemble 多模型方案生成

> T2+ 任务不走单模型直接编码，走多模型并行生成 + 独立审查择优。

## 触发条件

T2/T3 判定后，主代理不直接 patch/write_file，先触发 ensemble：

```
需求扩散 → T2/T3 判定 → 触发 ensemble → execute_code 运行脚本
```

T0/T1 任务跳过 ensemble，直接编码。

## 角色分工

| 角色 | 模型 | 任务 | 自查 |
|------|------|------|------|
| engineer-A | kimi-k2.6 | 生成完整方案一 | ❌ |
| engineer-B | MiniMax-M3 | 生成完整方案二 | ❌ |
| checker | glm-5.2 | 综合两方案，取长补短，查漏补缺 | ✅ |

## 执行流程

1. 主代理完成需求扩散和 gitnexus 分析
2. `execute_code` 运行 `skills/ensemble/scripts/ensemble.py`
3. 脚本并行调用 engineer-A、engineer-B 生成两版方案
4. checker 综合审查：
   - 对比两方案的优劣与遗漏
   - 取长补短，生成一份更完整的综合方案
   - 标注内容来源（来自 A / 来自 B / 新增）
5. 主代理应用综合方案
6. 跑四门门禁验证

## 不自检自查原则

- engineer 只生成，不审查自己
- checker 用独立视角查漏补缺，不简单地二选一
- 主代理不自审（checker 已综合优化过）
