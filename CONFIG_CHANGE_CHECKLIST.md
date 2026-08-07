# 配置变更检查清单

> 用于修改全局配置时保持单一事实来源和跨文件一致性。

## 单一事实来源

| 信息类型 | 主文档 | 其他位置 |
|---------|--------|----------|
| 全局硬锚点索引入口（运行时自动注入） | `AGENTS.md` | 只做索引或引用 |
| 运行时通用规则 | `.kilo/instructions/*.md` | agent 只引用，不复制正文 |
| 单个 agent 职责差异 | `agent/{name}.md` | 不维护全局流程 |
| 模型、权限、MCP | `kilo.json` | `README.md` 只说明 |
| 安装脚本 | `install.sh` / `install.ps1` | 双平台同步 |
| 目录结构 | `README.md` | 必须与文件系统一致 |

## 修改检查

| 修改内容 | 必查项 |
|---------|--------|
| 首次 clone / 初始化本仓库 | ① 运行 `./install.ps1` 或 `./install.sh` 完成全局部署；② 复制 `tools/hooks/post-commit` → `.git/hooks/post-commit`（防部署漂移提醒）；③ 运行 `node scripts/lifecycle-doctor/index.mjs` 确认校验全绿 |
| 新增/删除/改名 agent | 同步 `AGENTS.md` 清单、`README.md` 目录树、`agent/` 文件（必须含完整 YAML frontmatter：`description` / `mode` / `hidden` / `color` / `permission` / `steps` / `mount` / `task_context` / `isolation`），参考现有 `agent/conductor.md` 的写法；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `lifecycle/graph.yaml` 节点 `on_fail` / `required_roles` / 新增节点 | ① 节点 `on_fail` 取值 ∈ {abort, retry_once, degrade, escalate, pause}；② `stages/README.md` 阶段索引表同步 `on_fail` 列；③ `agent/conductor.md` §异常处理派发表覆盖新取值（如新增取值需扩表）；④ 新增节点须丢 `lifecycle/stages/<id-lower>.md` |
| 修改 `lifecycle/config.yaml` `timeouts` 段 | ① `per_agent_s` 键名与 `agent/*.md` 智能体名（去 .md + 连字符转下划线）一致；② `per_tier_multiplier` 键 ⊆ {T0,T1,T2}；③ 新增智能体时同步加 `per_agent_s` 键；④ 数值为正整数 |
| 修改 `lifecycle/config.yaml` `hooks.quality` 段 | ① 阈值变更同步 `agent/conductor.md` §task_context 结构 `quality.max_rounds` 注释；② 同步 `lifecycle/graph.yaml` edges 注释引用的阈值描述 |
| 修改 `lifecycle/config.yaml` `tier_defaults` / `overrides` | ① 智能体键名按自动派生规则（连字符转下划线）；② `disabled_agents` 中的角色若被某节点 `required_roles` → `[ASSEMBLY_FAIL]`，checklist 需验证未禁用必配角色 |
| 新增/修改 `.kilo/instructions/*` | ① 同步 `README.md` 目录树；② 若新文件被 `kilo.json` agent.*.prompt 引用，必须同步更新 `lifecycle-doctor/index.mjs` 的引用路径存在性校验；**重跑 `./install.ps1` 或 `./install.sh`**；**漏跑 install 会导致全局版落后于仓库版（已发生过 workflow-core.md 漂移），install 后可用 `node scripts/lifecycle-doctor/index.mjs` 验证装配自检全绿** |
| 修改 `agent/*.md` | 确认只包含该 agent 的职责差异和关键门禁；frontmatter `mount[].on_fail`（可选视角用 degrade）与节点级 `on_fail`（5 值）按位置区分；frontmatter `mount[].tiers`（定级挂载，按 `sizing.tier` 过滤）与 `mount[].when`（非 tier 条件，如 feature flag/环境变量）**互斥二选一**（同时声明 → lifecycle-doctor B4 `[FAIL]`），新增"同阶段按 tier 差异化"视角用 `tiers` 替代 `when: "config.agents.<key>"` 开关；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` | 同步 `README.md` 中模型、MCP 说明；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` `skills.paths` | `skills.paths` 使用 `~` 原生字面量（如 `~/.config/kilo/.kilo/skills`、`~/.agents/skills`），**install 双脚本不再替换 kilo.json 占位符**（kilo.json 占位符替换段已删除，新增技能目录创建）；修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过装配自检 |
| 修改 `kilo.json` 中 `compaction` 字段 | ① 必须同步更新对应 `.kilo/instructions/*.md` 与 `agent/*.md` 的条件化规则描述；② 修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过校验 |
| 修改 `kilo.json` agent.*.prompt | ① agent prompt 已是极简锚点，完整职责在 agent/{name}.md，两者不重复职责，无需联动检查术语；conductor prompt 须保留 意图判定/定级/lifecycle/task_context/compaction 锚点关键词；② 必须同步检查 `.kilo/instructions/*.md` 中引用的标记（`[MARKER]`）定义一致性，确保 prompt 中引用的 marker 在对应 instructions 文件中存在且语义未漂移；③ 修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过校验 |
| 新增/修改 `scripts/lifecycle-doctor/` | ① 同步 `README.md` 中对该脚本的说明（如存在）；② 同步 `CHANGELOG.md` 记录新增/变更的校验维度；③ 若新增校验维度涉及 frontmatter 字段或 prompt 引用规则，同步更新本文档对应修改检查项 |
| 修改安装脚本 | `install.sh` 与 `install.ps1` 保持路径、EXCLUDE 列表、复制逻辑、关键文件校验、退出码语义一致；**修改后必须双平台都验证一次** |
| 修改 EXCLUDE 列表 | 必须同步 `install.sh` 与 `install.ps1` 的双平台 EXCLUDE 数组；**同步 `README.md` 中 diff 验证命令的排除参数**；修改后必须双平台都验证一次 |

