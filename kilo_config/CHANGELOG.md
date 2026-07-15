# Changelog

本文件记录 `kilo_config` 全局配置仓库的演进。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [Unreleased]

- **2026-07-15**: 记忆系统可插拔化改造 —— L1/L2 硬编码注入与回溯规则全面条件化。
  - `kilo.json` 新增 `memory.enabled` 总控开关（默认 `true`，向后兼容）。为 `false` 时优雅降级：跳过 MEMORY.md/USER.md 自动注入、跳过 `kilo_local_recall` 强制回溯、跳过 skill-usage.log 追加，不删除文件、不报错。
  - `AGENTS.md` / `core.md` / `workflow-core.md` / `reflection.md` / `skill-usage-tracking.md` 中所有记忆相关规则改为条件执行。
  - `agent/coderAgent.md` / `engineer.md` / `architect.md` / `checker.md` / `fixer.md` / `reviewer.md` 的 skill-usage.log 追加要求改为条件追加。
  - `MEMORY.md` / `USER.md` 加载机制说明改为条件注入。
  - `.kilo/skills/workflow/SKILL.md` 记忆回写与回写后验证改为条件执行。
  - `validate-config.mjs` 新增 check14（`memory.enabled` 字段存在性与类型校验），总校验项 13→14。

### Added
- **2026-07-07**: 接入 Holographic 记忆提供商——真自学习记忆系统落地。
  - `hermes/config.yaml` 新增 `memory.provider: holographic` + `plugins.hermes-memory-store` 配置（auto_extract: true 启用自动事实提取）。
  - Holographic 是 8 个 Hermes 记忆提供商中唯一**免费 + 本地 SQLite + 零外部依赖**的方案：
    - `fact_store`（9 动作：添加/搜索/探测/相关/推理/矛盾/更新/删除/列出）
    - `fact_feedback`（信任评分训练，+0.05/-0.10 非对称反馈）
    - `probe`（针对特定实体的代数式回忆）
    - `reason`（跨多实体的组合 AND 查询）
    - `contradict`（自动检测冲突事实）
  - `hermes/SOUL.md` 补充「记忆系统」章节：L1 内置 MEMORY.md + L2 Holographic + L3 session_search + L4 gitnexus 四层架构。
  - `hermes/SOUL.md` 自进化闭环升级：Step 4 经验回写增加 `fact_store add` 自动提取 + 信任评分；Step 5 增加回写后 `fact_feedback` 标注信任度。
  - `hermes/.hermes.md` 锚点 8 更新：经验回写用 `fact_store` 自动提取 + 信任评分。
  - **架构升级**：从"MEMORY.md 2200 字符手动维护"升级为"Holographic 自动事实提取 + 语义检索 + 信任评分 + 矛盾检测的真记忆系统"。
- **2026-07-07**: C 档方案落地——Kilo + Hermes 双轨架构，获得框架级 SOTA 能力。
  - 新增 `hermes/` 目录存放 Hermes Agent 配置产物：
    - `hermes/SOUL.md`：身份文件，从 coderAgent + workflow-core 提取编排精华（T0-T3 定级、7 节点流程日志、checker/reviewer 门禁、SCOPE_CREEP、验收映射表、自进化闭环、压缩后结构化恢复模板）。
    - `hermes/config.yaml`：从 kilo.json 迁移 provider/compression/mcp/delegation/memory/skills 配置，适配 Hermes 双层压缩 + Anthropic prompt caching。
    - `hermes/.hermes.md`：项目上下文文件，从 AGENTS.md 迁移编排锚点 + 工具体系映射表 + 子代理委派策略。
    - `hermes/memories/`：复制 MEMORY.md + USER.md（Hermes 原生兼容 2200/1375 字符限制）。
    - `hermes/skills/`：复制 4 个技能分类（anti-patterns/patterns/workflow/hermes-migration，agentskills.io 标准兼容）。
    - `hermes/delegate-templates/README.md`：从 12 个 agent.md 提取 delegate_task 委派模板（engineer/checker/fixer/reviewer/architect/pre-checker/ensemble）。
  - 新增 `install-hermes.ps1` + `install-hermes.sh`：双平台 Hermes 配置安装脚本，同步 `hermes/` 到 `~/.hermes/`。
  - `validate-config.mjs` 新增 check12（Hermes 产物存在性：SOUL.md/config.yaml/.hermes.md/memories/skills/delegate-templates）+ check13（install-hermes 双平台 EXCLUDE 一致性）。总校验项 11→13。
  - `README.md` 目录树新增 `hermes/` 子树 + install-hermes 脚本说明。
  - **架构定位**：Kilo 保留为编排规则 + 项目知识层（B 档优化全部保留），Hermes 作为执行引擎获得 47 工具 + execute_code + session_search + prompt caching + delegate_task + checkpoint + RL 训练等框架级 SOTA 能力。两套配置共享 `~/.agents/skills` 社区技能源。
