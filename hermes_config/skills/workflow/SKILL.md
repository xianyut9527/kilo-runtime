---
name: workflow
description: 自进化编码工作流。基于 session_search（跨会话检索）、GitNexus（代码图谱）、git history（持久经验）构建真实可落地的自我学习闭环。当 checker/reviewer FAIL、fixer 同症状复发、或用户反馈"不对/遗漏"时触发跨会话根因回溯，避免重复踩坑。
keywords:
  - self-evolution
  - self-learning
  - memory
  - recall
  - root-cause
  - cross-session
  - feedback-loop
  - session-search
  - gitnexus
  - code-graph
  - experience
  - 自进化
  - 自学习
  - 记忆
  - 跨会话
  - 根因回溯
  - 经验回写
license: MIT
compatibility:
  - hermes-agent >= 2026
  - requires gitnexus MCP enabled
metadata:
  version: "1.0"
  category: workflow
---

# 自进化编码工作流

> 基于真实工具构建自我学习闭环：跨会话检索（`session_search`）+ 代码图谱（`gitnexus_*`）+ git history（持久经验）。
> 不依赖 LLM 自觉回写，每一层都用真实工具驱动。
> 兼容 [agentskills.io](https://agentskills.io/specification) 开放标准。

## 记忆三层架构

| 层 | 工具 | 存什么 | 检索方式 | 持久性 |
|----|------|--------|----------|--------|
| L1 冻结快照 | `SOUL.md` / `.hermes.md` / `skills/` | 项目流程、编码标准、安全约束、模式/反模式 | 任务启动时自动注入 | git 永久 |
| L2 跨会话历史 | `session_search` | 历史对话中的错误模式、解决方案、踩坑记录 | SQLite+FTS5 全文检索 | 本机持久 |
| L3 代码图谱 | `gitnexus_context` / `gitnexus_impact` / `gitnexus_query` | 调用链、影响面、数据依赖、API 消费者 | Cypher 查询 + 自然语言检索 | git 索引持久 |
| L4 持久经验 | `git log` / `git diff` | commit message 中的经验标注、SKILL.md 条目 | `git log --grep` / SKILL.md 全文 | git 永久 |

## 触发条件

以下任一条件触发自进化闭环：

1. checker/reviewer FAIL 且错误类型为方法层或需求层
2. fixer 连续 2 轮命中同症状
3. 用户反馈"还是有问题/不对/遗漏/不干净"
4. Circuit Breaker 触发（连续 3 次仍无法收敛）
5. Retry 升级（T1→T2, T2→T3）

## 自进化闭环流程

```
触发条件命中
    ↓
Step 1: 跨会话根因回溯（session_search）
    ↓ 找到历史同类问题？
    ├─ 是 → 提取历史解决方案，直接应用，跳过 Step 2
    └─ 否 → 继续 Step 2
Step 2: 代码图谱验证（gitnexus）
    ↓ 确认修改的爆炸半径与调用方
Step 3: 修复 + 验证（正常 engineer→checker 闭环）
    ↓ PASS
Step 4: 经验回写评估
    ├─ 跨项目价值 → 回写 `SOUL.md` / `.hermes.md`
    ├─ 项目特定模式/陷阱 → 回写对应 `SKILL.md`
    └─ 仅本次 → commit message 标注（git history 留痕）
    ↓
Step 5: 回写后验证
    ↓ session_search 搜索确认新经验可被未来会话检索到
```

### Step 1：跨会话根因回溯

**何时调用 `session_search`**：触发条件命中后，fixer 修复前。

**怎么搜**：
- 用错误症状关键词（如 "BOM 污染"、"SCOPE_CREEP 误判"、"PowerShell 编码"）
- 用失败的技术词（如函数名、错误消息、文件路径片段）
- 用错误类型（如 "方法层失败"、"同症状复发"）

**搜索后判断**：
- 找到历史同类问题 → 提取历史解决方案，直接应用
- 找到但解决方案过时 → 更新方案后应用
- 没找到 → 标记为新经验，Step 4 评估回写

**示例**：
```
错误：checker FAIL，"config.yaml 修改后 JSON.parse 失败"
搜索词：BOM JSON.parse config.yaml
→ 命中历史会话：AP-001 BOM 污染反模式
→ 提取解决方案：检测并剥离 BOM
→ 直接应用，不重复诊断
```

### Step 2：代码图谱验证

**何时调用 `gitnexus_*`**：修改函数/接口/数据结构前，或 checker FAIL 后定位影响面。

- `gitnexus_context`：查看修改符号的全部调用方/被调用方
- `gitnexus_impact`：分析修改的爆炸半径（upstream/downstream）
- `gitnexus_detect_changes`：确认未提交改动的受影响执行流程
- `gitnexus_data_impact`：数据库表/字段变更的影响面
- `gitnexus_api_impact`：API 路由变更的消费者影响

> GitNexus 索引可能滞后，结果必须用当前代码搜索复核。

### Step 4：经验回写规范

| 经验类型 | 写入目标 | 触发条件 | 执行者 |
|----------|----------|----------|--------|
| 跨项目通用架构约束 | `SOUL.md` / `.hermes.md` | reviewer 标注 `[建议写入 SOUL.md]` + 跨 2 次任务复现 | agent |
| 项目特定模式/陷阱 | 对应 `SKILL.md`（patterns/anti-patterns/workflow） | 命中回写触发条件 | agent |
| 仅本次任务的调试上下文 | commit message | 无跨会话价值 | engineer 在 commit 中标注 |

**回写后验证**：用 `session_search` 搜索刚写入的经验关键词，确认未来会话能检索到。

## 与错误三层判定的关系

自进化闭环不替代错误三层判定，而是在其基础上增加"跨会话回溯"维度：

| 错误层 | 动作 | 自进化附加动作 |
|--------|------|----------------|
| 执行层 | 直接修正，不计重试 | 不触发自进化 |
| 方法层 | 换策略重试，最多 2 次 | **触发 Step 1 跨会话回溯** |
| 需求层 | 暂停问用户 | **触发 Step 1 + Step 4 回写** |
