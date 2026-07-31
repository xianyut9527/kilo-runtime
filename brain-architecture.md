# xy-code AI Engineering OS

> **定位**：独立的 AI 软件生产基础设施（AI Software Factory / AI Engineering OS）
> **当前状态**：使用 Kilo 作为快速迭代开发环境
> **终局目标**：人只需设计 AI 工程系统，AI Agent 自主生产软件、自我进化

---

## 核心命题

### 你不是在升级 Kilo

你在构建一个**独立的编排运行时**。Kilo 只是你当前雇用的一个承包商——用来快速验证想法。未来，这个运行时同样可以调用 Claude Code、Codex、OpenCode，或者你自己的 Agent。

### 范式转移

```
以前：
人 → 写需求 → 写代码 → 维护系统
         （Software Developer）

未来：
人 → 设计 AI 工程系统 → AI Agent → 生产软件 → 反馈数据 → 升级 AI Agent
         （AI System Architect）
```

你的角色从写业务代码的人，变成编写让 AI 更强的系统的人。

### 系统真正应该是什么

不是：
```
Kilo 增强版
```

而是：
```
AI 软件公司的操作系统
```

```
          人类架构师
              │
              │
        AI CEO / Brain
              │
    ---------------------
    │         │         │
产品Agent  技术Agent  运营Agent
    │
    │
开发Agent群
    │
    │
代码仓库
```

---

## 七层架构

```
┌──────────────────────────────────────────────────────────────┐
│  L7: EVOLUTION（进化层）                                      │
│  核心问题：怎么让 Agent 自己变强                               │
│  - 发现不足（错误率分析、瓶颈识别）                            │
│  - 优化策略（A/B 测试、流程固化）                              │
│  - 优化 Agent（模型偏差补偿、Prompt 调优）                     │
│  - 产出 Strategy Proposal，经审批后应用                        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L6: COGNITION（认知层）                                      │
│  核心问题：让系统会思考                                        │
│  - 反模式检测（BLIND_RETRY / SCOPE_CREEP / FAKE_CONTEXT）     │
│  - 经验推理（从 Memory 检索相关 Fact）                         │
│  - 意图理解（解析用户需求为结构化任务）                        │
│  - 提示模板选择（按模型/任务/项目匹配）                        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L5: EVALUATION（评估层）                                     │
│  核心问题：知道什么叫好                                        │
│  - 六层验证网络（入参→设计→执行→合成→审查→后验）             │
│  - 质量指标（任务完成率、代码质量、Bug率、回滚率）             │
│  - 质量校准（不同模型的系统偏差自动补偿）                      │
│  - 不替代 checker，只提供趋势分析和进化输入                    │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L4: MEMORY（记忆层）                                         │
│  核心问题：记住一切该记住的                                    │
│  - OrchestrationJournal（全链路事件流，永久保留 = 训练数据）  │
│  - Checkpoint（状态快照，崩溃可恢复、可分叉）                  │
│  - FactStore（结构化经验教训，语义检索）                       │
│  - ProjectMemory（项目专属知识：架构决策、业务规则）           │
│  - FailureDatabase（失败案例库）                               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L3: CONTEXT（上下文层）                                      │
│  核心问题：给 Agent 正确的上下文                               │
│  - ContextEngine（代码关系、架构约束、历史决策自动抽取）       │
│  - GitNexus / AST / CodeGraph / RAG                          │
│  - 自适应压缩（设计阶段轻压缩、验证阶段重压缩）                │
│  - context_anchor 精确度管理                                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L2: ORCHESTRATION（编排层）                                  │
│  核心问题：让任务稳定完成                                      │
│  - 意图分类 + 任务定级（T0-T3）                                │
│  - 状态机 + DAG（条件边 + 超时 + 回退策略）                    │
│  - Checkpoint 快照（每节点自动落盘）                           │
│  - 委派生成（结构化 Dispatch）                                 │
│  - 异常路由（10 种错误码 → RETRY / ROLLBACK / ESCALATE）     │
│  - 结果合成                                                    │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  L1: AGENT RUNTIME（执行层）                                  │
│  核心问题：让 Agent 安全执行                                   │
│  - 内置 Agent：engineer / checker / fixer / reviewer         │
│  - 外部执行器：Kilo（当前）/ Claude Code / Codex / OpenCode  │
│  - 四层隔离：进程 / Worktree / 环境 / 资源                     │
│  - 熔断 + 退避 + 负载均衡                                      │
│  - 模型无关底座（Capability 抽象 + 提示自适应）                │
└──────────────────────────────────────────────────────────────┘
```

### 层边界

| 层 | 做什么 | 不做什么 |
|----|--------|----------|
| Evolution | 读全系统数据 → 产优化提案 | 不直接修改运行时代码 |
| Cognition | 读历史 → 产推理结论 | 不直接调用 Agent |
| Evaluation | 读结果 → 产质量报告 | 不阻断执行期流程 |
| Memory | 只写不改、只读不删 | 不持有业务状态 |
| Context | 提供上下文切片与压缩 | 不参与业务逻辑决策 |
| Orchestration | 决策、路由、合成 | 不直接操作文件系统 |
| Agent Runtime | 按委派包执行 | 不自己做决策 |

