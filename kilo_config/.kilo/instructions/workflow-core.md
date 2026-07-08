---
name: workflow-core
description: 编排核心规则 — 任务定级、单元化编排、闭环门禁、流程日志
keywords: workflow, orchestration, 任务定级, 单元编排, 闭环, 流程日志
---

# Workflow Core Rules

## 默认路由

- 入口：`coderAgent` 负责理解需求、路由、跟踪验证和交付。
- 简单局部实现 → `engineer`
- 架构变更、范围不清、跨层规则 → `architect`
- 显式 review 或安全/资金/权限/核心逻辑 → `reviewer`
- 多次失败、高风险、用户反馈"还是不对/有遗漏" → `ensemble`

## 任务定级

执行类任务必须按以下流程定级，并显式输出定级结论：

```
【任务定级结论】
- 任务等级：T0 / T1 / T2 / T3
- 定级依据：[具体判定条件]
- 执行路径：[直达engineer / 拆单元+pre-checker / architect+DAG / reviewer/ensemble]
- 触发条件：[Trace-First / 需求扩散 / 无]
```

### 定级决策树

```
Step 1: 意图判定（core.md）
  ├─ 咨询类 → 只分析，不改文件
  └─ 执行类 → 继续 Step 2

Step 2: T0 极速通道检查（5条全部满足）
  ├─ 全部满足 → T0，直达 engineer
  └─ 任一不满足 → 继续 Step 3

Step 3: 需求清晰度检查
  ├─ 模糊/矛盾/高风险/范围不清 → 先澄清，清晰后重新定级
  └─ 清晰 → 继续 Step 4

Step 4: 复杂度量化判定
  ├─ 命中安全敏感关键词 → 最低 T2
  ├─ 单文件/单点修改，有明确验收标准 → T1
  └─ 跨模块/规则扩散/无明确验收 → T2+
```

### T0 极速通道（5条全部满足）

1. ≤2 行代码变更
2. 无逻辑变更
3. 单文件
4. 纯表面修改（文案/格式/命名）
5. 无跨模块依赖

T0 直达 engineer，无需 pre-checker、checker、reviewer。

### T1-T3 定级

| 级别 | 标准 | 执行路径 |
|------|------|----------|
| T1 | 2-5 文件，单模块，有明确验收标准 | 拆单元，每单元 engineer → checker 闭环 |
| T2 | 跨模块，5+ 文件，规则扩散，命中安全敏感词 | architect 规划 → 单元 DAG → reviewer |
| T3 | 安全/资金/权限/核心逻辑，fixer 3 轮仍失败 | 全量 ensemble → reviewer → 用户决策 |

### 安全敏感模块识别

命中以下关键词 → **最低 T2**：

`user / account / auth / login / password / token / jwt / session / payment / checkout / wallet / balance / fund / transfer`

## 单元化编排

T1+ 任务必须拆分为可验证的单元，每单元独立闭环。

### 单元定义

- **最小可交付单元**：一个单元必须能独立验证、独立回滚。
- **单元边界**：以文件/模块/接口为界，避免跨界单元。
- **单元依赖**：单元间依赖必须是 DAG（无循环）。

### 单元 DAG

```
architect 规划 → 生成单元列表 → 并行/串行执行 → 逐单元验收 → 总体验收
```

- 无依赖单元 → 并行执行
- 有依赖单元 → 按依赖顺序串行

## 门禁与闭环

### 单元级闭环（T1+）

每单元：engineer → checker → 如需 fixer → 重新 checker。

- engineer 不自验，必须过 checker。
- checker FAIL → fixer 修复 → 重新 checker。
- fixer 连续 2 轮同症状 → 升级 reviewer。

### 总体验收（T2+）

所有单元通过后：
1. reviewer 三视角审查（安全/架构/简化）
2. 所有单元集成验证
3. 回归测试

### 质量门禁

| 门禁 | 说明 | 失败标记 |
|------|------|----------|
| 不自验 | engineer 不得自行验证 | `[PROCESS_VIOLATION]` |
| 双重 checker | 正向（需求/语法/逻辑/边界）+ 反向（SCOPE_CREEP/调试残留/重复实现） | `[SCOPE_CREEP]` / `[MISSING_ACCEPTANCE_MAP]` |
| 同症状防空转 | 连续 2 轮 fixer 同症状 → 升级 reviewer | `[NEEDS_REVIEW]` |
| Circuit Breaker | 连续 3 次无法收敛 → 停止 | `[CIRCUIT_BREAKER]` |
| 验收映射表 | 每条标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态 | `[MISSING_ACCEPTANCE_MAP]` |

## 交付

### 收尾三步

1. **验证确认**：测试、构建、类型、Lint 通过。
2. **范围确认**：`git diff --` 确认改动范围，无 SCOPE_CREEP。
3. **经验沉淀**：可复用事实 → `MEMORY.md`；模式/反模式 → `.kilo/skills/`; 架构约束 → `AGENTS.md`。

### 交付信号

- **正常交付**："任务完成，以上是全部变更和验证结果。"
- **降级交付**："任务部分完成，以下是已完成内容、未完成项和阻塞原因。"
- **失败交付**："任务未完成，阻塞原因是 X，建议方案是 Y。"

## 验证与修复通用原则

1. **不信任声明**：要求证据，怀疑一切。
2. **先验证后交付**：未通过验证不得标记完成。
3. **回归先行**：修复后首先确认未引入回归。
4. **根因闭合**：排查类任务必须证明根因闭合，而非表层补丁。
5. **三层修复**：执行层 → 方法层 → 需求层，逐层上升。
