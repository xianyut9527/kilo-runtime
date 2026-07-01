# kilo_config 优化升级任务 DAG v2

> Phase 1-3 执行计划：瘦身 + 按需记忆 + 反馈闭环
> 不做 Phase 4（模型路由学习，需要先有反馈数据）

## 执行范围

- **Phase 1**：合并 review-security / review-architecture / review-simplification 到 reviewer.md；删除 3 个 review-*.md 文件；调整 compaction；消除 prompt 重复；同步所有索引文档
- **Phase 2**：SKILL.md 增加 keywords；skill-retriever 按需加载（替换"全量扫描"语义）；更新 skills-lifecycle.md
- **Phase 3**：新建 .kilo/experience/；新增 feedback-collector / experience-ranker；修改 coderAgent 交付流程调用 feedback-collector

## 需求扩散覆盖矩阵

| 改动点 | 必须同步的文件 | 验证命令 |
|--------|----------------|----------|
| 删除 review-* agent | AGENTS.md / README.md / CONFIG_CHANGE_CHECKLIST.md / kilo.json / workflow.md / reviewer.md / coderAgent.md | `grep -n "review-security\|review-architecture\|review-simplification" AGENTS.md README.md CONFIG_CHANGE_CHANGE_CHECKLIST.md kilo.json .kilo/instructions/workflow.md agent/reviewer.md agent/coderAgent.md` 最终返回空；历史文件保留位置除外 |
| 合并审查视角到 reviewer | reviewer.md / workflow.md | 读取 reviewer.md 确认含三种视角自检清单；grep workflow.md 无 review-* 残留 |
| 调整 compaction | kilo.json | `node -e "JSON.parse(fs.readFileSync('kilo.json','utf8').replace(/^\uFEFF/,''))"` + 字段值校验 |
| SKILL.md 增加 keywords | 5 个 SKILL.md / skills-lifecycle.md | 读取每个 SKILL.md 前 15 行；grep "keywords" skills-lifecycle.md |
| skill-retriever 机制 | coderAgent.md / kilo.json | 读取 coderAgent.md 核对描述；JSON.parse + 内容核对 |
| 新增 .kilo/experience/ | README.md / install 脚本 | `Test-Path .kilo/experience/log` / `ls .kilo/experience`；读取 install 脚本确认递归复制 |
| 新增 feedback-collector / experience-ranker | agent/*.md / AGENTS.md / README.md / kilo.json | glob + JSON.parse + 读取核对 |
| 修改 coderAgent 交付流程 | coderAgent.md / kilo.json | 读取 coderAgent.md 交付章节；JSON.parse |

## 跨层引用清单

**需更新的位置（本次任务必须同步）：**

| 位置 | 当前引用 | 需要更新为 |
|------|----------|-----------|
| workflow.md L52/L67 | 必须调用 `review-security` | reviewer 的安全视角自检 |
| workflow.md L291 | 自动调用 `review-simplification` | reviewer 的简化视角自检 |
| reviewer.md L31-36 | 专审路由到 review-security/architecture/simplification | 三种视角已内化为 reviewer 自检清单 |
| coderAgent.md L145 | 自动调用 `review-security` | 自动触发 reviewer 的安全视角自检 |
| README.md L24-25 模型路由表 | review-architecture / review-security / review-simplification 行 | 删除 3 行，reviewer 行备注"覆盖三种视角" |
| README.md L65-67 目录树 | review-security.md / review-architecture.md / review-simplification.md | 删除 3 行 |
| AGENTS.md 智能体清单 | review-security / review-architecture / review-simplification 行 | 删除 3 行 |
| kilo.json agent 对象 | review-security / review-architecture / review-simplification 键 | 删除 3 个键 |

**历史保留位置（不修改，仅说明）：**
- CHANGELOG.md：历史变更记录，保留原 review-* 名词作为历史上下文
- hermes-integration-plan.md：历史计划文档，保留原 review-* 名词
- .kilo/memory/USER.md L37：冻结快照中的"review-security 会检查并拦截"属于 memory 内容，本次不修改（memory 作为冻结快照只应在后续经验沉淀中更新，不随本次 agent 调整立即变更）

## 边界声明

1. **skill-retriever 与全量加载关系**：本次是"替换"——coderAgent 不再默认全量扫描 skills，改为按任务 keywords 匹配 top-k；新增 `#skill:all` 手动 override 标签，当任务描述中出现 `#skill:all` 时切换回全量扫描
2. **experience/ 与 memory/ 职责边界**：memory/ 是项目级冻结记忆，由 coderAgent 在任务启动时注入；experience/ 是任务级反馈数据和元学习数据，不参与启动注入。experience/ 的当前消费者：feedback-collector 写入 log；experience-ranker 周期性读取 log 并决定写入 MEMORY.md/SKILL.md 或丢弃；wins.json 和 skill-index.json 供未来 Phase 4 model-router 消费（本次只生成 schema 和初始数据）
3. **validate-config.mjs**：每个 Phase 结束时必须运行，退出码 0 作为硬门禁
4. **向后兼容说明**：删除 review-* agent 后，已安装的全局配置需重跑 install 脚本清理；将在 CHANGELOG 中说明

## Phase 1 单元

| 单元ID | 目标 | 验收标准 | 验证方式 | 关键文件 | 依赖 | 冲突 |
|--------|------|----------|----------|----------|------|------|
| **P1-A** | 在 reviewer.md 中完整吸收 3 个 review-*.md 的检查清单 | 1. 含安全视角自检清单（来源 review-security.md）：外部输入校验、权限边界、敏感信息保护、注入防护（SQL/XSS/命令/路径/模板）、外部接口异常处理、密码安全哈希、认证接口防暴力破解、支付接口幂等性、memory 敏感信息泄露检查<br>2. 含架构视角自检清单（来源 review-architecture.md）：分层与依赖方向、接口输入输出兼容性、跨模块消费者影响、需求扩散业务不变量落点、external_dirs 只读与分层约定<br>3. 含简化视角自检清单（来源 review-simplification.md）：重复实现、复杂度膨胀、过度抽象、范围外修改/SKOPE_CREEP、修得过窄、memory 超限、SPECULATIVE 残留<br>4. "专审路由"章节改为"专审视角自检清单" | 读取 reviewer.md，grep 关键词："输入校验" "分层" "SCOPE_CREEP" "external_dirs" "MEMORY_SENSITIVE_LEAK" "防暴力破解" | reviewer.md | 无 | reviewer.md |
| **P1-B** | 删除 3 个 review-*.md 文件 | 文件不存在且无残留引用 | glob + grep | agent/review-*.md | P1-A | 删除操作 |
| **P1-C** | 同步 workflow.md 和 coderAgent.md 中的 review-* 引用 | 1. workflow.md L52/L67 的 review-security 引用改为 reviewer 安全视角<br>2. workflow.md L291 的 review-simplification 引用改为 reviewer 简化视角<br>3. coderAgent.md L145 的"自动调用 review-security"改为"自动触发 reviewer 安全视角自检"<br>4. grep 返回空（保留 CHANGELOG.md / hermes-integration-plan.md 历史记录和 USER.md 冻结快照不修改） | `grep -n "review-security\|review-simplification" .kilo/instructions/workflow.md agent/coderAgent.md` 返回空；`grep -n "review-security\|review-simplification" CHANGELOG.md .kilo/plans/hermes-integration-plan.md .kilo/memory/USER.md` 可命中历史保留位置 | workflow.md, coderAgent.md | P1-A | workflow.md, coderAgent.md |
| **P1-D** | 调整 compaction 配置 | threshold_percent=92, tail_turns=8, preserve_recent_tokens=20000, prune=false | JSON.parse + 字段校验 | kilo.json | 无 | kilo.json |
| **P1-E** | 从 kilo.json 删除 3 个 review-* agent 定义 | 1. agent 对象不包含 review-* 键，JSON 有效<br>2. `skills.external_dirs` 不涉及已删除 agent | JSON.parse + 键名检查 + external_dirs 引用检查 | kilo.json | P1-B | kilo.json |
| **P1-F** | 从 kilo.json 各 agent prompt 和对应 agent/*.md 中删除与 core.md/workflow.md 重复的通用规则 | 1. kilo.json 各 agent prompt 不再复述通用安全/资源/生命周期/流程规则<br>2. agent/*.md 正文不再复述 core.md/workflow.md 通用规则（保留职责差异和特有流程）<br>3. 保留 agent 特有的行为锚点、输出格式、检查清单 | diff + 关键词检查：在 kilo.json 和 agent/*.md 中搜索"通用安全约束""流程强制基线""资源与性能约束"等原文复述并确认已删除 | kilo.json, agent/*.md | P1-A, P1-C, P1-D, P1-E | 13 个 agent 文件 + kilo.json |
| **P1-G** | 同步 AGENTS.md、README.md、CONFIG_CHANGE_CHECKLIST.md 和 install 脚本说明 | 1. AGENTS.md 删除 3 行 review-*<br>2. README.md 目录树 L65-67 删除 3 个 review-*.md 文件<br>3. README.md 模型路由表 L24-25 删除 3 行并更新 reviewer 描述<br>4. CONFIG_CHANGE_CHECKLIST.md L21 的参考示例从 review-security.md 改为其他现有 agent<br>5. CHANGELOG.md 增加一条说明：删除 review-* agent 后需重跑 install 脚本 | grep 验证 + 读取 CHANGELOG 新增条目 | AGENTS.md, README.md, CONFIG_CHANGE_CHECKLIST.md, CHANGELOG.md | P1-A, P1-B | AGENTS.md, README.md, CONFIG_CHANGE_CHECKLIST.md, CHANGELOG.md |
| **P1-H** | Phase 1 整体验证 | 1. node validate-config.mjs 退出码 0<br>2. 无残留 review-* 引用（历史保留位置除外） | `node validate-config.mjs` + grep | 全部 P1 文件 | P1-A~P1-G | - |

## Phase 2 单元

| 单元ID | 目标 | 验收标准 | 验证方式 | 关键文件 | 依赖 | 冲突 |
|--------|------|----------|----------|----------|------|------|
| **P2-A** | 给 5 个 SKILL.md frontmatter 增加 keywords 数组 | 每个 SKILL.md 顶层含 keywords 数组，元素 ≥3 个 | 读取前 15 行 | 5 个 SKILL.md | P1-H | 5 个 SKILL.md |
| **P2-B** | 更新 skills-lifecycle.md | 新增 keywords 字段说明和 skill-retriever 用途 | grep "keywords" | skills-lifecycle.md | P1-H | skills-lifecycle.md |
| **P2-C** | 修改 coderAgent.md，将 skills 加载改为按需检索 top-k | 1. 描述从"全量扫描"改为"按任务描述与 SKILL.md keywords 匹配度检索 top-k"<br>2. 说明当任务描述中出现 `#skill:all` 标签时切换回全量扫描<br>3. 不破坏现有 skills 注入的优先级 | 读取核对，grep "skill-retriever\|按需检索\|keywords" | coderAgent.md | P2-A | coderAgent.md |
| **P2-D** | 修改 kilo.json coderAgent.prompt 同步 skill-retriever | 1. 与 coderAgent.md 描述一致<br>2. 明确 `#skill:all` override 语义<br>3. JSON 有效 | JSON.parse + 核对 | kilo.json | P2-C | kilo.json |
| **P2-E** | Phase 2 整体验证 | validate-config.mjs 退出码 0，文档一致 | `node validate-config.mjs` + 读取核对 | 全部 P2 文件 | P2-A~P2-D | - |

## Phase 3 单元

| 单元ID | 目标 | 验收标准 | 验证方式 | 关键文件 | 依赖 | 冲突 |
|--------|------|----------|----------|----------|------|------|
| **P3-A** | 创建 .kilo/experience/ 目录结构及初始 schema 文件 | 1. log/ 目录存在<br>2. failure-clusters/ 目录存在<br>3. wins.json 为有效 JSON，含 `schema_version`、`models`（模型胜率数组）、`task_types`（任务类型数组）<br>4. skill-index.json 为有效 JSON，含 `schema_version`、`skills`（name + keywords 数组）<br>5. .kilo/experience/README.md 说明目录用途、数据消费者、与 memory/ 的职责边界 | glob + JSON.parse | .kilo/experience/ | P2-E | 新目录 |
| **P3-B** | 新增 feedback-collector agent | 1. YAML frontmatter 完整<br>2. 职责：任务结束后写 feedback log 到 .kilo/experience/log/YYYY-MM-DD.jsonl<br>3. 记录字段明确：task_id、timestamp、task_type、agent_chain、models_used、fixer_rounds、final_status、failure_tags、user_feedback | 读取核对 | agent/feedback-collector.md | P2-E | 新文件 |
| **P3-C** | 新增 experience-ranker agent | 1. YAML frontmatter 完整<br>2. 职责：周期性读取 .kilo/experience/log/ 下的 feedback log，评估经验价值，决定写入 MEMORY.md / SKILL.md / 丢弃<br>3. 明确与 skills-writer 的分工：ranker 决策分类和目标，writer 执行写入文件 | 读取核对 | agent/experience-ranker.md | P2-E | 新文件 |
| **P3-D** | 同步 AGENTS.md、README.md 和 CONFIG_CHANGE_CHECKLIST.md 新增 2 个 agent | 1. AGENTS.md 表格新增 2 行<br>2. README.md 目录树新增 2 个文件<br>3. README.md 模型路由表新增 2 个 agent 描述<br>4. CONFIG_CHANGE_CHECKLIST.md 检查新增 agent 的 frontmatter 示例是否需同步 | 读取核对 | AGENTS.md, README.md, CONFIG_CHANGE_CHECKLIST.md | P3-B, P3-C | AGENTS.md, README.md, CONFIG_CHANGE_CHECKLIST.md |
| **P3-E** | 同步 kilo.json 新增 2 个 agent 定义 | 1. 新增 feedback-collector 和 experience-ranker 的 agent 定义<br>2. JSON 有效 | JSON.parse + 键名检查 | kilo.json | P3-D | kilo.json |
| **P3-F** | 修改 coderAgent.md 交付阶段调用 feedback-collector | 1. coderAgent.md 交付阶段明确包含"调用 feedback-collector"步骤<br>2. 调用时机在 checker PASS 之后、经验沉淀之前<br>3. 说明 feedback-collector 只记录不修改文件 | 读取核对 | coderAgent.md | P3-B | coderAgent.md |
| **P3-G** | 验证 install 脚本同步 .kilo/experience/ | install.ps1/install.sh 能递归复制新目录 | 读取核对 | install.ps1, install.sh | P3-A | install 脚本 |
| **P3-H** | Phase 3 整体验证 | validate-config.mjs 退出码 0，所有改动一致 | `node validate-config.mjs` + 读取核对 | 全部 P3 文件 | P3-A~P3-G | - |

## 并行组

| 组 | 单元 | 说明 |
|---|---|---|
| G1a | P1-A | 先完成 reviewer.md 能力迁移 |
| G1b | P1-B, P1-C, P1-G | P1-A 完成后可并行 |
| G1c | P1-D → P1-E → P1-F | G1b 完成后串行；P1-F 还修改 agent/*.md |
| G2 | P1-H | Phase 1 整体验证 |
| G3 | P2-A, P2-B | Phase 1 完成后可并行 |
| G4 | P2-C → P2-D | 串行 |
| G5 | P3-A, P3-B, P3-C | Phase 2 完成后可并行 |
| G6 | P3-D → P3-E → P3-F（P3-G 可并行） | P3-D~P3-F 串行，P3-G 可并行 |

## Phase 间依赖

- Phase 1 → Phase 2：Phase 1 的 agent 瘦身完成后再引入 skill-retriever，避免在已删除 agent 的上下文中描述机制
- Phase 2 → Phase 3：Phase 3 的 feedback-collector 需要知道最终 agent 集合以记录模型链
- G1c 必须在 G1b 完成后执行，因为 P1-F 修改 coderAgent.md，而 P1-C 也修改 coderAgent.md
