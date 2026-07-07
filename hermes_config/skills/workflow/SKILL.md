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

## 记忆架构

| 层 | 工具 | 存什么 | 检索方式 | 持久性 |
|----|------|--------|----------|--------|
| L1 冻结快照 | `SOUL.md` / `.hermes.md` / `skills/` | 项目流程、编码标准、安全约束、模式/反模式 | 任务启动自动注入 | git 永久 |
| L2 会话历史 | `session_search` | 原始对话中的错误模式、解决方案 | SQLite FTS5 全文检索 | 本机持久 |
| L3 结构化事实 | `fact_store` / `fact_feedback` | 提炼后的可复用经验、环境偏好、技术陷阱 | 实体 probe / 跨实体 reason / 信任评分 | SQLite 持久 |
| L4 代码图谱 | `gitnexus_*` | 调用链、影响面、数据依赖 | Cypher 查询 | git 索引持久 |
| L5 git 历史 | `git log` / `git diff` | commit message 经验标注 | `git log --grep` | git 永久 |

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
Step 1: 根因回溯
    ├─ `session_search` 检索历史同类错误
    └─ `fact_store` probe 相关实体获取结构化经验
    ↓ 找到？
    ├─ 是 → 直接应用，跳过 Step 2
    └─ 否 → 继续 Step 2
Step 2: 代码图谱验证（gitnexus）
    ↓
Step 3: 修复 + 验证（engineer→checker 闭环）
    ↓ PASS
Step 4: 经验回写
    ├─ 可复用事实 → `fact_store` add
    ├─ 项目特定模式/陷阱 → 对应 `SKILL.md`
    ├─ 跨项目架构约束 → `SOUL.md` / `.hermes.md`
    └─ 仅本次 → commit message
    ↓
Step 5: 回写后验证
    ├─ `session_search` 确认新经验可被检索
    └─ `fact_store` search 确认新事实可被召回
```

### Step 1：根因回溯

**顺序**：先 `session_search` → 再 `fact_store` probe。

| 工具 | 搜索内容 | 命中后动作 |
|------|----------|------------|
| `session_search` | 错误症状、函数名、错误消息、文件路径 | 提取历史解决方案 |
| `fact_store` | 错误类型实体、技术栈实体、模块实体 | 获取信任评分高的结构化经验 |

- 找到 → 直接应用，跳过 Step 2
- 找到但过时 → 更新后应用
- 没找到 → 标记为新经验，Step 4 评估回写

**示例**：
```
错误：checker FAIL，"config.yaml 修改后 JSON.parse 失败"
session_search: BOM JSON.parse config.yaml
→ 命中历史会话：AP-001 BOM 污染反模式
fact_store probe: "BOM 污染"
→ 信任评分 0.9，确认检测并剥离 BOM
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

### Step 4：经验回写

| 经验类型 | 写入目标 | 示例 |
|----------|----------|------|
| 可复用事实（环境、偏好、陷阱、API 行为） | `fact_store` | "Windows PowerShell 默认 GBK"、"YAML 注释行 `provider` 被解析为键" |
| 项目特定模式/陷阱 | `skills/` 对应 SKILL.md | AP-001 BOM 污染、PAT-004 规则进版本控制 |
| 跨项目架构约束 | `SOUL.md` / `.hermes.md` | T0-T3 定级、7 节点流程日志 |
| 仅本次上下文 | commit message | 调试时的临时 workaround |

**回写后验证**：
- `session_search` 搜索关键词，确认可被未来会话检索
- `fact_store` search 确认新事实可被召回

## 与错误三层判定的关系

自进化闭环不替代错误三层判定，而是在其基础上增加"跨会话回溯"维度：

| 错误层 | 动作 | 自进化附加动作 |
|--------|------|----------------|
| 执行层 | 直接修正，不计重试 | 不触发自进化 |
| 方法层 | 换策略重试，最多 2 次 | **触发 Step 1 跨会话回溯** |
| 需求层 | 暂停问用户 | **触发 Step 1 + Step 4 回写** |
