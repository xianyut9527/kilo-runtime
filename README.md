# Kilo Runtime

<div align="center">

**简体中文** | [English](docs/GUIDE-EN.md) | [完整使用指南](docs/GUIDE.md)

</div>

Kilo Runtime 是 **Kilo 的全局配置与运行时增强包**，可用于 Kilo GUI 客户端、VS Code Kilo 扩展或 Kilo CLI。它不是独立应用，也不是新的模型；安装后仍在你原来的 Kilo 里描述任务，只是多了模型故障切换、交付质量检查、危险命令防护和记忆能力。

本仓库是配置的**唯一真源**：修改仓库文件，再运行安装脚本下发到 `~/.config/kilo/`。不要直接修改部署副本。

## 5 分钟上手

### 1. 准备环境

- Kilo GUI 客户端、VS Code + Kilo 扩展，或 Kilo CLI（任选其一）
- Windows：PowerShell 7+；macOS / Linux：bash
- Node.js 22+（安装冒烟检查、维护脚本和单模型工具使用；Bun 可选）
- 模型供应商：[OpenLlamas](https://openllamas.com)（准备其 API Key；这里默认使用 OpenLlamas，你也可以更换为自己的模型供应商与 API Key）

日常安装不需要执行 `npm install`；provider 的构建产物已随仓库提供。

### 2. 获取并安装

```powershell
git clone https://github.com/xianyut9527/kilo-runtime.git
Set-Location kilo-runtime
.\install.ps1 -DryRun   # 预览渲染结果和待写文件，不修改系统
.\install.ps1           # 正式下发；写盘前自动备份现有配置
```

macOS / Linux：

```bash
git clone https://github.com/xianyut9527/kilo-runtime.git
cd kilo-runtime
./install.sh --dry-run
./install.sh
```

默认安装到 `~/.config/kilo/`。已有个人配置会先备份，但安装会替换清单内的同名文件；有定制配置时，务必先看 Dry Run 输出。

### 3. 配置 OpenLlamas API Key

模型请求通过 **OpenLlamas** 网关转发。先在 [OpenLlamas 官网](https://openllamas.com) 获取 API Key，再编辑 `~/.local/share/kilo/auth.json`，合并以下内容（不要覆盖文件里已有的其他凭证）：

```json
{
  "openllamas": {
    "key": "你的 API Key"
  }
}
```

API Key 不进入仓库。修改 Key 不需要重新 install；共享分析客户端的配置缓存最长 60 秒，若运行中的 Kilo 仍使用旧凭证，重载或重启 Kilo 后再试。

使用自己的模型供应商时，在 `auth.json` 中配置你的 Key，并将 `kilo.json.tmpl` 中的 `baseURL` 改为你的网关地址后重新 install。

### 4. 跑通第一个任务

1. 重载或重启 Kilo；VS Code 用户可执行 `Developer: Reload Window`。
2. 在 GUI 客户端、VS Code 扩展或 CLI 中打开一个项目，新建 Kilo 会话，确认使用 `code` agent 和 `openllamas` 下的模型。
3. 先发送一个只读任务：

   > 阅读当前项目结构，告诉我如何安装依赖和运行测试；不要修改文件。

能正常读取项目并连续回答，就说明主链路已经跑通。之后直接描述真实任务即可，例如：

> 修复当前测试失败，修改后运行相关测试，并说明改了什么。

你不需要手动调用插件。遇到权限提示时按需确认；涉及代码交付时，质量门禁会要求真实验证，复杂或高风险改动会自动进入多模型审查。

## 日常使用

| 想做什么 | 怎么做 |
|---------|--------|
| 日常写代码、跑命令 | 新建会话，默认使用 `code` |
| 先讨论方案、不改文件 | 切换到 `plan`，确认方案后再回 `code` 执行 |
| 查看任务质量检查 | 正常提交任务即可；`quality-gate` 自动工作，无需单独启动 |
| 换主模型或角色模型 | 修改 `kilo.json.tmpl`，Dry Run 后重新 install |
| 换 API Key | 修改运行时 `auth.json` 的 `openllamas.key`，不重新 install |
| 复盘并沉淀经验 | 在 Kilo 中运行 `/evolve` |
| 单独测试一个模型 | 模式选择器选「单模型测试」（single）+ 模型选择器选定模型即可；严格隔离用[命令行锁定](docs/GUIDE.md#52-命令行锁定严格隔离) |

## 安装后多了什么

| 能力 | 对使用者的意义 |
|------|----------------|
| 模型路由与故障切换 | 不同岗位使用不同模型；当前模型故障时按配置尝试备用模型 |
| 流式与空响应保护 | 处理流中断、推理耗尽输出预算、工具参数截断等异常 |
| 三层交付检查 | 防止“声称做了但没做”、代码改完未验证，以及复杂改动漏审 |
| 双向异源审查 | 正向查遗漏、反向找错，再由裁决席给出终审结论 |
| 危险命令防护 | 在静态权限之外拦截破坏磁盘、覆盖凭证等高风险操作 |
| 记忆与经验复用 | 项目记忆自动启用，跨项目通用经验可检索、复盘和沉淀 |

具体模型名、降级顺序和审查席位**只看 `kilo.json.tmpl`**，文档不复制这些会频繁变化的绑定。

## 修改配置

```powershell
# 在仓库根目录
.\install.ps1 -DryRun
.\install.ps1
.\install.ps1 -Check    # 之后可随时检查仓库与部署副本是否漂移
```

macOS / Linux 对应为 `./install.sh --dry-run`、`./install.sh`、`./install.sh --check`。

| 要改什么 | 修改位置 |
|---------|----------|
| 默认主模型 | 模板顶部 `model` |
| 各 agent 的模型与推理档位 | `agent.<name>.model / variant` |
| 网关地址 | `provider.openllamas.options.baseURL` |
| 备用模型顺序 | `provider.openllamas.options.failover.chain.models` |
| 多模型分析 / 审查席位 | `provider.openllamas.options.moa / dual_review` |
| 新模型及其上下文、输出上限 | `provider.openllamas.models` |

注意：`failover.chain.models` 是当前模型之后的**后备列表**，provider 会把当前模型放在链首并去重，所以实际跳数随 agent 不同而变化。修改插件或 provider 后必须重载 VS Code 窗口；模型路由调整后建议新建会话核对实际生效模型。

## 架构与目录

```text
仓库中的模板、插件和 provider
            │ install.ps1 / install.sh
            ▼
   ~/.config/kilo/（Kilo 实际读取）
            │
            ▼
Kilo GUI / VS Code 扩展 / CLI ──▶ OpenLlamas 网关 ──▶ 模型

会话、记忆和 API Key 则保存在 ~/.local/share/kilo/，不由安装脚本覆盖。
```

- `kilo.json.tmpl`：模型、权限、网关和行为开关的唯一配置真源
- `plugin/`：质量门禁、审查、权限和记忆等运行时增强
- `provider/hx-failover/`：模型请求、流式保护与故障切换
- `lib/`：多模型分析和审查共用的请求层
- `agent/`、`command/`、`INSTRUCTIONS.md`：自定义 agent、全局命令与每会话工程原则
- `scripts/`：记忆、维护和单模型测试工具

## 遇到问题先看这里

- **模型选择器为空或 provider 初始化失败**：确认安装命令成功，再重载窗口；不要直接改部署副本。
- **返回 401**：检查 `auth.json` 的 `openllamas.key` 与模板中的 `baseURL` 是否属于同一套网关。
- **配置改了但没生效**：先运行 `-Check` / `--check`，再重载窗口并新建会话；VS Code 模型选择器保存的选择也可能覆盖 `agent.*` 路由。
- **需要排查故障切换**：查看 `~/.local/share/kilo/failover-events.jsonl`，其中不记录对话正文。
- **准备修改 provider**：先读完整指南的开发章节；仅执行 `npm run build` 的位置不对会构建失败。

## 继续阅读

- [完整使用指南](docs/GUIDE.md)：详细安装、任务流程、单模型测试、配置与故障排查
- [English Guide](docs/GUIDE-EN.md)
- [维护者文档与架构历史](docs/HISTORY.md)：资产清单、性能基线、维护、隐私边界和验收命令
