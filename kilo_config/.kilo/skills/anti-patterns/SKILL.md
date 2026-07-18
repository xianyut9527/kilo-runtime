---
name: anti-patterns
description: 反模式知识库索引。13 条 AP-XXX 按主题拆分到 4 个子 skill（encoding / process / coordination / contract），本文件提供总览与回写指引。
keywords: [anti-patterns, index, encoding, process, coordination, contract, 索引]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式索引

> 原 616 行 SKILL.md 按主题拆为 4 个子 skill，**保留全部 13 条 AP-XXX**。
> 拆分目的：降低单文件长度，提升按主题检索效率，避免子 skill 加载无关内容。
> 新增条目按主题写入对应子 skill，并在此索引登记。

## 主题分类总表

| 主题 | 子 skill 路径 | 条目数 | 覆盖范围 |
|------|--------------|--------|----------|
| encoding | `.kilo/skills/anti-patterns-encoding/SKILL.md` | 2 | Windows 编码 / BOM 污染 |
| process | `.kilo/skills/anti-patterns-process/SKILL.md` | 3 | 软约束 / 跳步 / SCOPE_CREEP |
| coordination | `.kilo/skills/anti-patterns-coordination/SKILL.md` | 6 | 关联遗漏 / 引用断链 / 子 agent 异常 |
| contract | `.kilo/skills/anti-patterns-contract/SKILL.md` | 2 | 权限越界 / 运行时能力误判 |

## 13 条 AP-XXX 反向链接

| ID | 标题 | 主题 | 跳转 |
|----|------|------|------|
| AP-001 | Edit 工具 BOM 污染 | encoding | [anti-patterns-encoding](./anti-patterns-encoding/SKILL.md#ap-001) |
| AP-002 | 软约束 vs 硬门禁 | process | [anti-patterns-process](./anti-patterns-process/SKILL.md#ap-002) |
| AP-003 | pre-checker FAIL 修正后未复验 | process | [anti-patterns-process](./anti-patterns-process/SKILL.md#ap-003) |
| AP-004 | 子智能体返回空结果未升级 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-004) |
| AP-005 | PowerShell 5.1 GBK 编码根因 | encoding | [anti-patterns-encoding](./anti-patterns-encoding/SKILL.md#ap-005) |
| AP-006 | 关联功能遗漏 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-006) |
| AP-007 | Agent 删除遗漏执行主体引用 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-007) |
| AP-008 | Agent Frontmatter 权限与职责不一致 | contract | [anti-patterns-contract](./anti-patterns-contract/SKILL.md#ap-008) |
| AP-009 | 多单元工作区 SCOPE_CREEP 全量 diff 误判 | process | [anti-patterns-process](./anti-patterns-process/SKILL.md#ap-009) |
| AP-010 | 删除配置字段前未确认外部消费者 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-010) |
| AP-011 | 由校验代码反推运行时能力 | contract | [anti-patterns-contract](./anti-patterns-contract/SKILL.md#ap-011) |
| AP-012 | 引用化前未确认目标文件覆盖完整性 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-012) |
| AP-013 | 重命名函数时遗漏内部调用同步 | coordination | [anti-patterns-coordination](./anti-patterns-coordination/SKILL.md#ap-013) |

## 回写指引

新增条目流程（详见 `.kilo/instructions/skills-lifecycle.md`）：

1. 确认经验已通过 checker/reviewer 验证。
2. 根据主题选择对应子 skill（encoding / process / coordination / contract）。
3. 按子 skill 末尾的"条目模板"追加。
4. 在本索引的反向链接表新增一行。
5. 更新对应子 skill 顶部的"主题条目表"。
