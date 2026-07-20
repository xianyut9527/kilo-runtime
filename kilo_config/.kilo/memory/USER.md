---
name: user
description: 用户档案（用户偏好 + 项目约定）。可由用户直接编辑；coderAgent 在加载时按 [tag] 按需注入上下文。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.3"
  char_limit: 1375
  category: memory
---

# USER.md（用户档案）

> 本文件存放用户偏好和项目约定。可由用户直接编辑。
> 字符限制：**≤ 1375 字符**（约 300–450 tokens）。
> 加载机制：由 `.kilo/memory/AGENTS.md` 统一调度（v2.6 模块入口，含 FTS5 trigram 检索 + helpful_rate 强制反馈），按 **[tag]** 按需注入，未命中当前任务标签的条目不注入，文件保留，不报错。
>
> 兼容路径：`.kilo/memory/memory-strategy.md` 保留为指针文件，AGENTS.md 中 `strategy: "memory-strategy.md"` 仍可命中。

## 用户偏好 [tag:general]

<!-- 由用户直接编辑；agent 不得自动写入 -->

## 项目约定 [tag:general]

<!-- 由用户直接编辑；agent 不得自动写入 -->

> 写入权限见 `.kilo/instructions/workflow-reference.md`「程序化记忆」章节。

## 安全约束 [tag:security]

⚠️ **禁止写入以下内容**（review-security 会检查并拦截）：
- API Key / Token / 密码 / 凭证
- 内部域名 / IP 地址 / 内部 URL
- 个人身份信息（PII）
- 任何受 NDA / 保密协议保护的内容
