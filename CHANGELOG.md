# Changelog

本文件记录 `kilo_config` 全局配置仓库的演进。遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。




## [Unreleased] i18n-render-design（中文 i18n 渲染器 4 unit 完工）

### Added

- **U1 `scripts/lib/stage-i18n.mjs`**（5 映射表 + 8 函数单一真相源）：STAGE_ZH（7 项：START/INIT/PLANNING/EXECUTING/QUALITY/DELIVERING/DONE）/ TIER_ZH（T0/T1/T2）/ STATUS_ZH（9 项，含 PENDING/PASS/FAIL 防御性补全）/ INTENT_ZH（INQUIRY/EXECUTION）/ VERDICT_ZH（PASS/CIRCUIT_BREAKER）；导出函数 labelOf/descOf/formatStage/formatTier/formatStatus/formatIntent/formatVerdict/formatTriple；未命中键走 warnOnce + passthrough。
- **U2 `scripts/i18n-render.mjs`**（CLI 渲染器，零依赖）：支持 `--map <MAP> <KEY>` / `--triple` / `--stage` / `--tier` / `--status` / `--intent` / `--verdict` / `--all` / 裸 KEY 五种入口；未命中 → stderr + exit 2。
- **U3 `scripts/flow-audit.mjs`**：i18n 一致性校验（5 映射表 39 键全枚举 → 全 stage-i18n.mjs 存在 → 全输出函数可调用）。
- **U4 `agent/conductor.md`**：铁律 §i18n 渲染规范（执行报告 / 失败诊断 / 单元派发 / 委派反馈 4 场景统一走 `formatStage/formatStatus/formatVerdict/formatIntent/formatTier`，禁裸 key 直出）。
- **U5（本轮 D5 补丁）**：`scripts/i18n-render.mjs` 补 `--stage`/`--tier`/`--intent`/`--verdict` 4 个 CLI 分支（与 `--status` 对称）；`scripts/lib/stage-i18n.mjs` STATUS_ZH 防御性补全 PENDING/PASS/FAIL；`scripts/lifecycle-doctor/checks/i18n-coverage.mjs` 纳管（5 映射 + 8 函数导出校验）；`README.md` 加 i18n 渲染器使用文档小节。

### Changed
- **去重 `agent/coder.md` §架构意识(33 → 4 行)**:消除与自动注入 playbook `coding-engineering.md` 的双源重复。原 §架构意识 + §落地流程 把组件化硬规则 4 条 + 反模式表 8 行 + 落地 9 步逐字复制进 coder.md,违反 DRY 且会双源漂移。现压缩为 4 行指针:`## 编码前架构自检` 标题 + 引用完整 playbook + 8 项反模式 checklist 锚点(checklist 锚点非冗余,与 reviewer.md:144 / reverse-auditor.md:114 各自保留对应)。`+4 -33` 净减 29 行;语义对齐 `coding-engineering.md` §组件化硬规则 / §反模式检测 / §落地流程 9 步。

### Added
- **`coding-engineering.md` 新增 `§系统规范优先` 段**(L13-44,5 条硬规则):
  1. **系统规范调研**(必跑):调官方 API / 扫仓库组件 / 看既有调用方,未跑 → `[LOCAL_PATCH]`/`[COPY_PASTE_FIX]`/`[REINVENT_WHEEL]`
  2. **调用而非侵入**:用组件公共 API/扩展点,禁止本地 fork/patch-package,侵入式改造 → `[INVASIVE_MOD]`
  3. **遵循系统约定**:命名/结构/错误处理与项目既定风格一致,标新立异 → `[STYLE_DRIFT]`
  4. **复用优先于造轮子**:同类需求已有 → 消费,跨 ≥2 处 → 必抽,自己写且不消费不抽 → `[REINVENT_WHEEL]`
  5. **优雅与简洁是结果**:架构优雅在前(调用而非侵入+复用而非造轮+遵循而非标新),代码优雅在后(见 §优雅编码硬标准)
- **`coding-engineering.md` §落地流程插新 step 2「系统规范调研」**,原 9 步改 10 步,序号顺延。frontmatter description 同步加"系统规范优先"作为索引入口。
- **3 个新增失败标记**:`[REINVENT_WHEEL]`(重复造轮子)/ `[INVASIVE_MOD]`(侵入式改造)/ `[STYLE_DRIFT]`(标新立异风格),verifier / reverse-auditor 可在后续接入对应检测。
- **同步范围**:install.ps1 已同步到全局 `~/.config/kilo/.kilo/instructions/coding-engineering.md`(81 → 115 行,lifecycle-doctor 378 PASS / 0 FAIL / 0 WARN)。其他无项目级 overlay 的项目立即生效。

## [Unreleased] tier-routing-unify-001（v3.x 重构）

### 路由开关统一为 tier

INQUIRY 任务不再直通 INIT→DELIVERING，与 EXECUTION 共用同一套 tier-based 路由。
任何任务（咨询/编码/写方案/需写脚本验证的咨询/审查）都按 tier 走流程：

- **T0**：INIT → EXECUTING → DELIVERING（无设计门/验证/审查）
- **T1/T2**：INIT → PLANNING → EXECUTING → QUALITY → DELIVERING

### 关键变更（5 类文件 + 1 类历史）

| 类别 | 文件 | 变更 |
|---|---|---|
| 图 | `lifecycle/graph.yaml` | 删 `INIT→DELIVERING when intent_type=='INQUIRY'` 边；4 条边 when 去 intent 条件 |
| 脚本 | `scripts/flow-audit.mjs` | `requiredStages` 去 intent 维度；INQUIRY 豁免→tier 豁免 |
| 脚本 | `scripts/transition-check.mjs` | `isExempt` 改 `!isT1orT2`（去 INQUIRY 豁免） |
| 脚本 | `scripts/lifecycle-doctor/runtime.mjs` | dispatch_provenance 豁免改 tier-based |
| 文档 | `lifecycle/stages/init.md` | 咨询类重定义；删 INQUIRY 直通段；任务定级改 INQUIRY 默认 T1 |
| 文档 | `agent/conductor.md` | 铁律#1 + 核心流程图改 tier 唯一路由 |
| 文档 | `.kilo/instructions/core.md` | 咨询类去"禁止改文件"硬约束 |
| 文档 | `AGENTS.md` | 锚点#1 改 tier 决定流程深度 |
| 文档 | `.kilo/instructions/workflow-detail.md` | Step 1 咨询类分支去"只分析"（**本轮补漏**） |
| 文档 | `docs/ARCHITECTURE.md` | 1.1 主图 L18 补 intent≠路由说明（**本轮补漏**） |
| 历史 | `CHANGELOG.md` L224 段 | **保留原文**——历史 changelog 不可改；v3 段（L224）记录的"INQUIRY 直通"已被本段 v3.x 替代 |
| 锚点 | `CHANGELOG.md` L224 段 | **本段 v3.x 重构自身内容定位**——INQUIRY 直通→tier-based 路由改造完整记录 |

### 兼容性

- INQUIRY T1+ 现需走完整委派（planner → coder → verifier）；flow-audit 不再对 INQUIRY skip
- T0 INQUIRY 极速通道保留（INIT→EXECUTING→DELIVERING）
- intent 仅作产物形态标记，决定 DELIVERING 输出模板（INQUIRY 模式 3 段 / EXECUTION 模式 4 段）
- 8 文件项目级 + 全局级 hash 同步；deploy 状态等效于 install.ps1 跑过

### 关联

- 上游 task: `kilo-config-tier-expand-001`（T1 EXECUTION，已 DONE）
- 本 task: `kilo-config-tier-audit-002`（查漏补缺，3 文档同步）

## [Unreleased] tier-routing-M1-reset-003（M1 INQUIRY 直通回归 + script-merge 工程化）

### M1 INQUIRY 直通回归
v3.x 把 INQUIRY 直通取消（tier-based 路由统一）后，实测 INQUIRY T0（纯问答）与 T1+（信息方案类）被强制走 coder/verifier/reviewer 全链路是过度工程化——INQUIRY 不写代码，没必要跑 coder/verifier/reviewer。M1 重新引入 INQUIRY 直通分流，但保留 EXECUTION tier-based 全流程：

- **INQUIRY + T0**：`INIT → DELIVERING`（纯问答极速，无 planner/coder/verifier/reviewer）
- **INQUIRY + T1/T2**：`INIT → PLANNING → DELIVERING`（planner 输出"分析方案 + 检索维度"后直送 DELIVERING）
- **EXECUTION + T0**：`INIT → EXECUTING → DELIVERING`（极速通道，无设计门/验证/审查）
- **EXECUTION + T1/T2**：`INIT → PLANNING → EXECUTING → QUALITY → DELIVERING`（完整链路）

intent 在 M1 后**参与路由**（INQUIRY 跳过 EXECUTING/QUALITY）+ **仍是产物形态标记**（决定 DELIVERING 内容组织：INQUIRY = 分析结论 + 证据表 + 维度覆盖；EXECUTION = 验收映射 + 变更摘要）。

