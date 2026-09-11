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
| 路径解析语义（全局根目录 vs 项目级 overlay） | `AGENTS.md`（全局指令入口声明） | `docs/configuration-guide.md` §0.5 只做引用 |
| 跨项目故障经验（FX 索引与模板） | knowledge-base/index.md | .kilo/instructions/reflection.md 只做检索入口引用 |
| 错误码字典 | `scripts/error-codes.mjs` | 消费方用 `codeMsg()` 引用，禁止多处硬编码文案 |
| 任务上下文 schema 与写权限 | `scripts/task-context.mjs`（WRITE_MATRIX） | agent frontmatter `task_context.write` 只声明本角色字段 |
| 阶段必配角色 | `lifecycle/stages/*.md` frontmatter `required_roles` | `graph.yaml` 不出现角色名 |
| 智能体注册与生命周期声明 | `agent/*.md` frontmatter | v6 单源：manifest 与行为文件合一 |
| agent prompt | `agent/*.md` frontmatter `description` | `scripts/sync-agent-prompt.mjs` 单向生成 `kilo.json`，**禁手改 kilo.json prompt** |
| 生命周期 DAG | `lifecycle/graph.yaml` | 纯拓扑，零智能体名/角色名 |
| 定级默认组合与熔断阈值 | `lifecycle/config.yaml` | agent 文件不重复阈值数值 |
| 占位符替换范围（哪些文档里的 `${KILO_CONFIG_DIR}` 会被安装脚本换成绝对路径） | `install.ps1` `$MdFilePatterns` + `install.sh` `md_dir` 循环（双端必须一致） | 消费方一律**解析而不重抄**：`scripts/lib/install-runtime-data.mjs#parseMdSubstDirs` 是唯一解析器，`scripts/deploy-drift-check.mjs`（逆变换范围）与 `checks/command-path-hygiene.mjs`（A/B 规则范围）共用它 |
| 部署拷贝排除清单（Recursive / RootOnly 两类） | `install.ps1` `$RecursiveExclude`/`$RootOnlyExclude` + `install.sh` `RECURSIVE_EXCLUDE`/`ROOT_ONLY_EXCLUDE`（双端必须一致） | `deploy-drift-check.mjs` 从事实源**解析**；仅「候选根均无 install 脚本」时用 `scripts/lib/install-runtime-data.mjs` 的 `FALLBACK_*` 镜像（由夹具钉一致性） |
| 运行时命令写法 | 一律 `node "${KILO_CONFIG_DIR}/scripts/<path>.mjs"`（部署后为绝对路径，在任意项目 cwd 可跑） | 仅目录 `README.md` 与 `docs/` 可用仓库相对路径（维护者在仓库里跑）|
| 模型能力倾向 | `docs/model-registry.md` | 人类可读，无机器可读副本 |

## 修改检查

