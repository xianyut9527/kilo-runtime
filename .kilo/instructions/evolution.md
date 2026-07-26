# Evolution 自进化规则

> **本文档已迁移**：SQL 模板与写入规则统一由 `docs/memory-ops-reference.md` 定义（生命周期驱动后唯一业务规则入口）。
>
> | 原章节 | 新位置 |
> |---|---|
> | 步骤 1（dispatch_log 写入） | `docs/memory-ops-reference.md` §M8 |
> | 步骤 2（fact_store 提取） | `docs/memory-ops-reference.md` §M4/M5 |
> | 步骤 3（failure_db 写入） | `docs/memory-ops-reference.md` §M7 |
> | 步骤 4（model_calibration 更新） | `docs/memory-ops-reference.md` §M8 |
> | 观测数据闭环（model_calibration UPSERT） | `docs/memory-ops-reference.md` §M8 |
>
> 本文件保留**进化闭环总览**与**禁止事项**，不再重复 SQL 模板。
>
> 模块入口：`.kilo/memory/README.md`（公共 API 文档）；SQL 模板入口：`docs/memory-ops-reference.md`。

## 四步闭环

```
① 执行 → 写入 dispatch_log（什么任务 + 什么策略 + 什么模型 + 什么结果）
② 反思 → 从 dispatch_log + verifier 结果提取 Pattern / AntiPattern
③ 提炼 → 写入全局 sqlite（fact_store / failure_db / model_calibration）
④ 应用 → 生成 Strategy Proposal，经 Regression Test → 应用
```

## 触发条件

T1+ 任务交付后，**必须**执行进化步骤。T0 可选。

## 进化优先级

| 优先级 | 动作 | 触发条件 | 能力插件位置 |
|--------|------|----------|----------|
| P0 | 写入 dispatch_log | 每次 T1+ 任务结束 | `memory-ops.md` §M8 |
| P1 | 写入 failure_db | 任务失败或 fixer 多轮 | `memory-ops.md` §M7 |
| P1 | 写入 fact_store | 发现可复用 Pattern/AntiPattern | `memory-ops.md` §M4/M5 |
| P2 | 更新 model_calibration | 每次 dispatch 后 | `memory-ops.md` §M8 |
| P3 | Skill 升级提案 | fact_store.confidence >= 0.8 且 hit_count >= 3 | `.kilo/instructions/skill-upgrade.md` |

## 禁止事项

- 不写入项目特定代码（如具体变量名、业务逻辑）
- 不写入敏感信息（API Key、密码、内部域名）
- 不重复写入相同 Pattern（先查后写，详见 `docs/memory-ops-reference.md` §M4 去重）
- 不虚构未验证的经验（必须有 dispatch_id 作为 evidence）
