---
description: "复盘进化：从近期会话蒸馏经验入库，修正过期记忆，反哺 SSOT 配置"
agent: code
---

# /evolve — 复盘进化回路

目标：把「踩过的坑、被纠正的做法、花钱买到的环境事实」沉淀为可复用资产，并让配置体系随使用变强。
执行原则：只蒸馏**下次还用得上**的经验；过程性细节不入库。全程只读仓库，改动需用户确认。

## 步骤

1. **取材**：`kilo_local_recall`（mode=search）检索本项目近期会话，关键词建议：
   `报错/失败/修复/correction/不对/重新/rollback/慢/超时`。限定近 1-2 天的高信号会话，别全量扫。
2. **遥测**（可选，本机配置项目才做）：读 `~/.local/share/kilo/failover-events.jsonl` 统计
   各模型 retry/fallback 频次与时间分布；热点模型考虑调整 `hx.failover.chain` 次序。
3. **蒸馏入库**（`kilo_memory_save`）：
   - 用户纠正过的做法 → action=`correct`（会写 corrections.md，优先级最高）；
   - 非显然事实（构建命令、隐藏依赖、路径约定、环境怪癖）→ action=`remember`，key 用短横线小写英文；
   - 发现已入库内容过期/错误 → action=`forget` 后重存，不要留双份。
4. **反哺 SSOT**（仅当本项目是 Kilo Runtime 配置仓库——判断链：`git remote -v` 含 kilo-runtime/kilo_config → 是；无 remote 时按目录名兜底 kilo-runtime/kilo_config；两者都不匹配 → 不是，跳过本步）：跨项目通用的教训才升级为配置——
   INSTRUCTIONS.md（行为策略）/ kilo.json.tmpl（权限、路由）/ plugin（自动化）。
   先展示拟改动 diff，经用户确认后改仓库并跑 `./install.ps1` 部署验证。单项经验不够通用就留在项目记忆层。
5. **修剪全局经验层**：整理 `~/.config/kilo/GLOBAL-NOTES.md`——去重合并、删除过时/低价值条目、
   总量压回 ~1KB；连续两个复盘周期仍然有效且高度通用的条目，提议升格进 INSTRUCTIONS.md（需确认）。
6. **报告**：入库条数（remember/correct/forget 分列）+ GLOBAL-NOTES 修剪明细 + SSOT 拟改动清单（或"无需升级"）。

## 边界

- 不自动 commit/push；SSOT 改动必须先经确认。
- 记忆条目保持一行一条、带稳定 key；同 key 重复写入会更新而非堆积。
