# Changelog

本文件记录 `kilo_config` 全局配置仓库的演进。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [Unreleased]

- **2026-07-19**: 记忆模块 v2.0 边界封装（S3 方案：模块边界 + 4 层分离，零行为变更）。
  - **新模块结构**：`.kilo/memory/` 目录内分 4 层（schema / policy / contracts / 入口文档），所有记忆相关文件收敛到单一目录。
    - `schema/init.sql` — DDL 唯一源（5 表 + 索引 + 视图）
    - `policy/dispatch_recorder.md` — dispatch_log 写入规则
    - `policy/fact_dedup.md` — fact_store 去重 + 写入规则
    - `policy/failure_recorder.md` — failure_db 写入规则
    - `policy/skill_upgrade.md` — fact_store 触发 skill 升级检测
    - `policy/model_calibration.md` — model_calibration 更新规则
    - `policy/query_strategy.md` — 任务开始 + 失败回溯查询规则
    - `policy/init_check.md` — memory.db 4 步初始化 SOP
    - `contracts/health_check.sql` — 标准化健康度 SQL（5 项检查）
    - `README.md` — 公共 API 文档（外部模块唯一应看的入口）
    - `AGENTS.md` — 模块对 agent 的指令入口（运行时注入）
  - **旧文件改造为指针文件**（保留兼容路径，0 行为变更）：
    - `evolution.md` 从 232 行精简为 60 行（指向 4 个 policy）
    - `skills-lifecycle.md`「回写流程」段落删除（指向 fact_dedup.md）
    - `skill-upgrade.md` 整文搬走，本文件保留为指针
    - `memory-strategy.md` 整文搬走，本文件保留为指针
    - `init.sql` 改为向后兼容指针（DDL 唯一源迁到 schema/init.sql）
    - `MEMORY.md` / `USER.md` 加载机制引用更新到 AGENTS.md
    - `core.md` / `workflow-core.md` / `workflow-reference.md` 路径引用同步
    - 仓库根 `AGENTS.md` 第 8 条引用更新
  - **check14 升级**：「记忆模块完整性」校验，验证 11 个核心文件全部存在（README + AGENTS + schema + contracts + 7 个 policy）；旧 `memory-strategy.md` + `init.sql` 改为兼容可选
  - **check17 升级**：先校验 `contracts/health_check.sql` 契约文件存在；行为完全等价，仍是 5 项健康度（REQUIRED_TABLES / REQUIRED_INDEXES / REQUIRED_VIEWS / ROW_COUNTS / CHECK_CONSTRAINTS）
  - **零行为变更**：runtime 行为、SQL 模板、agent prompt 锚点、schema 字段、enforcement 模型**完全不变**；纯文件搬迁 + 指针改造
  - **diff 规模**：modified 12 文件 -594 / +154 行；新增 9 文件 ~36KB；总减少 ~600 行重复定义
  - **未来演进路径**：v3.0 自定义 MCP server（api/ 层）+ tool 强制执行 + 删除 `[MISSING_MEMORY_WRITE]` 标记；v4.0 跨会话语义检索 + 跨项目 fact_store 共享