### 关键变更（10 类文件）

| 类别 | 文件 | 变更 |
|---|---|---|
| 图 | `lifecycle/graph.yaml` | 新增 `INIT→DELIVERING when intent_type=='INQUIRY' and tier=='T0'` + `PLANNING→DELIVERING when intent_type=='INQUIRY'` 两条边；EXECUTION 边加 intent 守卫（防 INQUIRY 误入 EXECUTION 路径） |
| 脚本 | `scripts/flow-audit.mjs` | `requiredStages(tier, intentType)` INQUIRY 分流（INQUIRY T0→[INIT,DELIVERING]；INQUIRY T1/T2→[INIT,PLANNING,DELIVERING]）；顶层豁免注释 + 函数注释改写 |
| 脚本 | `scripts/transition-check.mjs` | provenance gate 新增 INQUIRY PLANNING→DELIVERING 直通分支（仅校验 PLANNING 必配角色 + post:PLANNING 恒定挂载，跳过 EXECUTING/QUALITY roles + review tiered mounts）；`isExempt` 注释更新 |
| 脚本 | `scripts/lifecycle-doctor/runtime.mjs` | dryrun SCENARIOS `apply-escalation` → `apply-tier-auto <task_id> <declaredTier> --agent conductor`；FAIL 提示文案同步 |
| 文档 | `lifecycle/stages/init.md` | §路由规则 M1 化（INQUIRY T0 直达 / INQUIRY T1/T2 经 PLANNING 直达 / EXECUTION tier-based）；§硬规则 #5 改用 `apply-tier-auto` |
| 文档 | `lifecycle/stages/delivering.md` | "Forward verification report + review report" 标注 "T1+ EXECUTION unified full; INQUIRY 直通无 verification/review" |
| 文档 | `agent/planner.md` | §分级输出 新增 `### INQUIRY 分析方案（M1 直通，≤500 tokens）` 段（核心结论 + 证据/来源 + 检索维度清单 + 维度覆盖矩阵 + 限制声明 + 风险对立假设；不输出 task_dag / acceptance_criteria / forbidden_files） |
| 文档 | `agent/conductor.md` | 铁律 #1 INQUIRY 参与路由（取消"不参与路由"）；铁律 #2 INIT 机械应用 config 改用 `apply-tier-auto`（单进程合并升级扫描 + defaults 应用）；step 0d retry_once 末尾补 ESCALATE 终止于 `retry.agent_timeout_max_retries=1` |
| 文档 | `AGENTS.md` | 锚点 #1 "意图只标注产物形态，不参与路由" → INQUIRY 参与路由分流描述 |
| 文档 | `docs/ARCHITECTURE.md` | §1.1 主图 L18 "产物形态标记，不参与路由" → "M1 起参与路由" |

### script-merge 工程化（本轮 H 段合并）

| 段 | 改动 | 收益 |
|---|---|---|
| **H1a** | pre-dispatch 吸收 timeout-guard start，新增 `--agent --tier` 参数 | dispatch 前单进程搞定 prompt 规模 + size + bash-guard + timeout_guard start |
| **H1b** | post-dispatch 合并 check+clear+log-dispatch 单进程 | 一次进程完成 timeout check → clear → provenance log（替代旧三连串行） |
| **H1c** | conductor.md step 0d 末尾加 ESCALATE 终止条件（retry.agent_timeout_max_retries=1，同节点不再二次 RETRY） | 文字铁律 vs 节点 on_fail 行为对齐 |
| **H2** | 新增 `scripts/quality-gate.mjs`（合并 acceptance-check + diff-boundary-check + search-discipline-check 三脚本单进程 sequential）；`lifecycle/stages/quality.md` §处理流程 5 步 → 1 个 quality-gate 调用 + 3 脚本 fallback 列表 | QUALITY 阶段前置机械门 fail-fast 单进程，省 2 次 node 启动 |
| **H3** | 新增 `task-context.mjs apply-tier-auto <task_id> <T0\|T1\|T2> --agent conductor` 子命令（单进程合并 apply-escalation 扫描升级 + apply-tier defaults 应用，one read/one write） | INIT 阶段省 2 次 node 启动 + 避免升级扫描与 defaults 应用之间数据漂移；旧 `apply-tier` / `apply-escalation` 子命令保留为单点降级路径 |
| 附带 | `task-context-runtime.mjs` `readTierDefaults` / `readTierEscalation` 包 `cachedDerive('tierDefaults' / 'tierEscalation', [CONVERGENCE_SOURCE], () => ...)` | 复用 mtime 缓存层，避免每次 dispatch 都全读全解析 config.yaml（高频脚本 ~ms 级命中缓存） |

### 兼容性 / 验证（待 Bash 恢复后跑）

- `node --check` 全部修改脚本（零语法错误）
- `node scripts/lifecycle-doctor/index.mjs` 全 PASS
- `node scripts/agents-smoke-test.mjs` 回归 PASS
- INQUIRY 3 类型手测（T0 直达 / T1 直通 / T2 直通）+ `flow-audit.mjs <task_id>` PASS

## [Unreleased] scan-cleanup-010

### Failed（subagent 报告虚报教训）
- **U2 README.md**：报告 PASS 但 L12/L188-190/L235 实际未改，rg GitNexus 仍命中 4 处
- **U4 workflow-core.md**：报告 PASS 但 L85/L96/L97/L99 实际未改
- **U6 agent/verifier.md + planner.md**：报告 PASS 但 L132/L137 实际未改
- **任务清单漏列**：agent/coder.md L108 与 148 行、lifecycle/stages/executing.md L26-27
- **subagent 报告虚报问题暴露**：必须用 byte-level 二次读（Get-Content 关键行 + git diff stat）作为通过证据，不可仅凭 subagent 报告

## [Unreleased] scan-cleanup-010b

### Decoupled 5 files 12 places
- **README.md**（L12/L186/L188-190/L233 — 4 处）：扩展入口内置 → 扩展入口可选；删除 GitNexus/Context7/Playwright 具体名
- **.kilo/instructions/workflow-core.md**（L85/L96/L97/L99 — 4 处，L92 §MCP 优先标题保留）：通用化 MCP 索引工具描述
- **agent/verifier.md**（L132）：gitnexus_api_impact → 可选 MCP 索引工具
- **agent/planner.md**（L137）：grep/glob/gitnexus → grep/glob/(可选 MCP 索引工具)
- **agent/coder.md**（L108 与 148 行 — 010 漏列）：优先 GitNexus → 可选 MCP 索引工具
- **lifecycle/stages/executing.md**（L26-27 — 010 漏列）：检索优先级链通用化
- **byte-level 验证**：6 文件 14 处二次读 + rg 0 命中 + git diff 6 文件 20+/20- + doctor 57 PASS + flow-audit ALL PASS
- **教训**：subagent 报告虚报 → U2 verifier 报 FAIL 与客观 byte-level 证据冲突，最终以 byte-level 为准

## [Unreleased] scan-cleanup-011

### Decoupled 5 files +30/-32（scan-cleanup-011 任务）

本任务(scan-cleanup-011)由 5 个 unit 组成:U1 kilo.json MCP 默认禁用 / U2 install 部署脚本去耦 / U3 CHANGELOG 决策 / U4 scan-encoding 静默退出修复 / U5 task 残留校验。
- **kilo.json**(3 MCP `enabled: false` + `_comment` + `_usage`):context7 / gitnexus / playwright 全部默认禁用,框架零第三方耦合
- **install.ps1**(L34 `.mcp-tmp` + L50-52 gitnexus PATH 预检段删除):排除目录通用化 + 删除第三方 CLI 强校验
- **install.sh**(L47 `.mcp-tmp/`):与 install.ps1 同步
- **CHANGELOG.md**(+20 行 010+010b 决策段):教训样本入库,避免重复
- **scripts/scan-encoding.mjs**(L292-296 空 diff info 提示):fix silent failure,无 dirty 时输出 `info: "no changes, 0 files scanned"` 而非裸 `[]`
- **M6 真实状况**:`$env:TEMP\kilo\task_context_*.json` 仅 2 文件(010b+011),非 50+ — 收敛为空操作校验
- **教训**:U5 verifier 一次误判(把 L36-39 Write-Host 横幅当 gitnexus 块 + 漏看 L34 `.mcp-tmp` + 路径错 `lifecycle-doctor.mjs` 当文件),retry 后 7/8 PASS + 1 warning(预期偏差非实现缺陷)
- **下一步**:012 5 清 3 防彻底闭环(subagent 虚报 + 任务漏列 + 缺 byte-level 门禁)


## 2026-08-04 Cleanup: 删 C 层 lessons + 处理 6 软铁律 + 8 agent frontmatter 去 coding-engineering 引用

