# 快速上手

> Kilo（AI 编程助手）的全局配置仓库。要改配置：**改仓库 → install 下发 → 重载 VS Code 窗口**。三句话用完全程。

## 架构

```
本仓库（唯一真源）──install──▶ ~/.config/kilo/（运行时读取的部署副本）

kilo.json.tmpl ──▶ kilo.json      一切配置：模型路由 / API 网关 / 权限 / 开关
provider/hx-failover ──▶          模型网关客户端：流式、超时、故障自动降级、推理门控
plugin/ ──▶                       质量门禁（quality-gate）、双向审查（dual-review）、
                                  多模型分析（moa）、危险命令拦截（permission-guard）等
INSTRUCTIONS.md ──▶               每会话注入的工程原则
```

改模型只动 `kilo.json.tmpl`（插件/provider 代码零内置默认）；API Key 只存 `~/.local/share/kilo/auth.json` 的 `hx.key` 字段（凭证零入库）。

## 安装

```powershell
.\install.ps1 -DryRun   # 预览（校验模板渲染 + JSON 合法性，不写盘）
.\install.ps1           # 下发（自动备份，幂等）
# 然后重载 VS Code 窗口（Ctrl+Shift+P → Reload Window）
```

macOS / Linux：`./install.sh --dry-run` → `./install.sh`，同样重载。

## 改模型 / API 配置

都在 `kilo.json.tmpl` 一个文件里：

| 要改什么 | 位置 |
|---------|------|
| 主模型 | 顶部 `"model": "hx/glm-5.3-flash"` |
| 各角色模型 | `agent.code / agent.plan / agent.explore...` 的 `model` |
| 网关地址 | `provider.hx.options.baseURL` |
| API Key | `~/.local/share/kilo/auth.json` 的 `hx.key`（改这个不用 install） |
| 降级链 | `provider.hx.options.failover.chain.models` |
| 审查模型 | `provider.hx.options.moa` / `dual_review` |

⚠️ 新模型要在 `provider.hx.models` 注册表登记（能力/上下文/输出上限），降级链与审查模型引用的名字必须已登记。

固定流程：

```powershell
# 1. 编辑 kilo.json.tmpl（注释只写「行首 //」整行）
# 2. 校验 + 下发
.\install.ps1 -DryRun
.\install.ps1
# 3. 重载 VS Code 窗口
```

## 日常

| 场景 | 操作 |
|------|------|
| 拉了新代码/改了配置 | `install.ps1` 下发 → 重载窗口 |
| 配置漂移体检 | `.\install.ps1 -Check` |
| 换 API Key | 改 `auth.json` 的 `hx.key` |
| 磁盘维护 | `.\scripts\kilo-maintenance.ps1 -Status` |
| 复盘沉淀经验 | 会话里输入 `/evolve` |
| 改了 provider/src | `npm run build` + 跑两个 test-*.mjs，再 install |

## 别踩的坑

- 直接改 `~/.config/kilo/kilo.json` → 下次 install 被覆盖，白改
- 模板写行尾注释或 `/* */` → 部署产物变非法 JSON
- kilo.json 加自定义键（含 `"//"` 键）→ 整份配置失效
- `debug config` 通过 ≠ 能跑任务 → 必须真跑一次 `kilo run` 冒烟

---

进阶与历史细节见 [README.md](../README.md)。