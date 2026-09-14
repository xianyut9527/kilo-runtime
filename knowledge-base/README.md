# 全局工程经验库（knowledge-base）

跨项目共享的「故障 → 根因 → 修复」经验库。**仓库是 SSOT**，installer 下发到 `~/.config/kilo/knowledge-base/`。

## 定位

| 层 | 承载物 | 归属 |
|----|--------|------|
| Session Memory | Kilo 会话 + compaction 锚点（plugin） | 运行时 |
| Project Memory | 各项目根 `AGENTS.md` | 各项目自维护 |
| **Global Engineering Memory** | 本目录 | **本仓库（跨项目共享）** |
| Skill Memory | `~/.agents/skills/` | 可复用流程用 skill 承载 |

## 使用方式（按需，不强制）

```bash
# 新增一条经验（写入部署副本 ~/.config/kilo/knowledge-base/）
node scripts/kb.mjs add --symptom "..." --root-cause "..." --fix "..." --tags a,b

# 检索
node scripts/kb.mjs search "关键词"
node scripts/kb.mjs list
```

> 检索是**按需**行为，不存在 `[KB_HIT]` 之类的机械门禁，也不做评分。

## 同步机制（三段，双向有门）

| 阶段 | 方向 | 机制 |
|------|------|------|
| 下发 | 仓库 → 全局 | `install.ps1` / `install.sh` 拷贝本目录 → `~/.config/kilo/knowledge-base/` |
| 采集 | 运行时 → 全局 | agent 按需 `kb.mjs add` 写入**部署副本**（不进各项目 repo） |
| 回收 | 全局 → 仓库 | `deploy-drift-check` 把全局新增判为「待回收」，人工 commit |

## 脱敏要求

入库前逐条自查：**不得包含** `sk-` 开头的 key、`api_key`、token、口令、内网 IP、真实客户数据。用占位符替代。
