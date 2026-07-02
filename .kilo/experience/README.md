# Experience 目录

本目录存放 kilo_config 的**运行时经验数据**（experience data），由各 agent 在任务执行过程中产生的胜负记录、失败聚类、运行日志聚合而成，用于驱动模型路由、技能检索和未来决策优化。

## 目录结构

```
.kilo/experience/
├── README.md                    # 本文件
├── wins.json                    # 模型与任务类型的胜率/通过率汇总
├── skill-index.json             # 技能索引（从 .kilo/skills/ frontmatter 提取）
└── log/                         # 原始事件日志（feedback-collector 写入）
    └── YYYY-MM-DD.jsonl         # 按日期分片的 JSONL 事件流
```

## 与 `.kilo/memory/` 的职责边界

`.kilo/memory/` 与 `.kilo/experience/` 是两类不同的持久化层，**不可混用**：

| 维度 | `.kilo/memory/` | `.kilo/experience/` |
|------|----------------|---------------------|
| 存储内容 | 冻结的**系统级约束**与**用户偏好** | **运行时统计与聚类**（胜率、失败模式、事件流） |
| 写入方 | 用户直接编辑 USER.md；coderAgent / skills-writer 写入 MEMORY.md | feedback-collector 写入；experience-ranker 聚合；model-router 消费 |
| 加载时机 | 会话启动时由 coderAgent 加载为冻结快照 | 按需消费（路由决策、技能检索） |
| 字符上限 | MEMORY.md ≤ 2200，USER.md ≤ 1375 | 无硬性字符上限，但 wins.json/skill-index.json 应保持精简 |
| 更新频率 | 低（手动或重大决策时） | 高（每次任务执行后增量更新） |
| 性质 | **权威规范**（"系统必须遵守的规则"） | **观察数据**（"历史上表现如何"） |

**判定原则**：一条经验若属于"系统级/跨项目通用约束"→ 写入 MEMORY.md；属于"统计性/历史性观察"→ 写入本目录。

## 数据生产者与消费者

| 文件/目录 | 生产者（写入） | 消费者（读取） |
|----------|---------------|---------------|
| `log/*.jsonl` | feedback-collector（每个任务闭环后追加事件） | experience-ranker（聚合统计） |
| `wins.json` | experience-ranker（从 log 聚合胜率） | **model-router**（未来：按模型/任务类型选路） |
| `skill-index.json` | 初始化由本任务静态生成；后续可由 experience-ranker 更新 usage 字段 | model-router、coderAgent（关键词检索） |

## 文件格式说明

### wins.json

聚合视图，按 schema_version 演进。当前 v1.0 字段：

- `schema_version`: string，当前为 `"1.0"`
- `models`: array，元素含：
  - `name`: 模型标识（如 `"MiniMax-M3"`）
  - `provider`: 提供方（如 `"MiniMax"`）
  - `wins`: number，胜出次数
  - `losses`: number，失败次数
  - `draws`: number，平局/并列次数
- `task_types`: array，元素含：
  - `name`: 任务类型（如 `"implementation"`、`"review"`）
  - `total`: number，总执行次数
  - `pass`: number，通过次数
  - `fail`: number，失败次数

**初始状态**：两个数组均为空 `[]`，等待 feedback-collector 首次写入后填充。

### skill-index.json

从 `.kilo/skills/*/SKILL.md` 的 YAML frontmatter 自动提取 `name` 和 `keywords`，供关键词检索和路由决策使用。当前 v1.0 字段：

- `schema_version`: string，当前为 `"1.0"`
- `skills`: array，元素含：
  - `name`: skill 标识（与 frontmatter `name` 一致）
  - `path`: SKILL.md 相对路径
  - `keywords`: string[]（来自 frontmatter `keywords`）

**初始状态**：包含 2 个 skill（anti-patterns / patterns）的索引条目。后续可由 experience-ranker 追加 `usage` 字段（被引用次数、最后使用时间等）而不破坏 schema。新增 skill 分类时，按 `.kilo/instructions/skills-lifecycle.md`「扩展机制」章节同步更新本文件。

### log/YYYY-MM-DD.jsonl

每行一个 JSON 对象，表示一次任务事件。事件 schema（预告，待 feedback-collector 实现时定稿）：

```json
{"ts":"2026-06-30T16:55:04+08:00","task_id":"...","agent":"engineer","model":"MiniMax-M3","task_type":"implementation","outcome":"pass","duration_ms":1234,"skill_used":["patterns"],"failure_mode":null}
```

## schema 演进规则

- 任何字段新增/重命名/删除必须先升级 `schema_version`（如 `"1.0"` → `"1.1"`）。
- 消费者读取时必须先校验 `schema_version`，不匹配则走迁移或拒绝读取。
- 演进记录应同步到 `CHANGELOG.md` 或对应任务 commit message 中。

## 写入约束

- **禁止手动编辑 wins.json / skill-index.json**：这些文件由 experience-ranker 与本任务脚本管理。手动写入会破坏统计准确性。
- skill-index.json 的初始内容由本任务（P3-A）静态生成，后续 skill 增删时由 skills-writer 同步更新本文件。
- 本目录下的文件不应包含敏感信息（API Key、Token、用户凭据、内部 URL、PII）。