### instructions 与 prompt 联动检查

- [ ] 新增 `.kilo/instructions/*.md` 时，是否同步更新 `AGENTS.md` 的硬锚点与索引指针？
- [ ] 在 `.kilo/instructions/*.md` 中新增/修改 `[MARKER]` 定义时，是否同步搜索 `kilo.json` agent.*.prompt 和 `agent/*.md` 中对该 marker 的引用，确保引用方未引用已废弃或重命名的 marker？
- [ ] prompt 中引用 instructions 文件路径时，是否与 `README.md` 目录树中实际路径完全一致（无大小写/分隔符差异）？

## 已集中维护的规则

- fixer 轮次、升级阈值、Circuit Breaker：`.kilo/instructions/workflow-core.md`
- 三层错误恢复：`.kilo/instructions/reflection.md`
- 交付和验证底线：`.kilo/instructions/core.md` + `workflow-core.md`
- 需求扩散、同类点扫描：`.kilo/instructions/workflow-reference.md`
- 局部补丁拦截、重复模式修复 / 组件化 SOP：`.kilo/instructions/workflow-core.md`
- 修复方法论（全链路审计、完整阅读、验证剩余路径、推测与验证区分）：`.kilo/instructions/workflow-core.md` + `core.md` + `reflection.md`
- planner 设计门预审、verifier 分层、fixer 权限约束：`.kilo/instructions/workflow-core.md`（生命周期驱动后由 `lifecycle/stages/` 阶段文件 + `agent/*.md` frontmatter 生命周期声明 + 行为文件承载，v6 单源）
- Skills 生命周期治理（编写规范、回写触发、发现位置）：`.kilo/instructions/skills-lifecycle.md`
- **安全/性能检测模式**（检测项总览、检测项 ID、INJ/PERF/AUTH 分类、检测流程）→ 集中维护在 `.kilo/instructions/security-checklist.md`；其他文件（`kilo.json` prompt、agent 文件）只做引用。
- **输出格式规范**（交付输出的最小公共字段、`[MARKER]` 标记语言规范、状态枚举）→ 集中维护在 `.kilo/instructions/output-schema.md`；其他文件只做引用。
- **SKILL.md frontmatter 规范**（含 keywords 数量 3–20、name 与目录名一致、兼容 agentskills.io 标准）→ 由项目级 `.kilo/skills/` 各 skill 自治；全局骨架只在 `skills-lifecycle.md` 给出编写参考，不强制校验仓库外的 skill 文件。
- **自进化闭环**（执行→反思→提炼→固化的写入规则与优先级）→ 集中维护在 `.kilo/instructions/evolution.md`；其他文件只做引用。
- **Skill 升级提案**（由维护者根据实际运行反馈人工评估后触发）→ 集中维护在 `.kilo/instructions/skill-upgrade.md`；其他文件只做引用。
- **工作流参考**（small_model 触发规则、需求扩散与同类点扫描）→ 集中维护在 `.kilo/instructions/workflow-reference.md`；README 与其他文件只做引用。

修改这些规则时，优先改主文档；agent 文件只保留必要引用和角色化执行要求。

> 与 `AGENTS.md` 的硬锚点索引交叉对照；两份清单内容必须保持一致。