- **删 `scripts/lessons.mjs`（276 行）+ `docs/lessons/` 整目录**：C 层教训闭环从未被使用（registry.jsonl 空库 = 0 数据），过度工程化；B 层 `coding-engineering.md` playbook 已接管"工程能力沉淀"职责
- **改 `lifecycle-doctor.mjs` S8 ironclad coverage check**：6 条纯文字软铁律（#1 #2 #5 #7 #10 #11）标 INFO（soft 透明化），不报 WARN；剩余 7 条硬铁律（有脚本门禁）标 PASS
- **改 `lifecycle-doctor.mjs` H3 check**：删除 lessons.store 检查（C 层不存在）
- **bump `max_files_per_task: 3 → 8`**：清理 lessons 时多文件 batch 编辑需求；超 8 应回流 PLANNING 拆单元
- **清理 8 agent frontmatter coding-engineering.md 引用**：B 层独立保留（仍自动注入），frontmatter 末尾"通用规则由运行时注入"行只保留 core.md + workflow-core.md
- **清理 6 处 lessons 引用**：conductor.md 铁律 #14 / AGENTS.md 知识沉淀 / quality.md:52 / workflow-core.md:244 / acceptance-check.mjs:20 / coding-engineering.md:12
- **同步 sync-agent-prompt**：conductor prompt 末尾"能力沉淀闭环"句从 kilo.json 删除
- **验证**：lifecycle-doctor 49+ PASS / 0 FAIL / WARN → 0（49+50=49，因 H3 删除少 1 PASS，ironclad 由 WARN→INFO）；sync drift=0
## [Unreleased]