---

## 护城河：三大核心资产

### 第一：Execution Data

你的 `OrchestrationJournal` 不是日志，是**训练数据**。

100 万个任务之后，你拥有：

```
什么任务
+ 什么策略
+ 什么模型
+ 什么 Prompt
+ 什么结果
```

这是模型训练、策略进化、竞争壁垒的根本来源。

### 第二：Context Engine

模型越来越强，但软件工程知识——代码关系、架构约束、历史决策、业务规则——永远需要上下文。

`GitNexus + AST + CodeGraph + RAG + Memory` 是你的核心。

### 第三：Evaluation System

没有评价，AI 不会进化。必须知道什么叫好：

- 任务完成率
- 代码质量
- Bug 率
- 回滚率
- 用户满意度
- 维护成本

否则所谓学习只是随机变化。

---

## 核心机制

### 一次任务的生命周期

```
① 用户请求
    │
    ▼
② Context Engine → 查询项目上下文
    │
    ▼
③ Orchestration → 意图分类 → 定级 T0-T3
    │
    ▼
④ Memory → 读取历史经验和 Skill
    │
    ▼
⑤ 生成 Dispatch（含 context_query + memory_query）
    │
    ▼
⑥ Checkpoint 快照（superstep=0）
    │
    ▼
⑦ Worktree 隔离 → spawn Agent
    │
    ▼
⑧ Agent 执行 → 流式事件 → Journal 实时追加
    │
    ▼
⑨ Agent 返回 → Checkpoint 快照（superstep=N）
    │
    ▼
⑩ Evaluation → 计算 QualityMetrics
    │
    ▼
⑪ Worktree cherry-pick / discard
    │
    ▼
⑫ Memory → 提取 pattern/antipattern → FactStore
    │
    ▼
⑬ Evolution → 异步分析 → Strategy Proposal
    │
    ▼
⑭ 交付用户
```

### 四步自进化闭环

```
执行    → Journal（什么任务+什么策略+什么模型+什么结果）
   │
反思    → Evaluation + Cognition 提取 Pattern / AntiPattern
   │
提炼    → 写入 Memory（FactStore + FailureDatabase）
   │
应用    → Evolution 生成 Strategy Proposal
       → 经 Regression Test → 人工审批 → 应用
       → V4 之后逐步探索自动审批
```

---

## 案例：系统怎么自己变强

### 案例 1：发现不足 → 生成知识

系统在 100 次 React 项目任务中发现：

```
组件状态管理错误率: 35%
原因: Agent 没有理解状态边界
```

自动生成 Fact：

```yaml
category: "ANTIPATTERN"
trigger: "React 项目组件状态管理任务"
action: "要求 Agent 在修改前显式画出状态边界图"
confidence: 0.35  →  规则注入后更新为 0.95
```

### 案例 2：优化策略 → 固化 Skill

基线：`Coder Agent` 直接修改代码，失败率 20%

实验：引入 `Architect → Plan Review → Coder` 流程

结果：成功率提升至 85%

动作：自动固化为 `complex-refactor-v2` Skill

### 案例 3：优化 Agent → 偏差补偿

发现 `Qwen3-Coder` 喜欢直接写代码，跳过依赖分析

`QualityCalibrator` 自动追加：

```
Before editing:
1. analyze dependency graph
2. list affected files
3. explain risk
```

效果：`structure_adherence` 从 0.62 提升至 0.89

---

## 路线图

### V1：稳定生产（当前 ~ 2 个月）

**目标**：AI 可以稳定写代码

**必须实现**：
- Orchestrator（状态机 + DAG + 委派）
- Checkpoint + Journal（持久化 + 断点续跑）
- **Context Engine**（代码关系、架构约束查询）
- **Memory**（历史经验检索、Skill 版本管理）
- 四层隔离（进程 + Worktree + 环境 + 资源）
- 异常路由 + 错误码分类

**验收**：
- 端到端任务成功率 > 90%
- kill-resume 恢复成功率 100%
- Context Engine 覆盖核心项目上下文

### V2：知识积累（2 ~ 4 个月）

**目标**：AI 越来越懂你的项目

**实现**：
- Project Memory
- Engineering Knowledge
- Skill Library
- Failure Database

**验收**：
- 新项目 onboarding 时间缩短 50%
- Skill 复用率 > 70%
- Failure Database 覆盖 10+ 种常见失败模式

### V3：自主优化（4 ~ 6 个月）

**目标**：AI 能分析自身不足并优化策略

**实现**：
- Evaluation → Failure Analysis（自动根因分析）
- Strategy Proposal（策略升级提案）
- Regression Test（回归测试验证）
- Upgrade（经审批后应用）