- **2026-07-19**: 记忆飞轮 P0-P3 — 把「sqlite 优先」从文档层升级为 runtime 写入路径。
  - **P0 workflow-core.md「收尾自检」硬门**：T1+ 任务「经验沉淀」执行前必须按 checklist 勾选（dispatch_log INSERT → fact_store 去重查询 → failure_db 写入 → model_calibration 更新 → fixer error_code 回写 → skill 升级检测），缺任一项 → `[MISSING_MEMORY_WRITE]` 阻塞交付；路径口径统一为 `${HOME}/.config/kilo-data/memory.db`。
  - **P0 coderAgent.md「输出」段改写**：经验沉淀明确「T1+ 必走收尾自检硬门；md 写入仅作索引兜底；禁止直接 patch SKILL.md 承载新经验」。
  - **P1 skills-lifecycle.md「回写流程」改写**：6 步改为「识别→验证→**去重 SQL 查询**→**INSERT sqlite fact_store 主路径**→异步 skill 升级检测→链接」，新增 V1 阶段人工审批 gate；SKILL.md 不再是经验入口。
  - **P1 workflow/SKILL.md Step 4 改写**：主路径改为 `INSERT/UPDATE sqlite fact_store`，MEMORY.md 不再接收新经验条目；记忆架构表扩展为 L1-L7（新增 L1 经验 / L2 调度日志 / L3 模型校准三层 sqlite 主路径）。
  - **P2 reviewer.md「是否值得回写 skill 判定」改为 SQL**：先 `SELECT fact_id, hit_count, confidence FROM fact_store` 查历史命中数，三分支判定（命中升级 / 命中仅累计 / 未命中 INSERT），主观判定 → 数据库查询。
  - **P2 engineer.md「是否值得回写 skills」自检删除**：改为「INSERT sqlite fact_store（命中数自动累计，不再由人判）」+ 明确「禁止直接 patch SKILL.md 承载新经验」。
  - **P3 validate-config.mjs 新增 check17**：memory.db 健康度校验（5 表结构存在性 + 行数统计 + `[MEMORY_LAYER_HOLLOW]` 告警），适配 better-sqlite3 / sqlite3 CLI 双后端；总校验项 16→17。
  - **依赖收敛**：check17 通过 `require('better-sqlite3')` / sqlite3 CLI / 仅确认文件存在 三级 fallback，不引入硬依赖。
  - **遗漏修补**：evolution.md §步骤 1 dispatch_log INSERT 模板补齐 `initial_tier / final_tier / review_mode / tier_deviation` 四字段（commit 8a71114 加的两阶段定级同步落库），否则 coderAgent 按旧模板执行时丢字段、下游模型校准失效；output-schema.md 标记语言表新增 `[MISSING_MEMORY_WRITE]` + `[MEMORY_LAYER_HOLLOW]` 两条标记。

- **2026-07-19**: 组件化与重复模式治理强化。
  - **新增 skill**：`.kilo/skills/component-driven-fixes/SKILL.md`，给出跨页面/组件重复 UI/样式/行为问题的六步组件化修复决策树、典型示例、失败标记。
  - **核心规则升级**：`core.md` 新增「组件化优先 / 重复模式拦截」原则与编码前「重复点/同类模式扫描确认」；`workflow-core.md` 新增「重复模式修复 / 组件化 SOP」与质量门禁 `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`。
  - **agent 执行链闭合**：`agent/coderAgent.md` 新增「重复模式硬门」；`agent/engineer.md` / `agent/architect.md` 写入全量扫描与组件化方案要求；`agent/checker.md` / `agent/reviewer.md` / `agent/fixer.md` / `agent/pre-checker.md` 补齐四个新失败标记的检测、审查、修复、预审路径。
  - **反模式固化**：`anti-patterns-process/SKILL.md` 新增 AP-014「逐页补丁式修复」；`anti-patterns/SKILL.md` 索引更新为 14 条并重新排序。
  - **清理冗余**：删除过时的 `.kilo/agent/` 目录，消除与 `agent/` 下权威 agent 定义的双源漂移；`CONFIG_CHANGE_CHECKLIST.md` 与 `workflow-reference.md` 同步权威源指针。

- **2026-07-18**: 闭环体检 + 6 项缺口修复。
  - **P0 README 双源漂移修复**：`kilo_config/` 仓库内无 `hermes/` 子目录（原描述路径错误，实际产物在外层 `hermes_config/`），删除 README.md §目录结构 中错误的 hermes 子树。
  - **P0 kilo.json 路径跨平台化**：`sqlite` MCP 路径 `C:\Users\Administrator\.config\kilo-data\memory.db` → `${KILO_DATA_DIR}/memory.db`；`skills.external_dirs` Windows 绝对路径 → `${KILO_CONFIG_DIR}/.kilo/skills` + `${HOME}/.agents/skills`；install.ps1/sh 末尾新增「kilo.json 占位符替换」步骤（sed/Set-Content 双平台实现），install 后路径才落地。
  - **P1 ensemble 并发配额**：`workflow-core.md` 异常路由表后新增「ensemble 并发配额」章节，3 executor + 1 synthesizer 硬上限；触发 RATE_LIMIT 自动串行化；3 次失败 → 降级 single-engineer；新增 `[ENSEMBLE_DEGRADED]` / `[ENSEMBLE_ABANDONED]` 标记。
  - **P1 fixer error_code 强制回写**：`evolution.md` 步骤 1.5 新增「fixer 修复后 error_code 强制回写」段（`FIXED_BY_FIXER_ROUND_N` 标记），即使单轮修复成功也必须 UPDATE dispatch_log，便于计算 fixer 单轮修复率；新增 `[MISSING_FIXER_WRITE]` 标记。
  - **P1 reviewer 输出格式对齐**：`reviewer.md` 改为「markdown 主输出 + JSON 摘要同步」双格式；`output-schema.md` §reviewer 输出格式 增加说明「coderAgent 优先解析 JSON 摘要，缺失回退 markdown」。
  - **P2 validate-config 新增 check16**：kilo.json 占位符校验（必须被 install 双脚本替换）+ README.md §目录结构 声明目录必须在仓库根目录存在（防双源漂移）；总校验项 15→16。
  - **新增标记**：`[MISSING_FIXER_WRITE]` / `[ENSEMBLE_DEGRADED]` / `[ENSEMBLE_ABANDONED]`（写入 `output-schema.md` 标记语言表）。

