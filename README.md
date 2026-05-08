# kilo_config

Kilo 全局配置维护仓库。通过全局配置 + 工作区继承，让所有项目自动共享同一套智能体、命令与规则。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md`、`./.kilo/instructions/workflow.md` 和 `./.kilo/learned/rules.md`，避免把长篇设计文档整份塞进每个 session。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **模型分层更清晰**：主模型改为 `hsyq/glm-5.1`，侧重高质量推理与中文指令跟随；轻量模型改为 `hsyq/doubao-seed-2.0-mini`，承担更便宜、更快的轻任务。
- **扩展入口内置**：默认启用 `context7` 远程 MCP 作为最新文档检索入口；预置 `github` MCP 配置，默认关闭，填入 `GITHUB_PAT` 后可启用。
- **子智能体 prompt 瘦身**：保留各 agent 的职责差异，移除大量重复的全局规则，减少 token 开销和指令冲突。

## 目录结构

```text
kilo_config/
├── kilo.json                     # 全局配置入口
├── AGENTS.md                     # 设计标准与长期参考文档
├── .kilo/
│   ├── instructions/
│   │   ├── core.md               # 运行时核心规则
│   │   └── workflow.md           # 运行时工作流规则
│   └── learned/
│       └── rules.md              # 自适应学习规则库
├── agent/                        # 智能体定义（全局可用）
│   ├── coderAgent.md
│   ├── architect.md
│   ├── engineer.md
│   ├── reviewer.md
│   ├── ensemble.md
│   ├── synthesizer.md
│   ├── checker.md
│   ├── fixer.md
│   ├── executor-dp.md
│   └── executor-mm.md
├── install.ps1
├── install.sh
└── README.md
```

## 这次优化解决了什么

- **编码效率**：之前 `AGENTS.md` 过长且大量规则与 agent prompt 重复，会增加上下文负担并拖慢决策；现在改为轻量注入，效率会明显更稳。
- **输出质量**：主模型切到更强的推理模型，子智能体职责更聚焦，减少互相打架的提示词。
- **减少冗余**：把“所有 agent 共享的规则”上收进运行时指令，把“每个 agent 独有的职责”留在各自 prompt 中。
- **扩展性**：预留 MCP 扩展入口，后续接入更多文档、GitHub、Sentry、Figma 等能力时，不需要重构主配置。

## 安装

### Windows

在 PowerShell 中运行：

```powershell
.\install.ps1
```

### macOS / Linux

在终端中运行：

```bash
chmod +x install.sh
./install.sh
```

安装脚本会将本仓库的内容复制到对应的全局配置目录：

- **Windows**：`C:\Users\<用户名>\.config\kilo\`
- **macOS / Linux**：`~/.config/kilo/`

## 使用

1. 修改 `kilo.json`、`.kilo/instructions/*` 或 `agent/*.md`。
2. 运行对应平台安装脚本同步到全局目录。
3. 重启 Kilo，让新配置生效。

## MCP 扩展

### Context7

默认启用，用于拉取最新官方文档与库文档：

```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    }
  }
}
```

### GitHub MCP

默认关闭。设置环境变量 `GITHUB_PAT` 后可打开，用于 issue、PR、仓库上下文等社区协作场景：

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "enabled": false,
      "headers": {
        "Authorization": "Bearer {env:GITHUB_PAT}"
      }
    }
  }
}
```

## 项目级覆盖（可选）

如果某个项目需要特殊覆盖，可在项目根创建 `kilo.json` 或 `.kilo/kilo.json`：

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "permission": {
    "edit": {
      "*.md": "allow",
      "*": "ask"
    }
  }
}
```

项目配置优先级高于全局配置，遵循深合并规则。

## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。
- `context7` 适合最新文档检索；`github` 适合仓库协作与社区上下文，不建议在无 PAT 时强开。
