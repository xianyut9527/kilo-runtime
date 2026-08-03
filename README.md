# kilo_config

Kilo 全局配置骨架仓库。负责通用 agent 编排、默认模型路由和运行时规则；项目级知识应下沉到各项目自己的 `AGENTS.md` 和 `.kilo/skills/`。

> **仓库定位**：本仓库是 Kilo 的**全局通用配置唯一源**，通过 `install.ps1`/`install.sh` 全量部署到 `~/.config/kilo/`。仓库内的 `.kilo/instructions/` 是全局通用规则的工作区，`.kilo/skills/` 不随仓库分发（运行时从项目级与社区源 `${HOME}/.agents/skills` 发现，见 `kilo.json` `skills.paths`），**不是项目级特化配置**——所有项目共享同一份全局配置，项目级特化应放在各项目根目录的 `AGENTS.md` 和 `.kilo/` 中。修改仓库内任何配置后必须重跑 install 同步到全局，否则全局版会落后。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md`、`workflow-core.md`、`reflection.md`，避免把长篇设计文档整份塞进每个 session。`workflow-reference.md` / `skills-lifecycle.md` 不在自动注入列表中，作为按需引用的参考文档，由 conductor 在需要时主动读取。`security-checklist.md` 作为 verifier 在 L3 安全/性能阶段调用的检查清单，`output-schema.md` 作为统一交付输出规范，二者按智能体按需加载，不作为通用上下文全量注入。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **默认路由**：模型选择只在 `kilo.json` 中维护；运行规则按角色和任务复杂度路由，不硬编码具体模型名。
- **扩展入口内置**：默认仅启用 `context7` 远程文档检索；`gitnexus`（调用链/影响面分析）与 `playwright`（浏览器端验证）按需手动开启。
- **职责分层**：通用规则集中在 `.kilo/instructions/`；`agent/*.md` 作为人工维护参考与职责差异记录；`kilo.json` 中的 `agent.*.prompt` 提供运行时行为锚点（极简、稳定、不堆积通用规则）。三层各司其职，避免重复维护。
- **项目知识隔离**：项目特化知识不放在本仓库，而是下沉到真实项目根目录的 `AGENTS.md` 和 `.kilo/skills/`。
- **质量改进依赖项目反馈**：质量提升依赖具体项目的测试、review 审查与反馈，不依赖自动改写规则文件。

## 模型路由原则

模型选择按 agent 职责的能力维度匹配，**不硬编码具体模型名**。具体模型名和 provider 配置集中在 `kilo.json` 的 `agent.*.model` 和 `provider` 字段，作为模型配置的唯一事实来源。

**选择原则**：
1. 编排/实现优先稳定性（长上下文主控模型族，temperature 0）。
2. 规划/合并保留适度发散（推理深度模型族，temperature 0.1-0.2）。
3. 审查/对抗低发散（严谨判断模型族，temperature 0-0.1）。
4. `small_model` 是可选降级路由入口，适用场景见 `.kilo/instructions/workflow-reference.md`「small_model 触发规则」。

## 目录结构

```text
.
├── kilo.json                     # 全局配置入口（Kilo 侧）
├── AGENTS.md                     # 全局骨架设计与长期参考文档
├── CONFIG_CHANGE_CHECKLIST.md    # 配置变更一致性检查清单
├── .kilo/                        # Kilo 配置（保留为编排规则 + 项目知识层）
│   ├── instructions/
│   │   ├── core.md                # 运行时核心规则
│   │   ├── workflow-core.md       # 运行时工作流规则（自动注入）
│   │   ├── workflow-reference.md  # 工作流参考内容（按需读取，不自动注入）
│   │   ├── reflection.md          # 反思与错误恢复规则
│   │   ├── security-checklist.md  # 安全/性能检查清单（由 verifier 在 L3 调用）
│   │   ├── output-schema.md       # 统一交付输出规范（供下游 agent 解析）
│   │   ├── evolution.md           # 自进化闭环（执行→反思→提炼→固化写入规则）
│   │   ├── skill-upgrade.md       # Skill 升级提案生成（由维护者根据实际运行反馈人工评估后触发）
│   │   ├── skill-usage-tracking.md # skill 使用记录协议（已简化，不再独立追踪）
│   │   └── skills-lifecycle.md    # Skills 生命周期管理规则（按需引用，不自动注入）
│   ├── skills/                   # skill 能力扩展位（运行时由 Kilo 从项目级与社区源发现，仓库不预置源文件；见 kilo.json skills.paths）
├── agent/                        # Kilo 智能体定义（v6 单源：一智能体一文件，frontmatter 自注册生命周期路由）
│   ├── conductor.md           # 工作流编排者（type: primary，内建执行 INIT/DELIVERING）
│   ├── planner.md                # 规划智能体（mount: PLANNING；设计门、DAG、验收点）
│   ├── coder.md                  # 编码智能体（mount: EXECUTING；实现、自测、三件套）
│   ├── verifier.md               # 正向验证（mount: QUALITY hook:verify；L1/L2/L3、5 元组证据）
│   ├── reviewer.md               # 静态审查（mount: QUALITY hook:review；安全编码模式/架构/简化/SCOPE_CREEP 四视角）
│   ├── fixer.md                  # 修复智能体（mount: QUALITY hook:fix, auto-trigger；定向修复阻塞问题）
│   └── (新增智能体 = 丢一个 <name>.md + kilo.json 绑模型，零改框架)
├── lifecycle/                    # 生命周期（5 阶段：INIT→PLANNING→EXECUTING→QUALITY→DELIVERING）
│   ├── graph.yaml                # 主 DAG 单一真相来源（节点 INIT/PLANNING/.../DONE + 边 + 流转条件）
│   ├── config.yaml               # 定级默认智能体组合 tier_defaults + 用户覆盖 overrides + hooks 熔断阈值（唯一真相）
│   ├── stages/                   # 阶段执行逻辑（语义命名，文件名派生节点 ID，插入中间阶段无占号问题）
│   │   ├── README.md             # 阶段索引 + 扩展指南（插拔式注册）
│   │   ├── init.md               # INIT 意图判定+定级 [conductor 内建]
│   │   ├── planning.md           # PLANNING 设计门 [planner]
│   │   ├── executing.md          # EXECUTING 实现 [coder]
│   │   ├── quality.md            # QUALITY 检查修复循环 [verifier → fixer → reviewer，FAIL 自动修复再检查，直到全 PASS]
│   │   └── delivering.md         # DELIVERING 交付 [conductor 内建]
├── docs/                           # 参考文档
│   ├── ARCHITECTURE.md              # 架构全景导航（v2.1 综合速查手册）
│   ├── agent-mount-guide.md        # 智能体挂载注册指南（frontmatter mount 字段）
│   ├── conductor-full-spec.md      # conductor 完整设计规范（运行时精简版的完整版）
│   ├── configuration-guide.md      # 配置指南（快速上手：新增智能体/阶段/模型/定级调整）
│   ├── multi-agent-lifecycle-architecture.md  # 多智能体协作生命周期架构（设计门产物）
│   └── model-registry.md          # 模型能力倾向矩阵人类可读版（v6.1 唯一能力参考，无机器可读副本）
├── install.ps1                   # Kilo 配置安装脚本（Windows）
├── install.sh                    # Kilo 配置安装脚本（macOS/Linux）
└── README.md
```

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

> ⚠️ **重要**：修改 `kilo.json`、`.kilo/instructions/*` 或 `agent/*.md` 后，**必须**运行对应平台安装脚本（`./install.ps1` 或 `./install.sh`）将变更同步到全局配置目录 `~/.config/kilo/`，然后**重启 Kilo**。否则其他项目仍会加载旧版全局配置，导致编排规则执行不一致。

1. 修改 `kilo.json`、`.kilo/instructions/*` 或 `agent/*.md`。
2. 运行对应平台安装脚本同步到全局目录。
3. 重启 Kilo，让新配置生效。

验证同步是否成功（PowerShell）：

```powershell
Test-Path "$env:USERPROFILE\.config\kilo\kilo.json"
```

验证同步是否成功（macOS / Linux）：

```bash
test -f ~/.config/kilo/kilo.json && echo "OK"
```

对比仓库与全局配置差异（Windows）：

```powershell
robocopy . "$env:USERPROFILE\.config\kilo" /E /XJ /XD .git node_modules /XF install.ps1 install.sh README.md LICENSE .gitignore package.json package-lock.json pnpm-lock.yaml bun.lock yarn.lock agent-manager.json /L /NS /NC /NP /NDL
```

对比仓库与全局配置差异（macOS / Linux）：

```bash
diff -rq . ~/.config/kilo \
  --exclude=.git --exclude=node_modules \
  --exclude=install.ps1 --exclude=install.sh \
  --exclude=README.md --exclude=LICENSE --exclude=.gitignore \
  --exclude=package.json --exclude=package-lock.json \
  --exclude=pnpm-lock.yaml --exclude=bun.lock --exclude=yarn.lock \
  --exclude=agent-manager.json
```

### 给真实项目接入项目级 context pack

1. 在项目根目录创建项目级 `AGENTS.md` 和 `.kilo/skills/`。
2. 只写该项目独有的架构、边界、契约、验证命令和高频工作流。
3. 让项目级知识覆盖全局默认行为，不要再把项目知识写回本仓库。
4. 具体写法参考本仓库中的 `AGENTS.md`，其已包含项目级 context pack 接入指南。

## MCP 扩展

本配置启用以下 MCP 服务器（详见 `kilo.json` 中的 `mcp` 节）：

- **GitNexus** (`gitnexus`): 本地调用链与影响面分析（默认关闭，按需手动开启）
- **Context7** (`context7`): 远程文档检索，用于拉取最新官方文档与库文档（默认启用，增强编码准确度）
- **Playwright** (`playwright`): 浏览器端验证、截图和交互检查（默认关闭，按需手动开启）

> 注意：MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。

## Skills 跨项目复用

`kilo.json` 已配置 `skills.paths` 指向 `~/.config/kilo/.kilo/skills`（全局配置目录技能位）与 `~/.agents/skills`（社区技能目录），可扫描社区技能源。社区技能源见 `.kilo/instructions/skills-lifecycle.md`「社区技能发现」章节（含 anthropics/skills、openai/skills、vercel-labs/agent-skills、skills.sh 等已知源）。

```json
{
  "skills": {
    "paths": [
      "~/.config/kilo/.kilo/skills",
      "~/.agents/skills"
    ]
  }
}
```

外部 skill 目录为**只读**引用，项目级 `.kilo/skills/` 始终优先；命名冲突时按 `name` 字段去重。frontmatter 兼容 [agentskills.io](https://agentskills.io/specification) 开放标准，可与 Hermes / Claude Code 等工具的技能目录互通。

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

项目配置优先级高于全局配置，遵循深合并规则。项目级 `AGENTS.md` 和 skills 比单纯覆盖模型更有效。

## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。
- `context7` 适合最新文档检索；`gitnexus` 适合调用链和影响面分析；`playwright` 适合浏览器端验证。
- 大型系统优先建设项目级 context pack；全局配置只做骨架和兜底，不承担具体项目知识。
- `.kilo/skills/` 写入路径约束：仅写入当前项目工作区的 `.kilo/skills/`，禁止回写全局配置目录（`~/.config/kilo/.kilo/skills/`）。install 脚本会清空全局目录后重新同步，项目级 skills 位于项目根目录，不受影响。
- `.kilo/skills/` 兼容 [agentskills.io](https://agentskills.io/specification) 开放标准，可与 Hermes / Claude Code 等工具的技能目录互通。
- **安全姿态声明**：`kilo.json` 顶层 `permission.bash: "allow"` 为全局 bash 免确认放行（与历史运行行为一致，v2.2 起纳入版本管理显式声明）。这放大了自动化执行面——所有项目的 bash 命令不再经 ask 门。如需收紧，改为 `"ask"` 或按 glob 细化（如 `"git *": "allow", "*": "ask"`）；各 agent frontmatter 的细粒度 permission 仍独立生效。