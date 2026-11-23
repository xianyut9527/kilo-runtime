---
description: "单模型硬隔离：把整套配置收敛到单一模型（清 failover 链 / moa 参考席 / dual_review 席位），或恢复原配置"
agent: code
---

# /single-strict — 单模型硬隔离开关

用途：UI 的 `single` 模式只做到「提示 + 结果按混模型标注」，**failover 仍会静默换模型**。
原因是本机 Kilo 7.8.32 没有 `chat.params` / `chat.message` 钩子，provider 侧拿不到会话身份，
无法按会话开关降级链（见 `docs/HISTORY.md` 与 `kilo.json.tmpl` 的 `agent.single` 注释）。
需要**真正的硬隔离**时用本命令。

## enter（进入严格档）

1. 取目标模型：用户指定则以其为准，否则读 `kilo.json` 的 `model` 当前值。
2. 先干跑看计划：`node scripts/single-model.mjs enter --model <id> --dry-run`
3. 计划符合预期再去掉 `--dry-run` 执行；变体档位需要时加 `--variant <v>`。
4. 结束后必须提醒用户：**重载 VS Code 窗口**才生效（插件/配置不热加载）。

## restore（恢复原配置）

1. 查现状：`node scripts/single-model.mjs --status`（LOCKED / INCONSISTENT / CLEAN）。
2. 恢复：`node scripts/single-model.mjs restore`；enter 之后手改过配置时需 `--force` 并说明后果。
3. 同样提醒重载窗口。

## 纪律

- 严格档会清空 failover 链与多模型席位的路由，**上游故障时直接报错不降级**——这是硬隔离的代价，不要中途手动改回。
- enter 会备份当前部署配置；状态文件未清除前不要重复 enter。
- 单模型测试完成后回 `restore`，长期停留在严格档会让所有模式都失去容错。
