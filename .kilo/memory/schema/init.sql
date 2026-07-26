-- kilo memory system schema
-- 模块位置：.kilo/memory/schema/init.sql（DDL 唯一源）
-- 初始化命令: 通过 bash 调用 sqlite3 CLI 执行本文件的 CREATE TABLE 语句（v2.5-过渡版主通道）
-- 全局数据库路径: ${HOME}/.config/kilo-data/memory.db
--
-- 初始化示例:
--   Linux / macOS:
--     mkdir -p "${HOME}/.config/kilo-data"
--     sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/schema/init.sql
--   Windows (PowerShell):
--     New-Item -ItemType Directory -Path "${env:USERPROFILE}\.config\kilo-data" -Force
--     # 若已安装 sqlite3 CLI:
--     sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" < .kilo\memory\schema\init.sql
--     # 否则在 PowerShell 中: sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" ".read .kilo/memory/schema/init.sql"
--
-- 模块架构：本文件由 .kilo/memory/contracts/health_check.sql 验证完整性
--            业务规则由 docs/memory-ops-reference.md 定义（生命周期驱动后唯一入口，不在此处重复）
--
-- 版本：v2.7（在 v2.6.2 基础上为 project_context 增加跨项目 scope 隔离，对齐 fact_store / failure_db）
--   v2.6.2：v_active_project_context 视图 / M-001 动态注入 / 反馈执行率告警
--   v2.6.1：修复 v_failure_patterns 视图 GROUP_CONCAT DISTINCT 语法错误 + 段编号重排
--   v2.6：FTS5 分词器 unicode61 → trigram，修复中文 MATCH
--   v2.7（新增）：
--     - project_context.scope / project_context.project_name 列（跨项目隔离，对齐 fact_store v2.3 / #5）
--     - idx_project_scope 复合索引
--     - v_active_project_context 视图增加 scope / project_name 列
--     - 8 条种子回填 scope：4 global + 4 project(kilo_config)
--     - 既有 DB 升级：执行本文件末尾 ALTER TABLE 段或重建（api/ 迁移脚本已随 policy/ 一并在 v2.6.2 精简删除）
--     - docs/memory-ops-reference.md §M1 query A 加 scope 过滤（对齐 query B/C）
--     - contracts/health_check.sql 新增 #19 #20 两项检查
--   v2.4：FTS5 / helpful_rate / failure_db scope / project_context use_count
--   v2.5（新增）：
--     - skill_usage_events 表（替代 .kilo/memory/skill-usage.log md 累积）
--     - 强制 sqlite 唯一记忆原则：禁止 md 文件累积经验/日志
--   v2.6（新增）：
--     - fact_fts / failure_fts 分词器 trigram（中文 ≥3 字符子串可 MATCH；
--       既有 DB 升级：DROP 旧虚表后重跑本文件 CREATE VIRTUAL TABLE 段）
--   v2.3：
--     - skill_upgrade_log 表（#3）
--     - fact_store.scope / fact_store.project_name 列（#5 跨项目隔离）
--     - model_calibration.compensation_prompt_set_at / compensation_prompt_consumed_count 列（#8）
--     - dispatch_log.compensation_prompt_used / compensation_calibration_id 列（#8）
--     - 末尾自动 seed project_context（#1）
--   v2.4（新增）：
--     - fact_store.helpful_count / misleading_count / helpful_rate 列（#13 反馈质量量化）
--     - failure_db.scope / project_name 列（#15 镜像 fact_store 跨项目隔离）
--     - project_context.last_used_at / use_count 列（#2 上下文动态化）
--     - fact_fts / failure_fts FTS5 虚表（#5 全文检索效率 +++）
--     - dispatch_log.trigger_fact_ids / helpful_fact_ids / misleading_fact_ids 列（#13 反馈结构化）

