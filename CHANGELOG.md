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
