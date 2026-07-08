---
name: security-checklist
description: 安全与性能检测项清单
keywords: security, performance, checklist, injection
---

# Security & Performance Checklist

## 通用注入检测

| ID | 检测项 | 触发条件 | 标记 |
|----|--------|----------|------|
| INJ-01 | SQL 注入 | 动态 SQL 拼接、未参数化查询 | `[SECURITY_GAP_SQL_INJECTION]` |
| INJ-02 | XSS | 用户输入直接输出到 HTML/JS/CSS | `[SECURITY_GAP_XSS]` |
| INJ-03 | 命令注入 | 用户输入拼接到系统命令 | `[SECURITY_GAP_COMMAND_INJECTION]` |
| INJ-04 | 路径遍历 | 用户输入用于文件路径拼接 | `[SECURITY_GAP_PATH_TRAVERSAL]` |

## 资源安全检测

| ID | 检测项 | 触发条件 | 标记 |
|----|--------|----------|------|
| PERF-01 | 无 LIMIT 查询 | 数据库查询无分页/LIMIT | `[PERF_GAP_NO_LIMIT]` |
| PERF-02 | 无上传限制 | 文件上传无大小/类型/数量限制 | `[PERF_GAP_NO_UPLOAD_LIMIT]` |
| PERF-03 | 无批量上限 | 批量操作无数量上限 | `[PERF_GAP_NO_BATCH_LIMIT]` |

## 安全敏感模块专项

| ID | 检测项 | 触发条件 | 标记 |
|----|--------|----------|------|
| AUTH-01 | 明文密码 | 密码明文存储或传输 | `[SECURITY_GAP_PLAINTEXT_PASSWORD]` |
| AUTH-02 | 弱哈希 | 使用 MD5/SHA1 等弱哈希 | `[SECURITY_GAP_WEAK_HASH]` |
| AUTH-03 | 无安全哈希 | 密码无加盐哈希 | `[SECURITY_GAP_NO_HASH]` |
| AUTH-04 | 无限流 | 登录/敏感操作无限流/防暴破 | `[SECURITY_GAP_NO_RATE_LIMIT]` |

## 检测原则

1. **白名单优先**：输入校验用白名单而非黑名单。
2. **上下文净化**：HTML 转义、SQL 参数化、命令参数化。
3. **统一中间件**：鉴权/权限校验落在统一中间件，不散落各调用点。
4. **错误脱敏**：错误响应不暴露内部路径、SQL、堆栈。
