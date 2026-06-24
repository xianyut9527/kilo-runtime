---
name: memory
description: 项目级冻结记忆（agent 笔记）。由 coderAgent / skills-writer 在任务过程中追加，由 reviewer 评估是否属于系统级经验。经 reviewer 确认后保留，否则回退到 skills 分类。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  char_limit: 2200
  category: memory
---

# MEMORY.md（agent 笔记）

> 本文件是 agent 维护的项目级冻结记忆。每个条目都必须经 reviewer 验证。
> 字符限制：**≤ 2200 字符**（约 500–700 tokens）。
> 加载机制：coderAgent 在任务启动时（意图判定完成后）自动注入系统提示。

## 系统级约束

> 来源：2026-06-07 ~ 2026-06-24 共 74 个本地会话提炼

### M-001: kilo_config 全局配置文件
- `kilo.json` 是 Kilo TUI 的运行时配置（不是普通 JSON）
- 修改后必须 `node -e "JSON.parse(...)"` 严格解析（无 BOM 容忍）
- Edit 工具偶尔会引入 UTF-8 BOM，必须检测剥离
- 详见 skills/anti-patterns/SKILL.md#AP-001

### M-002: Windows + PowerShell 5.1 编码永久化
- 任何中文/特殊字符文件操作前必须确保 `[Console]::OutputEncoding = UTF-8`
- install.ps1 已写入 `$PROFILE` 永久化
- 子进程编码不一致会导致"silent corruption"（写入成功但读出乱码）
- 详见 skills/anti-patterns/SKILL.md#AP-005

### M-003: 软约束变硬门禁
- 多次违反的规则必须从嵌套子条款提升到 `.kilo/instructions/core.md` 的"流程强制基线"平级位置
- 显式标注"违反视为方法层错误"显著提升遵守率
- 详见 skills/anti-patterns/SKILL.md#AP-002

### M-004: 子智能体返回空结果必须升级
- reviewer / architect / checker 连续 2 次空结果 → 标记 [SUBAGENT_RETURNED_EMPTY] + 升级 ensemble
- 不可直接内联（破坏独立验证）
- 详见 skills/anti-patterns/SKILL.md#AP-004

## 已验证经验

> 经验来源：2026-06-24 集成 Hermes 4 层加固任务（commit 630ba1d）

### M-101: T2 任务的标准流程
- 必须走 architect → pre-checker → engineer (G1 并行) → checker → fixer → 复验 → 串行（W1 / S1）→ reviewer
- G1 并行 4-8 单元节省约 60% 时间
- 5/5 SKILL.md 加 frontmatter 后，agentskills.io 工具可发现

### M-102: kilo.json 兼容性约束
- 12 顶层键必须保留（$schema / model / small_model / default_agent / instructions / snapshot / compaction / agent / commit_message / mcp / provider / provider）
- 实际有 16 个 agent（含 executor-A/B/C、ensemble、synthesizer、review-security/architecture/simplification）
- 顶层可新增 `skills` 字段（含 `external_dirs: []` 默认空数组）

## 写入触发条件

满足以下任一条件时，由 coderAgent 主动评估是否追加：

1. 跨 2 次以上任务重复出现的架构约束或安全模式
2. 经 reviewer 确认为系统级而非项目级的经验
3. 修复不收敛（fixer 多轮失败）时发现的根因模式

## 归档协议

超过 2200 字符时，由 skills-writer 触发压缩：
- 将最旧的低频条目迁移到 `archive/YYYY-MM/` 子目录
- 在原位置保留 1 行索引（如 `[已归档] 详见 archive/2026-06/foo.md`）
- 总长度回到 ≤ 1800 字符后停止归档
