# Evolution 自进化规则

> **本文档已简化**：工作流简化后，经验沉淀由 conductor 在 DELIVERING 阶段按需记录，不再依赖独立记忆模块。
> **运行时注入**：精简版（13 行）随每次 task 注入；扩展版（本文）按需参考。

---

## 触发条件

T1+ 任务交付后，conductor 记录任务执行摘要与关键决策，供后续任务参考。

## 禁止事项

- 不写入项目特定代码（如具体变量名、业务逻辑）
- 不写入敏感信息（API Key、密码、内部域名）
- 不虚构未验证的经验

---

## 维护性 / 扩展性机制（v6 单源架构）

### SSOT 化（Single Source of Truth）

| 领域 | 唯一真相 | 备注 |
|------|----------|------|
| 错误码 | `scripts/error-codes.mjs`（U1 实施） | 全局错误码字典 + `codeMsg()` 工具 |
| 任务上下文 | `task-context.mjs` | task_context schema 校验 + 读写规则 |
| 角色契约 | `lifecycle/stages/*.md` frontmatter `required_roles` | 阶段必配角色单源声明 |
| 智能体清单 | `agent/*.md` frontmatter | v6 单源：manifest 与行为文件合二为一 |
| 生命周期 DAG | `lifecycle/graph.yaml` | 纯拓扑，零智能体名/角色名 |
| 定级默认值 | `lifecycle/config.yaml` `tier_defaults` | 定级智能体组合唯一声明处 |
| 模型能力倾向 | `docs/model-registry.md` | 人类可读，v6.1 删除机器可读副本 |

### 错误码新增流程

1. 改 `scripts/error-codes.mjs` 加 `ERROR_CODES.XXX` 条目（code + message + 严重级别）
2. `transition-check.mjs` 用 `codeMsg('XXX')` 引用
3. 文档描述指向 `error-codes.mjs`（不在多处硬编码错误信息）
4. 跑 `node scripts/lifecycle-doctor.mjs` 校验 PASS

### 脚本模块化

| 任务 | 状态 | 实施单元 |
|------|------|----------|
| `lifecycle-doctor.mjs` 拆为 `checks/*.mjs` | 待实施 | U3 |
| `scripts/checks/` 统一 check 类脚本（frontmatter / mount / required_roles / config drift 等） | 待实施 | U3 |
| `scripts/new-{agent,stage,validator}.mjs` 脚手架 | 待实施 | U4 |
| 脚手架自动注册（frontmatter + kilo.json + required_roles 联动） | 待实施 | U4 |

### 扩展点

| 扩展类型 | 路径 | 脚手架 |
|----------|------|--------|
| 新加 subagent | `agent/<name>.md` + `kilo.json` `agent.<name>.model` | `node scripts/new-agent.mjs <name>` 自动生成 frontmatter 模板 |
| 新加 stage | `lifecycle/stages/<name>.md` + `lifecycle/graph.yaml` 加 node + edges | `node scripts/new-stage.mjs <name>` 自动写 graph.yaml + transition-check 边 |
| 新加 validator | `scripts/checks/<name>.mjs` + `lifecycle-doctor.mjs` 注册 | `node scripts/new-validator.mjs <name>` 自动写 error-codes.mjs + transition-check.mjs |
| 新加 skill | `.kilo/skills/<name>/SKILL.md` | 手动（skill 治理见 `skills-lifecycle.md`） |

### 文档角色分工

| 层级 | 文件 | 加载时机 | 用途 |
|------|------|----------|------|
| 全局入口 | `AGENTS.md` | 每次 task 启动 | 锚点 1-15（runtime 必备） |
| Runtime 注入 | `.kilo/instructions/*.md` | 每次 task 启动 | 核心规则（core/workflow-core/reflection）+ 按需扩展（workflow-detail/evolution 等） |
| 完整参考 | `docs/*.md` | 人类阅读 | 架构 / 配置 / 挂载 / 模型 / 完整设计规范 |
| 历史档案 | `docs/archive/*md` | 只读 | 废弃文档迁移 + 历史执行参考 |
| 阶段执行 | `lifecycle/stages/*.md` | 阶段执行时 | 阶段 frontmatter `required_roles` + 行为逻辑 |

### 文档迁移/废弃规则

- **废弃不删**：文档废弃一律移 `docs/archive/` + 头部标 `> 历史档案` 注释
- **引用改指 current SSOT**：例如 `multi-agent-lifecycle-architecture.md` → `conductor-full-spec.md`（U2 实施）
- **CHANGELOG 记录废弃决策**：每次废弃/迁移写入 `CHANGELOG.md` 同步范围章节
- **禁止直接删除**：除非确认无任何历史参考价值（需 reviewer 确认）

### 实施状态

| 单元 | 内容 | 状态 | 实施说明 |
|------|------|------|----------|
| U1 | 错误码字典 `scripts/error-codes.mjs` | ✅ 已实施 | 全局错误码 + codeMsg() 工具 |
| U2 | 文档清晰化（5-7 文件） | 🔄 进行中 | 本次 task（多文档归档 + 拆分 + 引用改写） |
| U3 | 脚本模块化（`scripts/checks/*.mjs`） | ⏳ 待实施 | lifecycle-doctor 拆分 |
| U4 | 脚手架 `new-{agent,stage,validator}.mjs` | ⏳ 待实施 | 扩展点自动化 |
