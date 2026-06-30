# kilo_config

Kilo 全局配置骨架仓库。它负责通用 agent 编排、默认模型路由和运行时规则；真正决定上下文理解精度的知识，应该放在每个项目自己的 `AGENTS.md` 和 `.kilo/skills/` 中。

## 当前设计

- **运行时指令轻量化**：真正注入模型上下文的是 `./.kilo/instructions/core.md`、`workflow.md`、`reflection.md`，避免把长篇设计文档整份塞进每个 session。`skills-lifecycle.md` 不在自动注入列表中，作为按需引用的参考文档，由 coderAgent 和 skills-writer 在需要时主动读取。
- **长文档转为参考资料**：`AGENTS.md` 保留为设计标准和人工维护参考，不再承担高频运行时注入职责。
- **高精度默认路由**：模型选择只在 `kilo.json` 中维护；运行规则按角色和任务复杂度路由，不硬编码具体模型名。
- **扩展入口内置**：默认启用 `context7` 远程 MCP 作为最新文档检索入口；启用 `gitnexus` 辅助调用链/影响面分析；启用 `playwright` 辅助浏览器端验证。
- **职责分层**：通用规则集中在 `.kilo/instructions/`；`agent/*.md` 作为人工维护参考与职责差异记录；`kilo.json` 中的 `agent.*.prompt` 提供运行时行为锚点（极简、稳定、不堆积通用规则）。三层各司其职，避免重复维护。
- **项目知识项目化**：项目知识不放在本仓库，而是下沉到真实项目根目录中的 `AGENTS.md` 和 `.kilo/skills/`。
- **持续改进基于验证闭环**：质量提升依赖测试、构建、类型检查、review 审查与多模型升级，不依赖自动改写规则文件。

## 模型路由原则

模型选择按 agent 职责的能力维度匹配，**不硬编码具体模型名**。具体模型名和 provider 配置集中在 `kilo.json` 的 `agent.*.model` 和 `provider` 字段，作为模型配置的唯一事实来源。

> **模型事实来源**：本表只描述能力维度和路由原则，不硬编码模型名。修改模型分配请直接改 `kilo.json`，README 表无需同步。

| 能力维度 | 推荐模型族 | 适用 agent | 选择依据 |
|---------|-----------|-----------|---------|
| 编排与主控（长上下文、稳定输出） | 长上下文主控模型 | coderAgent, engineer, executor-A | 主控需长上下文窗口和稳定结构化输出；engineer 需稳健正确性 |
| 规划与架构（推理深度、适度发散） | 推理深度模型 | architect, review-architecture, executor-B, synthesizer, ensemble, **review-simplification** | 架构规划需推理深度；ensemble 编排需协调多候选；简化审查需推理分析 |
| 审查与对抗（严谨判断、低发散） | 严谨判断模型 | reviewer, review-security, executor-C, **fixer** | 审查/对抗需严谨判断；fixer 需精确根因判定 |
| 客观验证与复杂判断（高推理、准确） | 高推理验证模型 | **checker, pre-checker** | 验证/预审需高推理能力，降低漏判 |
| 轻量辅助 | 轻量快速模型 | small_model | 简单子任务降级用 |

**选择原则**：

1. 编排/实现优先稳定性（长上下文主控模型族，temperature 0）。
2. 规划/合并保留适度发散（推理深度模型族，temperature 0.1-0.2）。
3. 审查/对抗低发散（严谨判断模型族，temperature 0-0.1）。
4. 验证/预审用高推理验证模型族；修复/审查/对抗用严谨判断模型族；规划/合并/简化审查用推理深度模型族。不简单追求低成本。
5. 新增 agent 时按职责维度选模型，不按名字选；模型分配的唯一维护入口是 `kilo.json`。

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
│   └── memory/                   # 程序化记忆（参考 Hermes Agent）
│       ├── MEMORY.md             # agent 笔记（≤ 2200 字符）
│       ├── USER.md               # 用户档案（≤ 1375 字符）
│       └── README.md             # memory 机制说明
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

### 使用程序化记忆

借鉴 Hermes Agent 的 MEMORY.md / USER.md 双轨设计，kilo 支持项目级程序化记忆：

1. 在项目根目录创建 `.kilo/memory/MEMORY.md` 存放 agent 笔记（架构约束、安全模式、踩坑记录，≤ 2200 字符）
2. 在项目根目录创建 `.kilo/memory/USER.md` 存放用户偏好和项目约定（≤ 1375 字符）
3. coderAgent 在任务启动时自动检测并加载为冻结快照

详见 `.kilo/memory/README.md`。

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

## Skills 跨项目复用（可选）

`kilo.json` 支持 `skills.external_dirs` 数组，启用后可扫描外部 skill 目录（如 `~/.agents/skills/`）。默认空数组，向后兼容。

```json
{
  "skills": {
    "external_dirs": ["~/.agents/skills"]
  }
}
```

外部 skill 目录为**只读**引用，项目级 `.kilo/skills/` 始终优先；命名冲突时按 `name` 字段去重。

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

## 一次性成功率的终极杠杆

本仓库只是全局骨架。真正决定单次任务输出质量的，是**每个真实项目自己的 `AGENTS.md` 和 `.kilo/skills/`**：

1. 在项目根目录创建 `AGENTS.md`，写入该项目独有的架构边界、模块依赖方向、接口契约、高风险链路。
2. 在项目根目录创建 `.kilo/skills/`，沉淀该项目的编码范式、反模式、测试回归命令、踩坑记录。
3. 让项目级知识覆盖全局默认行为；不要把项目知识写回本仓库。

项目级 context pack 越完整，engineer 的"上下文确认"和"验收映射表"就越准确，一次性成功率就越高。

## 注意事项

- 本仓库 **不** 包含 API Key、Token 等敏感信息；敏感配置请通过环境变量管理。
- MCP 服务器会增加上下文和工具面，不要同时启用太多高噪声服务器。
- `context7` 适合最新文档检索；`gitnexus` 适合调用链和影响面分析；`playwright` 适合浏览器端验证。
- 大型系统优先建设项目级 context pack；全局配置只做骨架和兜底，不承担具体项目知识。
- 全局配置目录中的 `.kilo/skills/` 是模板/示例，安装脚本会同步到用户全局目录；实际项目经验应写入**项目根目录**的 `.kilo/skills/`，两者路径不同不会冲突。
- `skills-writer` 写入路径强约束：仅写入当前项目工作区的 `.kilo/skills/`，禁止回写全局配置目录（`~/.config/kilo/.kilo/skills/`）。install 脚本会清空全局目录后重新同步，已配置的项目经验不会受影响（项目级 skills 在项目根目录，不在全局目录中）。