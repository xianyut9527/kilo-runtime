# AGENTS.md

> 通用 AI 代理配置骨架与设计参考。运行时只注入 `./.kilo/instructions/` 中的轻量规则；本文件用于说明分层原则、智能体职责和项目级落地方式。
>
> 运行时通用规则索引（`.kilo/instructions/*.md`，每条规则只在单一文件中完整维护，其他文件通过引用链接指向主文档，避免重复）：
>
> - `core.md` — 意图判定、通用安全约束、流程强制基线、编码前强制检查点
> - `workflow-core.md` — 任务定级、单元 DAG、门禁、交付与程序化记忆触发（自动注入）
> - `workflow-reference.md` — 工作流参考内容（按需读取）：small_model 触发规则、Trace-First、外部索引与 MCP 闸门、需求扩散与同类点扫描、委派包、知识沉淀、Anthropic 5 大模式映射、程序化记忆触发条件
> - `reflection.md` — 反思三层判定 / 根因 / Circuit Breaker
> - `security-checklist.md` — checker L3 调用的可扩展安全/性能检测清单（INJ / PERF / AUTH）
> - `output-schema.md` — 下游 agent 交付输出的最小公共字段与 `[MARKER]` 标记语言规范
> - `skills-lifecycle.md` — 按需引用（不自动注入所有 agent 上下文），由 `coderAgent` / `skills-writer` 主动读取

## 单一事实来源与修改指南

- **本文件是智能体清单和架构设计的唯一权威来源**。所有智能体的名称、类型、模式和职责概览以本文件为准。
- 每个智能体的**详细行为规则**在各自的 `agent/{name}.md` 中维护，本文件只做索引，不写详细规则。
- **修改前**：请同步阅读 `CONFIG_CHANGE_CHECKLIST.md`，确认变更涉及的关联文件和检查要点。

## 设计目标

- 全局配置只负责通用行为、安全边界、默认模型路由和编排骨架。
- 真正决定"上下文理解是否精准"的信息，必须沉淀在每个项目自己的 `AGENTS.md` 和 `.kilo/skills/` 中。
- 不把具体项目的目录、框架、命令或领域规则硬编码到全局配置里。

## 分层原则

### 全局层
- 定义默认 agent、模型、权限、通用 instructions 和通用审查流程。保持精简，避免堆叠项目知识。

### 项目层
- 在项目根目录维护项目级 `AGENTS.md`。
- 使用项目级 `.kilo/skills/` 注入架构、领域模型、接口契约、测试约定等高价值知识。

### 运行原则
- 先读后写，先定位后修改，先验证后交付。
- 默认最小改动；只有在复杂、高风险或单模型反复不稳定时才升级多模型并行。
- 项目级上下文优先于全局规则；全局规则只做兜底，不与项目规范争抢主导权。

## 智能体清单

| 智能体 | 类型 | 模式 | 职责 |
|--------|------|-------|------|
| coderAgent | 单模型编排 | primary | 日常入口；任务分级、单元化编排、委派、跟踪与交付 |
| architect | 单模型规划 | subagent | 复杂需求分析、架构拆解、边界识别、任务规划 |
| engineer | 单模型实现 | subagent | 读取、实现、验证、修复 |
| reviewer | 主审查者 | subagent | 主审查；内置覆盖安全/架构/简化三种视角；汇总 findings |
| skills-writer | 知识沉淀 | subagent | 将经 checker/reviewer 确认的经验写入 `.kilo/skills/` 长期知识库 |
| feedback-collector | 反馈采集 | subagent | 任务结束后将反馈信号（task_id、task_type、agent_chain、models_used、fixer_rounds、final_status、failure_tags、user_feedback 等）追加写入 `.kilo/experience/log/YYYY-MM-DD.jsonl`，只记录不修改文件 |
| experience-ranker | 经验评估 | subagent | 周期性读取 `.kilo/experience/log/` 的 feedback log，按复现频率/修复收益/泛化价值/置信度/衰减度多维评估，决定经验写入 MEMORY.md / SKILL.md / 丢弃，并委派 skills-writer 执行写入 |
| ensemble | 多模型并行编排 | all | 需求解析 → 并行编码 → 候选评估 → 双门禁 → 定向修复 → 交付 |
| executor-A | 多模型执行 A | subagent | 偏稳健正确性与回归控制 |
| executor-B | 多模型执行 B | subagent | 偏更小 diff、更高复用、更清晰实现 |
| executor-C | 多模型执行 C | subagent | 偏完整性与对抗性检查，补足边界条件、兼容性、失败路径与隐藏遗漏 |
| synthesizer | 多模型合并 | subagent | 在候选差异较大时进行必要融合 |
| checker | 客观验证门禁 | subagent | 运行测试、构建、类型检查、Lint，并检查范围与需求映射是否合格，输出明确的 PASS/FAIL 结论 |
| pre-checker | 预审门禁 | subagent | 需求理解偏差、单元边界遗漏、验收标准可验证性校验 |
| fixer | 定向修复 | subagent | 根据高置信失败项做定向修复，只修改 checker/reviewer 明确指出的问题 |

