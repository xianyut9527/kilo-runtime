# Memory Module 说明文档（MODULE_GUIDE）

> **模块位置**：`.kilo/memory/`（仓库内唯一记忆边界）
> **版本**：v2.6.1
> **数据库**：`${HOME}/.config/kilo-data/memory.db`（全局单库，跨项目共享 + scope 隔离）
> **策略标识**：`sqlite-first-md-fallback + bash-cli-channel + fts5-trigram + scope-isolation + helpful-rate-mandatory-feedback`
> **本文档职责**：模块简介 + 存储表说明。公共 API 与业务规则以 `README.md` / `policy/*.md` 为准，本文不重复定义规则。

---

## 1. 模块简介

### 1.1 定位

记忆模块为 Kilo 多智能体编排系统（coderAgent / architect / engineer / checker / fixer / reviewer）提供**跨会话、跨项目的结构化持久记忆**，覆盖五类数据：

1. **经验教训**（`fact_store`）— 可复用模式 / 反模式 / 配方 / 警告
2. **失败案例**（`failure_db`）— 症状 / 根因层 / 修复策略 / 复发计数
3. **任务调度日志**（`dispatch_log`）— 定级、review_mode、模型、状态、反馈标记
4. **项目上下文**（`project_context`）— 架构决策 / 业务规则 / 技术栈 / 约束
5. **模型校准**（`model_calibration`）— 各 agent 角色 × 任务类型的成功率与补偿 prompt

辅助表：`skill_upgrade_log`（skill 升级提案审计）、`skill_usage_events`（skill 使用频次时序）。

### 1.2 核心原则（3 条）

| # | 原则 | 含义 |
|---|---|---|
| 1 | **SQLite 唯一记忆** | 所有结构化记忆与时序数据只入 sqlite；md 文件禁止累积经验/日志，仅保留静态规则 / 模板 / 指针 |
| 2 | **写入即持久** | 任务中产生的经验、失败模式、使用事件必须当任务写入 sqlite，不得留在 prompt 中丢失 |
| 3 | **反馈闭环** | 每次 T1+ 任务收尾必须执行 M6（hit_count 自增 + helpful/misleading 反馈）/ M7（dispatch_log）/ M8（model_calibration），经验质量随真实使用动态校准 |

### 1.3 访问通道

- **主通道**：Kilo `bash` 工具调用 `sqlite3` CLI（命令模板见 `policy/bash_sqlite_template.md`）
- **备用通道**：自建 `memory-mcp` MCP server（v3.0 规划，`kilo.json` 预埋 `enabled:false`，启用前须 `node test.js` + `node test-stability.js` 双绿）
- **降级行为**：`memory.db` 不存在时自动跳过全部记忆读写，不报错

### 1.4 模块 4 层架构

```
.kilo/memory/
├── README.md       ← 公共 API 文档（外部模块唯一入口）
├── AGENTS.md       ← 模块对 agent 的运行时注入指令
├── schema/         ← 第 1 层：DDL 唯一源（init.sql）
├── policy/         ← 第 2 层：业务规则决策树（12 个 md）
├── api/            ← 第 3 层：迁移脚本 + 未来 MCP server
└── contracts/      ← 第 4 层：health_check.sql（17 项健康度，check17 调用）
```

---

## 2. 存储设计总览

| 类别 | 数量 | 清单 |
|---|---|---|
| 核心表 | 7 | fact_store / failure_db / dispatch_log / project_context / model_calibration / skill_upgrade_log / skill_usage_events |
| FTS5 虚表 | 2 | fact_fts / failure_fts（trigram 分词，content= 源表，触发器自动同步） |
| 查询视图 | 4 | v_failure_patterns / v_high_confidence_facts / v_high_helpful_facts / v_active_project_context |
| 索引 | 26 | 含 scope / helpful_rate / use_count 等复合索引 |

DDL 唯一源：`schema/init.sql`。schema 变更必须三文件同步（init.sql + health_check.sql + policy 文档），缺一即破坏模块完整性。

---

## 3. 核心表说明

### 3.1 fact_store — 经验教训库

结构化经验教训，全系统检索召回的核心数据源。

