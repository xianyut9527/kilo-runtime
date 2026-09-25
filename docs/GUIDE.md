# 快速上手

**改配置**：编辑 `kilo.json.tmpl` → `.\install.ps1` → 重载 VS Code 窗口。
**换 API Key**：两种方式任选——① 改 `~/.local/share/kilo/auth.json` 的 `hx.key`（不用 install，即时生效）；② VS Code 里 Kilo 面板的模型选择器直接编辑自定义模型/更新 Key（会话内生效）。

## 架构

```
本仓库 ─install→ ~/.config/kilo/（运行时副本，别直接改；改了会被覆盖回仓库版）
```

kilo.json.tmpl    → kilo.json   全部配置：模型路由 / 网关 / 权限 / 开关
provider/hx-failover           模型网关客户端：流式、超时、故障自动降级、推理门控
plugin/                        quality-gate 质量门禁 · dual-review 双向审查 ·
                               moa 多模型分析 · permission-guard 危险命令拦截
INSTRUCTIONS.md                每会话注入的工程原则
```

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