-- 1. 经验教训库 (FactStore)
-- 对应 brain-architecture L4: 结构化经验教训，语义检索
CREATE TABLE IF NOT EXISTS fact_store (
    fact_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('PATTERN', 'ANTIPATTERN', 'RECIPE', 'WARNING')),
    trigger TEXT NOT NULL,           -- 触发场景描述
    condition TEXT,                  -- 触发条件（可选）
    action TEXT NOT NULL,            -- 推荐做法
    confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
    evidence TEXT,                   -- JSON 数组: [dispatch_id, ...]
    tags TEXT,                       -- JSON 数组: ["react", "api", ...]
    hit_count INTEGER NOT NULL DEFAULT 0,  -- 命中次数（用于排序；衰减由 memory-ops.md §M6 14 天试用窗口实现）
    helpful_count INTEGER NOT NULL DEFAULT 0,    -- v2.4 / #13 M6 [memory:helpful=X] 反馈次数
    misleading_count INTEGER NOT NULL DEFAULT 0, -- v2.4 / #13 M6 [memory:misleading=X] 反馈次数
    helpful_rate REAL,               -- v2.4 / #13 helpful / (helpful+misleading)；NULL = 暂无反馈
    scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project')),  -- v2.3 跨项目隔离（#5）
    project_name TEXT,               -- v2.3：scope='global' 时为 NULL；scope='project' 时为稳定项目标识（KILO_PROJECT_NAME）
    created_at TEXT NOT NULL,        -- ISO8601
    updated_at TEXT NOT NULL,        -- ISO8601
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_fact_tags ON fact_store(tags);
CREATE INDEX IF NOT EXISTS idx_fact_category ON fact_store(category);
CREATE INDEX IF NOT EXISTS idx_fact_confidence ON fact_store(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_fact_scope ON fact_store(scope, project_name);  -- v2.3（#5）
CREATE INDEX IF NOT EXISTS idx_fact_helpful_rate ON fact_store(helpful_rate DESC);  -- v2.4（#13）

-- 1b. fact_store FTS5 镜像（v2.4 / #5 全文检索效率；v2.6 分词器 trigram）
-- content=fact_store 让 FTS5 与源表同步；外部内容表（contentless=1）也可以但需手动同步触发器
-- triggers 在 fact_dedup.md INSERT/UPDATE 时同步；详见 policy/query_strategy.md §1 query B MATCH 语法
-- v2.6：tokenize='trigram'（unicode61 把连续 CJK 当单 token，中文 MATCH 0 命中；
--       trigram 支持 ≥3 字符任意子串；2 字中文词需扩展为 ≥3 字词组或退化 LIKE）
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(
    fact_id UNINDEXED,
    trigger,
    action,
    condition,
    tags,
    content='fact_store',
    tokenize='trigram'
);

-- 2. 失败案例库 (FailureDatabase)
-- 对应 brain-architecture L4: 失败模式积累
CREATE TABLE IF NOT EXISTS failure_db (
    failure_id TEXT PRIMARY KEY,
    dispatch_id TEXT,                -- 关联 dispatch_log
    root_cause_level TEXT NOT NULL CHECK(root_cause_level IN ('执行层', '方法层', '需求层')),
    symptom TEXT NOT NULL,           -- 症状描述
    fix_strategy TEXT NOT NULL,      -- 修复策略
    fix_location TEXT,               -- 文件:行号
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),  -- 是否经 verifier 验证修复
    same_symptom_count INTEGER NOT NULL DEFAULT 1,  -- 同症状复发次数
    tags TEXT,                       -- JSON 数组
    scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project')),  -- v2.4（#15）镜像 fact_store
    project_name TEXT,               -- v2.4（#15）scope='global' 时 NULL
    created_at TEXT NOT NULL,
    resolved_at TEXT                 -- ISO8601，未解决为 NULL
);