| 修改内容 | 必查项 |
|---------|--------|
| 首次 clone / 初始化本仓库 | ① 运行 `./install.ps1` 或 `./install.sh` 完成全局部署；② 复制 `tools/hooks/post-commit` → `.git/hooks/post-commit`（防部署漂移提醒）；③ 运行 `node scripts/lifecycle-doctor/index.mjs` 确认校验全绿 |
| 新增/删除/改名 agent | 同步 `AGENTS.md` 清单、`README.md` 目录树、`agent/` 文件（必须含完整 YAML frontmatter：`description` / `mode` / `hidden` / `color` / `permission` / `steps` / `mount` / `task_context` / `isolation`），参考现有 `agent/conductor.md` 的写法；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `lifecycle/graph.yaml` 节点 `on_fail` / `required_roles` / 新增节点 | ① 节点 `on_fail` 取值 ∈ {abort, retry_once, degrade, escalate, pause}；② `stages/README.md` 阶段索引表同步 `on_fail` 列；③ `agent/conductor.md` §异常处理派发表覆盖新取值（如新增取值需扩表）；④ 新增节点须丢 `lifecycle/stages/<id-lower>.md` |
| 修改 `lifecycle/config.yaml` `timeouts` 段 | ① `per_agent_s` 键名与 `agent/*.md` 智能体名（去 .md + 连字符转下划线）一致；② `per_tier_multiplier` 键 ⊆ {T0,T1,T2}；③ 新增智能体时同步加 `per_agent_s` 键；④ 数值为正整数 |
| 修改 `lifecycle/config.yaml` `hooks.quality` 段 | ① 阈值变更同步 `docs/conductor-full-spec.md` §task_context 结构（摘要）的 `quality.max_rounds` 注释；② 同步 `lifecycle/graph.yaml` edges 注释引用的阈值描述 |
| 修改 `lifecycle/config.yaml` `tier_defaults` / `overrides` | ① 智能体键名按自动派生规则（连字符转下划线）；② `disabled_agents` 中的角色若被某节点 `required_roles` → `[ASSEMBLY_FAIL]`，checklist 需验证未禁用必配角色 |
| 新增/修改 `.kilo/instructions/*` | ① 同步 `README.md` 目录树；② 若新文件被 `kilo.json` agent.*.prompt 引用，必须同步更新 `lifecycle-doctor/index.mjs` 的引用路径存在性校验；**重跑 `./install.ps1` 或 `./install.sh`**；**漏跑 install 会导致全局版落后于仓库版（已发生过 workflow-core.md 漂移），install 后可用 `node scripts/lifecycle-doctor/index.mjs` 验证装配自检全绿** |
| 修改 `agent/*.md` | 确认只包含该 agent 的职责差异和关键门禁；frontmatter `mount[].on_fail`（可选视角用 degrade）与节点级 `on_fail`（5 值）按位置区分；frontmatter `mount[].tiers`（定级挂载，按 `sizing.tier` 过滤）与 `mount[].when`（非 tier 条件，如 feature flag/环境变量）**互斥二选一**（同时声明 → lifecycle-doctor B4 `[FAIL]`），新增"同阶段按 tier 差异化"视角用 `tiers` 替代 `when: "config.agents.<key>"` 开关；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` | 同步 `README.md` 中模型、MCP 说明；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` `skills.paths` | `skills.paths` 使用 `~` 原生字面量（如 `~/.config/kilo/.kilo/skills`、`~/.agents/skills`），**install 双脚本不再替换 kilo.json 占位符**（kilo.json 占位符替换段已删除，新增技能目录创建）；修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过装配自检 |
| 修改 `kilo.json` 中 `compaction` 字段 | ① 必须同步更新对应 `.kilo/instructions/*.md` 与 `agent/*.md` 的条件化规则描述；② 修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过校验 |
| 修改 `kilo.json` agent.*.prompt | ① agent prompt 已是极简锚点，完整职责在 agent/{name}.md，两者不重复职责，无需联动检查术语；conductor prompt 须保留 意图判定/定级/lifecycle/task_context/compaction 锚点关键词；② 必须同步检查 `.kilo/instructions/*.md` 中引用的标记（`[MARKER]`）定义一致性，确保 prompt 中引用的 marker 在对应 instructions 文件中存在且语义未漂移；③ 修改后必须运行 `node scripts/lifecycle-doctor/index.mjs` 通过校验 |
| 新增/修改 `scripts/lifecycle-doctor/` | ① 同步 `README.md` 中对该脚本的说明（如存在）；② 同步 `CHANGELOG.md` 记录新增/变更的校验维度；③ 若新增校验维度涉及 frontmatter 字段或 prompt 引用规则，同步更新本文档对应修改检查项；④ **新门禁必须同时在 `checks/__tests__/<name>.test.mjs` 放分支夹具**（正例零 FAIL + 每条规则至少一个必拦例），底座统一用 `scripts/lib/test-harness.mjs`，只喂临时沙箱 ROOT（禁止回扫真实仓库，会与 `unit.executed` 递归）；`node scripts/lifecycle-doctor/index.mjs` 的 `unit.executed` 会真跑它们 |
| 修改 `agent/*.md` / `lifecycle/graph.yaml` / `lifecycle/config.yaml` | ① **必跑 `node scripts/build-derivations.mjs`**——`scripts/lib/.generated/derivations.json` 是 gitignore 的安装期产物，不重建则 `task-context.mjs` 每次调用都刷 `[DERIVATIONS_STALE]` 走 `cachedDerive` 慢路径（预生成优化静默失效，且回退对用户不可见）；doctor 的 `derivations.freshness` 维度会以 WARN 提醒；② 改了 frontmatter `description` 时 `sync-agent-prompt.mjs` 会由 doctor 自动同步 `kilo.json`；③ **重跑 `./install.ps1` 或 `./install.sh`** |
| 在运行时文档里新增可执行命令 | ① 必须写 `node "${KILO_CONFIG_DIR}/scripts/..."`，**不写 `node scripts/...` 也不写 `node xxx.mjs`**（运行时 bash 的 cwd 是用户项目目录，相对命令直接 MODULE_NOT_FOUND，白耗一个回合或被当作可选步骤跳过）；② 新文档目录要同时加进 `install.ps1` `$MdFilePatterns` 与 `install.sh` `md_dir`（双端一致）；`deploy-drift-check.mjs` 与 `command-path-hygiene.mjs` 都从这两个数组**解析**，无需第三处同步；③ 两道不同步均由 `node scripts/lifecycle-doctor/index.mjs` 的 `cmd-path.*` 维度拦截（双端不一致 → `cmd-path.installer-consistent` FAIL）|
| 修改安装脚本 | `install.sh` 与 `install.ps1` 保持路径、EXCLUDE 列表、复制逻辑、关键文件校验、退出码语义一致；**修改后必须双平台都验证一次** |
| 修改 install 排除清单（`$RecursiveExclude` / `$RootOnlyExclude` / 对应 sh 数组） | 事实源是安装脚本，但有**三个隐藏耦合点**必须同步（2026-09 实测：漏一个就会假漂移或假绿，且已各踩过一次）：① `scripts/lib/install-runtime-data.mjs` 的 `FALLBACK_*_EXCLUDE` 镜像 —— 漏改会被 `checks/__tests__/install-runtime-data.test.mjs` 拦下；② 新增项若含第三方 MCP 工具名，须扩 `scripts/decouple-check.mjs` 的 `BENIGN` 豁免 —— 否则镜像一份到 lib 就被判 critical；③ RootOnly 项**可以是目录**（如 `reports`），drift 侧按首段匹配整棵子树（`isRootOnlyExcluded`），写成精确等于会报假 MISSING；④ 上述都改完后**重跑 install**，看输出行 `[DRIFT] excludes=install.ps1+install.sh@<根> (N names, M root-only)` 确认走的是事实源而不是 `excludes=fallback`（出现 fallback 即候选根解析失败，结果不可信） |
| 修改 `knowledge-base/`（index.md 或 fixes/*.md） | ① 新 FX 按四段结构（症状/根因/修复/复验）+ frontmatter（id/name/symptoms/category/hit_count/confidence/last_used）；② 跑 node scripts/kb.mjs add（索引自动重建）；③ 跨项目库，落盘后同步全局根 ~/.config/kilo/knowledge-base/；④ 重跑 node scripts/lifecycle-doctor/index.mjs 确认全绿 |
| 新增/重建 `.kilo/skills/<name>/` 子目录 | ① `install.sh`/`install.ps1` 的 EXCLUDE 数组已忽略 `.kilo/skills/`；② **必须用 `git add -f .kilo/skills/<name>/` 强制跟踪**（全局 .gitignore 忽略整个目录，否则会被 install 安全清理或 rm 无痕删除，8/11 事故根因）；③ skill 目录内放本地 .gitignore（首行 * + !SKILL.md + 豁免项）屏蔽临时文件；④ git commit --no-verify 跳过 pre-commit hook 检查，commit message 写明 force-add 原因 |

### instructions 与 prompt 联动检查

- [ ] 新增 `.kilo/instructions/*.md` 时，是否同步更新 `AGENTS.md` 的硬锚点与索引指针？
- [ ] 在 `.kilo/instructions/*.md` 中新增/修改 `[MARKER]` 定义时，是否同步搜索 `kilo.json` agent.*.prompt 和 `agent/*.md` 中对该 marker 的引用，确保引用方未引用已废弃或重命名的 marker？
- [ ] prompt 中引用 instructions 文件路径时，是否与 `README.md` 目录树中实际路径完全一致（无大小写/分隔符差异）？

## 已集中维护的规则

- fixer 轮次、升级阈值、Circuit Breaker：`.kilo/instructions/workflow-core.md`
- 三层错误恢复：`.kilo/instructions/reflection.md`
- 交付和验证底线：`.kilo/instructions/core.md` + `workflow-core.md`
- 需求扩散、同类点扫描：`.kilo/instructions/workflow-core.md`
- 局部补丁拦截、重复模式修复 / 组件化 SOP：`.kilo/instructions/workflow-core.md`
- 修复方法论（全链路审计、完整阅读、验证剩余路径、推测与验证区分）：`.kilo/instructions/workflow-core.md` + `core.md` + `reflection.md`
- planner 设计门预审、verifier 分层、fixer 权限约束：`.kilo/instructions/workflow-core.md`（生命周期驱动后由 `lifecycle/stages/` 阶段文件 + `agent/*.md` frontmatter 生命周期声明 + 行为文件承载，v6 单源）
- Skills 生命周期治理（编写规范、回写触发、发现位置）：`.kilo/instructions/skills-lifecycle.md`
- **安全/性能检测模式**（检测项总览、检测项 ID、INJ/PERF/AUTH 分类、检测流程）→ 集中维护在 `.kilo/instructions/security-checklist.md`；其他文件（`kilo.json` prompt、agent 文件）只做引用。
- **输出格式规范**（交付输出的最小公共字段、`[MARKER]` 标记语言规范、状态枚举）→ 集中维护在 `.kilo/instructions/output-schema.md`；其他文件只做引用。
- **SKILL.md frontmatter 规范**（含 keywords 数量 3–20、name 与目录名一致、兼容 agentskills.io 标准）→ 由项目级 `.kilo/skills/` 各 skill 自治；全局骨架只在 `skills-lifecycle.md` 给出编写参考，不强制校验仓库外的 skill 文件。
- **经验沉淀写入规则**（查重 / 禁写内容 / 回收进仓库）→ 集中维护在 `knowledge-base/index.md`「如何新增一条经验」折叠块；`.kilo/instructions/reflection.md` 只做检索入口引用。
- **工作流参考**（small_model 触发规则、需求扩散与同类点扫描）→ 集中维护在 `.kilo/instructions/workflow-core.md`；README 与其他文件只做引用。

修改这些规则时，优先改主文档；agent 文件只保留必要引用和角色化执行要求。

## 扩展点（新增能力只丢文件，零改框架）

| 扩展类型 | 落点 | 脚手架 |
|----------|------|--------|
| 新加 subagent | `agent/<name>.md` + `kilo.json` `agent.<name>.model` | `node scripts/new-agent.mjs <name>` |
| 新加 stage | `lifecycle/stages/<name>.md` + `lifecycle/graph.yaml` node/edges | `node scripts/new-stage.mjs <name>` |
| 新加 doctor 校验维度 | `scripts/lifecycle-doctor/checks/<name>.mjs` + `index.mjs` 注册 | `node scripts/new-validator.mjs <name>` |
| 新加 skill | `.kilo/skills/<name>/SKILL.md` | 手动（治理见 `.kilo/instructions/skills-lifecycle.md`）|

## 错误码新增流程

1. 改 `scripts/error-codes.mjs` 加 `ERROR_CODES.XXX`（code + message + 严重级别）
2. 消费方用 `codeMsg('XXX')` 引用，禁止在多处硬编码错误文案
3. 文档只指向 `scripts/error-codes.mjs`，不重复枚举
4. 跑 `node scripts/lifecycle-doctor/index.mjs` 确认全绿

## 文档角色分工

| 层级 | 文件 | 加载时机 | 用途 |
|------|------|----------|------|
| 全局入口 | `AGENTS.md` | 每次 task 启动（findUp）| 只列锚点名称与规则来源 |
| Runtime 注入 | `.kilo/instructions/{core,workflow-core,reflection}.md` | 每次 task 启动 | 通用基线；其余 instructions 按需引用，不自动注入 |
| 阶段执行 | `lifecycle/stages/*.md` | 阶段执行时 | frontmatter `required_roles` + 行为逻辑 |
| 完整参考 | `docs/*.md` | 人类阅读 | 架构 / 配置 / 挂载 / 模型 / 完整设计规范 |
| 历史档案 | `docs/archive/*.md` | 只读 | 废弃文档迁移留存 |

## 文档迁移 / 废弃规则

- **`docs/` 下废弃不删**：移 `docs/archive/` + 头部标 `> 历史档案`
- **运行时文档里的死文件直接删**（`agent/`、`.kilo/instructions/`、`lifecycle/stages/`）：这些文件每次部署都会被复制到全局根，留着就是每台机器的噪声；历史由 git 保留，不需 archive 副本
- **迁移后必须全仓改引用**：跑 `node scripts/lifecycle-doctor/index.mjs`，anchor-refs 维度会拦死引用与重复标题
- **CHANGELOG 记录废弃决策**

> 与 `AGENTS.md` 交叉对照：AGENTS.md 只列锚点名称与规则来源，本文件只列变更时的联动检查项，两者不得重复展开细则。
