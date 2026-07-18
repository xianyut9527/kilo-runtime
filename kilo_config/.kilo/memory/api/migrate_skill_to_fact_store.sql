-- ============================================================
-- 迁移脚本：从 SKILL.md 迁 14 条 AP + 2 条 PAT 到 fact_store
-- ============================================================
-- 模块位置：.kilo/memory/api/migrate_skill_to_fact_store.sql
-- 执行时机：本次迁移一次性执行（v2.0 → v2.1 架构升级）
-- 执行命令：
--   sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/migrate_skill_to_fact_store.sql
-- 或：
--   .read ${KILO_CONFIG_DIR}/.kilo/memory/api/migrate_skill_to_fact_store.sql
--
-- 迁移后：
--   - .kilo/skills/anti-patterns/SKILL.md 变为纯索引（指向 fact_id）
--   - .kilo/skills/anti-patterns-{encoding,process,coordination,contract}/SKILL.md 加 [已归档] 警告
--   - .kilo/skills/patterns/SKILL.md 变索引
--   - .kilo/memory/MEMORY.md M-001 引用 fact_id 而非 SKILL.md
--
-- 收益：
--   - 单任务 token 节省 ~3000-5000（不再每次加载 16 条 md 全文）
--   - hit_count 自增回路生效（之前 md 无法统计使用频率）
--   - 与 P1-3 / M6 节点对齐，confidence 自动反映真实使用价值
-- ============================================================

-- 防重复迁移：用 INSERT OR IGNORE 模式（fact_id 主键冲突则跳过）
INSERT OR IGNORE INTO fact_store (fact_id, category, trigger, condition, action, confidence, evidence, tags, hit_count, created_at, updated_at) VALUES

-- ============================================================
-- 14 条 AP-XXX 反模式（迁移自 .kilo/skills/anti-patterns-{encoding,process,coordination,contract}/）
-- ============================================================

('AP-001', 'ANTIPATTERN',
 'Windows 下 Edit 工具改 UTF-8 文件后 JSON.parse / YAML 解析失败',
 'Edit 工具 + Windows + UTF-8 文件（特别是 kilo.json / *.yaml / *.csv）',
 '检测并剥离 UTF-8 BOM (0xEF 0xBB 0xBF) 后再 JSON.parse；node -e 检测 BOM 后剥离',
 1.0, '["disp-20260624-001"]',
 '["encoding","bom","json","yaml","windows","edit"]',
 0, '2026-06-24', '2026-06-24'),

('AP-002', 'ANTIPATTERN',
 '核心规则放在 instructions/*.md 嵌套子条款里被淹没，规则存在但不被遵守',
 '任何被多次违反的规则几乎都位于嵌套位置',
 '规则放平级位置 + "违反视为方法层错误" + 每违反 1 次 = 1 次反模式反馈',
 1.0, '["disp-20260624-001"]',
 '["process","soft-rule","hard-gate","instruction-depth"]',
 0, '2026-06-24', '2026-06-24'),

('AP-003', 'ANTIPATTERN',
 'pre-checker FAIL 修正后未再次调用 pre-checker 验证，直接进入 engineer 阶段',
 'T1+ 任务 + pre-checker 第一次 FAIL',
 '修正后必须再过 pre-checker 复验（PASS），流程日志必须显式记录复验节点',
 1.0, '["disp-20260624-001"]',
 '["process","skip-step","pre-checker","verification"]',
 0, '2026-06-24', '2026-06-24'),

('AP-004', 'ANTIPATTERN',
 '子智能体连续 2 次返回空 task_result 时，coderAgent 直接内联执行其职责',
 'reviewer / architect / checker 子智能体空返回',
 '标记 [SUBAGENT_RETURNED_EMPTY] 并升级 ensemble / 拆细任务，禁止内联合并职责',
 1.0, '["disp-20260624-001"]',
 '["coordination","subagent","empty-result","escalation"]',
 0, '2026-06-24', '2026-06-24'),

('AP-005', 'ANTIPATTERN',
 'Windows 中文系统 PowerShell 5.1 默认输出 GBK/GB2312，shell 读 / 写中文乱码',
 'Windows + PowerShell 5.1 (不含 pwsh 7 / WSL) + bash 工具调用',
 '$OutputEncoding / [Console]::OutputEncoding / InputEncoding 永久化为 UTF-8（已写入 install.ps1 $PROFILE）',
 1.0, '["disp-20260624-001"]',
 '["encoding","gbk","powershell-5.1","windows","utf-8"]',
 0, '2026-06-24', '2026-06-24'),

('AP-006', 'ANTIPATTERN',
 '改功能 A 只改最直观的一处，未搜索同步修改依赖 A 的 B/C/D',
 '任何功能 / 常量 / 枚举 / 接口修改',
 '执行 4 项检查：调用方搜索 / 平行实现搜索 / 三层同步检查 / 配置复用检查；产出调用方摘要',
 1.0, '["disp-20260625-001"]',
 '["coordination","linkage","checklist","rework"]',
 0, '2026-06-25', '2026-06-25'),

