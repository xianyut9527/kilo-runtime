# kilo_config

Kilo 全局配置骨架仓库。负责通用 agent 编排、默认模型路由和运行时规则；项目级知识应下沉到各项目自己的 `AGENTS.md` 和 `.kilo/skills/`。

> **仓库定位**：本仓库是 Kilo 的**全局通用配置唯一源**，通过 `install.ps1`/`install.sh` 全量部署到 `~/.config/kilo/`。仓库内的 `.kilo/instructions/` 是全局通用规则的工作区，`.kilo/skills/` 不随仓库分发（运行时从项目级与社区源 `~/.agents/skills` 发现，见 `kilo.json` `skills.paths`），**不是项目级特化配置**——所有项目共享同一份全局配置，项目级特化应放在各项目根目录的 `AGENTS.md` 和 `.kilo/` 中。修改仓库内任何配置后必须重跑 install 同步到全局，否则全局版会落后。
> 所有相对路径（`agent/`、`lifecycle/`、`.kilo/instructions/`、`docs/`）以**全局配置根目录** `~/.config/kilo/` 为解析基准；项目级同名文件覆盖全局版（overlay 语义），项目级不存在时自动回落全局。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md`、`workflow-core.md`、`reflection.md`，避免把长篇设计文档整份塞进每个 session。`workflow-reference.md` / `skills-lifecycle.md` 不在自动注入列表中，作为按需引用的参考文档，由 conductor 在需要时主动读取。`security-checklist.md` 作为 verifier 在 L3 安全/性能阶段调用的检查清单，`output-schema.md` 作为统一交付输出规范，二者按智能体按需加载，不作为通用上下文全量注入。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **默认路由**：模型选择只在 `kilo.json` 中维护；运行规则按角色和任务复杂度路由，不硬编码具体模型名。
- **扩展入口可选**：Kilo 框架默认零耦合运行，需要时按需启用第三方 MCP（通用名称：远程文档检索 / 代码图谱索引 / 浏览器自动化等）。
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
│   ├── conductor-full-spec.md      # conductor 完整设计规范（设计门产物 + 多智能体架构历史）
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

## 子智能体冒烟测试

通过 `scripts/agents-smoke-test.mjs` 对 7 个 subagent（`planner / coder / verifier / reviewer / plan-reviewer / reverse-auditor / fixer`）做端到端连通性验证：实际向 `kilo.json` 中配置的 `provider.hx` 发起一次 chat completion 请求，校验模型路由、超时、HTTP 状态与响应解析是否正常。

### 用法

```bash
# 查看帮助与全部 flag
node scripts/agents-smoke-test.mjs --help

# 单跑：指定 agent + 自定义 prompt + 短超时（适合 401/超时快速失败场景）
node scripts/agents-smoke-test.mjs --agent planner --prompt ping --timeout 30s

# 全跑：8 个 agent 顺序调度，进度走 stderr，结构化结果走 stdout
node scripts/agents-smoke-test.mjs --full --timeout 60s --json
```

`--timeout` 支持 `30s` / `500ms` / `1m` / 纯数字（毫秒）。`--json` 模式下单跑输出 1 元素数组，`--full` 输出 8 元素 + 1 summary 元素。进度/进度信息走 stderr，结构化输出走 stdout，避免污染 JSON 解析。

### PASS 判据

- **单跑（`--agent`）**：`ok=true` 且 `error=null` → exit `0`；`http:401` / `timeout` / `parse` 等任意失败 → exit `1`。
- **全跑（`--full`）**：8 个 agent 全部 `ok=true` → exit `0`；至少 1 个 `ok=false` → exit `1`。
- **用法错误**：未知 flag / 缺值 / 未知 agent / `--agent` 与 `--full` 互斥 → exit `2`（含 stderr 错误信息）。

### 与其他诊断脚本的定位区分

| 脚本 | 关注点 | 触发条件 |
| --- | --- | --- |
| `scripts/lifecycle-doctor/index.mjs` | **装配**自检：frontmatter 注册、stage 挂载、`required_roles` 契约是否齐备 | 配置变更后 / 装配异常 |
| `scripts/agents-smoke-test.mjs`（本脚本） | **可达性**自检：subagent 端到端能否真正调到 provider 并拿到合法响应 | provider 异常 / 模型路由调整 / 新接入 subagent |
| `scripts/flow-audit.mjs` | **流程**自检：DAG 节点/边的合法性与触发条件 | lifecycle 拓扑调整 |

三者互补：装配通过 ≠ 可达（provider 401 仍会 fail）、可达通过 ≠ 流程合规（缺边仍报 PASS）、流程合规 ≠ 装配完整（缺 frontmatter 不被 flow-audit 捕获）。完整健康度需要三脚本全绿。

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
robocopy . "$env:USERPROFILE\.config\kilo" /E /XJ /XD .git node_modules .tmp worktrees .pytest_cache __pycache__ .kilo_tmp .playwright-mcp /XF install.ps1 install.sh README.md LICENSE .gitignore package.json package-lock.json pnpm-lock.yaml bun.lock yarn.lock agent-manager.json /L /NS /NC /NP /NDL
```