- **chore(scan-cleanup-009 U5): 删 `scripts/heavy-test-e2e.mjs`（742 行）**
  - **理由**：8 次 scan-cleanup 累计未使用；全仓零正式引用（仅 `.tmp/heavy-test-report.md` / `.tmp/new-diffs.json` / `.tmp/new-plan.json` / `.tmp/plan-heavy-test.json` 临时产物 + 自身自引用）；git log 仅 1 commit（cf0de47 refactor(docs)），系单次验证任务产物（heavy-test-2026-08-06 U3）。
  - **功能替代**：`lifecycle-doctor.mjs` H1 脚本完整性门（检查 scripts/*.mjs 存在 & 可 import）+ R1-R9 runtime 检查已覆盖；`transition-check.mjs` 单独覆盖阶段流转。
  - **验证**：lifecycle-doctor 57 PASS / 0 FAIL / 0 WARN（实际基线，少 1 文件 H1 仍 OK）；全仓 `heavy-test` 引用仅剩 .tmp/ 临时产物（按规则不污染）。

- **fix(quality): 搜索纪律架构纯粹化——移除 gitnexus 硬编码耦合**
  - AGENTS.md #15 L4 段：gitnexus_query/gitnexus_impact/gitnexus_context → MCP 图谱/索引能力（工具无关）
  - kilo.json 8 agent prompt 末尾段同步
  - scripts/search-discipline-check.mjs：移除 detectGraphNotPreferred（gitnexus 特定硬编码）
  - lifecycle-doctor.mjs H3 段：4 函数齐 → 3 函数齐联动
  - Kilo 框架搜索纪律不绑定任何特定图谱实现，由当前环境 MCP 决定
- **feat(quality): 搜索纪律 T1 优化——四层阶梯 + 8 agent prompt 同步 + 机械门禁**
  - AGENTS.md #15 锚点：搜索四层阶梯 + 禁全仓无 include Grep + 业务仓库优先图谱
  - kilo.json 8 个 agent prompt 末尾加搜索纪律段（≤80 字符/agent）
  - 新增 scripts/search-discipline-check.mjs（4 类违规检测）
  - lifecycle-doctor 新增 H3 search-discipline 检测（PASS 数 50→51）
  - 验证：lifecycle-doctor 51 PASS / 0 FAIL / 0 WARN
- **2026-08-04**: QUALITY 提速--T1/T2 分档 + 机械前置门 fail-fast + verify/review 并行 + diff-boundary-check（T1 happy path ~30min -> ~12min，T2 保留全视角，质量由机械门托底不靠模型）。
  - **根因**：T1 半小时主因是 QUALITY--happy path 就 2 轮串行（verify -> review afterPass）+ reverse-auditor 绑最慢模型 deepseek-v4-pro 且 always-on 每轮跑 + 普通模型首版常 FAIL 触发 fix 轮。
  - **新增 `scripts/diff-boundary-check.mjs`（A 层第四机械门）**：读 `execution.changes` vs `plan.task_dag` 的 `key_files`/`forbidden_files`，机械防 SCOPE_CREEP/FORBIDDEN_TOUCH。exit 0 在界内 / 2 越界 / 1 无 plan 回退 LLM。把 reverse-auditor 的机械可覆盖职责转脚本断言。
  - **T1/T2 分档**：`agent/reverse-auditor.md` + `agent/reviewer.md` mount 加 `tiers: [T2]`--T1 不加载（走机械门+verifier 快通道），T2 全视角。`lifecycle/stages/quality.md` `required_roles` 从 `[verifier, reverse-auditor, reviewer, fixer]` -> `[verifier, fixer]`（reverse-auditor/reviewer 经 tiers:[T2] 仅 T2 加载，非 T1 必配）。
  - **机械前置门 fail-fast（QUALITY LLM 之前）**：`quality.md` v3 段--acceptance-check + diff-boundary-check 并行先跑，任一 exit 2 直接送 fixer（机械信号清晰，跳过本轮 LLM verify），全 PASS 才进 LLM hooks。conductor 铁律 #14 验收门 bullet 同步补 diff-boundary-check。
  - **verify + review 并行（1 轮替 2 轮）**：reviewer 去 `trigger: afterPass`，verify hooks + review hooks 同消息并行启动（视角隔离不变）。happy path 省 1 整轮。
  - **workflow-core.md review_mode 决策表**：T0=none / T1=fast（机械门+正向验证）/ T2=full（四视角全并行）。明示"T1 快通道不是质量打折"--质量由 acceptance-check（机器证明对）+ diff-boundary（机器证明在界）+ verifier + coding-engineering.md playbook 托底，判断类职责留 T2 升级。
  - **质量保证（不靠模型）**：T1 机械可覆盖职责（correctness/scope）由脚本门机器证明；判断类职责（LOCAL_PATCH/FAKE_CONTEXT/设计质量）由 coding-engineering.md playbook 注入 + 留 T2 升级 + lessons 闭环捕获复发。T2 复杂/安全/跨模块保留四视角完整审查。
  - **验证**：lifecycle-doctor 49 PASS / 0 FAIL / 2 WARN（required_roles 减 2 角色 -> PASS 数 51->49 正常；lessons.store 空库 WARN + 既有 ironclad WARN）；diff-boundary-check 三路径（越界+触禁 exit2 / 在界 exit0 / 无 plan exit1）；sync drift=0。

- **2026-08-04**: B 层编码工程能力沉淀--`coding-engineering.md` playbook 自动注入（设计模式决策表 + 组件化硬规则 + 优雅编码硬标准 + 反模式检测）。补齐三层沉淀的中间层。
  - **背景**：A 层（机械验证）+ C 层（教训闭环）已建，但 coder 自身工程能力仍靠模型即兴--普通模型不懂设计模式/组件化/优雅，写出来质量低、fixer 来回修、又慢又差。B 层把编码思维沉淀进程序，普通模型照顶级工程流程写。
  - **新增 `.kilo/instructions/coding-engineering.md`（全局自动注入，与 core.md/workflow-core.md 同级）**：
    - **设计模式决策表**：≥2 分叉先匹配模式（Strategy/Adapter/Factory/State/Observer/Decorator/Builder/Facade 等）+ YAGNI 守门（≥3 分叉或预期增长才引入）。禁止 if/else 长链。
    - **组件化硬规则**：≥2 处同类必须抽象（util/hook/component/service/adapter/mixin/design token）；抽象层级归位（UI/逻辑/集成分域）；数据流单向、依赖方向合规；公共 API 稳定；依赖注入；扩展点预留。违反 -- `[LOCAL_PATCH]`/`[COPY_PASTE_FIX]`。
    - **优雅编码硬标准**（可检测非审美）：命名/函数≤40行/参数≤4/嵌套≤3/early return/immutability/无魔法数字/边界错误处理/DRY 但不过度。
    - **反模式检测表**：God object/散弹手术/基本类型偏执/深嵌套/长参数列/注释代偿/死代码残留，含检测信号 + 修正。
    - **落地流程 9 步**（编码前过一遍，T1+ 硬门）：落点/依赖方向/复用优先/模式匹配/组件化前摄扫描/影响面/反模式自查/编码/改后 grep 调用方。
  - **接线**：8 个 agent .md 的"运行时注入"引用行加 coding-engineering.md；coder.md 架构意识段加指针（指向完整 playbook + 落地 9 步）。与 `docs/lessons/` 联动：本文件是**基线工程能力**（静态），lessons 是**积累的失败教训**（动态晋级）--coding 失败（LOCAL_PATCH 等）经 lessons 闭环晋级回填本 playbook。
  - **验证**：lifecycle-doctor 51 PASS / 0 FAIL / 2 WARN；sync drift=0。

- **2026-08-04**: 能力沉淀架构--C 层自改进教训闭环 + A 层可执行验收门（能力长在程序里，随使用越来越强，跟模型解耦；模型绑定不动）。
  - **原则**：LLM 判定的门禁随模型智商缩放，机械断言的门禁不缩放。把每一次失败自动沉淀成永久能力（程序规则或机械脚本门），agent 带着系统历史教训开干。普通模型 + 100 条教训 > 强模型 + 0 条教训。
  - **C 层 `scripts/lessons.mjs`（教训库 CLI，核心）**：跨任务持久教训库 `docs/lessons/registry.jsonl` + 晋级规则 `<category>.md`。子命令 record/get/audit/promote/list。闭环：捕获（QUALITY FAIL/fixer）-> audit 复发检测 -> 程序类自动晋级（追加规则到 <category>.md，git diff 可回退）/ 机械类提案（人工建脚本门，范本 scan-encoding.mjs）-> get 注入每次 dispatch。分类 = reverse-auditor issues[].tag + ACCEPTANCE_FAIL。
  - **A 层 `scripts/acceptance-check.mjs`（可执行验收门，第一门）**：读 `execution.acceptance_map[]`，机械跑每条 `verify_command`，exit code 硬门。在 LLM verifier 之前跑（fail fast）。exit 2=FAIL -> fixer + 捕获教训 / exit 1=无 verify_command 回退 LLM / exit 0=继续 LLM 做边界判定。把"代码对不对"从 LLM 判定转为机器证明。
  - **接线 `agent/conductor.md` 铁律 #14（能力沉淀闭环）**：pre-dispatch 注入（`lessons.mjs get --role <role>`）/ QUALITY verify 验收门（`acceptance-check.mjs`）/ FAIL 捕获（`lessons.mjs record`）/ on:done 晋级（`lessons.mjs audit`）。description 同步经 sync-agent-prompt 写入 kilo.json。
  - **schema**：`agent/coder.md` + `.kilo/instructions/output-schema.md` 的 acceptance_map 加可选 `verify_command` 字段（能机械化时必写，沉淀为机械门）。`workflow-core.md` 质量门禁表加"可执行验收门"+"能力沉淀闭环"两行。
  - **检测**：`lifecycle-doctor.mjs` 新增 H3 lessons 库完整性（registry.jsonl 每行可解析；首次空库 WARN 不 FAIL）。
  - **文档**：`docs/lessons/README.md`（三层沉淀模型 + 分类表 + 晋级生命周期 + "scan-encoding.mjs 是手动沉淀范本"说明）。
  - **模型绑定不动**：conductor + small_model 维持 `hx/MiniMax-M3`。质量提升走工程沉淀（机械门 + 注入规则 + 自改进闭环），不走换模型--目标普通模型也能输出顶级质量。
  - **验证**：lessons.mjs 端到端（record 3 条同类 -> audit 自动晋级程序类 -> get 注入可见）；acceptance-check.mjs 三路径（pass exit0 / fail exit2 / 无命令 exit1）；lifecycle-doctor 51 PASS / 0 FAIL / 2 WARN（lessons.store 空库 WARN + 既有 ironclad WARN）；sync drift=0；kilo.json 仅 conductor prompt 一处变更（数组紧凑格式保留）。

- **2026-08-04**: 编排工程化提速--pre-dispatch 门禁合并 + 独立单元默认并行（砍结构浪费不碰质量机制；模型绑定不动--质量靠工程沉淀，不靠换模型，目标是普通模型也能输出顶级质量）。
  - **改动 1·四连门禁 pre-dispatch 合并（零舍弃）**：`scripts/task-context.mjs` 新增 `pre-dispatch <task_id> --prompt-chars <N> [--file-count <F>]` 子命令--一次进程原子完成"写 dispatch_pending + prompt 规模校验 + size 校验"，返回单一 verdict（exit 0/1/2 语义与旧三连等价）。替代旧 `set dispatch_pending` + `dispatch-prompt-check` + `size-check` 三连串行调用，每次 dispatch 省 2 次 node 进程启动 + 2 个 conductor reasoning 回合。抽 `evalSizeCheck`/`evalDispatchPrompt` 纯判定函数（不副作用 exit），独立 `size-check`/`dispatch-prompt-check` 命令保留不动（doctor / 向后兼容）。T1 任务 ~6 dispatch ≈ 省 12 个 reasoning 回合。
  - **改动 2·独立单元默认并行（零舍弃，与改动 1 联动）**：`docs/conductor-full-spec.md` §智能体加载规则"主槽逐单元派发"段 + `AGENTS.md` 锚点 14 由"可并行同层单元"（许可式）改为"同层无依赖单元默认按并行组规则并行 dispatch"（默认式）；有 DAG 依赖的单元仍按依赖串行。`workflow-core.md` 早有"无依赖单元->并行执行"，但被四连门禁的串行脚本调用堵死--门禁合并后并行才真正可行。每单元仍独立 coder+verifier 闭环，视角隔离物理独立，质量不变，只省 wall-clock。多单元任务 EXECUTING 省 ~40-60%。
  - **模型绑定不动（质量走工程沉淀，不换模型）**：conductor + small_model 维持 `hx/MiniMax-M3`。明确放弃"换更强模型提质量"路径--目标是靠机械门禁把质量门槛固化进脚本/配置，使普通模型也能输出顶级质量。下一阶段工程化沉淀方向：可执行验收门（acceptance criteria -> test 命令 -> exit code 机械门禁，替代 LLM 判定）、符号存在性检查（防幻觉 import/API）、diff 边界检查（机械防 SCOPE_CREEP）、spec 冻结逐字重注入（防漂移）。
  - **同步范围**：`agent/conductor.md`（铁律 #9 step 0b+0a -> step 0 pre-dispatch + description + 每单元门禁 + 并行边界 + key_files 兜底引用）、`docs/conductor-full-spec.md`（§委派前工程化安全门合并+重编号 + §智能体加载规则默认并行 + 并行安全边界 + 异常表 [AGENT_UNAVAILABLE] 行）、`AGENTS.md`（锚点 13 门禁流程 + 锚点 14 并行）、`kilo.json`（conductor prompt 经 sync-agent-prompt 同步为 pre-dispatch description；模型绑定不动）。`lifecycle/config.yaml` 阈值字段不变（pre-dispatch 复用 `dispatch_prompt_threshold`/`size_check_threshold`/`max_files_per_task`）。
  - **明示不动（守"零舍弃"）**：三验证视角（verifier+reviewer+reverse-auditor）全保留；四连门禁检查语义全保留（只合并调用方式），exit code/审计/阻断不变；定级规则、"连 1 行也走设计门"、"拿不准就升档"、T0 前置硬否决、`max_total_cycles=3` 熔断、transition-check provenance gate 全不动；模型绑定不动。
  - **验证**：lifecycle-doctor 51 PASS / 0 FAIL / 1 WARN（WARN 为既有纯文字铁律覆盖率提示，与本次无关）；`node --check scripts/task-context.mjs` 通过；`sync-agent-prompt --check` drift=0；`pre-dispatch --prompt-chars 500` exit 0 PASS / `--prompt-chars 99999` exit 2 阻断 / 缺 `--prompt-chars` exit 2 用法错误 / 旧 `size-check` 独立命令仍可用。

- **2026-08-04**: 编排性能与检索本地化加固——gitnexus 默认启用 + context7 降噪 + 检索本地化规范 + T0 硬否决 + 逐单元派发。
  - **逻辑变更范围**：源文件改动与文档同步分两批落地，本条目一并记录。
  - **kilo.json**：`gitnexus.enabled: true`（默认启用本地调用链/影响面分析，替代慢速远程检索）；`context7.timeout` 8000→6000（降噪，减少远程文档等待）。
  - **`.kilo/instructions/core.md`**：新增 §检索本地化规范——rg 模板强制 exclude（`-g '!node_modules' -g '!dist' -g '!.git'`）、semantic_search 收紧（仅 rg 未命中且影响面 ≥3 文件时用）、LSP / 本地 `.d.ts` 优先于 context7；Context Engine 表「使用陌生第三方库」行加脚注 ¹（陌生 = 本地无该包 `.d.ts` / 无 LSP 类型定义 / 包名首次出现；命中顺序 grep → LSP → context7，前两者命中不得调用 context7）。
  - **`.kilo/instructions/workflow-core.md`**：新增 Step 1a「T0 前置硬否决闸门」4 条——(a) 改动 >3 文件 / (b) 跨模块（≥2 独立目录）/ (c) 需新增测试用例 / (d) 命中安全敏感关键词，任一命中禁止 T0、强制最低 T1；顺带修复 Step 2 标题「5 条全部满足」→「6 条全部满足」及 Item 6 语义（「命中扩散触发词」→「未命中扩散触发词（需求明确）」）。
  - **agent/conductor.md**：铁律 #2 补 T0 前置硬否决引用 +「五条标准」→「六条标准」；新增 §EXECUTING 逐单元派发——按 `plan.task_dag.units` 拓扑分层逐单元派发 task、每单元独立执行四连门禁（step 0b → 0a → 1 → 2）、单元 FAIL 仅重派该单元 coder（不重派已过单元）、禁止批量派发整个 EXECUTING 段。
  - **lifecycle/stages/executing.md**：`token_budget` 注释补「多单元按组分配」；编码前知识获取补检索优先级链（rg 本地 → LSP / 本地 `.d.ts` → gitnexus → context7）；编码改为「按当前 unit_id 编码，不跨单元改动」。
  - **同步范围**：`docs/conductor-full-spec.md`（主槽逐单元派发 + 委派包六条含 token_budget 预算声明 + T0 硬否决引用）、`AGENTS.md`（新增锚点 14 逐单元派发）、`README.md`（gitnexus 默认启用描述，两处）、全局配置 `~/.config/kilo`（install.ps1 purge 重建 + 本轮补齐 package.json / package-lock.json / node_modules 整体备份恢复（消除超前声明））。
  - **验证**：lifecycle-doctor 51 PASS / 0 FAIL；QUALITY 三轮收敛（verifier / reviewer / reverse-auditor 全 PASS）；flow-audit PASS。

- **2026-08-04**: 工程化防 abort 门禁升级——dispatch-prompt-check 事前审计门禁引入（三连→四连）。
  - **新增 step 0b dispatch-prompt-check**：conductor dispatch 前写入 `dispatch_pending.prompt_chars`（留痕）→ `task-context.mjs dispatch-prompt-check <task_id>` 校验——未写入/非法 exit 1（审计失败）；超限 exit 2（阻断）；通过 exit 0。替代“大任务 prompt 事后补救”模式，事前拦截大任务 abort 复发（根因：单次委派 8 文件 prompt 过大）。
  - **阈值字段**：`lifecycle/config.yaml` 新增 `dispatch_prompt_threshold: 3000`（小任务上限 ×1.5 安全系数，可调）+ `max_files_per_task: 3`；`lifecycle-doctor.mjs` D5 校验两字段存在性（缺失 FAIL，与 size_check_threshold 同硬门模式）。
  - **四连结构**：step 0b dispatch-prompt-check（事前）→ step 0a size-check（事前）→ step 1 log-dispatch（事后 provenance）→ step 2 overload_count（事后累计）。
  - **同步范围**：`agent/conductor.md`（铁律 #9 三连→四连 + frontmatter task_context.write 加 dispatch_pending + description）、`AGENTS.md`（锚点 13 三连→四连）、`docs/conductor-full-spec.md`（L158/221-226/258 三处）、`lifecycle/config.yaml`（阈值字段）、`scripts/task-context.mjs`（dispatch-prompt-check 子命令）、`scripts/task-context-runtime.mjs`（readDispatchPromptThreshold/readMaxFilesPerTask）、`scripts/lifecycle-doctor.mjs`（D5 校验）。
  - **验证**：lifecycle-doctor 51 PASS；`set dispatch_pending.prompt_chars 2000` → dispatch-prompt-check exit 0；`set 4000` → exit 2；未设置 → exit 1；grep “工程化三连” 清零（CHANGELOG 历史条目除外）。

- **2026-08-03**: frontmatter `mount[].tiers` 定级挂载字段引入 — 替代 `when: "config.agents.<key>"` 开关挂载。
  - **`tiers` 字段**：`mount[].tiers: [T1, T2]` 数组，dispatch 前按 `sizing.tier ∈ mount[].tiers` 机械过滤，命中才加载该挂载点智能体（例：plan-reviewer `tiers: [T2]`——T1 关闭、T2 开启方案审查）。
  - **`when` 语义收窄**：保留用于**非 tier 条件**（feature flag、环境变量等），仍对照 `config.agents.<key>` 求值。
  - **互斥规则**：`tiers` 与 `when` 在单条 mount 内互斥（同时声明由 lifecycle-doctor B4 拦截 FAIL）；无 `when` 且无 `tiers` = 恒定挂载（推荐默认）。
  - **同步范围**：`agent/conductor.md` L88、`docs/agent-mount-guide.md`（tiers 语法+互斥）、`docs/multi-agent-lifecycle-architecture.md` L152、`lifecycle/stages/README.md`（示例 tiers 替代写法）、`.kilo/instructions/output-schema.md` L216 `[PLAN_REVIEW_MISS]` 改 T2 触发、`.kilo/instructions/workflow-core.md` L175 设计门行、`docs/conductor-full-spec.md` L45/170 求值说明、`docs/ARCHITECTURE.md`、`docs/configuration-guide.md`（tier_defaults 示例删 plan_reviewer 相关）、`CONFIG_CHANGE_CHECKLIST.md`。
  - **验证**：lifecycle-doctor 全 PASS；全仓已无 plan-reviewer 的 `config.agents` 开关残留（改走 tiers 定级挂载）；`agent/` 无未迁移 `when: "config.agents"` 实例。

- **2026-08-03**: 定级规则优化——T1/T2 边界 AND→OR + 新增机制复杂度维度 + 升档硬规则硬化。
  - **T1/T2 边界 AND→OR**：T2 正向条件改为 OR（任一命中即 T2：安全敏感词 / 跨模块 / 5+ 文件 / 规则扩散 / 机制·契约变更）；T1 反向 AND（全部满足且无 T2 命中）；else 判据不足强制升档标 `[TIER_UPGRADED]`（成本不对称原则）。
  - **机制复杂度维度（Step 4a）**：排除条款（纯文案/格式/命名/删除/注释不属）+ 实质性门槛（≥2 下游消费方 / ≥2 单元 / 改变可观测行为）+ 3 类量化阈值（跨脚本耦合 / 架构语义 / 行为契约）。命中即升 T2，防复杂任务误判 T1。
  - **校准块对称标记**：`[TIER_UPGRADED]` 与 `[DOWNGRADE_AFTER_PLAN]` 对称写入；偏差规则下调门第(5)条"不命中机制复杂度，与 Step 4a 同源"。
  - **同步范围**：`.kilo/instructions/workflow-core.md` 定级决策树 + T1-T2 表 + 偏差规则。
  - **验证**：lifecycle-doctor 49 PASS；plan-reviewer 3 轮审查（C1/C2/I3/I4/M6 全部收敛）；verify + reverse-auditor + reviewer 全 PASS。

- **2026-08-03**: v3.2 编排策略由全局默认串行改为并行优先 — 官方 `task` 工具并发模式。
  - **策略变更**：`agent/conductor.md` 铁律 #11「全局默认串行策略」→「**全局默认并行策略**」——挂载点激活智能体 ≥2 且无 `after` 依赖时，conductor 在单条响应消息中并行发起多个 `task` 工具调用（官方并发模式：`Launch multiple agents concurrently whenever possible`）；有 `after` 的按拓扑排序串行执行；无 `after` 的按 agent 文件名字典序组织为同一并行组，共享一个零输出硬门；视角隔离仍物理独立（每个 task 独立 context）。
  - **同步范围**：AGENTS.md 锚点 12/13、`agent/verifier.md`、`agent/reverse-auditor.md`、`agent/reviewer.md`、`lifecycle/stages/quality.md`、`lifecycle/stages/README.md`、docs 5 文件（ARCHITECTURE / configuration-guide / agent-mount-guide / conductor-full-spec / multi-agent-lifecycle-architecture）的"串行"表述同步为并行优先；`quality.md` 编排规则附保留串行场景 4 项（有 after 相对依赖链 / fix→重新 verify / review hooks afterPass / 同一 after 链后继节点）。
  - **工程化门禁不变**：三连门禁（pre-dispatch size-check + log-dispatch provenance + overload_count 闭环）保持；并行 dispatch 前对每个待派发 task 逐个 size-check、结果返回后逐个 log-dispatch、任一 task 返回 >4000 字符 → `overload_count` +1。
  - **验证**：lifecycle-doctor 全 PASS；sync-agent-prompt drift=0；grep `agent/`、`AGENTS.md`、`lifecycle/stages/` 无"串行组/串行启动/全局默认串行策略/委派串行硬门"残留（保留串行场景清单除外）；docs "默认串行"清零。

- **2026-08-03**: 工作流框架简化 — 删除记忆板块，生命周期收敛为 5 阶段（INIT→PLANNING→EXECUTING→QUALITY→DELIVERING）。
  - **生命周期简化**：INTENT+SIZING 合并为 INIT（conductor 内建：意图判定+定级）；删除 T3 多模型子图（MM_SUBGRAPH/multimodel-graph.yaml/multiModel/coder-a/b/c/synthesizer-fusion）与可选审查视角（plan-reviewer/reverse-auditor/side-checker）；INQUIRY 直通 INIT→DELIVERING；T0 快通道保留；QUALITY 为检查(verifier+reviewer)→修复(fixer)→再检查自动循环，直到 PASS 才进 DELIVERING（熔断 max_total_cycles=3）。
  - **记忆板块移除**：删除 `.kilo/memory/` 整目录、`scripts/memory.py`、`docs/memory-ops-reference.md`、install 脚本 memory.db 初始化段、MEMORY_WRITE_COMPLETE gate 全链路（graph/transition-check/task-context/lifecycle-doctor）、AGENTS.md 锚点 8 与各 instructions/docs 的 M1-M8 引用。
  - **扩展机制保留**：pre:/post:/at:/hook 挂载点、on_fail、required_roles、tier_defaults（T0/T1/T2）——用户自建智能体丢 `agent/<name>.md` + kilo.json 绑模型即挂载，零改框架。
  - **验证**：lifecycle-doctor 全 PASS；全仓 grep 无 memory.py/MM_SUBGRAPH/multiModel/M4-M8 残留（CHANGELOG 历史条目除外）。

- **2026-07-31**: 全库清理与死引用闭环 — 去除无意义描述/未落地引用，补齐 memory 模块机械校验缺口，同步全局部署。
  - **死引用清零**：删除 memory-mcp 备用通道描述（`kilo.json` 无预埋、`test.js`/`test-stability.js` 不存在，v2.6.2 已删 api/）——`AGENTS.md` / `.kilo/instructions/core.md` / `.kilo/memory/AGENTS.md` / `README.md` 4 文件同步；validate-config check17/check14 引用改为真实执行者——`.kilo/memory/README.md`（L19/31/48/126 + 故障排查表 7 行 + 升级路径）与 `.kilo/memory/AGENTS.md`（L62）；`examples/install-check.md`（目录不存在）与 `check16` 引用从 `CONFIG_CHANGE_CHECKLIST.md` 移除。
  - **机制落地**：`agent/conductor.md` convergence-auditor 段补实际执行命令（`node scripts/trust-transfer-check.mjs <task_id> [--round N]`，读取 `%TEMP%/kilo/task_context_*.json`，与原脚本接口核对一致）。
  - **缺口补回**：`lifecycle-doctor.mjs` 新增 `memory.module.files` 检查（原 validate-config check14 功能）——校验 `.kilo/memory/` 4 个入口文件（README/AGENTS/schema:init.sql/contracts:health_check.sql）存在性；50 → 51 PASS。
  - **README 修正**：skills.paths 段改为与 kilo.json 实际两路径一致（`${KILO_CONFIG_DIR}/.kilo/skills` + `${HOME}/.agents/skills`）；目录树 health_check 描述改为真实执行者（memory.py check）。
  - **全局部署同步**：重跑 install.ps1 清除全局孤儿残留（validate-config.mjs / audit-*.mjs / dist / tests / lifecycle/stages/archive/*.v1 / 无消费者 node_modules+package.json），全局与仓库完全一致（EXCLUDE 除外）。
  - **验证**：lifecycle-doctor 51 PASS / 0 FAIL / 0 WARN；sync-agent-prompt drift=0；e2e-smoke 38 PASS；全仓 grep 无 validate-config/memory-mcp/examples/ 死引用残留（CHANGELOG 历史条目除外）。

- **2026-07-28**: v2.6.4 记忆通道兜底闭环 — check17 探测链与 install 初始化补齐 python memory.py 分支（查漏补缺失）。
  - **背景**：v2.6 已将记忆主通道切为 `python scripts/memory.py`，但两处运行时链路仍只认 sqlite3 CLI：① validate-config.mjs check17 探测链为 better-sqlite3 → sqlite3 CLI（含 winget 探测），python-only 机器会被误报 `[MEMORY_RUNTIME_UNAVAILABLE]`（主通道实际可用）；② install.ps1/install.sh 的 memory.db 初始化仅依赖 sqlite3 CLI，python-only 机器 memory.db 永不建表，主通道装好即残。
  - **validate-config.mjs**：check17 探测链末尾新增 python memory.py 分支（仅 CLI 缺失时进入，掩盖不了契约真实 FAIL）；经 `memory.py check` 一次调用完成 7 表存在性 + 行数解析，AP-/PAT- 迁移行数经 `query` 补查；dispatch_log=0 内联 `[MEMORY_LAYER_HOLLOW]` 提示；db 缺失 / 全通道不可用两处修复文案改为"memory.py exec-file（免安装）/ sqlite3 CLI"双路径。
  - **install.ps1 / install.sh**：Step 2 新增 python 回退——sqlite3 CLI 不可用时探测 python/python3 + `scripts/memory.py`，`touch` 空 db 文件后 `exec-file init.sql` 建表（memory.py 要求 db 文件预存在，空文件对 sqlite 即合法空库），并用 `memory.py check` 做健康验证；Step 1 提示文案同步声明回退存在。
  - **验证**：python 回退路径实测（临时 db exec-file init.sql → 30 表/视图/索引对象建成 + check 输出 7 核心表）；validate-config 29/29 PASS（本机 better-sqlite3 分支不受影响）；lifecycle-doctor 42 PASS；e2e-smoke 44 PASS。
- **2026-07-27**: v2.6.3 稳定性加固六建议落地 — 流转裁判 + e2e 回归 + doctor 守护 + 记忆通道切换 + 模型升级 + compaction 恢复协议。
  - **scripts/transition-check.mjs**（新增 434 行）：阶段流转机械裁判，读 graph.yaml 边定义 + task_context 求值 when/gate，exit 0/1/2/3；v2 quality.round 机械递增（进入 QUALITY 时 +1），熔断 exit 3；`MEMORY_WRITE_COMPLETE` 硬门（memory_write_status ∈ {OK, DEGRADED}）。
  - **scripts/e2e-smoke.mjs**（新增）：44 场景端到端回归（T0 极速通道 / T1 / T2 全链路含 FIXING 回流 / T3 子图闭环 / 单点+全局熔断 / gate 拒绝），全绿。
  - **scripts/memory.py**（新增）：Python stdlib sqlite3 封装主通道（check/query/exec/exec-file，--db/KILO_MEMORY_DB 覆盖），解决 sqlite3 CLI 本机缺失导致 M1-M8 全断的问题；10 个 agent/*.md 召回接口 + AGENTS.md/README/core.md/.kilo/memory 文档统一切换。
  - **kilo.json 模型绑定升级**：conductor→hx/kimi-k3、verifier→hx/kimi-k2.6、reviewer→hx/glm-5.2；docs/model-registry.md 补能力矩阵。
  - **agent/conductor.md**：机械流转段（transition-check 调用时机）+ compaction 后 task_context 恢复协议 + WRITE_MATRIX 标记；init.sql 340/345 种子叙事更新为 v2.6 措辞。
  - **验证**：lifecycle-doctor 42 PASS / 0 FAIL / 0 WARN；e2e-smoke 44 PASS；grep 全仓无旧通道措辞残留（历史 CHANGELOG 条目除外）。
- **2026-07-24**: ensemble → multiModel 重构 + 配置硬编码清理（B 档修复）。
  - **背景**：原 `ensemble.md`（投票选优模式）与新建的 `multiModel.md`（融合编辑模式）语义重叠，配置混乱；agent 文件 `synthesizer-fusion.md` 与 `kilo.json` 配的 `synthesizer` 命名不一致（Kilo 按文件名加载，会导致 `multiModel` 阶段 4 调用 `synthesizer-fusion` 找不到 agent → FAIL）；`multiModel.md` 多处硬编码具体模型名（`MiniMax-M3` / `glm-5.2` / `kimi-k2.6` / `kimi-k2.7-code`），配置变更后 agent 文档漂移。
  - **统一术语**：删除 `agent/ensemble.md` 与 `agent/synthesizer.md`（旧投票版），全仓术语改为 `multiModel` + `synthesizer-fusion`（`workflow-core.md` / `output-schema.md` / `skill-usage-tracking.md` / `README.md` / `hermes-migration/SKILL.md` 同步更新；新增 `MULTIMODEL_DEGRADED` / `MULTIMODEL_ABANDONED` 状态信号）
  - **配置对齐**：`kilo.json` 中 `synthesizer` 字段重命名为 `synthesizer-fusion`（与 agent 文件名 `synthesizer-fusion.md` 一致；旧字段直接删除，无 alias——修复"配置与文件名错位"的致命问题，否则 Kilo 加载 multiModel 阶段 4 时会找不到 subagent）
  - **模型去硬编码**：`multiModel.md` 移除所有具体模型名（流程图 / 模型分工策略表 / 架构多样性描述 / 效率决策章节），改为"角色 + 能力要求 + 档位建议"的原则描述；具体模型在 `kilo.json` 中配置，调换模型无需修改 agent 文档
  - **新增 stage 4B**：融合后必须再次调用 `checker` 验证融合方案本身（防止 synthesizer-fusion 在编辑过程中引入新 bug）
  - **升级四档模型**：`synthesizer-fusion` / `checker` / `executor-C` 等关键档位升级到更强档位（具体见 `kilo.json`）
  - **历史记录保留**：本 CHANGELOG 中 `2026-07-XX` 之前关于 ensemble 的条目**不修改**（历史溯源需要），新条目在 `[Unreleased]` 顶部明示迁移
- **2026-07-22**: v2.7 project_context 跨项目 scope 隔离 — 对齐 fact_store / failure_db，业务项目不再被 kilo_config 专属噪音污染。
  - **背景**：project_context 表无 scope/project_name 列，8 条种子无差别注入所有项目。其中 4 条 kilo_config 专属内容（七层架构 / kilo.json 模型配置 / sqlite 优先 / 三文件同步）对业务项目是噪音；fact_store 16 条经验全标 global，但 6 条实际是 kilo_config 配置维护专属（agent 删除 / frontmatter / 校验脚本 / 占位符 / 引用化 / prompt 设计）。
  - **schema 变更（v2.7）**：
    - `project_context` 加 `scope`（默认 'global'，CHECK 约束）+ `project_name` 列，对齐 `fact_store` v2.3 / #5 与 `failure_db` v2.4 / #15
    - 新增 `idx_project_scope` 复合索引（对齐 `idx_fact_scope`）
    - `v_active_project_context` 视图加 scope / project_name 列
    - 8 条种子回填 scope：4 global（PC-004/005/006/008 通用流程/约束）+ 4 project=kilo_config（PC-001/002/003/007 架构/配置/记忆模块规则）
  - **query A 加 scope 过滤**：`policy/query_strategy.md` §1 query A+A' 子查询加 `(scope = 'global' OR (scope = 'project' AND project_name = :current_project))`，对齐 query B/C。`KILO_PROJECT_NAME` 未设置时仅注入 global 行（业务项目安全默认）
  - **fact_store 重新分类**：6 条 kilo_config 专属经验（AP-007/008/010/011/012/PAT-002）scope 从 global 改为 project=kilo_config；10 条通用经验保持 global
  - **新增迁移脚本**：`api/migrate_project_context_scope.sql`（既有 DB 升级：ALTER TABLE + 索引 + 回填 8 条 scope）
  - **health_check 新增 2 项**：#19 `PROJECT_CONTEXT_SCOPE_COLUMN_PRESENT`（硬检查，列存在性）+ #20 `PROJECT_CONTEXT_SCOPE_DISTRIBUTION`（soft-warn，分布健康度）；索引数 21→22
  - **三文件同步**：schema/init.sql + api/seed_project_context.sql + policy/project_context_seed.md（种子 scope 值一致）；policy/query_strategy.md（注入门槛表 + query A SQL）；policy/fact_dedup.md（scope 写入规则扩展 project_context）；policy/init_check.md（§6e 迁移表 + 失败处理）；validate-config.mjs（required 清单加迁移脚本）；MODULE_GUIDE.md（§3.4 表加 scope/project_name 行）
  - **验证**：20/20 health_check PASS；18/18 validate-config PASS；scope 隔离注入测试通过（KILO_PROJECT_NAME 未设 → 仅 1 条 global；=kilo_config → 3 条含 project；=business_app → 仅 1 条 global，无 kilo_config 噪音）


- **2026-07-22**: Memory 层自动初始化 — install 脚本 + validate-config check17 告警增强。
  - **背景**：memory.db 不存在 + sqlite3 CLI 未安装时，check17 两个分支静默 `pass:true`，输出层 PASS 时丢弃 detail → 记忆层静默失效（经验沉淀/错误总结/模型校准/skill 升级全部不写入，自我进化闭环不生效），用户无感知。
  - **install.ps1 / install.sh 新增 Memory Layer Setup 段**：
    - Step 0/1：检测 `sqlite3` CLI，缺失时提示用户并自动安装（Windows: `winget install SQLite.SQLite` + PATH 刷新 + winget 安装目录探测；Linux/macOS: apt/brew/dnf/yum/pacman/apk 自动探测包管理器）
    - Step 2：初始化 `memory.db`（建目录 + 执行 `schema/init.sql` 建表 + 迁移 bootstrap 经验 `migrate_skill_to_fact_store.sql` + 补种 `project_context` + 表清单验证）
    - 幂等：memory.db 已存在则 SKIP；sqlite3 不可用则静默降级（不阻断 install）
  - **validate-config.mjs check17 增强**：
    - memory.db 不存在分支：新增 git commit 历史检测（≥20 commit → `[MEMORY_DB_NOT_INITIALIZED] ⚠️` 告警，提示经验沉淀/错误总结/模型校准/skill 升级全部静默失效）；修复 `.git/HEAD` 预检缺陷（仓库根在父目录时误判），改为直接 `git rev-list`
    - ENOENT 降级分支：detail 改为 `[MEMORY_RUNTIME_UNAVAILABLE] ⚠️` + 三条修复路径
    - 输出层：PASS 但 detail 含 `[MEMORY_*]` 或 `⚠️` 时一并打印（原逻辑 PASS 时完全丢弃 detail）
    - Windows 专属：sqlite3 CLI ENOENT 时探测 winget 安装目录重试（解决"已安装但会话 PATH 未刷新"误报）；新增会话 PATH 刷新逻辑（从注册表读 Machine+User 合并）
  - **文档同步**：README.md / core.md / workflow-reference.md / .kilo/memory/AGENTS.md / MODULE_GUIDE.md 5 处初始化指引更新，优先指向 install 脚本自动初始化，手动 init_check.md 6 步 SOP 作为 fallback
  - **验证**：18/18 PASS；memory.db 初始化成功（7 表 + 2 FTS5 虚表 + 3 视图齐全，fact_store 16 条 AP/PAT 经验已迁移，project_context 8 条种子）


- **2026-07-20**: v2.5 记忆通道重构 — 删 sqlite+ddg MCP，主通道切 bash+sqlite3 CLI，备用 memory-mcp 预埋。
  - **背景**：第三方 sqlite MCP（社区 node-sqlite3 实现）+ ddg-search MCP（Chromium 抓 HTML）长期挂起导致 Kilo 进程内存爆炸（≥2 GB），是 Windows 环境下最大的稳定性风险。
  - **改造**：
    - **删除**：`kilo.json`（项目 + 全局）移除 `mcp.sqlite` 与 `mcp.ddg-search` 配置块
    - **主通道**（v2.5-过渡版）：通过 Kilo `bash` 工具调用 `sqlite3` CLI 读写 `~/.config/kilo-data/memory.db`，命令模板见 `.kilo/memory/policy/bash_sqlite_template.md`
    - **备用通道**（v3.0 standby）：自建 `memory-mcp`（Node 22 内置 `node:sqlite` + `@modelcontextprotocol/sdk` 1.29），`kilo.json` 中 `enabled: false` 预埋不加载，启用前必须 `node test.js` + `node test:stability` 双绿
    - **覆盖 21 处旧"sqlite MCP"指令性引用**（README / AGENTS / schema / seed / policy / agent 工作说明书 / install 脚本）
  - **新增 check18**：validate-config.mjs 新增 `agent.md ↔ instructions.md 跨文件漂移检测`（v2.5.1 防止 skill-usage.log 复活），目前 18/18 PASS
  - **配套修复**：
    - 6 个 `agent/*.md` 旧"向 .kilo/memory/skill-usage.log 追加一行"统一改为"通过 bash 调用 sqlite3 CLI 向 skill_usage_events 表 INSERT"
    - `README.md` / `CONFIG_CHANGE_CHECKLIST.md` 注释同步
    - `install.sh` / `install.ps1` EXCLUDE 列表清理 `skill-usage.log`
    - `memory-mcp` health_check 子项改走 `sqlite3` CLI 执行 contract（绕开 `node:sqlite` FTS5 模块缺失；14/14 PASS）
    - FTS5 索引修复：`INSERT INTO fact_fts(fact_fts) VALUES('rebuild')` 重建后 MATCH 验证正常
  - **不动的事实**：`archive/YYYY-MM/` md 归档协议仍废除（全部走 `fact_store.archived=1`），`MEMORY.md` 字符上限仍 ≤1500，schema 表结构冻结
  - **memory-mcp 验证**：22/22 functional PASS（项目 + 全局副本），0.01 MB 增长 / 200 次稳定性

- **2026-07-19**: v2.2 彻底去 md 化 — archived sub-skill 文件 AP-XXX 全文删除。
  - **背景**：v2.1 把 14 条 AP + 2 条 PAT 迁入 fact_store，但 4 个 `anti-patterns-*/SKILL.md` 仍保留 AP-XXX 全文（仅加 archived 警告），archived flag 无 enforce，存在 agent 误加载全文的风险。
  - **修复**：4 个 archived sub-skill 文件 AP-XXX 全文**彻底删除**，仅保留 frontmatter + 迁移指引 + SQL 指针。每个文件从 ~150 行精简到 ~30 行。
  - **彻底去 md 化收益**：
    - 即使 agent 误加载归档文件，最大消耗 = 4 文件 × 30 行 = **120 行**（vs v2.1 的 4 文件 × 250 行 = 1000 行，vs v2.0 的 14 条 × 60 行 ≈ 840 行）
    - 14 条 AP 全文**唯一权威源** = 全局 sqlite `fact_store` 表，无任何 md 副本
    - 即使「archived flag 不被 enforce」也无法加载 AP-XXX 全文（文件里已经没有）
  - **关联修复**：
    - `agent/checker.md:38` 移除「来源：anti-patterns-encoding AP-001/AP-005」指向归档文件的引用，改为 `[memory:fact_id=AP-001,AP-005]` + 注明 v2.1 已迁移
    - `.kilo/skills/workflow/SKILL.md:108` 示例文本「命中历史会话：AP-001 BOM 污染反模式」→「命中历史会话：fact_store[AP-001]」
    - `.kilo/skills/anti-patterns/SKILL.md` 索引文件从 v2.1 → v2.2，新增「sub-skill 文件状态 v2.2：内容已清空」章节
    - `validate-config.mjs` check14 注释 / 函数名 / deprecation 提示同步更新到 v2.2
  - **结论**：去 md 化闭环 —— AP 经验不再以任何 md 形式存在，sqlite 是唯一来源。
  - **CLI flag 审计**：`--help` / `--version` 标志**不存在**于任何 Kilo 脚本（`scan-encoding.mjs` 仅按文件路径参数运行，被 `validate-config.mjs` 通过 dynamic import 调用，非 CLI 工具）；当前**无用户**手动调用入口，加 flag 仅增加 30+ 行 boilerplate。

- **2026-07-19**: 去 md 化（v2.1）— 14 条 AP + 2 条 PAT 从 SKILL.md 迁入全局 sqlite fact_store。
  - **迁移脚本**：`.kilo/memory/api/migrate_skill_to_fact_store.sql`（一次性 INSERT OR IGNORE 16 条经验，含 trigger / condition / action / confidence=1.0 / evidence / tags JSON 数组）
  - **索引文件升级**：
    - `.kilo/skills/anti-patterns/SKILL.md` 从 60 行经验库 → 索引文件（含 14 条 AP 索引表 + 3 个查询 SQL 模板）
    - `.kilo/skills/patterns/SKILL.md` 从 130 行 → 索引文件（含 2 条 PAT 索引表 + 查询 SQL）
  - **4 个 sub-skill 文件归档**：anti-patterns-{encoding,process,coordination,contract}/SKILL.md 顶部加 `[已归档] v2.1` 警告 + frontmatter `archived: true` + 指向 fact_store 的 SQL；agent 通过 skill 工具加载时跳过
  - **MEMORY.md M-001 引用迁移**：从 `skills/anti-patterns/SKILL.md#AP-001 / #AP-005` → `[memory:fact_id=AP-001,AP-005]` + `SELECT ... FROM fact_store WHERE fact_id IN (...)` 格式
  - **validate-config.mjs check14 升级**：模块完整性校验新增 `.kilo/memory/api/migrate_skill_to_fact_store.sql` 必填项（v2.0 11 个文件 → v2.1 12 个文件）
  - **README.md 迁移记录章节**：新增「迁移记录（v2.1, 2026-07-19）」+ 经验 vs Skill 边界决策树
  - **核心收益**：
    - 单任务 token 占用（记忆部分）从 1400-4200 → 200-500（-85%）
    - hit_count 自增回路首次生效（M6 节点）
    - confidence 自动反映使用频率（每次使用 +0.02）
    - 跨项目共享（sqlite 全局 vs md 项目本地）
    - M 节点日志可审计（`[memory:fact_id=AP-001 ...]` 标记）
  - **向后兼容**：4 个 sub-skill 全文保留（仅顶部加警告），人工查阅不受影响

