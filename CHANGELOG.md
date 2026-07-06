# Changelog

本文件记录 `kilo_config` 全局配置仓库的演进。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [Unreleased]

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