- **2026-07-18**: 记忆飞轮修复 + 引擎参数入配置 + 校验器漂移治理。
  - **记忆库迁出清空区**：sqlite 路径 `~/.config/kilo/memory/memory.db` → `~/.config/kilo-data/memory.db`（install.ps1 全量清空策略不再误删知识库）；`kilo.json` / `core.md` / `workflow-core.md` / `.kilo/memory/memory-strategy.md` 四处路径口径统一；删除不存在的 `init-db.ts` 幽灵引用，初始化统一为执行 `.kilo/memory/init.sql`。
  - **kilo.json 引擎分层**：顶层 model → `hx/kimi-k3`；agent 节新增 `variant` 字段（kimi 系 `high`、glm-5.2 `max`、MiniMax-M3 `thinking`）；checker/fixer 从 `deepseek-v4-flash` 升级 `kimi-k2.7-code`；温度分层（执行 0 / 主控 0.3 / 审查 0.2）；清除 11 处 `prompt` 误用（"参见 xxx"/单词），coderAgent 替换为含 8 个锚点关键词的真锚点 prompt；compaction `prune: true`、`preserve_recent_tokens` 120000→60000。
  - **workflow-core.md**：新增「规范统一 / 审计类任务 SOP」五步（全量扫描→组件化→注释溯源→防复发→反向验证）与「T1 直办条款」。
  - **workflow-reference.md 重建**：恢复被 README/清单引用但缺失的文件（small_model 触发规则 / 程序化记忆 / 需求扩散与同类点扫描）。
  - **agent frontmatter 补全**：executor-A/B/C、synthesizer、ensemble 补 color/hidden/steps/permission（执行器对齐 engineer 权限，synthesizer/ensemble 收敛只读）；coderAgent 补 `hidden: false`。
  - **skills 治理**：18 个 SKILL.md 裸字符串 keywords 批量转 flow 数组；`skills-lifecycle.md` 新增 30 个 skill 的分类总表（check3 声明源）。
  - **validate-config.mjs 校验维度变更**：check14 由「kilo.json memory.enabled 字段存在性」改为「.kilo/memory/ 策略与 schema 文件存在性 + 废弃 memory 字段检测」（对齐 CONFIG_CHANGE_CHECKLIST.md 第 54 条）；parseFrontmatter 新增 YAML flow 数组解析（`keywords: [a, b]` 与块式数组等效）；check12/check13 对齐 Hermes 实际布局（产物校验指向外层 `hermes_config/`，必检清单更新为 SOUL.md/config.yaml/.hermes.md/USER.md/skills/workflow；install-hermes 双脚本路径指向外层仓库根）。
  - **skills 发现路径修复**：`kilo.json` 新增 `skills.external_dirs`（指向 install 实际安装路径 `~/.config/kilo/.kilo/skills` + 社区技能源 `~/.agents/skills`），修复 30 个全局 skills 无法被 skill 工具发现的断裂；`core.md` / `skill-upgrade.md` 全局 Skill 层路径统一为 `~/.config/kilo/.kilo/skills/`（原 `~/.config/kilo/skills/` 为错误口径）。

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