CREATE INDEX IF NOT EXISTS idx_failure_symptom ON failure_db(symptom);
CREATE INDEX IF NOT EXISTS idx_failure_tags ON failure_db(tags);
CREATE INDEX IF NOT EXISTS idx_failure_level ON failure_db(root_cause_level);
CREATE INDEX IF NOT EXISTS idx_failure_scope ON failure_db(scope, project_name);  -- v2.4（#15）

-- 2b. failure_db FTS5 镜像（v2.4 / #15 全文检索效率；v2.6 分词器 trigram，同 fact_fts 注释）
CREATE VIRTUAL TABLE IF NOT EXISTS failure_fts USING fts5(
    failure_id UNINDEXED,
    symptom,
    fix_strategy,
    fix_location,
    tags,
    content='failure_db',
    tokenize='trigram'
);

-- 3. 任务调度日志 (OrchestrationJournal)
-- 对应 brain-architecture L4: 全链路事件流
CREATE TABLE IF NOT EXISTS dispatch_log (
    dispatch_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,         -- 会话标识
    agent TEXT NOT NULL,             -- 执行 agent 名
    task_summary TEXT NOT NULL,      -- 任务摘要（≤100 字）
    initial_tier TEXT CHECK(initial_tier IN ('T0', 'T1', 'T2', 'T3')),  -- 阶段 A 预估等级
    final_tier TEXT CHECK(final_tier IN ('T0', 'T1', 'T2', 'T3')),      -- 阶段 B 校准等级
    tier TEXT CHECK(tier IN ('T0', 'T1', 'T2', 'T3')),                  -- 兼容旧字段（=final_tier）
    review_mode TEXT CHECK(review_mode IN ('none', 'lightweight', 'full')),  -- reviewer 工作模式（T0=none；v3.2 起 lightweight 已废弃，全用 full，保留值仅为兼容历史数据）
    tier_deviation TEXT CHECK(tier_deviation IN ('maintain', 'upgrade', 'downgrade')),  -- 校准偏差方向
    model TEXT,                      -- 实际使用的模型
    status TEXT NOT NULL CHECK(status IN ('STARTED', 'DONE', 'DONE_WITH_CONCERNS', 'FAILED', 'BLOCKED', 'TIMEOUT')),
    error_code TEXT,                 -- 若失败，错误码
    duration_ms INTEGER,             -- 执行耗时
    input_tokens INTEGER,
    output_tokens INTEGER,
    files_changed TEXT,              -- JSON 数组
    findings_count INTEGER,          -- verifier 发现的问题数
    compensation_prompt_used INTEGER NOT NULL DEFAULT 0 CHECK(compensation_prompt_used IN (0,1)),  -- v2.3（#8）本次 dispatch 是否消费了补偿 prompt
    compensation_calibration_id TEXT, -- v2.3（#8）本次消费的 calibration_id（用于反查 model_calibration）
    trigger_fact_ids TEXT,         -- v2.4 / #13 本次 dispatch 涉及的 fact_id（JSON 数组；M3 注入引用收集）
    helpful_fact_ids TEXT,         -- v2.4 / #13 M6 [memory:helpful=X] 反馈收集
    misleading_fact_ids TEXT,      -- v2.4 / #13 M6 [memory:misleading=X] 反馈收集
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispatch_thread ON dispatch_log(thread_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_agent ON dispatch_log(agent);
CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_log(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_final_tier ON dispatch_log(final_tier);
CREATE INDEX IF NOT EXISTS idx_dispatch_review_mode ON dispatch_log(review_mode);
CREATE INDEX IF NOT EXISTS idx_dispatch_tier_deviation ON dispatch_log(tier_deviation);

-- 4. 项目专属上下文 (ProjectMemory)
-- 架构决策、业务规则、技术栈约束
-- v2.7：增加 scope / project_name 列，对齐 fact_store v2.3 / #5 与 failure_db v2.4 / #15 跨项目隔离
CREATE TABLE IF NOT EXISTS project_context (
    context_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('ARCHITECTURE', 'BUSINESS_RULE', 'TECH_STACK', 'CONSTRAINT')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_file TEXT,                -- 来源文件（如 AGENTS.md）
    priority INTEGER NOT NULL DEFAULT 5 CHECK(priority >= 1 AND priority <= 10),  -- 1=最高
    tags TEXT,                       -- JSON 数组
    use_count INTEGER NOT NULL DEFAULT 0,         -- v2.4 / #2 实际注入次数
    last_used_at TEXT,                              -- v2.4 / #2 最近一次注入时间
    scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project')),  -- v2.7 跨项目隔离
    project_name TEXT,               -- v2.7：scope='global' 时为 NULL；scope='project' 时为稳定项目标识（KILO_PROJECT_NAME）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_category ON project_context(category);
CREATE INDEX IF NOT EXISTS idx_project_priority ON project_context(priority);
CREATE INDEX IF NOT EXISTS idx_project_use_count ON project_context(use_count DESC);  -- v2.4（#2）
CREATE INDEX IF NOT EXISTS idx_project_scope ON project_context(scope, project_name);  -- v2.7（对齐 idx_fact_scope）

-- 5. 模型校准记录 (QualityCalibrator)
-- 随使用积累，指导模型路由
CREATE TABLE IF NOT EXISTS model_calibration (
    calibration_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    agent_role TEXT NOT NULL,        -- coder/verifier/reviewer/...
    task_type TEXT NOT NULL,         -- 如 "react-refactor", "api-design"
    success_rate REAL,               -- 成功率（0-1）
    avg_findings REAL,               -- verifier 平均发现问题数
    structure_adherence REAL,        -- 结构 adherence 评分
    overconfident_flag INTEGER DEFAULT 0 CHECK(overconfident_flag IN (0, 1)),
    compensation_prompt TEXT,        -- 补偿 prompt 片段
    compensation_prompt_set_at TEXT, -- v2.3（#8）补偿 prompt 写入时间；NULL = 从未设置
    compensation_prompt_consumed_count INTEGER NOT NULL DEFAULT 0,  -- v2.3（#8）累计被 dispatch 消费的次数
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_evaluated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cal_model ON model_calibration(model, agent_role);
CREATE INDEX IF NOT EXISTS idx_cal_task ON model_calibration(task_type);

-- 5b. 技能升级日志（v2.3 / #3 — skill_upgrade V2 自动化追踪）
-- 对应 brain-architecture L7: Strategy Proposal → 应用
-- V1（人工 gate）下 DRAFT 行仅作审计；V2（opt-in，env KILO_SKILL_UPGRADE_V2=true）下连续 3 次 DONE 自动 AUTO_PROMOTED
CREATE TABLE IF NOT EXISTS skill_upgrade_log (
    upgrade_id TEXT PRIMARY KEY,
    fact_id TEXT NOT NULL,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,  -- 连续成功计数；任意 FAILED/DONE_WITH_CONCERNS 重置为 0
    last_success_at TEXT,                              -- 最近一次成功时间
    last_evaluated_dispatch_id TEXT,                   -- 最近一次评估的 dispatch_id
    promoted_at TEXT,                                  -- 自动 / 人工晋升时间；NULL = 未晋升
    promotion_status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK(promotion_status IN ('DRAFT','AUTO_PROMOTED','MANUAL_PROMOTED','REJECTED')),
    evidence_dispatch_ids TEXT                         -- JSON 数组：晋级证据 dispatch_id 列表
);

CREATE INDEX IF NOT EXISTS idx_upgrade_fact ON skill_upgrade_log(fact_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_status ON skill_upgrade_log(promotion_status);

-- 5c. Skill 使用事件日志（v2.5 — 替代 .kilo/memory/skill-usage.log md 累积）
-- 强制 sqlite 唯一记忆原则：所有"使用频次 / 时间序列"数据必须入 sqlite，禁止 md append
-- 原 .kilo/memory/skill-usage.log 由 api/migrate_skill_usage_log_to_sqlite.sql 一次性迁移后删除
CREATE TABLE IF NOT EXISTS skill_usage_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,                    -- ISO8601
    session_id TEXT NOT NULL,                   -- Kilo 注入或随机
    skill_name TEXT NOT NULL,                   -- skill 目录名
    trigger TEXT NOT NULL,                      -- 短描述（≤40 字符）
    outcome TEXT NOT NULL CHECK(outcome IN ('success','fail','partial')),
    agent TEXT,                                 -- 哪个智能体触发（conductor / planner / coder / verifier / reverse-auditor / side-checker / reviewer / fixer / multiModel）
    task_tier TEXT,                             -- T0/T1/T2/T3
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage_events(skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_usage_session ON skill_usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_skill_usage_outcome ON skill_usage_events(outcome);
CREATE INDEX IF NOT EXISTS idx_skill_usage_timestamp ON skill_usage_events(timestamp DESC);

-- 6. 查询辅助视图: 高频失败模式（v2.4 / #15 scope 隔离；v2.6.1 修复 GROUP_CONCAT DISTINCT 语法）
--    注：SQLite 中 DISTINCT 聚合只接受 1 个参数，自定义分隔符与 DISTINCT 不可兼得
CREATE VIEW IF NOT EXISTS v_failure_patterns AS
SELECT
    symptom,
    root_cause_level,
    COUNT(*) as occurrence,
    AVG(same_symptom_count) as avg_recurrence,
    GROUP_CONCAT(DISTINCT fix_strategy) as strategies
FROM failure_db
WHERE verified = 1
GROUP BY symptom, root_cause_level
HAVING occurrence >= 2
ORDER BY occurrence DESC;

-- 7. 查询辅助视图: 高置信度事实
CREATE VIEW IF NOT EXISTS v_high_confidence_facts AS
SELECT * FROM fact_store
WHERE confidence >= 0.8 AND archived = 0
ORDER BY confidence DESC, hit_count DESC;

-- 8. v2.4 高 helpful_rate 视图（#13 反馈质量 — 优先注入高质 fact）
CREATE VIEW IF NOT EXISTS v_high_helpful_facts AS
SELECT fact_id, category, trigger, action, confidence, hit_count, helpful_count, misleading_count, helpful_rate
FROM fact_store
WHERE archived = 0
  AND helpful_count >= 3
  AND helpful_rate >= 0.7
ORDER BY helpful_rate DESC, hit_count DESC;

-- 9. v2.4 高质 project_context 视图（#2 动态化 — 按 use_count + last_used_at 排序）
--    v2.7：增加 scope / project_name 列（对齐 fact_store / failure_db）
CREATE VIEW IF NOT EXISTS v_active_project_context AS
SELECT context_id, category, title, content, priority, use_count, last_used_at, scope, project_name
FROM project_context
WHERE use_count > 0
ORDER BY use_count DESC, last_used_at DESC;

-- 10. v2.4 FTS5 同步触发器（#5 / #15 — 自动维护 fact_fts / failure_fts 与源表同步）
--    触发器在 fact_dedup.md / failure_recorder.md INSERT/UPDATE/DELETE 时调用
CREATE TRIGGER IF NOT EXISTS fact_fts_ai AFTER INSERT ON fact_store BEGIN
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS fact_fts_ad AFTER DELETE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS fact_fts_au AFTER UPDATE ON fact_store BEGIN
    INSERT INTO fact_fts (fact_fts, rowid, fact_id, trigger, action, condition, tags)
    VALUES ('delete', old.rowid, old.fact_id, old.trigger, old.action, old.condition, old.tags);
    INSERT INTO fact_fts (rowid, fact_id, trigger, action, condition, tags)
    VALUES (new.rowid, new.fact_id, new.trigger, new.action, new.condition, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS failure_fts_ai AFTER INSERT ON failure_db BEGIN
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS failure_fts_ad AFTER DELETE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS failure_fts_au AFTER UPDATE ON failure_db BEGIN
    INSERT INTO failure_fts (failure_fts, rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES ('delete', old.rowid, old.failure_id, old.symptom, old.fix_strategy, old.fix_location, old.tags);
    INSERT INTO failure_fts (rowid, failure_id, symptom, fix_strategy, fix_location, tags)
    VALUES (new.rowid, new.failure_id, new.symptom, new.fix_strategy, new.fix_location, new.tags);
END;

-- ============================================================
-- 附注：mcp_config 表（v3.0 备用通道 memory-mcp 的运行时元数据）
-- ============================================================
-- mcp_config 不属于本 DDL（核心 7 表之外）。它由 api/mcp/memory-mcp.js 启用时按需自建
-- （key/value 元数据：version / initialized_at / features）。v2.6.1 起健康度不检查该表；
-- 未启用 memory-mcp 的部署中若存在历史遗留 mcp_config，可安全 DROP（无任何代码引用）。

-- ============================================================
-- v2.3 自动 seed（项目级架构上下文）
-- ============================================================
-- 触发条件：首次部署（CREATE TABLE IF NOT EXISTS 后）；INSERT OR IGNORE 保证幂等
-- 数据源：api/seed_project_context.sql（迁移脚本独立可重跑；本段为首次部署自动种子）
-- 8 条种子覆盖 4 个 category（ARCHITECTURE / BUSINESS_RULE / TECH_STACK / CONSTRAINT），
-- 优先级 1（最高）到 4。priority<=5 在 M1 query A 注入流中。
-- v2.7 scope 分布：4 global（PC-004/005/006/008 通用流程/约束）+ 4 project=kilo_config（PC-001/002/003/007 kilo_config 专属架构/配置/记忆模块规则）
-- 业务项目（KILO_PROJECT_NAME 未设）仅注入 global 行，不被 kilo_config 专属噪音污染。
-- 详见 policy/project_context_seed.md。
INSERT OR IGNORE INTO project_context (context_id, category, title, content, source_file, priority, tags, use_count, last_used_at, scope, project_name, created_at, updated_at) VALUES
('PC-001', 'ARCHITECTURE', '七层架构（Brain → L7 Evolution）',
 'xy-code AI Engineering OS 七层架构：L4 MEMORY（dispatch_log/checkpoint/fact_store/project_memory/failure_db）→ L5 EVALUATION（六层验证网络 + 质量校准）→ L6 COGNITION（反模式检测 / 经验推理 / 意图理解）→ L7 EVOLUTION（错误率分析 / A/B 测试 / Strategy Proposal）。当前用 Kilo 快速验证，最终目标是人设计系统，AI Agent 自主生产软件。',
 'brain-architecture.md', 2,
 '["architecture","seven-layer","brain","evolution"]', 0, NULL, 'project', 'kilo_config', '2026-07-19', '2026-07-19'),

('PC-002', 'TECH_STACK', '模型与 MCP 配置（kilo.json）',
 '主模型 hx/MiniMax-M3（conductor + coder）；架构/审查 kimi-k3 + glm-5.2；verifier/reverse-auditor glm-5.2；fixer kimi-k2.7-code/deepseek-v4-flash。MCP：context7（文档）+ gitnexus（代码图谱）+ playwright（浏览器自动化，谨慎用）。记忆通道：bash + sqlite3 CLI 主通道（v2.5-过渡版）；可选 memory-mcp（v3.0，kilo.json enabled:false 默认关闭）。已移除 ddg-search / 第三方 sqlite MCP（内存爆炸风险）。compaction auto，threshold 65%，tail_turns 25，preserve_recent_tokens 60K。',
 'kilo.json', 3,
 '["config","model","mcp","compaction","kilo-json"]', 0, NULL, 'project', 'kilo_config', '2026-07-19', '2026-07-19'),

('PC-003', 'CONSTRAINT', '强制 sqlite 优先 + md 兜底',
 '记忆系统采用全局 sqlite 优先（~/.config/kilo-data/memory.db，7 表 + 26 索引 + 4 视图 + 2 FTS5 虚表（trigram 分词，v2.6））+ 项目 md 兜底（MEMORY.md ≤ 1500 字符 + USER.md ≤ 1375 字符）。其他模块通过 bash 调用 sqlite3 CLI 与记忆交互（v2.5-过渡版主通道），禁止直接操作 memory.db 文件。',
 '.kilo/memory/README.md', 1,
 '["memory","sqlite","md-fallback","invariant"]', 0, NULL, 'project', 'kilo_config', '2026-07-19', '2026-07-19'),

('PC-004', 'CONSTRAINT', '跳步即停 / [PROCESS_VIOLATION]',
 '执行类任务禁止跳步（按 task tier 声明的路径执行），缺步即违规；发现 [PROCESS_VIOLATION] 立即暂停修正。MCP 启动超时 / 表缺失 / 写入缺失 / 编码前检查点缺失等均有对应硬门标记（[MISSING_*]）。',
 'AGENTS.md', 1,
 '["process","hard-gate","violation-marker","workflow"]', 0, NULL, 'global', NULL, '2026-07-19', '2026-07-19'),

('PC-005', 'BUSINESS_RULE', 'T1+ planner → coder → verifier → fixer 闭环',
 'T1+ 任务单元级闭环：coder 输出不自行验证（不自验），过 verifier；verifier FAIL → fixer 修复 → 重新 verifier；fixer 连续 2 轮同症状升级 reviewer；Circuit Breaker 连续 3 次无法收敛则停止。T0 极速通道豁免。',
 '.kilo/instructions/workflow-core.md', 2,
 '["workflow","tier","unit-closure","verifier","fixer"]', 0, NULL, 'global', NULL, '2026-07-19', '2026-07-19'),

('PC-006', 'BUSINESS_RULE', 'review_mode 决策表',
 'T0 → none（无 reviewer）；T1 单文件/2-3 文件 → lightweight（架构 + SCOPE_CREEP）；T1 ≥4 文件 / 跨模块 / 安全敏感 → full（自动升级，安全+架构+简化+SCOPE_CREEP 四视角）；T2/T3 → full。升级必须在阶段 B 输出 [REVIEW_MODE_UPGRADED] 标记。',
 '.kilo/instructions/workflow-core.md', 3,
 '["review","review-mode","lightweight","full","upgrade-trigger"]', 0, NULL, 'global', NULL, '2026-07-19', '2026-07-19'),

('PC-007', 'BUSINESS_RULE', 'Schema 变更三文件同步（铁律 2/3）',
 '记忆模块 schema 变更必须同时改 3 个文件（缺一即破坏模块完整性）：(1) schema/init.sql（DDL 唯一源）;(2) contracts/health_check.sql（表名/索引名/视图名同步）;(3) policy/*.md 对应文档（业务规则同步）。',
 '.kilo/memory/README.md', 2,
 '["invariant","iron-rule","schema-sync","module-internal-consistency"]', 0, NULL, 'project', 'kilo_config', '2026-07-19', '2026-07-19'),

('PC-008', 'TECH_STACK', '临时文件位置 $env:TEMP / /tmp/',
 '临时文件（脚本 / 构建产物 / debug 日志）必须写入系统临时目录：Windows $env:TEMP / Linux /tmp/。禁止写入项目根目录、src/、lib/、dist/。残留临时文件标记 [FOUND_ORPHAN_ARTIFACT: 路径]。',
 '.kilo/instructions/core.md', 4,
 '["lifecycle","temp-file","artifact-cleanup","cross-platform"]', 0, NULL, 'global', NULL, '2026-07-19', '2026-07-19');