| 列 | 类型 | 说明 |
|---|---|---|
| fact_id | TEXT PK | 事实标识（如 AP-001 / PAT-001 / M-001） |
| category | TEXT | PATTERN / ANTIPATTERN / RECIPE / WARNING（CHECK 约束） |
| trigger | TEXT | 触发场景描述（FTS5 索引字段） |
| condition | TEXT | 触发条件（可选，FTS5 索引字段） |
| action | TEXT | 推荐做法（FTS5 索引字段） |
| confidence | REAL | 置信度 0–1，默认 0.5；每次使用 +0.02 封顶 0.95，misleading 反馈 -0.05 下限 0.1 |
| evidence | TEXT | JSON 数组：证据 dispatch_id 列表 |
| tags | TEXT | JSON 数组（FTS5 索引字段） |
| hit_count | INTEGER | 命中次数（M6 回路自增） |
| helpful_count / misleading_count | INTEGER | M6 显式反馈计数（v2.4） |
| helpful_rate | REAL | helpful / (helpful + misleading)；NULL = 暂无反馈；< 0.5 自动降权 |
| scope | TEXT | global / project（v2.3 跨项目隔离） |
| project_name | TEXT | scope=project 时的稳定项目标识（KILO_PROJECT_NAME） |
| created_at / updated_at | TEXT | ISO8601 |
| archived | INTEGER | 0/1；归档替代删除（废除 md 归档协议） |

**注入门槛**：`confidence ≥ 0.7 AND hit_count ≥ 2 AND archived = 0 AND scope 匹配 AND (helpful_rate IS NULL OR ≥ 0.5)`；试用期（14 天内、hit < 2、conf ≥ 0.5）每任务 ≤2 条破冷启动。

### 3.2 failure_db — 失败案例库

| 列 | 类型 | 说明 |
|---|---|---|
| failure_id | TEXT PK | 失败标识 |
| dispatch_id | TEXT | 关联 dispatch_log |
| root_cause_level | TEXT | 执行层 / 方法层 / 需求层 |
| symptom | TEXT | 症状描述（FTS5 索引字段） |
| fix_strategy | TEXT | 修复策略（FTS5 索引字段） |
| fix_location | TEXT | 文件:行号（FTS5 索引字段） |
| verified | INTEGER | 是否经 checker 验证修复 |
| same_symptom_count | INTEGER | 同症状复发次数（回溯命中时自增） |
| tags | TEXT | JSON 数组（FTS5 索引字段） |
| scope / project_name | TEXT | v2.4 镜像 fact_store 跨项目隔离 |
| created_at / resolved_at | TEXT | resolved_at IS NOT NULL 才注入（未解决不污染上下文） |

### 3.3 dispatch_log — 任务调度日志

| 列 | 类型 | 说明 |
|---|---|---|
| dispatch_id | TEXT PK | 调度标识 |
| thread_id | TEXT | 会话标识 |
| agent | TEXT | 执行 agent 名 |
| task_summary | TEXT | 任务摘要（≤100 字） |
| initial_tier / final_tier / tier | TEXT | 阶段 A 预估 / 阶段 B 校准 / 兼容字段（T0–T3） |
| review_mode | TEXT | none / lightweight / full |
| tier_deviation | TEXT | maintain / upgrade / downgrade |
| model | TEXT | 实际使用模型 |
| status | TEXT | STARTED / DONE / DONE_WITH_CONCERNS / FAILED / BLOCKED / TIMEOUT |
| error_code / duration_ms / input_tokens / output_tokens / files_changed / findings_count | — | 执行度量 |
| compensation_prompt_used / compensation_calibration_id | — | v2.3 补偿 prompt 消费追踪 |
| trigger_fact_ids / helpful_fact_ids / misleading_fact_ids | TEXT | v2.4 结构化反馈（JSON 数组） |
| created_at | TEXT | ISO8601 |

### 3.4 project_context — 项目专属上下文

| 列 | 类型 | 说明 |
|---|---|---|
| context_id | TEXT PK | 上下文标识（PC-001…） |
| category | TEXT | ARCHITECTURE / BUSINESS_RULE / TECH_STACK / CONSTRAINT |
| title / content | TEXT | 标题 / 内容 |
| source_file | TEXT | 来源文件（如 AGENTS.md） |
| priority | INTEGER | 1–10，1 最高；priority ≤ 5 进注入流 |
| tags | TEXT | JSON 数组 |
| use_count / last_used_at | — | v2.4 动态排序维度；v2.6 起 M1 注入后 UPDATE 为硬门 |
| created_at / updated_at | TEXT | ISO8601 |

首次部署自动 seed 8 条（PC-001–PC-008，INSERT OR IGNORE 幂等）。

### 3.5 model_calibration — 模型校准记录

