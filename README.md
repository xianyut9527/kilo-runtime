# kilo_config

Kilo 全局配置骨架仓库。它负责通用 agent 编排、默认模型路由和运行时规则；真正决定上下文理解精度的知识，应该放在每个项目自己的 `AGENTS.md` 和 `.kilo/skills/` 中。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md` 和 `./.kilo/instructions/workflow.md`，避免把长篇设计文档整份塞进每个 session。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **高精度默认路由**：主模型使用 `deepseek/deepseek-v4-pro`，优先保证复杂任务的理解和推理质量；轻量模型使用 `minimax-cn-coding-plan/MiniMax-M2.7-highspeed`，承担更快的轻任务和低成本探索。
- **扩展入口内置**：默认启用 `context7` 远程 MCP 作为最新文档检索入口；预置 `github` MCP 配置，默认关闭，填入 `GITHUB_PAT` 后可启用。
- **子智能体 prompt 瘦身**：保留各 agent 的职责差异，移除大量重复的全局规则，减少 token 开销和指令冲突。
- **项目知识项目化**：项目知识不放在本仓库，而是下沉到真实项目根目录中的 `AGENTS.md` 和 `.kilo/skills/`。
- **持续改进基于验证闭环**：质量提升依赖测试、构建、类型检查、review 审查与多模型升级，不依赖自动改写规则文件。

## 目录结构

```text
kilo_config/
├── kilo.json                     # 全局配置入口
├── AGENTS.md                     # 全局骨架设计与长期参考文档
├── .kilo/
│   ├── instructions/
│   │   ├── core.md               # 运行时核心规则
│   │   └── workflow.md           # 运行时工作流规则
├── agent/                        # 智能体定义（全局可用）
│   ├── coderAgent.md
│   ├── architect.md
│   ├── engineer.md
│   ├── reviewer.md                # 包含主审查 + security/architecture/simplification 专审
│   ├── ensemble.md
│   ├── synthesizer.md
│   ├── checker.md
│   ├── fixer.md
│   ├── executor-A.md
│   ├── executor-B.md
│   └── executor-C.md

├── install.ps1
├── install.sh
└── README.md
```

## 这次优化解决了什么

- **编码效率**：之前 `AGENTS.md` 过长且大量规则与 agent prompt 重复，会增加上下文负担并拖慢决策；现在改为轻量注入，效率会明显更稳。
- **输出质量**：主模型切到更强的推理模型，子智能体职责更聚焦，减少互相打架的提示词。
- **减少冗余**：把“所有 agent 共享的规则”上收进运行时指令，把“每个 agent 独有的职责”留在各自 prompt 中。
- **扩展性**：预留 MCP 扩展入口，后续接入更多文档、GitHub、Sentry、Figma 等能力时，不需要重构主配置。
- **复杂任务质量更高**：`ensemble` 默认采用双执行器并行候选，在高风险、失败历史或深度检查场景下再加入第 3 个执行器；随后通过 `checker + reviewer lead` 双门禁、按需专审与必要时 `synthesizer / fixer` 兜底。
- **审查更聚焦**：`reviewer` 已升级为主审查者，可按风险动态调度安全、架构、简化专审，减少单一 reviewer 的盲区。
- **修复闭环更实用**：`fixer` 默认 1 轮修复，满足收敛条件时允许第 2 轮，兼顾质量上限与停止边界。
- **上下文更可持续**：全局层不再承担项目知识记忆，未来大型系统应在项目根目录建立自己的 context pack。

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

### 维护全局骨架

1. 修改 `kilo.json`、`.kilo/instructions/*` 或 `agent/*.md`。
2. 运行对应平台安装脚本同步到全局目录。
3. 重启 Kilo，让新配置生效。

### 给真实项目接入项目级 context pack

1. 在项目根目录创建项目级 `AGENTS.md` 和 `.kilo/skills/`。
2. 只写该项目独有的架构、边界、契约、验证命令和高频工作流。
3. 让项目级知识覆盖全局默认行为，不要再把项目知识写回本仓库。
4. 具体写法参考本仓库中的 `AGENTS.md`，其已包含项目级 context pack 接入指南。

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

## 项目级覆盖

如果某个项目需要特殊覆盖，可在项目根创建 `kilo.json`：

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

项目配置优先级高于全局配置，遵循深合并规则。高精度理解通常来自项目级 `AGENTS.md` 和 skills，而不是单纯覆盖模型。

## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。
- `context7` 适合最新文档检索；`github` 适合仓库协作与社区上下文，不建议在无 PAT 时强开。
- 大型系统优先建设项目级 context pack；全局配置只做骨架和兜底，不承担具体项目知识。