- **2026-07-07**: 极强自进化编码智能体升级——基于 Kilo 真实工具构建可落地的自学习闭环。
  - 新增 `.kilo/skills/workflow/SKILL.md`：自进化工作流技能。基于 `kilo_local_recall`（跨会话记忆检索）+ `gitnexus_*`（代码图谱）+ git history（持久经验）构建真实可落地的自我学习闭环。定义记忆三层架构（L1 冻结快照 / L2 跨会话历史 / L3 代码图谱 / L4 持久经验）、5 个触发条件、5 步闭环流程。不依赖 LLM 自觉回写（已证明无效），每一层都用真实工具驱动。
  - 新增 `.kilo/skills/hermes-migration/SKILL.md`：Kilo → Hermes 迁移工具包（C 档方案）。包含迁移映射表、SOUL.md 模板、config.yaml 模板、9 步迁移流程、VS Code/Trae 编辑器集成、回退方案。保留 Kilo 编排哲学精华，获得 Hermes 47 工具+execute_code+session_search+prompt caching+delegate_task+checkpoint+RL 训练等框架级 SOTA 能力。
  - `core.md` 新增「自进化触发点」章节：4 个触发条件命中时强制调用 `kilo_local_recall` 执行跨会话根因回溯。
  - `core.md` Memory 探测扩展为「三层记忆架构」：L1 冻结快照 + L2 跨会话历史（kilo_local_recall）+ L3 代码图谱（gitnexus）。
  - `reflection.md` memory 回溯扩展为「跨会话根因回溯协议」：检索历史 → 判断命中 → 代码图谱验证 → 回写留痕，4 步真实工具驱动流程。
  - `skills-lifecycle.md` 新增 `workflow/` + `hermes-migration/` 两个技能分类。
  - `skills-lifecycle.md` 新增「社区技能发现」章节：6 个已知社区技能源（anthropics/skills、openai/skills、vercel-labs/agent-skills、skills.sh、well-known 端点、VoltAgent/awesome-agent-skills）+ external_dirs 启用方式 + Hermes 迁移说明。
  - `kilo.json` 启用 `context7` MCP（远程文档检索增强编码准确度）；`skills.external_dirs` 指向 `~/.agents/skills`（社区技能源）。
  - 同步更新 README.md / AGENTS.md 目录树与引用。