| 列 | 类型 | 说明 |
|---|---|---|
| calibration_id | TEXT PK | 校准标识 |
| model | TEXT | 模型名 |
| agent_role | TEXT | engineer / checker / reviewer / … |
| task_type | TEXT | 如 react-refactor / api-design |
| success_rate / avg_findings / structure_adherence | REAL | 质量度量 |
| overconfident_flag | INTEGER | 过自信标记 |
| compensation_prompt | TEXT | 补偿 prompt 片段 |
| compensation_prompt_set_at / compensation_prompt_consumed_count | — | v2.3 设置时间 + 累计消费次数（30 天未消费停止注入） |
| sample_count | INTEGER | 样本数；注入门槛 ≥ 2（v2.6 放宽），补偿 prompt 生成门槛 ≥ 5 |
| last_evaluated_at | TEXT | 最近评估时间 |

### 3.6 skill_upgrade_log — Skill 升级审计（v2.3）

| 列 | 类型 | 说明 |
|---|---|---|
| upgrade_id | TEXT PK | 升级标识 |
| fact_id | TEXT | 源 fact |
| consecutive_successes | INTEGER | 连续成功计数；FAILED / DONE_WITH_CONCERNS 归零 |
| last_success_at / last_evaluated_dispatch_id | — | 评估轨迹 |
| promoted_at | TEXT | 晋升时间；NULL = 未晋升 |
| promotion_status | TEXT | DRAFT / AUTO_PROMOTED / MANUAL_PROMOTED / REJECTED |
| evidence_dispatch_ids | TEXT | JSON 数组：晋级证据 |

晋升路径：`fact_store.confidence ≥ 0.8 && hit_count ≥ 3` → `[AUTO_DRAFT]` 草稿 → **人工审批**后才落盘 SKILL.md（V1 默认；V2 opt-in 连续 3 次 DONE 自动晋升）。

### 3.7 skill_usage_events — Skill 使用时序（v2.5）

替代原 `.kilo/memory/skill-usage.log` md 累积（v2.5 铁律：时序数据禁入 md）。

| 列 | 类型 | 说明 |
|---|---|---|
| event_id | INTEGER PK AUTOINCREMENT | 自增主键 |
| timestamp | TEXT | ISO8601 |
| session_id | TEXT | 会话标识 |
| skill_name | TEXT | skill 目录名 |
| trigger | TEXT | 短描述（≤40 字符） |
| outcome | TEXT | success / fail / partial |
| agent / task_tier | TEXT | 触发 agent / 任务定级 |
| created_at | TEXT | 默认 datetime('now') |

---

## 4. FTS5 虚表与视图

### 4.1 fact_fts / failure_fts（v2.4 建，v2.6 重建为 trigram）

- `USING fts5(..., content='fact_store', tokenize='trigram')` 外部内容表，与源表共享存储
- 6 个触发器（ai/ad/au × 2）保证 INSERT/UPDATE/DELETE 自动同步，无需手工维护
- **trigram 分词**：支持中英文任意 ≥3 字符子串匹配；解决 unicode61 将连续 CJK 视为单 token 导致中文 MATCH 恒 0 命中的缺陷。2 字中文词需扩展为 ≥3 字词组或退化 LIKE

### 4.2 查询视图

| 视图 | 用途 |
|---|---|
| v_failure_patterns | 高频失败模式（verified=1，occurrence ≥ 2，聚合修复策略） |
| v_high_confidence_facts | 高置信事实（confidence ≥ 0.8 且未归档） |
| v_high_helpful_facts | 高质反馈事实（helpful_count ≥ 3 且 helpful_rate ≥ 0.7） |
| v_active_project_context | 活跃项目上下文（use_count > 0，按使用频次排序） |

---

## 5. 检索召回机制：为什么不用 md，全走 SQLite

### 5.1 检索路径核查结论（2026-07-20 实测）

**当前系统不存在任何"以 md 文件作为检索匹配召回载体"的路径**：