## 工作流选择

### 路径 A：单模型默认链路
适用：需求清晰、中等复杂度、改动范围可控的任务。

用户 → `coderAgent` → 简单任务直达 `engineer`；中等及以上任务先拆为任务 DAG，再按小单元调度 `architect` / `pre-checker` / `engineer` / `checker` / `fixer` / `reviewer`

### 路径 B：多模型并行链路
适用：复杂、高风险、跨模块、边界多、单模型多轮仍不稳定的任务。

用户 → `ensemble` → 需求解析 → 并行实现 → 候选评估 → 双门禁 → 定向修复 → 交付

## 上下文策略

动态项目探测：读取根目录 `package.json`、`pyproject.toml`、`Cargo.toml`、`pom.xml` 等基础配置推断构建与验证命令，用于自测和审查。

项目知识优先：推荐优先沉淀的 skill：架构与边界、编码规范、接口契约、领域模型、测试与回归策略。

## 交付规范

- 输出只保留高信号内容：改了什么、为什么改、影响范围、如何验证。
- 验证结果优先给出命令、结论和关键失败片段。
- 发现需求歧义、关键信息缺失或置信度不足时，先一次性澄清，不基于猜测执行。
- 禁止自动编造规则：LLM 不得凭空生成规则写入长期文档。进入 `.kilo/skills/` 的内容必须经过闭环验证（触发条件匹配 + checker/reviewer 客观验证通过 + 标注验证证据来源），见 `.kilo/instructions/skills-lifecycle.md`。
- 用户或项目维护者可直接确认规则写入，不依赖自动回写触发条件。

## 项目级接入

真实项目应在项目根目录自行维护项目级 context pack，让全局配置保持通用精简，让项目知识留在项目目录。

### 最小结构

```text
your-project/
├── AGENTS.md
├── kilo.json                  # 可选
└── .kilo/
    ├── skills/
    │   ├── architecture/SKILL.md
    │   ├── contracts/SKILL.md
    │   └── testing/SKILL.md
    └── memory/
        ├── MEMORY.md          # agent 笔记（≤ 2200 字符）
        └── USER.md            # 用户档案（≤ 1375 字符）
```

### 推荐的 3 个首批 skills

1. **架构与边界**：模块划分、依赖方向、跨层限制、新逻辑落点
2. **接口与契约**：输入输出格式、兼容性要求、调用方影响面、事件结构
3. **测试与回归**：必须跑的测试、必须补测试的改动、可局部执行的验证、高风险链路
4. **程序化记忆（memory）**：项目级冻结记忆，借鉴 Hermes Agent 的 MEMORY.md / USER.md 双轨设计
5. **运行时安全基线（不属 skill）**：参见 `.kilo/instructions/security-checklist.md`，由 `checker` 在 L3 阶段调用；与 `.kilo/skills/` 中的 `anti-patterns` 互不重复——前者是检测项结构化清单，后者是踩坑模式沉淀。

### 判断标准

离开某项目后仍成立的信息适合放全局，只对某个项目成立的信息应放项目级 context pack。

项目级经验沉淀应优先判断：跨项目通用 → 写入 MEMORY.md；项目特定 → 写入 SKILL.md。

## 修改本仓库时的注意事项

- **禁止在多个位置重复维护同一规则**。同一规则只在一处完整维护，其他位置使用引用或索引方式指向主文档。
- **新增或删除 agent 时**，必须同步更新以下位置：
  - 本文件中的智能体清单表格
  - `README.md` 中的目录结构树
  - `agent/` 目录下的对应文件（必须含完整 YAML frontmatter，详见 `CONFIG_CHANGE_CHECKLIST.md`）
- **修改跨 agent 协同规则时**（如 fixer 轮次、升级阈值、三层框架、需求扩散），优先修改 `.kilo/instructions/` 中的单一规则源；agent 文件只保留必要引用。
- **修改 `kilo.json` 中任何 agent 的 `prompt` 字段时**：必须同步检查 `agent/{name}.md` 是否含同类术语/规则，保持术语一致。pre-checker 校验同步性，遗漏标记 `[MISSING_LINKAGE]`。这是避免运行时行为锚点与长期文档脱节的结构性约束。
  - 同时检查 `agent/{name}.md` 与 `.kilo/instructions/*.md` 中 `[MARKER]` / 检测项 ID 的一致性；避免 prompt 中引用的标记在 instructions 中无定义（`[MARKER]` 写法见 `output-schema.md` 标记语言规范；检测项 ID 与分类见 `security-checklist.md`「检测项总览」表）。