### Changed
- **2026-07-06**: 删除伪自进化功能 + 采纳 agentskills.io 标准 + 借力 Hermes 协同（B 档优化）。
  - 删除 `feedback-collector` / `experience-ranker` / `skills-writer` 3 个 agent（LLM 自觉回写=无效，无运行时落地）。
  - 删除 `.kilo/experience/` 整个目录（wins.json/skill-index.json/log/ 从未真正消费）。
  - 删除 `skills-lifecycle.md` 的 BM25 假检索机制章节（无实现代码），改为"coderAgent 判断相关性"。
  - 简化 `workflow-reference.md` 的"程序化记忆触发条件"+"交付 MEMORY 回写说明"长篇协议为精简版。
  - SKILL.md frontmatter 对齐 [agentskills.io](https://agentskills.io/specification) 开放标准（name 小写连字符+与目录名一致、description ≤1024、渐进式披露、目录结构建议），可与 Hermes / Claude Code 互通。
  - `coderAgent.md` / `engineer.md` / `checker.md` 顶部加"独立上下文声明"（委派 subagent 不继承父会话，必须传完整委派包）。
  - `core.md` 顶部加"压缩后结构化恢复模板"（Goal/Constraints/Progress/Decisions/Next Steps，对标 Hermes ContextCompressor）。
  - `kilo.json` compaction 参数调优：`threshold_percent` 85→70（提前压缩）、`tail_turns` 12→20（对齐 Hermes protect_last_n）、`preserve_recent_tokens` 60000→80000。
  - `kilo.json` coderAgent.prompt 锚点关键词从 11 个缩减为 8 个（删 feedback-collector/skills-writer/experience-ranker）。
  - `validate-config.mjs` check10 从"skill-index.json 一致性"重写为"SKILL.md frontmatter 合规性"（name 与目录名一致 / description ≤1024 / keywords [3,20]）；check9 锚点列表同步缩减。
  - 同步更新 README.md / AGENTS.md / CONFIG_CHANGE_CHECKLIST.md / examples/install-check.md 目录树与引用。
  - agent 数：15 → 12；流程规则行数减少约 30%；技能系统从封闭手工作坊转为 agentskills.io 开放标准。
- **2026-07-03**: 架构审计与精简——消除 agent/*.md 顶部模板重复、安全/资源规则跨文件重复、格式字段重复；修复 validate-config.mjs 失效检查项；DRY 安装脚本 EXCLUDE 注释；精简 CHANGELOG / README / .kilo/memory/README.md。
  - 增强 validate-config.mjs check10：新增 SKILL.md frontmatter 与 skill-index.json 的 keywords 数量边界校验 [3, 20]（与 skills-lifecycle.md "SKILL.md frontmatter 扩展" 一致），index 与 frontmatter 各源单独校验以防御漂移。
- **2026-07-03**: 第三轮遗漏清理——skills 分类枚举从 5 分类（architecture/patterns/anti-patterns/contracts/testing）精简为 2 分类（patterns/anti-patterns），同步修正 skills-writer/reviewer/experience-ranker 与 skills-lifecycle.md 条目模板；清理 CONFIG_CHANGE_CHECKLIST.md 中 agentskills.io 残留引用；README.md 目录树补全 .kilo/experience/ 子树；删除 kilo.json dp provider 死配置（全仓无 dp/ 模型引用）。
- **2026-07-02**: workflow.md 拆分为 `workflow-core.md`（自动注入）与 `workflow-reference.md`（按需读取）；启用 compaction.auto: true；精简 kilo.json agent prompt（-64%）；新增 validate-config.mjs。
- **2026-06-30**: 质量前移——新增 pre-checker、checker L2 SCOPE_CREEP、fixer 根因回传、reviewer 三视角自检；移除 3 个 review-* 专审 agent。
- **2026-06-30**: 通用性增强——新增 output-schema.md / security-checklist.md / skills-lifecycle.md / experience-ranker / feedback-collector；精简 checker / reviewer 硬编码规则。

## Earlier

- 仓库初始化（kilo.json + AGENTS.md + core.md + workflow.md + reflection.md + agent/*.md）
- 程序化记忆集成（MEMORY.md / USER.md 双轨设计）
- Skills 生命周期管理（patterns / anti-patterns + frontmatter 规范）
- MCP 扩展（gitnexus / context7 / playwright）
- skills.external_dirs 跨项目复用

---

> 本仓库尚处 0.x 演进阶段，未发布稳定版本。