('AP-007', 'ANTIPATTERN',
 '删除 agent 只清理 agent/*.md 和 kilo.json，未 grep 搜索其他文档中的执行主体引用',
 '删除 agent 名称 / 缩写 / 文件路径',
 '全仓 grep {name}（含中文别名、缩写、文件路径），同步更新 AGENTS.md / workflow-core.md / 其他 agent 引用',
 1.0, '["disp-20260630-001"]',
 '["coordination","agent-deletion","linkage-residue","break-link"]',
 0, '2026-06-30', '2026-06-30'),

('AP-008', 'ANTIPATTERN',
 'agent frontmatter permission.edit 与正文"写入职责"契约不一致',
 '任何 agent 文件 frontmatter 与正文',
 '缩 frontmatter 权限到正文声明的实际写入范围；只读 agent 设为 edit: []',
 1.0, '["disp-20260630-001"]',
 '["contract","permission","frontmatter","overprivilege"]',
 0, '2026-06-30', '2026-06-30'),

('AP-009', 'ANTIPATTERN',
 'T2 多单元工作区中，checker 用 git diff HEAD~1 / git diff --stat 全量范围做 SCOPE_CREEP，把历史提交或前置单元合法变更误判',
 'T2 多单元 DAG 在同一工作区顺序执行',
 '用 git status --short 确认实际改动 + git diff -- <本单元文件> 限定范围；全量 diff 仅用于总体验收',
 1.0, '["disp-20260703-001"]',
 '["process","scope-creep","multi-unit","git-diff"]',
 0, '2026-07-03', '2026-07-03'),

('AP-010', 'ANTIPATTERN',
 '仅凭"当前校验脚本未引用"就删除配置字段，忽略框架/TUI/CI 等外部消费者',
 '删除 frontmatter 字段 / 配置项',
 'grep 字段名全仓（含 .gitignore / CHECKLIST / install / TUI）；无外部消费者时先加入校验再删除',
 1.0, '["disp-20260703-001"]',
 '["coordination","config-deletion","external-consumer"]',
 0, '2026-07-03', '2026-07-03'),

('AP-011', 'ANTIPATTERN',
 '看到校验脚本做占位符替换就反推运行时框架也支持任意模板变量',
 '设计"提取公共模板变量"方案',
 '在 README / examples / 实际运行中验证框架是否支持目标占位符；不支持时直接删除字面句',
 1.0, '["disp-20260703-001"]',
 '["contract","placeholder","runtime-capability"]',
 0, '2026-07-03', '2026-07-03'),

('AP-012', 'ANTIPATTERN',
 '源文件多条规则"引用化"到目标文件时只检查部分条目重复就全文替换',
 'core.md / security-checklist.md 等文件间引用化',
 '逐条核对：重复的改引用，独有的保留；或先补缺失条目再引用化',
 1.0, '["disp-20260703-001"]',
 '["coordination","reference-extract","coverage-loss"]',
 0, '2026-07-03', '2026-07-03'),

('AP-013', 'ANTIPATTERN',
 '批量重命名函数（check4→check3 等）只改定义和主流程调用，漏改内部相互调用',
 'validate-config.mjs 等脚本函数重命名',
 '全仓 grep 函数名（定义 / 调用 / 内部调用 / 注释），运行脚本验证',
 1.0, '["disp-20260703-001"]',
 '["coordination","rename","internal-call","refactor"]',
 0, '2026-07-03', '2026-07-03'),

('AP-014', 'ANTIPATTERN',
 '同一 UI/样式/行为问题在多个页面 / 组件出现时，engineer 不扫描全仓同类点也不创建共享抽象，直接把同一段代码复制到每个出现点',
 '跨页面 / 组件重复症状（拖动 / 样式 / 校验提示等）',
 'grep 全量扫描同类点 → 根因分类 → 共享抽象（Layout / Component / Token）→ 反向验证（命中数=0，引用数=消费者数）',
 1.0, '["disp-20260719-001"]',
 '["process","copy-paste-fix","local-patch","component","repeat-pattern"]',
 0, '2026-07-19', '2026-07-19'),

-- ============================================================
-- 2 条 PAT-XXX 正向模式（迁移自 .kilo/skills/patterns/）
-- ============================================================

('PAT-001', 'PATTERN',
 '修改任何函数 / 常量 / 枚举 / 接口后',
 'T1+ 编码任务',
 '执行 4 项检查：调用方搜索 / 平行实现搜索 / 三层同步检查 / 配置复用检查；产出调用方摘要',
 1.0, '["disp-20260625-001"]',
 '["linkage","checklist","T1","pattern"]',
 0, '2026-06-25', '2026-06-25'),

('PAT-002', 'PATTERN',
 'kilo.json agent.*.prompt 设计',
 '所有 agent prompt',
 '最小锚点关键词 + 运行时指令注入（findUp AGENTS.md → 注入 core/workflow-core/reflection）；删除"完整职责见 agent/X.md"重复字面句',
 1.0, '["disp-20260703-001"]',
 '["config-dedup","prompt-minimal","runtime-injection","pattern"]',
 0, '2026-07-03', '2026-07-03');

-- ============================================================
-- 验证迁移结果
-- ============================================================
-- 期望返回 16 行（14 AP + 2 PAT），且 confidence = 1.0
SELECT fact_id, category, confidence,
       (SELECT COUNT(*) FROM json_each(tags)) AS tag_count
FROM fact_store
WHERE fact_id LIKE 'AP-%' OR fact_id LIKE 'PAT-%'
ORDER BY fact_id;