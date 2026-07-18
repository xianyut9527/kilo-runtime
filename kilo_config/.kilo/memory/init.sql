-- kilo memory system schema
-- 初始化命令: 通过 sqlite MCP 执行本文件的 CREATE TABLE 语句
-- 建议数据库路径: .kilo/memory/memory.db

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
    hit_count INTEGER NOT NULL DEFAULT 0,  -- 命中次数（用于排序和衰减）
    created_at TEXT NOT NULL,        -- ISO8601
    updated_at TEXT NOT NULL,        -- ISO8601
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_fact_tags ON fact_store(tags);
CREATE INDEX IF NOT EXISTS idx_fact_category ON fact_store(category);
CREATE INDEX IF NOT EXISTS idx_fact_confidence ON fact_store(confidence DESC);

-- 2. 失败案例库 (FailureDatabase)
-- 对应 brain-architecture L4: 失败模式积累
CREATE TABLE IF NOT EXISTS failure_db (
    failure_id TEXT PRIMARY KEY,
    dispatch_id TEXT,                -- 关联 dispatch_log
    root_cause_level TEXT NOT NULL CHECK(root_cause_level IN ('执行层', '方法层', '需求层')),
    symptom TEXT NOT NULL,           -- 症状描述
    fix_strategy TEXT NOT NULL,      -- 修复策略
    fix_location TEXT,               -- 文件:行号
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),  -- 是否经 checker 验证修复
    same_symptom_count INTEGER NOT NULL DEFAULT 1,  -- 同症状复发次数
    tags TEXT,                       -- JSON 数组
    created_at TEXT NOT NULL,
    resolved_at TEXT                 -- ISO8601，未解决为 NULL
);

CREATE INDEX IF NOT EXISTS idx_failure_symptom ON failure_db(symptom);
CREATE INDEX IF NOT EXISTS idx_failure_tags ON failure_db(tags);
CREATE INDEX IF NOT EXISTS idx_failure_level ON failure_db(root_cause_level);

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
    review_mode TEXT CHECK(review_mode IN ('none', 'lightweight', 'full')),  -- reviewer 工作模式（T0=none）
    tier_deviation TEXT CHECK(tier_deviation IN ('maintain', 'upgrade', 'downgrade')),  -- 校准偏差方向
    model TEXT,                      -- 实际使用的模型
    status TEXT NOT NULL CHECK(status IN ('STARTED', 'DONE', 'DONE_WITH_CONCERNS', 'FAILED', 'BLOCKED', 'TIMEOUT')),
    error_code TEXT,                 -- 若失败，错误码
    duration_ms INTEGER,             -- 执行耗时
    input_tokens INTEGER,
    output_tokens INTEGER,
    files_changed TEXT,              -- JSON 数组
    findings_count INTEGER,          -- checker 发现的问题数
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
CREATE TABLE IF NOT EXISTS project_context (
    context_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('ARCHITECTURE', 'BUSINESS_RULE', 'TECH_STACK', 'CONSTRAINT')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_file TEXT,                -- 来源文件（如 AGENTS.md）
    priority INTEGER NOT NULL DEFAULT 5 CHECK(priority >= 1 AND priority <= 10),  -- 1=最高
    tags TEXT,                       -- JSON 数组
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_category ON project_context(category);
CREATE INDEX IF NOT EXISTS idx_project_priority ON project_context(priority);

-- 5. 模型校准记录 (QualityCalibrator)
-- 随使用积累，指导模型路由
CREATE TABLE IF NOT EXISTS model_calibration (
    calibration_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    agent_role TEXT NOT NULL,        -- engineer/checker/reviewer/...
    task_type TEXT NOT NULL,         -- 如 "react-refactor", "api-design"
    success_rate REAL,               -- 成功率（0-1）
    avg_findings REAL,               -- checker 平均发现问题数
    structure_adherence REAL,        -- 结构 adherence 评分
    overconfident_flag INTEGER DEFAULT 0 CHECK(overconfident_flag IN (0, 1)),
    compensation_prompt TEXT,        -- 补偿 prompt 片段
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_evaluated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cal_model ON model_calibration(model, agent_role);
CREATE INDEX IF NOT EXISTS idx_cal_task ON model_calibration(task_type);

-- 6. 查询辅助视图: 高频失败模式
CREATE VIEW IF NOT EXISTS v_failure_patterns AS
SELECT 
    symptom,
    root_cause_level,
    COUNT(*) as occurrence,
    AVG(same_symptom_count) as avg_recurrence,
    GROUP_CONCAT(DISTINCT fix_strategy, ' | ') as strategies
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
