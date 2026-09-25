# 快速上手

<div align="center">

**简体中文** | [English](GUIDE-EN.md)

</div>

**改配置**：编辑 `kilo.json.tmpl` → `.\install.ps1` → 重载 VS Code 窗口。
**换 API Key**：改 `~/.local/share/kilo/auth.json` 的 `hx.key`（不用 install，即时生效）。

## 架构

```
                    ┌─────────────────────────────────────────────┐
                    │            VS Code + Kilo 扩展              │
                    └────────────────────┬────────────────────────┘
                                         │ 读取
                                         ▼
本仓库（唯一真源） ─install.ps1/sh→ ~/.config/kilo/（运行时副本，别直接改）
│                                          │
├─ kilo.json.tmpl ──渲染──▶ kilo.json      │← 全部配置：模型路由 / 网关 / 权限 / 开关
├─ provider/hx-failover                    │← 模型网关客户端：流式、超时、故障自动降级、
│   src/ → build → dist/                   │   推理门控（thinking 模型救活）
├─ plugin/（随进程自动加载，改后需重载窗口） │
│   ├─ quality-gate                        │← 三层交付质量门禁：防"声称完成但没做"
│   ├─ dual-review                         │← 双向异源审查：正向查遗漏 × 反向红队 + 裁决
│   ├─ moa                                 │← 多模型交叉分析（高风险决策）
│   ├─ permission-guard                    │← 动态拦截危险命令与密钥路径
│   ├─ compaction-anchor                   │← 长会话压缩后保留任务锚点
│   └─ memory-bootstrap                    │← git 项目自动启用原生记忆
├─ INSTRUCTIONS.md                         │← 每会话注入的工程原则
└─ command/evolve.md 等                    │← 全局命令（/evolve 复盘进化）
                                           │
                              ~/.local/share/kilo/（数据目录：会话库 / 记忆 / 凭证 auth.json）
```

数据流：Kilo 会话 → provider（网关客户端）→ 上游模型网关（OpenAI 兼容 API）；
主模型故障时按 `failover.chain.models` 依次自动降级；交付节点由 quality-gate 按
风险触发 dual-review 自动审查。

## 改模型（都在 kilo.json.tmpl）

| 要改什么 | 位置 |
|---------|------|
| 主模型 | 顶部 `"model": "hx/glm-5.3-flash"` |
| 角色模型 | `agent.code / agent.plan / ...` 的 `model` |
| 网关地址 | `provider.hx.options.baseURL` |
| 降级链 / 审查模型 | `provider.hx.options.failover / moa / dual_review` |

新模型需在 `provider.hx.models` 登记后才能被引用。

## 常用命令

```powershell
.\install.ps1 -DryRun   # 改完模板先校验（不写盘）
.\install.ps1           # 下发（自动备份）
.\install.ps1 -Check    # 漂移体检
```

改 provider/hx-failover/src 后：`npm run build` → 跑 `test-failover.mjs` / `test-reasoning-gate.mjs` → install → 重载。

## 坑

- 直接改 `~/.config/kilo/kilo.json` 会被 install 覆盖，白改
- 模板注释只写「行首 `//`」；kilo.json 加自定义键整份失效
- `debug config` 通过 ≠ 能跑任务，改完必须真跑一次 `kilo run`

---

维护者进阶见 [docs/HISTORY.md](HISTORY.md)