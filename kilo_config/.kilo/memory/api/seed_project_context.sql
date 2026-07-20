-- ============================================================
-- 项目级架构上下文种子（v2.3 / #1 — 填实 project_context）
-- ============================================================
-- 模块位置：.kilo/memory/api/seed_project_context.sql
-- 执行时机：
--   (a) 首次部署：schema/init.sql 末尾自动 seed（同一份 SQL 内联），无需单独执行
--   (b) 升级到 v2.3 后表为空：单独执行本脚本补齐
--   (c) 维护：新增 context_id 时同步更新本文件 + schema/init.sql 末尾段 + policy/project_context_seed.md
--
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/seed_project_context.sql
-- 或：
--   .read ${KILO_CONFIG_DIR}/.kilo/memory/api/seed_project_context.sql
--
-- 幂等性：INSERT OR IGNORE（PK = context_id），可重复执行无副作用。
-- 8 条种子覆盖 4 个 category：ARCHITECTURE / BUSINESS_RULE / TECH_STACK / CONSTRAINT
-- 优先级 1（最高，强制注入）到 4（低优先级）。priority<=5 在 M1 query A 注入流中。
-- 详细维护规则见 policy/project_context_seed.md。
-- ============================================================

INSERT OR IGNORE INTO project_context (context_id, category, title, content, source_file, priority, tags, use_count, last_used_at, created_at, updated_at) VALUES
('PC-001', 'ARCHITECTURE', '七层架构（Brain → L7 Evolution）',
 'xy-code AI Engineering OS 七层架构：L4 MEMORY（dispatch_log/checkpoint/fact_store/project_memory/failure_db）→ L5 EVALUATION（六层验证网络 + 质量校准）→ L6 COGNITION（反模式检测 / 经验推理 / 意图理解）→ L7 EVOLUTION（错误率分析 / A/B 测试 / Strategy Proposal）。当前用 Kilo 快速验证，最终目标是人设计系统，AI Agent 自主生产软件。',
 'brain-architecture.md', 2,
 '["architecture","seven-layer","brain","evolution"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-002', 'TECH_STACK', '模型与 MCP 配置（kilo.json）',
 '主模型 hx/MiniMax-M3（coderAgent + engineer）；架构/审查 kimi-k2.6 + glm-5.2；checker/fixer deepseek-v4-flash。MCP：context7（文档）+ gitnexus（代码图谱）+ playwright（浏览器自动化，谨慎用）。记忆通道：bash + sqlite3 CLI 主通道（v2.5-过渡版）；可选 memory-mcp（v3.0，kilo.json enabled:false 默认关闭）。已移除 ddg-search / 第三方 sqlite MCP（内存爆炸风险）。compaction auto，threshold 65%，tail_turns 25，preserve_recent_tokens 60K。',
 'kilo.json', 3,
 '["config","model","mcp","compaction","kilo-json"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-003', 'CONSTRAINT', '强制 sqlite 优先 + md 兜底',
 '记忆系统采用全局 sqlite 优先（~/.config/kilo-data/memory.db，7 表 + 26 索引 + 4 视图 + 2 FTS5 虚表（trigram 分词，v2.6））+ 项目 md 兜底（MEMORY.md ≤ 1500 字符 + USER.md ≤ 1375 字符）。其他模块通过 bash 调用 sqlite3 CLI 与记忆交互（v2.5-过渡版主通道），禁止直接操作 memory.db 文件。',
 '.kilo/memory/README.md', 1,
 '["memory","sqlite","md-fallback","invariant"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-004', 'CONSTRAINT', '跳步即停 / [PROCESS_VIOLATION]',
 '执行类任务禁止跳步（按 task tier 声明的路径执行），缺步即违规；发现 [PROCESS_VIOLATION] 立即暂停修正。MCP 启动超时 / 表缺失 / 写入缺失 / 编码前检查点缺失等均有对应硬门标记（[MISSING_*]）。',
 'AGENTS.md', 1,
 '["process","hard-gate","violation-marker","workflow"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-005', 'BUSINESS_RULE', 'T1+ pre-checker → engineer → checker → fixer 闭环',
 'T1+ 任务单元级闭环：engineer 输出不自行验证（不自验），过 checker；checker FAIL → fixer 修复 → 重新 checker；fixer 连续 2 轮同症状升级 reviewer；Circuit Breaker 连续 3 次无法收敛则停止。T0 极速通道豁免。',
 '.kilo/instructions/workflow-core.md', 2,
 '["workflow","tier","unit-closure","checker","fixer"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-006', 'BUSINESS_RULE', 'review_mode 决策表',
 'T0 → none（无 reviewer）；T1 单文件/2-3 文件 → lightweight（架构 + SCOPE_CREEP）；T1 ≥4 文件 / 跨模块 / 安全敏感 → full（自动升级，安全+架构+简化+SCOPE_CREEP 四视角）；T2/T3 → full。升级必须在阶段 B 输出 [REVIEW_MODE_UPGRADED] 标记。',
 '.kilo/instructions/workflow-core.md', 3,
 '["review","review-mode","lightweight","full","upgrade-trigger"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-007', 'BUSINESS_RULE', 'Schema 变更三文件同步（铁律 2/3）',
 '记忆模块 schema 变更必须同时改 3 个文件（缺一即破坏模块完整性）：(1) schema/init.sql（DDL 唯一源）;(2) contracts/health_check.sql（表名/索引名/视图名同步）;(3) policy/*.md 对应文档（业务规则同步）。',
 '.kilo/memory/README.md', 2,
 '["invariant","iron-rule","schema-sync","module-internal-consistency"]', 0, NULL, '2026-07-19', '2026-07-19'),

('PC-008', 'TECH_STACK', '临时文件位置 $env:TEMP / /tmp/',
 '临时文件（脚本 / 构建产物 / debug 日志）必须写入系统临时目录：Windows $env:TEMP / Linux /tmp/。禁止写入项目根目录、src/、lib/、dist/。残留临时文件标记 [FOUND_ORPHAN_ARTIFACT: 路径]。',
 '.kilo/instructions/core.md', 4,
 '["lifecycle","temp-file","artifact-cleanup","cross-platform"]', 0, NULL, '2026-07-19', '2026-07-19');

-- ============================================================
-- 验证 seed 结果
-- ============================================================
SELECT category, COUNT(*) AS cnt
FROM project_context
GROUP BY category
ORDER BY category;
-- 期望返回 4 行（每 category ≥1），total=8