---
name: user
description: 用户档案（用户偏好 + 项目约定）。可由用户直接编辑；coderAgent 在加载时作为 USER 偏好注入上下文。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  char_limit: 1375
  category: memory
---

# USER.md（用户档案）

> 本文件存放用户偏好和项目约定。可由用户直接编辑。
> 字符限制：**≤ 1375 字符**（约 300–450 tokens）。
> 加载机制：`.kilo/memory/` 存在有效记忆文件时，与 MEMORY.md 一同由 coderAgent 在任务启动时注入。目录为空或不存在时跳过注入，文件保留，不报错。

## 用户偏好

<!-- 由用户直接编辑；agent 不得自动写入 -->

## 项目约定

<!-- 由用户直接编辑；agent 不得自动写入 -->

> 写入权限见 `.kilo/instructions/workflow-reference.md`「程序化记忆」章节。

## 安全约束

⚠️ **禁止写入以下内容**（review-security 会检查并拦截）：
- API Key / Token / 密码 / 凭证
- 内部域名 / IP 地址 / 内部 URL
- 个人身份信息（PII）
- 任何受 NDA / 保密协议保护的内容
