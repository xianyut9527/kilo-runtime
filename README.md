# kilo_config

Kilo 全局配置维护仓库。通过全局配置 + 工作区继承，让所有项目自动共享同一套智能体、命令与规则。

## 目录结构

```
kilo_config/
├── kilo.json              # 全局配置入口（模型、默认智能体、指令文件等）
├── AGENTS.md              # 通用 AI 代理配置标准（全局规则）
├── agent/                 # 智能体定义（全局可用）
│   ├── coderAgent.md      # 编排者
│   ├── architect.md       # 规划者
│   ├── engineer.md        # 实现者
│   ├── reviewer.md        # 审查者
│   ├── ensemble.md        # 多模型并行编排主控
│   ├── synthesizer.md     # 合并智能体
│   ├── checker.md         # 审查智能体
│   ├── fixer.md           # 修复智能体
│   ├── executor-dp.md     # 执行智能体 A（DeepSeek）
│   └── executor-mm.md     # 执行智能体 B（MiniMax）
├── command/               # 自定义命令（全局可用）
│   （空目录，ensemble 通过 agent 直接调用，无需 command 入口）
├── install.ps1            # Windows 安装脚本
├── install.sh             # macOS/Linux 安装脚本
└── README.md
```

## 核心思路

- **全局配置独立仓库**：所有通用配置集中在此仓库，与任何业务项目解耦。
- **跨项目自动生效**：安装到全局目录后，所有项目默认继承，无需在每个项目重复放置。
- **项目零污染**：业务项目根只需极少量覆盖（可选），不存大块配置。
- **修改即生效**：更新此仓库后重新运行安装脚本，重启 Kilo 即全局生效。

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

1. **修改配置**：直接在本仓库编辑智能体、命令或 `kilo.json`。
2. **同步到全局**：运行对应平台的安装脚本。
3. **重启 Kilo**：在任意项目中重启 Kilo，新配置自动生效。

## 项目级覆盖（可选）

如果某个项目需要特殊覆盖，可在项目根创建 `.kilo/kilo.json`：

```json
{
  "model": "anthropic/claude-sonnet",
  "exclude": ["**/tmp/**"]
}
```

项目配置优先级高于全局配置，遵循深合并规则。

## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- 全局配置中 `AGENTS.md` 作为 `instructions` 被加载，所有项目都会继承其中的约束。
- 如需禁用全局配置，可设置环境变量 `KILO_DISABLE_PROJECT_CONFIG`（不推荐，除非调试）。
