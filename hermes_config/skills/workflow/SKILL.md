---
name: workflow
description: 自进化编码工作流。基于 session_search（跨会话检索）、search_files（代码搜索）、read_file（文件读取）、memory（自动记忆）构建真实可落地的自我学习闭环。当 checker/reviewer FAIL、fixer 同症状复发、或用户反馈"不对/遗漏"时触发跨会话根因回溯，避免重复踩坑。
keywords:
  - self-evolution
  - self-learning
  - memory
  - recall
  - root-cause
  - cross-session
  - feedback-loop
  - session-search
  - search_files
  - read_file
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
metadata:
  version: "2.0"
  category: workflow
---

# 自进化编码工作流

> 基于真实工具构建自我学习闭环：跨会话检索（`session_search`）+ 代码搜索（`search_files` + `read_file`）+ 自动记忆（`memory`）。
> 不依赖 LLM 自觉回写，每一层都用真实工具驱动。

## 记忆架构

| 层 | 工具 | 存什么 | 检索方式 | 持久性 |
|----|------|--------|----------|--------|
| L1 冻结快照 | `SOUL.md` / `.hermes.md` / `skills/` | 项目流程、编码标准、安全约束、模式/反模式 | 任务启动自动注入 | git 永久 |
| L2 会话历史 | `session_search` | 原始对话中的错误模式、解决方案 | SQLite FTS5 全文检索 | 本机持久 |
| L3 结构化记忆 | `memory` | 自动提炼的用户偏好、环境信息、技术陷阱 | `memory(action='list')` 查看 | SQLite 持久 |
| L4 用户偏好 | `USER.md` | 用户明确声明的偏好和约束 | 任务启动自动注入 | git 永久 |
| L5 代码图谱 | `search_files` + `read_file` | 调用链、影响面、数据依赖 | 实时搜索 + 读取 | 实时分析 |

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
    └─ `search_files` + `read_file` 搜索相关代码确认上下文
    ↓ 找到？
    ├─ 是 → 直接应用，跳过 Step 2
    └─ 否 → 继续 Step 2
Step 2: 代码验证（search_files + read_file）
    ↓
Step 3: 修复 + 验证（engineer→checker 闭环）
    ↓ PASS
Step 4: 经验回写
    ├─ 可复用事实 → `memory(action='add')` + `skills/`
    ├─ 项目特定模式/陷阱 → 对应 `SKILL.md`
    ├─ 跨项目架构约束 → `SOUL.md` / `.hermes.md`
    └─ 仅本次 → commit message
    ↓
Step 5: 回写后验证
    ├─ `session_search` 确认新经验可被检索
    └─ `skill_view` 确认 skill 内容正确
```

### Step 1：根因回溯

**顺序**：先 `session_search` → 再 `search_files` / `read_file` 确认上下文。

| 工具 | 搜索内容 | 命中后动作 |
|------|----------|------------|
| `session_search` | 错误症状、函数名、错误消息、文件路径 | 提取历史解决方案 |
| `search_files` | 修改符号的定义和全部引用 | 确认影响面和上下文 |
| `read_file` | 疑似相关代码的完整内容 | 获取精确上下文 |

- 找到 → 直接应用，跳过 Step 2
- 找到但过时 → 更新后应用
- 没找到 → 标记为新经验，Step 4 评估回写

**示例**：
```
错误：checker FAIL，"config.yaml 修改后 JSON.parse 失败"
session_search: BOM JSON.parse config.yaml
→ 命中历史会话：AP-001 BOM 污染反模式
search_files: config.yaml 相关修改
→ 确认 BOM 存在
→ 直接应用，不重复诊断
```

### Step 2：代码验证

**何时调用**：修改函数/接口/数据结构前，或 checker FAIL 后定位影响面。

- `search_files(pattern, target='content')`：搜索修改符号的全部定义和引用
- `search_files(pattern, target='files')`：搜索相关文件列表
- `read_file(path)`：读取具体文件内容确认上下文
- `git diff`：确认未提交改动的实际范围

> 优先用 `search_files` + `read_file` 做实时分析，比依赖索引更可靠。

### Step 4：经验回写（强制规则）

**触发条件**（任一满足必须回写）：
1. 同类错误 `[CHECKPOINT_MISSED]` / `[NEEDS_RECALL]` / `[PROCESS_VIOLATION]` / `[SCOPE_CREEP]` 出现 **2 次及以上**
2. 用户明确纠正（"应该这样而不是那样"）
3. 发现新的项目特定坑（Windows GBK、库行为陷阱、工具 bug）
4. 修复后验证不通过，根因是之前未记录的经验

**回写目标与格式**：

| 经验类型 | 写入目标 | 工具 |
|----------|----------|------|
| 环境/偏好/陷阱 | `memory` + `skills/...` | `memory` / `skill_manage` |
| 项目反模式/陷阱 | `skills/anti-patterns/` | `skill_manage` |
| 项目最佳实践 | `skills/patterns/` | `skill_manage` |
| 工作流改进 | `skills/workflow/` | `skill_manage` |
| 架构约束 | `SOUL.md` / `.hermes.md` | `patch` / `write_file` |
| 用户偏好 | `USER.md` | `patch` / `write_file` |

**回写后验证**（必须执行）：
1. `session_search` 搜索关键词，确认可被未来会话检索
2. `skill_view` 读取刚写入的 skill，确认内容正确
3. `memory(action='list')` 确认新条目存在

**禁止**：
- 编造未经验证的经验
- 把项目规则写入个人运行时数据（SQLite、logs）而不进版本控制
- 使用不可用的工具（如 `fact_store`、`fact_feedback`）进行回写

## 与错误三层判定的关系

自进化闭环不替代错误三层判定，而是在其基础上增加"跨会话回溯"维度：

| 错误层 | 动作 | 自进化附加动作 |
|--------|------|----------------|
| 执行层 | 直接修正，不计重试 | 不触发自进化 |
| 方法层 | 换策略重试，最多 2 次 | **触发 Step 1 跨会话回溯** |
| 需求层 | 暂停问用户 | **触发 Step 1 + Step 4 回写** |