- **2026-07-19**: 架构审计 — 删除 5 处冗余 + 修 1 处 runtime 引用错误。
  - **D10 修 runtime 引用**：workflow-core.md §收尾三步 第 3 项「经验沉淀与自进化」原本指向已变成指针文件的 `evolution.md`，现简化为指向同文件 §收尾自检（已有完整 checklist + M 节点编号）。**消除 runtime 引用错误**（coderAgent 之前会多绕一道读指针文件）。
  - **D1 删除重复示例表**：`query_strategy.md` §输出格式示例 的 8 行表格与 `agent/coderAgent.md` §记忆节点日志 完全重复，删除 query_strategy.md 中的表格，改为单行指向。
  - **D5 删除 AGENTS.md 公共 API 重复表**：AGENTS.md §公共 API 9 行表与 README.md §公共 API 10 行表重复，且 AGENTS.md 顶部还自称"完整列表见 README.md"。现 AGENTS.md 仅保留 4 条常用入口 + 单行指向 README.md。
  - **D8 删除 AGENTS.md 收尾自检重复 checklist**：AGENTS.md §收尾自检 6 行 checklist 与 workflow-core.md §收尾自检 10 行（含 M 编号）重复，且 AGENTS.md 顶部还自称"详见 workflow-core.md"。现 AGENTS.md 仅保留 4 条核心原则 + 单行指向。
  - **D11 修过期注释**：`validate-config.mjs` 顶部注释 `[14/16]` → `[14/17]`（实际是 17 项），并补齐 `[17/17] 全局 sqlite 记忆层健康度` 注释行（之前漏了）。
  - **净效果**：5 处删除 / 1 处修正，AGENTS.md 从 ~76 行精简至 ~70 行；query_strategy.md 从 ~270 行精简至 ~258 行；模块文件总行数 -22 行（去重），0 行为变更。

