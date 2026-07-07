---
name: memory
description: 项目级冻结记忆（agent 笔记）。存放经 reviewer 验证的系统级经验，每次任务启动自动注入。
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  char_limit: 2200
  category: memory
---

# MEMORY.md

> 经 reviewer 验证的系统级经验，跨会话复用。
> 字符限制：≤ 2200 字符。

## 系统级约束

### M-001: JSON/YAML 配置文件严格校验
- 修改 `*.json` 后必须 `node -e "JSON.parse(...)"` 验证，无 BOM
- 修改 `*.yaml` 后必须 `hermes config check` 通过
- 详见 `skills/anti-patterns/SKILL.md#AP-001`

## 已验证经验

> 当前为空。T2/T3 任务命中跨会话价值后追加。

## 归档协议

超过 2200 字符时，将最旧低频条目迁移到 `archive/YYYY-MM/`，原位置保留索引。
