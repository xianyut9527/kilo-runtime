# kilo_config 架构决策（精简版）

> 详细过程与实测记录见 git history。这里只留**决策 + 边界**，防重复踩坑。

## 分层

```
E:\AI\agent\kilo_config（SSOT）
├─ kilo.json            模型路由 / 权限 / 压缩 / MCP / 实验开关
├─ INSTRUCTIONS.md      会话级策略：认知中心 + 风险分级验证 + 硬约束
├─ agent/verify.md      异源复核子代理（edit=deny）
├─ plugin/              permission-guard（安全）/ compaction-anchor（长会话）/ moa（按需多模型）
├─ provider/hx-failover 模型故障降级链（可靠性核心）
└─ install.{sh,ps1,manifest}  幂等下发 + 漂移检测
        │ ./install.sh
        ▼
~/.config/kilo/  （Kilo 7.6.2 全局根，plugin/*.ts 自动加载）
```

## 模型路由（角色绑定 + 故障降级，无自动评分器）

| 场景 | 模型 |
|---|---|
| 默认执行 code / subagent_model | glm-5.3-flash |
| plan | kimi-k2.6 |
| general（深度子任务） | glm-5.2 |
| explore（省算力探索） | minimax-m3 |
| orchestrator | deepseek-v4.1-flash |
| verify（异源复核） | deepseek-v4.1-flash |
| 故障降级链 | glm-5.3-flash → kimi-k2.6 → deepseek-v4.1-flash → glm-5.2 |

`experimental`: task_model_selection（子代理自选模型）/ shared_agent_board（主子代理共享发现）/ batch_tool。

## 能力边界（回答"能不能"的依据）

- **Kilo 不会在模型故障时换模型**——降级由 provider 层实现（hx-failover）。
- **不存在**按复杂度自动选模型；近似手段 = 角色绑定 + 子代理自选 + 降级链。
- MoA 是**按需工具**（上限 3 参考 + 1 聚合），不是自动 fanout。
- Kilo 内置重试只对同一模型退避 5 次。

## 硬约束（每条实测踩过）

1. 权限规则**最后一条匹配者生效**（兜底 `*` 放最前）。
2. Kilo 不展开 `~`；占位符 `__KILO_HOME__`（家目录）/ `__KILO_CONFIG__`（部署目录）由 installer 替换为**原生正斜杠**路径。
3. `kilo.json` 拒绝自定义键（含 `"//"`）→ 整份失效。
4. `provider.npm` 必须三斜杠 `file:///C:/...`。
5. 本地 `plugin/*.ts` 自动加载，无需登记。
6. 内置 agent 名下放 `.md` 会整体覆盖其提示词。
7. **改配置后必须真跑任务验证**（`debug config` 通过 ≠ 能执行）。
8. MSYS 与原生路径不互认：写进配置的用 `C:/...`，shell 操作用 `/c/...`（`cygpath` 互转）。
9. 本机双 CLI：扩展内嵌 7.6.2（日用）vs 全局 npm 7.4.16（旧，读同份配置会报 Unrecognized keys——不是配置坏了）。

## 精简原则（为什么删了 knowledge-base 等）

只留**改变运行时行为**的资产。经验类知识固化为 `INSTRUCTIONS.md` 的策略条目（每会话注入，检索率 100%），
优于独立知识库（agent 需主动检索，实际命中率低）。被动诊断件（遥测）在没接告警时是纯负担。
