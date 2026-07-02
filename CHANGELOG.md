# Changelog

本文件记录 `kilo_config` 全局配置仓库的演进。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式，日期采用 ISO 8601（YYYY-MM-DD）。

本仓库版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

变更分组（按 Keep a Changelog 规范）：

- `Added` 新增功能
- `Changed` 既有功能变更
- `Deprecated` 即将废弃
- `Removed` 已移除
- `Fixed` 问题修复
- `Security` 安全相关修复

---

## [Unreleased]

### Changed - 2026-07-02: workflow.md 拆分与 MCP 默认精简
- 拆分 `.kilo/instructions/workflow.md` 为 `workflow-core.md`（自动注入，强制锚点：任务定级、编排强制检查点、安全敏感模块、SCOPE_CREEP、T3 升级、自动二检等）和 `workflow-reference.md`（按需读取，参考内容：small_model 触发规则、Trace-First、MCP 闸门、需求扩散、委派包、skills 回写、Anthropic 5 模式、程序化记忆触发条件、MEMORY 回写说明）
- `kilo.json` 中 `instructions` 数组用 `workflow-core.md` 替换 `workflow.md`；`workflow-reference.md` 标注为按需读取，不在自动注入列表
- MCP 默认精简：`kilo.json` 中 `context7.enabled` 与 `playwright.enabled` 由 `true` 改为 `false`，仅保留 `gitnexus.enabled: true`（按需启用 context7/playwright 需在 kilo.json 显式开启）
- 同步更新所有引用文件：`README.md` / `AGENTS.md` / `CONFIG_CHANGE_CHECKLIST.md` / `.kilo/instructions/{core,reflection,output-schema}.md` / `agent/*.md` / `.kilo/skills/**/*.md` / `.kilo/memory/README.md` 中对 `workflow.md` 的引用按内容归属改为 `workflow-core.md` 或 `workflow-reference.md`

### Changed - 2026-07-02: 启用 context 压缩（compaction.auto: true）
- `kilo.json` 中 `compaction.auto` 由 `false` 改为 `true`：启用 LLM 上下文窗口自动压缩，提升长对话速度与效率
- 保护机制：引用 `agent/coderAgent.md`「编排流持久化保护」节的 prompt 锚点保护——核心编排锚点位于系统提示级（不受压缩影响）；若早期内容被压缩冲掉，coderAgent 必须重新读取 `.kilo/instructions/workflow-core.md` 恢复编排规则并输出 `[RECOVERED_FROM_INSTRUCTIONS]` 标记
- 同步更新：`agent/coderAgent.md`「编排流持久化保护」段落中的 `auto` 描述已与 `kilo.json` 的 `compaction.auto: true` 一致
- 进一步压缩 `kilo.json` 全部 agent prompt：总字符从 3357 降至 1199（-64.3%）
- 扩展 `validate-config.mjs`：新增 [9/9] prompt 与 agent.md 过度文本重复检测（4-gram Jaccard，阈值 30%）

### Added - 2026-06-30: 通用性 / 扩展性 / 维护性 / 输出质量增强（第二轮）
- T0 极速通道新增调用方检查：即使 ≤2 行改动也必须 grep 调用方；命中 >1 个调用方 → 自动降级 T1
- checker L2 新增反向核对：扫描 diff 中是否存在验收标准未声明的改动（范围外实现、顺手重构、多余逻辑）；命中标记 `[SCOPE_CREEP]` 并 FAIL
- 验收映射表新增边界覆盖维度：每条验收标准必须覆盖正常 / 空值 / 异常三条路径
- executor-A / executor-B 输出模板新增「验收映射表」段（与 engineer 对齐）
- ensemble 编排输出模板列名统一（候选评估、双门禁、修复记录字段命名一致）
- `kilo.json` 中 `agent.prompt` 与 `agent/*.md` 同步规则成文写入 AGENTS.md「修改本仓库时的注意事项」（pre-checker 校验同步性，遗漏标记 `[MISSING_LINKAGE]`）
- README.md 新增模型路由原则表（任务等级 → 推荐模型族）
- `reflection.md` 新增同症状交叉引用规范（连续 2 轮 fixer 命中同症状时，必须引用三层判定 + memory 条目）
- 新增 `validate-config.mjs` 配置自检脚本（kilo.json schema 校验、必填字段、外部路径存在性）
- 新增 `CHANGELOG.md`（本文件）变更日志

### Added - 2026-06-30: 质量前移 + 循环防空转（第一轮）
- engineer 交付强制「验收映射表」（每条验收标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态）
- engineer 交付强制「上下文确认」（已读取的调用方、同类点、复用实现）
- checker 缺验收映射表判 `[MISSING_ACCEPTANCE_MAP]` 并 FAIL
- pre-checker 验收标准可验证性硬约束：不可验证项标 `[NEEDS_CLARIFICATION]` 并 FAIL
- fixer 根因回传强制：每轮修复必须输出「根因层（执行/方法/需求，引用 reflection.md）+ 修复点 + 是否同症状复发」
- fixer 连续 2 轮命中同症状 → 自动判定方法层失败，coderAgent 直接升级 reviewer，不再继续 fixer 轮次
- 委派包「验收标准」字段升级为硬约束：每条必须可验证；不可验证标 `[NEEDS_CLARIFICATION]` 退回
- review-simplification 新增残留标记清理检查（`[SPECULATIVE]` / `[UNVERIFIED]` / `[PARTIAL_IMPLEMENTATION]`）