**验收**：
- 反模式自动检测覆盖率 > 80%
- 校准后策略成功率提升 > 5%
- 策略提案经回归测试不降级

### V4：AI 生产团队（6 个月以后）

**目标**：多 Agent 协作生产完整软件

**场景**：

用户说：
```
我要做一个类似淘宝的二手交易平台
```

系统自动拆分：
```
Product Agent:   拆需求、写 PRD
Architect:       设计系统架构
Backend Agent:   开发服务端
Frontend Agent:  开发前端
QA Agent:        编写并执行测试
Security Agent:  安全审查
DevOps Agent:    构建、部署、监控
```

**验收**：
- 单个需求从 PRD 到部署的全自动完成率 > 60%
- 多 Agent 协作链路可追踪可回滚

### V4 之后（探索性）

> 以下能力明确列为 V4 之后演进方向，V1-V3 **不实现**：
> - 异构 Ensemble 加权投票
> - 自动化 SKILL 升级（无人工审批）
> - 复杂 Borda 投票策略

---

## 与 Kilo 的关系

| | xy-code | Kilo |
|--|---------|------|
| **角色** | 指挥官 / 独立编排运行时 | 当前雇用的承包商 / 下游执行器之一 |
| **进程** | 独立长期驻留 | 按任务 spawn，用完即走 |
| **决策** | 调度、路由、重试、熔断、进化 | 单次代码生成 / 审查 |
| **状态** | 全局编排状态、检查点、历史 | 单次 task 上下文 |
| **未来** | 可接入 Claude/Codex/OpenCode 等任意执行器 | 可被替换、被抽象为统一接口 |

**当前**：V1 直接调用 Kilo 快速迭代  
**未来**：V2 通过 Adapter 统一接口，Kilo 只是众多执行器中的一个选项

---

## 关键设计

### 状态机 + Checkpoint

```typescript
interface Checkpoint {
  checkpoint_id: string;   // "cp_<uuid>"
  thread_id: string;       // 会话标识
  superstep: number;       // 0, 1, 2...
  node: string;            // 当前节点名
  state: Record<string, unknown>;
  created_at: string;      // ISO8601
}
```

- 每进入新节点前自动 `save_checkpoint()`
- 进程崩溃后可 `resume(thread_id)` 恢复
- 不可变（append-only），支持 `fork_checkpoint()` 用于并行

### 委派模板

```typescript
interface DispatchTemplate {
  template_id: string;
  tier: "T0" | "T1" | "T2" | "T3";
  role: string;
  prompt_template: string;
  output_schema?: JSONSchema;
  expected_tools: string[];
  timeout_ms: number;
  retry_policy: RetryPolicy;
  isolation: IsolationConfig;
  context_query: string;     // 调用 Context Engine
  memory_query: string;      // 调用 Memory
}
```

### 错误码与路由

| 错误码 | 触发 | 路由 |
|--------|------|------|
| `TIMEOUT` | 超时 | 退避重试 3 次 → ESCALATE reviewer |
| `RATE_LIMIT` | 限流 | 指数退避 + 错峰 |
| `CONTEXT_OVERFLOW` | 上下文超限 | 转 Context Engine 压缩后重试 |
| `AUTH` | 鉴权失败 | **不重试**，立即升级 |
| `BAD_INPUT` | 参数不合法 | **不重试**，回 brain 修正 |
| `TOOL_DENIED` | 工具被拒 | 转人机回路 |
| `CRASH` | 进程崩溃 | 重试 1 次 → 切备用执行器 |
| `AMBIGUOUS` | 说不清 | 重试 1 次（换严 schema）→ reviewer |

### 质量校准

```typescript
interface Calibration {
  model: string;
  task_type: string;
  bias: {
    overconfident: boolean;
    structure_adherence: number;
  };
  compensation: {
    prompt_suffix: string;
    temperature_adjustment: number;
  };
}
```

### 事实结构

```typescript
interface Fact {
  fact_id: string;
  category: "PATTERN" | "ANTIPATTERN" | "RECIPE" | "WARNING";
  trigger: string;       // 什么场景
  condition: string;    // 什么条件
  action: string;        // 怎么做
  confidence: number;    // 0-1
  evidence: string[];    // 来源 dispatch_id
}
```

---

## 参考

- **LangGraph**：状态图 + Checkpoint + Pregel 运行时
- **AutoGen v0.4+**：运行时与架构解耦 + TerminationCondition
- **Claude Code**：Worktree 隔离 + Hooks + Subagent Task
- **CrewAI**：Manager Agent + Guardrail
- **Codex**：JSON-RPC + Thread tree + execpolicy
- **建议.md**：AI Engineering OS 定位、V1-V4 路线图、Evolution Layer 架构

---

> **版本**：v2.1（按建议.md 优化：明确独立性、精简结构、强化进化）
> **状态**：待评审