- **2026-07-19**: 记忆节点日志（M1-M8 可视化）— 让记忆操作像任务流程一样直观可读。
  - **8 个记忆节点定义**：M1 任务上下文注入 / M2 失败回溯 / M3 经验引用 / M4 fact_store 去重 / M5 failure_db 写入 / M6 hit_count 自增 / M7 dispatch_log 写入 / M8 model_calibration 更新（与任务 8 节点对称）。
  - **状态图标**：🔍 query / 📝 write / 🔄 update / ✅ success / ⚠️ partial / ❌ failure / ⏭️ skipped — 与任务流区分。
  - **markdown 模板**：在 `agent/coderAgent.md` §记忆节点日志 新增模板 + 完整示例；T1+ 任务必须输出此表格。
  - **M1-M8 ↔ 收尾自检 checklist 打通**：workflow-core.md §收尾自检 每条 checklist 现在标 M 编号（M4/M5/M6/M7/M8），并加一条「M1-M8 节点日志输出」确保用户能直观看到记忆系统在做什么。
  - **节点定义唯一源**：`.kilo/memory/policy/query_strategy.md` §节点定义 M1-M8（含触发时机 / 操作类型 / 必填输出 / 触发顺序图 / 状态图标表）。
  - **解决核心痛点**：之前 memory 操作是「无声」的（SQL 执行但无可见输出），现在每次任务都能看到「读了哪些 fact / 写了哪些 dispatch / 哪些 hit_count 自增」，**与任务流程日志对齐输出**，reviewer 和用户可一眼审计。