对比仓库与全局配置差异（macOS / Linux）：

```bash
diff -rq . ~/.config/kilo \
  --exclude=.git --exclude=node_modules --exclude=.tmp --exclude=worktrees --exclude=.pytest_cache --exclude=__pycache__ --exclude=.kilo_tmp --exclude=.playwright-mcp \
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

本配置默认零耦合（所有 MCP `enabled: false`），需用时手动启用：

- **可选 MCP 工具**：通用类别包括远程文档检索、代码图谱索引、浏览器自动化等。具体 MCP 由 IDE 运行时注入决定；本仓库仅在 `kilo.json` 的 `mcp` 节保留占位配置，默认全部 `enabled: false`。启用时按所选工具官方文档配置（如部分工具需全局安装 CLI 客户端、设置环境变量等）。



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



## i18n 渲染器使用

`scripts/i18n-render.mjs` 是 stage-i18n 单一真相源（`scripts/lib/stage-i18n.mjs`）的 CLI 入口，零依赖，支持裸 KEY 查找 / `--map <MAP> <KEY>` 显式指定 / `--triple <INTENT> <TIER> <STAGE>` 三段拼接 / 5 个 `--<kind> <KEY>` 快捷分支。未知 key → stderr + exit 2。

```bash
node scripts/i18n-render.mjs --stage PLANNING    # 设计门 (PLANNING)
node scripts/i18n-render.mjs --status PENDING    # 待处理 (PENDING)
node scripts/i18n-render.mjs --verdict PASS      # 通过 (PASS)
node scripts/i18n-render.mjs --all               # 5 个映射表全量 dump
```

5 个映射表名（大小写不敏感）：`STAGE` / `TIER` / `STATUS` / `INTENT` / `VERDICT`。库形式 `import { formatStage, formatStatus, ... } from './lib/stage-i18n.mjs'` 供 agent 与脚本内部消费；纳管校验在 `scripts/lifecycle-doctor/checks/i18n-coverage.mjs`。
## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。
- 各类 MCP 工具按需启用，选择匹配任务场景的即可。
- 大型系统优先建设项目级 context pack；全局配置只做骨架和兜底，不承担具体项目知识。
- `.kilo/skills/` 写入路径约束：仅写入当前项目工作区的 `.kilo/skills/`，禁止回写全局配置目录（`~/.config/kilo/.kilo/skills/`）。install 脚本会清空全局目录后重新同步，项目级 skills 位于项目根目录，不受影响。
- `.kilo/skills/` 兼容 [agentskills.io](https://agentskills.io/specification) 开放标准，可与 Hermes / Claude Code 等工具的技能目录互通。
- **安全姿态声明**：`kilo.json` 顶层 `permission.bash: "allow"` 为全局 bash 免确认放行（与历史运行行为一致，v2.2 起纳入版本管理显式声明）。这放大了自动化执行面——所有项目的 bash 命令不再经 ask 门。如需收紧，改为 `"ask"` 或按 glob 细化（如 `"git *": "allow", "*": "ask"`）；各 agent frontmatter 的细粒度 permission 仍独立生效。