### Removed - 2026-06-30: 移除 3 个 review-* 专审 agent
- 删除 `review-security.md` / `review-architecture.md` / `review-simplification.md` 三个专审 agent
- 原专审职责（安全边界 / 架构分层 / 简化审查）并入 `reviewer.md`，由 reviewer 内置覆盖三种视角
- 同步清理：`AGENTS.md` 智能体清单、`README.md` 模型路由表与目录树、`CONFIG_CHANGE_CHECKLIST.md` agent 引用示例
- 升级提醒：删除 agent 后必须重跑对应平台安装脚本（`./install.ps1` 或 `./install.sh`），将变更同步到全局配置目录 `~/.config/kilo/`，否则本地仍会残留已删除的专审 agent 出现在 agent 列表中

### Changed - 2026-07-02: 配置精简 / 可扩展性 / 索引同步重构
- 新增 `.kilo/instructions/security-checklist.md`：将 `agent/checker.md` 中硬编码的安全 / 性能检测模式结构化为可扩展清单（含检测项 ID、分类与判定规则）
- 新增 `.kilo/instructions/output-schema.md`：统一 checker / reviewer / engineer / fixer 的最小公共输出字段与 `[MARKER]` 标记语言规范
- 精简 `agent/checker.md`：删除硬编码检测模式与输出模板，改为调用框架并引用 `security-checklist.md` / `output-schema.md`
- 明确 `[SCOPE_CREEP]` 归属：由 checker L2 反向核对负责，reviewer 自动二检不重复检测（同步 `agent/reviewer.md` / `workflow-core.md` / `agent/feedback-collector.md` / `output-schema.md`）
- 压缩 `kilo.json` 全部 15 个 agent prompt：总字符从 5721 降至 3357（-41.3%），保留关键锚点
- 修正 `agent/coderAgent.md` 中 `compaction.auto` 描述：与 `kilo.json` 实际 `auto: false` 配置一致
- `workflow-reference.md` 新增 `small_model` 触发规则：明确适用场景（T0 极速通道 / 纯记录型 / 轻量预审 / 结构化总结）与不适用场景（主控 / 实现 / 审查 / 修复 / 复杂规划 / 知识沉淀）
- 扩展 `validate-config.mjs`：从 4 项检查扩展到 8 项，新增 frontmatter 合规性 / prompt 引用路径存在性 / README 目录树一致性 / AGENTS 与 CHECKLIST 索引一致性
- 更新 `README.md`：目录树与 `small_model` 路由说明同步
- 更新 `AGENTS.md`：智能体清单索引与 `CONFIG_CHANGE_CHECKLIST.md` 检查项同步

---

## Earlier

### 初始全局配置骨架
- 仓库初始化：`kilo.json`（Kilo 运行时配置）+ `AGENTS.md`（智能体清单与分层原则）+ `.kilo/instructions/`（core.md / workflow.md / reflection.md 三份轻量规则）+ `agent/`（各智能体详细规则）
- `install.ps1` / `install.sh` 双平台安装脚本
- `LICENSE` / `README.md` / `.gitignore` / `.editorconfig` 项目级元数据
- 智能体清单：coderAgent / engineer / architect / reviewer（主审 + 3 个专审）/ skills-writer / ensemble / executor-A·B·C / synthesizer / checker / pre-checker / fixer

### 程序化记忆集成
- 引入 `.kilo/memory/` 双轨设计（参考 Hermes Agent）：`MEMORY.md`（≤2200 字符，系统级冻结约束）+ `USER.md`（≤1375 字符，用户偏好）
- 任务启动时由 coderAgent 加载注入；优先级 MEMORY > USER > 项目 AGENTS > 全局 instructions
- review-security 检查敏感信息（API Key / Token / 密码 / 内部地址）是否被意外写入，命中即 `[MEMORY_SENSITIVE_LEAK]` 必须清理
- MEMORY.md 超 2200 字符时由 skills-writer 触发归档协议（迁移至 `archive/YYYY-MM/`）

### Skills 生命周期管理
- 新增 `.kilo/instructions/skills-lifecycle.md`：回写触发条件、回写流程、约束
- Skills 5 分类：`architecture/`（模块划分 / 依赖方向 / 跨层限制 / 新逻辑落点）、`patterns/`（可复用实现范式）、`anti-patterns/`（反复踩坑 / 禁止事项）、`contracts/`（API / 数据 / 事件契约）、`testing/`（测试策略 / 回归约定 / 高风险链路）
- 写入约束：禁止自动编造规则；进入长期知识库的内容必须经过闭环验证（触发条件匹配 + checker/reviewer 客观验证通过 + 标注验证证据来源）
- 禁止在多个 skills 文件中重复维护同一规则

### MCP 扩展
- 新增 `context7`（远程，文档查询）
- 新增 `gitnexus`（本地，代码知识图谱 / 影响面分析 / 执行流追踪）
- 新增 `playwright`（本地，浏览器行为验证）
- MCP 使用闸门：T0 默认不调用 GitNexus；T1 仅在调用链 / 同类点 / 接口契约场景调用；T2/T3 / 需求扩散 / Trace-First / API / 数据 / 权限 / 核心逻辑变更优先使用 GitNexus；Context7 仅用于外部库文档；Playwright 仅用于 Web 行为验证

### skills.external_dirs 跨项目复用
- `kilo.json` 新增 `skills.external_dirs` 数组字段，允许引用外部 skills 目录
- 约定：external_dirs 指向的目录为只读，禁止写入
- review-architecture 审查锚点：external_dirs 配置不得破坏项目分层与只读约定
- skills-writer 写入约束：不得写入 external_dirs 指向的目录

---

## 版本说明

本仓库尚处 0.x 演进阶段，未发布稳定版本。每次配置演进都按 `Added / Changed / Deprecated / Removed / Fixed / Security` 分组记录在 `[Unreleased]` 下；首个发布版本将在功能集稳定后以 `[1.0.0] - YYYY-MM-DD` 形式发布。
