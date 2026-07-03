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
| 程序化记忆 | `.kilo/memory/*.md` | 仅在本文档做引用 |

## 修改检查

| 修改内容 | 必查项 |
|---------|--------|
| 新增/删除/改名 agent | 同步 `AGENTS.md` 清单、`README.md` 目录树、`agent/` 文件（必须含完整 YAML frontmatter：`description` / `mode` / `hidden` / `color` / `permission` / `steps`），参考现有 `agent/engineer.md` 或 `agent/feedback-collector.md` 或 `agent/experience-ranker.md` 的写法；**重跑 `./install.ps1` 或 `./install.sh`** |
| 新增/修改 `.kilo/instructions/*` | ① 同步 `README.md` 目录树；② 若新文件被 `kilo.json` agent.*.prompt 引用，必须同步更新 `validate-config.mjs` 的引用路径存在性校验；**重跑 `./install.ps1` 或 `./install.sh`**；**漏跑 install 会导致全局版落后于仓库版（已发生过 workflow-core.md 漂移），install 后可用 examples/install-check.md 的 diff 命令验证一致性** |
| 修改 `agent/*.md` | 确认只包含该 agent 的职责差异和关键门禁；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` | 同步 `README.md` 中模型、MCP 说明；**重跑 `./install.ps1` 或 `./install.sh`** |
| 修改 `kilo.json` 中 `compaction` 字段 | ① 必须同步更新 `agent/coderAgent.md`「编排流持久化保护」段落的描述，确保配置值（`auto` / `threshold_percent`）与文档一致；② 修改后必须运行 `node validate-config.mjs` 通过校验 |
| 修改 `kilo.json` agent.*.prompt | ① agent prompt 已是极简锚点，完整职责在 agent/{name}.md，两者不重复职责，无需联动检查术语；coderAgent prompt 须保留意图判定/定级/pre-checker/engineer/checker/fixer/reviewer/feedback-collector/skills-writer/experience-ranker/compaction 锚点关键词；② 必须同步检查 `.kilo/instructions/*.md` 中引用的标记（`[MARKER]`）定义一致性，确保 prompt 中引用的 marker 在对应 instructions 文件中存在且语义未漂移；③ 修改后必须运行 `node validate-config.mjs` 通过校验 |
| 新增/修改 `validate-config.mjs` | ① 同步 `README.md` 中对该脚本的说明（如存在）；② 同步 `CHANGELOG.md` 记录新增/变更的校验维度；③ 若新增校验维度涉及 frontmatter 字段或 prompt 引用规则，同步更新本文档对应修改检查项 |
| 修改安装脚本 | `install.sh` 与 `install.ps1` 保持路径、EXCLUDE 列表、复制逻辑、关键文件校验、退出码语义一致；**修改后必须双平台都验证一次** |
| 修改 EXCLUDE 列表 | 必须同步 `install.sh` 与 `install.ps1` 的双平台 EXCLUDE 数组；**同步 `README.md` / `examples/install-check.md` 中 diff/robocopy 验证命令的排除参数**；修改后必须双平台都验证一次 |

### 程序化记忆相关

- [ ] 修改 `.kilo/memory/` 模板时是否同步 README.md 目录树？
- [ ] 修改 memory 触发条件时是否同步 `.kilo/instructions/workflow-reference.md` 的「程序化记忆触发条件」章节？
- [ ] 是否同步更新 `agent/coderAgent.md` / `agent/skills-writer.md` / `agent/reviewer.md` 的相关职责描述？

### instructions 与 prompt 联动检查

- [ ] 新增 `.kilo/instructions/*.md` 时，是否同步更新 `AGENTS.md` 的硬锚点与索引指针？
- [ ] 在 `.kilo/instructions/*.md` 中新增/修改 `[MARKER]` 定义时，是否同步搜索 `kilo.json` agent.*.prompt 和 `agent/*.md` 中对该 marker 的引用，确保引用方未引用已废弃或重命名的 marker？
- [ ] prompt 中引用 instructions 文件路径时，是否与 `README.md` 目录树中实际路径完全一致（无大小写/分隔符差异）？

## 已集中维护的规则

- fixer 轮次、升级阈值、Circuit Breaker：`.kilo/instructions/workflow-core.md`
- 三层错误恢复：`.kilo/instructions/reflection.md`
- 交付和验证底线：`.kilo/instructions/core.md` + `workflow-core.md`
- 需求扩散、同类点扫描、局部补丁拦截：`.kilo/instructions/workflow-reference.md`
- 修复方法论（全链路审计、完整阅读、验证剩余路径、推测与验证区分）：`.kilo/instructions/workflow-core.md` + `core.md` + `reflection.md`
- pre-checker 预审、checker 分层、fixer 权限约束：`.kilo/instructions/workflow-core.md`
- Skills 生命周期管理（触发条件、回写流程、分类规范）：`.kilo/instructions/skills-lifecycle.md`
- **安全/性能检测模式**（检测项总览、检测项 ID、INJ/PERF/AUTH 分类、检测流程）→ 集中维护在 `.kilo/instructions/security-checklist.md`；其他文件（`kilo.json` prompt、agent 文件、SKILL.md）只做引用。
- **输出格式规范**（交付输出的最小公共字段、`[MARKER]` 标记语言规范、状态枚举）→ 集中维护在 `.kilo/instructions/output-schema.md`；其他文件只做引用。
- **memory 触发条件** → 集中维护在 `.kilo/instructions/workflow-reference.md`「程序化记忆触发条件」章节和 `.kilo/memory/README.md`；其他文件只做引用。
- **SKILL.md frontmatter 规范**（含 keywords 数量 3–20、name 与目录名一致等）→ 集中维护在 `.kilo/instructions/skills-lifecycle.md`「SKILL.md frontmatter 扩展」章节和 `.kilo/skills/*/SKILL.md`；name 必须与目录名一致。

修改这些规则时，优先改主文档；agent 文件只保留必要引用和角色化执行要求。

> 与 `AGENTS.md` 的硬锚点索引交叉对照；两份清单内容必须保持一致。