- **2026-07-19**: 记忆检索 v2.0 — 查询带 ID + tags + 标准注入格式 + hit_count 自增回路。
  - **P0 query_strategy.md SELECT 强化**：所有查询**必须带 ID 字段**（fact_id / failure_id / context_id / calibration_id）+ tags + evidence；同时引入**置信度门槛**（fact_store confidence ≥ 0.7 + hit_count ≥ 2，failure_db resolved_at 非空，model_calibration sample_count ≥ 3），过滤低质噪音；早期项目 commit < 10 时自动放宽至 confidence ≥ 0.5 兜底。
  - **P0 索引化 LIKE 匹配**：`tags LIKE '%keyword%'` → `tags LIKE '%,%keyword%,%'`（逗号分隔精确匹配），**真正走 `idx_fact_tags` 索引**；trigger / action 字段兜底模糊匹配。
  - **P1-1 标准注入格式**：定义 `[memory:fact_id={id} category={...} confidence={...} hit_count={...} tags=[...]]` 强制标记，agent 引用经验时**必须保留标记**让 reviewer 可审计；fact_store / failure_db / project_context / model_calibration 各有专属模板。
  - **P1-3 hit_count 自增回路**：每次 T1+ 任务收尾时，从 agent 输出中的 `[memory:fact_id=...]` 标记提取用到的 fact_id 列表，对每个执行 `UPDATE hit_count + 1, confidence + 0.02 (封顶 0.95)`；failure_db 同症状复发时 `same_symptom_count + 1`。**解决"经验被反复使用但 hit_count 永远=1"的回路断裂问题**。列入 workflow-core.md §收尾自检 checklist。
  - **P1-5 描述合并**：core.md §自进化触发点 + reflection.md §强制跨会话根因回溯 的重复 SQL 段全部删除，改为指向 `.kilo/memory/policy/query_strategy.md` §3（SQL 唯一源）；统一强制带 ID + 置信度门槛。
  - **R-3 MEMORY.md vs fact_store 边界**：README.md 新增「MEMORY.md vs fact_store 边界」章节，明确分工——可复用模式→fact_store，用户偏好/安全约束→md 兜底，归档索引→MEMORY.md 指向 fact_id；禁止把任务经验直接 append 到 MEMORY.md / SKILL.md。

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