| md 文件 | 角色 | 是否参与检索召回 |
|---|---|---|
| MEMORY.md | 静态指针（≤1500 字符）+ `<DYNAMIC_INJECT>` 占位符 | ❌ 不参与；占位内容本身是 M1 时从 sqlite 实时 SELECT top-2 ANTIPATTERN + top-1 PATTERN 渲染 |
| USER.md | 用户手动编辑的偏好 / 安全约束 | ❌ 不参与关键词检索；按 `[tag]` 机械注入 |
| memory-strategy.md | 兼容性指针 | ❌ 纯指向模块入口 |
| policy/*.md / README.md / AGENTS.md | 规则文档（给 agent 读的规则，非被检索数据） | ❌ |
| 遗留 skill-usage.log / archive/ | — | ❌ 已确认不存在（v2.5 迁移并删除） |

全部检索召回（query A 项目上下文 / query B 经验 / query B2 试用期 / query C 失败模式 / query D 模型校准 / 失败回溯 / M-001 动态注入）**100% 落在 sqlite**。

### 5.2 SQLite vs md 检索对比（实测证据）

| 维度 | md 文件检索 | SQLite + FTS5（当前方案） |
|---|---|---|
| 匹配方式 | 全文加载后 prompt 内模糊匹配，无排序 | FTS5 trigram MATCH + bm25 相关度排序（实测：英文 `PowerShell` 命中 AP-005 rank=-4.02；中文 `未再次调用` 命中 AP-003 rank=-2.86） |
| 结构化过滤 | 不可能（无列概念） | 注入门槛 5 维组合过滤（confidence / hit_count / archived / scope / helpful_rate） |
| 中文检索 | 依赖模型上下文 | trigram 分词，≥3 字符子串命中 |
| 单任务 token 占用 | 1400–4200（全量加载） | 200–500（LIMIT 截断 + 2000 token 预算，-85%） |
| 质量反馈 | 无法累积 | helpful_rate 反向校准 confidence，低质 fact 自动降权 |
| 跨项目共享 | 不可能（项目本地文件） | 全局单库 + scope/project_name 隔离 |
| 并发与一致性 | 文件锁无保障 | SQLite WAL 事务 |
| 归档 | md append / archive/ 目录 | `UPDATE archived=1`，数据不出库 |

### 5.3 结论

SQLite 方案在**科学性**（结构化 schema + 量化置信度 + 反馈闭环）、**性能**（FTS5 索引 O(log n) 检索 vs md 全量加载，token 占用降 85%）、**召回精确度**（bm25 排序 + 5 维门槛过滤 + trigram 中文支持）三个维度均严格优于 md 检索，当前实现已无 md 检索残留，方向正确、落地完整。

---

## 6. 记忆操作节点（M1–M8）速览

> M1–M8 是**执行标准**（何时查 / 写什么 / 硬门）。输出形式为**即时单行提示**（hermes 风格）：召回时 `🧠 [memory:recall]`、写入时 `💾 [memory:write]`，不输出大表格。

| 节点 | 时机 | 操作 | 硬门 |
|---|---|---|---|
| M1 上下文注入 | 任务开始 | SELECT 4 表 + UPDATE use_count（A'） | v2.6 起 A' 必执行，recall 提示须含证据 |
| M2 失败回溯 | 失败条件命中 | SELECT failure_fts MATCH + ANTIPATTERN | — |
| M3 经验引用 | 执行中 | 输出 `[memory:fact_id=X]` 标记 | 保留标记供审计 |
| M4 fact 去重写入 | 发现可复用模式 | 去重 + INSERT/UPDATE fact_store | — |
| M5 失败写入 | checker FAIL / fixer 多轮 | INSERT failure_db | v2.6 降门槛：首轮 FAIL 即记录 |
| M6 反馈回路 | 任务收尾 | UPDATE hit_count/confidence/helpful_rate | v2.6 强制输出反馈标记，无则 `[memory:helpful=none]` |
| M7 dispatch 写入 | 任务收尾（T1+） | INSERT dispatch_log | 未执行 → `[MISSING_MEMORY_WRITE]` 阻塞交付 |
| M8 模型校准 | dispatch 后 | UPDATE model_calibration | — |

提示格式与输出规则：`agent/coderAgent.md` §记忆提示；校验规则：`policy/m6_validation.md`。

---

## 7. 相关文档索引

| 文档 | 职责 |
|---|---|
| `README.md` | 公共 API 文档 + 升级路径 + 故障排查 |
| `AGENTS.md` | agent 运行时注入指令（核心原则 / Token Budget / 降级行为） |
| `schema/init.sql` | DDL 唯一源 |
| `policy/query_strategy.md` | 查询规则 + 注入门槛 + 标准注入格式 + M1–M8 节点定义 |
| `policy/dispatch_recorder.md` | dispatch_log 写入规则 |
| `policy/fact_dedup.md` | fact_store 去重 + scope 写入规则 |
| `policy/failure_recorder.md` | failure_db 写入规则 |
| `policy/model_calibration.md` | 模型校准更新规则 |
| `policy/skill_upgrade.md` | skill 升级触发与审批边界 |
| `policy/init_check.md` | 首次部署 + 版本升级 SOP |
| `policy/bash_sqlite_template.md` | bash + sqlite3 CLI 命令模板 |
| `contracts/health_check.sql` | 17 项健康度查询 |
