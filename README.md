# kilo_config

Kilo 全局配置骨架仓库。它负责通用 agent 编排、默认模型路由和运行时规则；真正决定上下文理解精度的知识，应该放在每个项目自己的 `AGENTS.md` 和 `.kilo/skills/` 中。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md`、`workflow.md`、`reflection.md`，避免把长篇设计文档整份塞进每个 session。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **高精度默认路由**：模型选择只在 `kilo.json` 中维护；运行规则按角色和任务复杂度路由，不硬编码具体模型名。
- **扩展入口内置**：默认启用 `context7` 远程 MCP 作为最新文档检索入口；启用 `gitnexus` 辅助调用链/影响面分析；启用 `playwright` 辅助浏览器端验证。
- **子智能体 prompt 瘦身**：保留各 agent 的职责差异，移除大量重复的全局规则，减少 token 开销和指令冲突。
- **项目知识项目化**：项目知识不放在本仓库，而是下沉到真实项目根目录中的 `AGENTS.md` 和 `.kilo/skills/`。
- **持续改进基于验证闭环**：质量提升依赖测试、构建、类型检查、review 审查与多模型升级，不依赖自动改写规则文件。

## 目录结构

```text
kilo_config/
├── kilo.json                     # 全局配置入口
├── AGENTS.md                     # 全局骨架设计与长期参考文档
├── CONFIG_CHANGE_CHECKLIST.md    # 配置变更一致性检查清单
├── .kilo/
│   ├── instructions/
│   │   ├── core.md               # 运行时核心规则
│   │   ├── workflow.md           # 运行时工作流规则
│   │   ├── reflection.md         # 反思与错误恢复规则
│   │   └── skills-lifecycle.md   # Skills 生命周期管理规则
│   └── skills/                   # 长期知识库（按项目实例化）
│       ├── architecture/
│       ├── patterns/
│       ├── anti-patterns/
│       ├── contracts/
│       └── testing/
├── agent/                        # 智能体定义（全局可用）
│   ├── coderAgent.md
│   ├── architect.md
│   ├── engineer.md
│   ├── reviewer.md               # 主审查者，按需路由专审
│   ├── review-security.md        # 安全专审
│   ├── review-architecture.md    # 架构专审
│   ├── review-simplification.md  # 简化专审
│   ├── skills-writer.md          # 经验写入，维护长期知识库
│   ├── ensemble.md
│   ├── synthesizer.md
│   ├── checker.md
│   ├── pre-checker.md
│   ├── fixer.md
│   ├── executor-A.md
│   ├── executor-B.md
│   └── executor-C.md
├── install.ps1
├── install.sh
└── README.md
```

## 设计收益

- **规则更集中**：共享流程放在 `.kilo/instructions/`，agent 只保留职责差异。
- **执行更聚焦**：默认单模型闭环，复杂或失败场景再升级多模型并行。
- **单元化闭环**：中等及以上任务先拆为任务 DAG，architect 后经 pre-checker 校验方向；小单元独立执行 engineer/checker/fixer/checker 循环，无冲突单元可并行，最后再做整体 checker/reviewer 门禁。
- **验证-修复循环放大**：pre-checker 在 engineer 前拦截方向错误，fixer 只修复明确阻塞问题；checker 分层执行（L1 格式/L2 逻辑/L3 安全），系统化验证-修复-再验证循环提升输出质量。
- **遗漏更可控**：跨模块、互斥、唯一性等需求先做需求扩散和同类点扫描。
- **维护更轻**：模型、MCP、权限由 `kilo.json` 管；项目知识放回真实项目。

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
- 安装脚本将本仓库内容同步到全局配置目录，不再创建 `agents/` 兼容副本。

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

本配置默认启用以下 MCP 服务器（详见 `kilo.json` 中的 `mcp` 节）：

- **Context7** (`context7`): 远程文档检索，用于拉取最新官方文档与库文档
- **GitNexus** (`gitnexus`): 本地调用链与影响面分析
- **Playwright** (`playwright`): 浏览器端验证、截图和交互检查

> 注意：MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。

## 项目级覆盖

如果某个项目需要特殊覆盖，可在项目根创建 `kilo.json`：

```json
{
  "model": "provider/model-name",
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
- `context7` 适合最新文档检索；`gitnexus` 适合调用链和影响面分析；`playwright` 适合浏览器端验证。
- 大型系统优先建设项目级 context pack；全局配置只做骨架和兜底，不承担具体项目知识。