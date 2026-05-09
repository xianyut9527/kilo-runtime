# AGENTS.md

> 通用 AI 代理配置骨架与设计参考。运行时只注入 `./.kilo/instructions/` 中的轻量规则；本文件用于说明分层原则、智能体职责和项目级落地方式。

## 设计目标

- 全局配置只负责通用行为、安全边界、默认模型路由和编排骨架。
- 真正决定“上下文理解是否精准”的信息，必须沉淀在每个项目自己的 `AGENTS.md`、`.kilo/skills/`、`.kilo/commands/` 中。
- 不把具体项目的目录、框架、命令或领域规则硬编码到全局配置里。

## 分层原则

### 全局层

- 定义默认 agent、模型、权限、通用 instructions、全局命令和通用审查流程。
- 保持精简，避免堆叠项目知识。

### 项目层

- 在项目根目录维护项目级 `AGENTS.md`。
- 使用项目级 `.kilo/skills/` 注入架构、领域模型、接口契约、测试约定等高价值知识。
- 使用项目级 `.kilo/commands/` 封装 `/review`、`/test`、`/trace`、`/architect` 等重复工作流。

### 运行原则

- 先读后写，先定位后修改，先验证后交付。
- 默认最小改动；只有在复杂、高风险或单模型反复不稳定时才升级多模型并行。
- 项目级上下文优先于全局规则；全局规则只做兜底，不与项目规范争抢主导权。

## 智能体清单

| 智能体                | 类型           | 模式     | 职责                                                           |
| --------------------- | -------------- | -------- | -------------------------------------------------------------- |
| coderAgent            | 单模型编排     | all      | 日常入口；理解需求、选择路径、委派、跟踪与交付                 |
| architect             | 单模型规划     | subagent | 复杂需求分析、架构拆解、边界识别、任务规划                     |
| engineer              | 单模型实现     | subagent | 读取、实现、验证、修复                                         |
| reviewer              | 主审查者       | subagent | 主审查、按需调度专审、汇总 findings                            |
| review-security       | 安全专审       | subagent | 输入边界、权限控制、敏感信息与危险副作用                       |
| review-architecture   | 架构专审       | subagent | 分层、依赖方向、接口契约、跨模块影响                           |
| review-simplification | 简化专审       | subagent | 重复实现、复杂度膨胀、过度抽象、范围外修改                     |
| ensemble              | 多模型并行编排 | all      | 需求解析 → 并行编码 → 候选评估 → 双门禁 → 定向修复 → 交付      |
| executor-dp           | 多模型执行 A   | subagent | 偏稳健正确性与回归控制                                         |
| executor-mm           | 多模型执行 B   | subagent | 偏更小 diff、更高复用、更清晰实现                              |
| executor-cx           | 多模型执行 C   | subagent | 偏完整性与对抗性检查，补足边界条件、兼容性、失败路径与隐藏遗漏 |
| synthesizer           | 多模型合并     | subagent | 在候选差异较大时进行必要融合                                   |
| checker               | 客观验证门禁   | subagent | 运行测试、构建、类型检查、Lint，并检查范围与需求映射           |
| fixer                 | 多模型修复     | subagent | 根据高置信失败项做定向修复                                     |

## 工作流选择

### 路径 A：单模型默认链路

适用：需求清晰、中等复杂度、改动范围可控的任务。

用户 → `coderAgent` → `architect` / `engineer` / `reviewer`

### 路径 B：多模型并行链路

适用：复杂、高风险、跨模块、边界多、单模型多轮仍不稳定的任务。

用户 → `ensemble`
├→ 步骤 1: 需求解析与范围锁定
├→ 步骤 2: 默认并行 `executor-dp + executor-mm`
├→ 步骤 3: 满足条件时加入 `executor-cx`
├→ 步骤 4: 候选评估与必要融合
├→ 步骤 5: `checker + reviewer` 双门禁
├→ 步骤 6: `fixer` 默认 1 轮，条件满足最多 2 轮
└→ 步骤 7: 交付

## 上下文策略

### 动态项目探测

若项目级信息未填写，应主动探测：

1. 读取根目录 `package.json`、`pyproject.toml`、`Cargo.toml`、`pom.xml` 等基础配置。
2. 扫描 `tsconfig.json`、`eslint.config.*`、`vite.config.*`、`webpack.config.*`、`docker-compose.*` 等推断构建与验证命令。
3. 将探测到的命令用于自测和审查，而不是凭空假设。

### 项目知识优先

- 未来大型系统必须把核心知识拆到项目级 skill，而不是继续膨胀全局规则。
- 推荐优先沉淀的项目级 skill：
  - 架构与边界
  - 编码规范
  - 接口契约
  - 领域模型
  - 测试与回归策略

## 交付规范

- 输出只保留高信号内容：改了什么、为什么改、影响范围、如何验证。
- 验证结果优先给出命令、结论和关键失败片段。
- 发现需求歧义、关键信息缺失或置信度不足时，先一次性澄清，不基于猜测执行。
- 不做自我沉淀式“自动学习写规则”；只有经用户确认或项目维护者确认的规则，才进入长期文档。

## 项目级接入

- 本仓库不存放具体项目模板，避免把技术栈、目录结构或项目形态预设写回全局配置。
- 真实项目应在项目根目录自行维护：
  - 项目级 `AGENTS.md`
  - 项目级 `.kilo/skills/`
  - 项目级 `.kilo/commands/`
  - 必要时项目级 `kilo.json`
- 推荐先从最小 context pack 开始：
  - 1 个项目级 `AGENTS.md`
  - 3 到 5 个高价值 skills
  - 2 到 4 个高频 commands
- 如何结合项目级配置，请参考 [PROJECT_CONTEXT_PACK.md](file:///e:/AI/agent/kilo_config/PROJECT_CONTEXT_PACK.md)。
