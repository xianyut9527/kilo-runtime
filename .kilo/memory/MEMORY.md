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

> 触发条件：跨 2 次以上任务重复出现 / reviewer 确认为系统级 / 修复不收敛时
> 入选条目：M-001（其余条目因不满足触发条件或与 SKILL 重复已清理）

### M-001: kilo_config 全局配置运行约束
- `kilo.json` 修改后必须 `node -e "JSON.parse(...)"` 严格解析（无 BOM 容忍）
- 详见 skills/anti-patterns/SKILL.md#AP-001 / #AP-005

## 已验证经验

> 本节当前为空。T2 / T3 任务结束后，命中触发条件的经验由 reviewer 评估是否追加。
> 单次发生的任务瑕疵、本次任务具体细节，不写入本节（归入 SKILL 的反思笔记或本任务 commit message）。

## 写入触发条件

满足以下任一条件时，由 coderAgent 主动评估是否追加：

1. 跨 2 次以上任务重复出现的架构约束或安全模式
2. 经 reviewer 确认为系统级而非项目级的经验
3. 修复不收敛（fixer 多轮失败）时发现的根因模式

**不满足触发条件的内容（不应写入本文件）**：

- 本任务单次发生的流程瑕疵 → 写入本任务 commit message 或 SKILL 的"反思笔记"区
- 与已有 SKILL.md 条目重复的内容 → 引用 SKILL 条目而非重复写入
- 任务级具体细节（如"16 个 agent"）→ 属于 commit/plan 文档，不属于跨会话记忆

## 归档协议

超过 2200 字符时，由 skills-writer 触发压缩：
- 将最旧的低频条目迁移到 `archive/YYYY-MM/` 子目录
- 在原位置保留 1 行索引（如 `[已归档] 详见 archive/2026-06/foo.md`）
- 总长度回到 ≤ 1800 字符后停止归档
