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
6. 内置 agent 名下放 `.md` 会整体覆盖其提示词。内置清单只认 `kilo agent list`（实测：ask/code/compaction/debug/explore/general/orchestrator/plan/summary/title）；`kilo.json` schema 注解里的 `build`/`scout` 已过期，实测不存在。
7. **改配置后必须真跑任务验证**（`debug config` 通过 ≠ 能执行）。
8. MSYS 与原生路径不互认：写进配置的用 `C:/...`，shell 操作用 `/c/...`（`cygpath` 互转）。
9. 本机双 CLI：扩展内嵌 7.6.2（日用）vs 全局 npm 7.4.16（旧，读同份配置会报 Unrecognized keys——不是配置坏了）。

## 自我进化（原生记忆，2026-09-14 确认）

Kilo 7.6.2 内置**按项目根的本地记忆系统**，比自建 knowledge-base 正确：

- 物理位置：`~/.local/share/kilo/memory/<项目hash>/`（project.md / environment.md / corrections.md + 注入式索引 index.kmem + state.json）
- 激活条件：项目根存在记忆目录即激活（`state.json: enabled=true`）；**首次在项目里让 agent "记住xxx" 即创建**
- 工具：`kilo_memory_recall`（检索，会话自动注入摘要）+ `kilo_memory_save`（remember/correct/forget/skip）
- 权限：已在 kilo.json 放开为 allow（默认 ask 会锁死自主沉淀）
- 策略：INSTRUCTIONS.md「自我进化」节 —— 会话结束自省三类必沉淀场景（用户纠正 / 高成本发现的非显然事实 / 反复故障与修复）
- 实测：fed-cfba 项目记忆 5 条命中，路径知识准确复述；capture.turnClose=true 自动沉淀在工作

## 稳定性运维

- `db-maintain.sh`：kilo.db 体检/清理。实测体积构成（2026-09-14）：
  `event` 202 万行 / 3.78GB（事件溯源日志，全清）+ 30 天前 `message` 3.58GB + `part` 1.36GB ≈ 可回收 8.7GB，
  余下有效数据不到 1GB。**必须在 Kilo/VS Code 关闭时运行**（独占锁）。用法：`--status` 体检 / `--days N` 保留天数。
  保护项：`memory/`、`credential`、`project` 表不碰；`part` 靠 `message` 外键 CASCADE 级联删除（`PRAGMA foreign_keys=1` 已确认）。

## 下发器一致性（易踩）

- `install.sh` 与 `install.ps1` **必须同时替换两个占位符**。ps1 曾只替换 `__KILO_HOME__`，
  导致它渲染出 `file:///__KILO_CONFIG__/provider/hx-failover` —— 按提示跑 ps1 会让 provider 初始化失败、
  降级链整体失效。两版都加了「渲染后残留占位符即 FAIL」的硬校验。
- `build.mjs` 的入口/产物路径必须基于脚本自身位置（`import.meta.url`）解析；
  用相对路径时只有 cwd 正好是包目录才能构建成功。
