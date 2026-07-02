---
name: security-checklist
description: 可扩展的安全/性能/认证检查清单。由 checker 在 L3 安全/性能检查阶段调用，将通用注入检测、资源安全检测、安全敏感模块专项检查的硬编码模式结构化以便扩展。
keywords:
  - security
  - sql-injection
  - xss
  - command-injection
  - path-traversal
  - rate-limit
  - pagination
  - upload-limit
  - batch-limit
  - password-hash
  - plaintext-password
  - weak-hash
---

# Security & Performance Checklist

## 用途

本文件是 `agent/checker.md` 在 L3 安全/性能检查阶段调用的通用注入/资源/认证检测模式的单一事实来源。

## 检测项总览

| ID | 标记 | 类别 | 来源段落 |
|----|------|------|----------|
| INJ-01 | `SECURITY_GAP_SQL_INJECTION` | security | 通用注入检测 §1 |
| INJ-02 | `SECURITY_GAP_XSS` | security | 通用注入检测 §1 |
| INJ-03 | `SECURITY_GAP_COMMAND_INJECTION` | security | 通用注入检测 §1 |
| INJ-04 | `SECURITY_GAP_PATH_TRAVERSAL` | security | 通用注入检测 §1 |
| PERF-01 | `PERF_GAP_NO_LIMIT` | performance | 资源安全检测 §2 |
| PERF-02 | `PERF_GAP_NO_UPLOAD_LIMIT` | performance | 资源安全检测 §2 |
| PERF-03 | `PERF_GAP_NO_BATCH_LIMIT` | performance | 资源安全检测 §2 |
| AUTH-01 | `SECURITY_GAP_PLAINTEXT_PASSWORD` | auth | 安全敏感模块专项 §3 |
| AUTH-02 | `SECURITY_GAP_WEAK_HASH` | auth | 安全敏感模块专项 §3 |
| AUTH-03 | `SECURITY_GAP_NO_HASH` | auth | 安全敏感模块专项 §3 |
| AUTH-04 | `SECURITY_GAP_NO_RATE_LIMIT` | auth | 安全敏感模块专项 §3 |

---

## 通用注入检测

触发条件：当变更涉及用户输入处理时自动触发——包括表单字段、API 参数、URL 查询、文件上传、Header 读取的增删改。

### INJ-01 SQL 注入

**类别**: security
**触发条件**: 变更涉及用户输入处理且包含 SQL 拼接或字符串模板生成 SQL 片段。
**检测模式**:
- `"SELECT` 后跟 `+`、`${`、`fmt.Sprintf`、`.format(`、`concat(` 等拼接
- `'SELECT` 后跟 `+`、`${`、`fmt.Sprintf`、`.format(`、`concat(` 等拼接
- 任意 SQL 关键字（INSERT/UPDATE/DELETE/FROM/WHERE）拼接用户输入变量
**安全替代模式**:
- 参数化查询：PreparedStatement、`?` 占位符、`$1` 占位符
- ORM 安全 API：Sequelize/TypeORM/SQLAlchemy 参数化方法
**输出标记**: `[SECURITY_GAP_SQL_INJECTION]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### INJ-02 XSS

**类别**: security
**触发条件**: 变更涉及用户输入处理且包含前端模板输出或 DOM 直接写入。
**检测模式**:
- `innerHTML` 赋值或传参用户可控内容
- `dangerouslySetInnerHTML` 接收用户可控内容
- `v-html` 绑定用户可控内容
- `document.write(` 输出用户可控内容
- `eval(` 执行用户可控字符串
**安全替代模式**:
- React/Vue/Angular 等自动转义模板
- 富文本场景使用 DOMPurify 等净化库
- URL/JSON 场景使用 `textContent`/`JSON.stringify`
**输出标记**: `[SECURITY_GAP_XSS]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### INJ-03 命令注入

**类别**: security
**触发条件**: 变更涉及用户输入处理且包含系统命令调用。
**检测模式**:
- `exec(` 拼接或插值用户输入
- `execSync(` 拼接或插值用户输入
- `spawn(` 拼接或插值用户输入
- `system(` 拼接或插值用户输入
- `popen(` 拼接或插值用户输入
- `subprocess.call(` 拼接或插值用户输入
**安全替代模式**:
- 使用参数数组形式：`child_process.spawn(cmd, [arg1, arg2])`
- 子进程调用前对参数做白名单校验
**输出标记**: `[SECURITY_GAP_COMMAND_INJECTION]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### INJ-04 路径遍历

**类别**: security
**触发条件**: 变更涉及文件路径拼接或用户提供路径片段。
**检测模式**:
- 文件路径操作中拼接 `../`
- 文件路径操作中拼接 `..`
- 未校验用户输入直接作为路径片段
**安全替代模式**:
- 使用 `path.resolve` / `path.join` 并校验最终路径在白名单目录内
- 文件名过滤：禁止 `..`、绝对路径前缀、URL 编码绕过
- 使用文件 ID 替代用户输入路径
**输出标记**: `[SECURITY_GAP_PATH_TRAVERSAL]`
**FAIL 条件**: 命中任一检测模式即 FAIL

---

## 资源安全检测

触发条件：当变更涉及查询/列表/文件/批量操作时触发。

### PERF-01 无 LIMIT 查询

**类别**: performance
**触发条件**: 变更涉及数据库查询或 ORM 数据获取。
**检测模式**:
- `SELECT ... FROM` 类查询无 `LIMIT` 子句
- ORM `find(` 调用无 `limit` 参数
- ORM `findAll(` 调用无 `limit` 参数
- ORM `.all(` 调用无 `limit` 参数
**安全替代模式**:
- 必须带 `LIMIT` + `OFFSET` 或游标分页
- 默认页大小 ≤100 条，调用方可指定 `pageSize` 但需设上限（如 max 1000）
**输出标记**: `[PERF_GAP_NO_LIMIT]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### PERF-02 无上传限制

**类别**: performance
**触发条件**: 变更涉及文件上传中间件或上传路由配置。
**检测模式**:
- 上传中间件/配置中无 `maxFileSize`
- 上传中间件/配置中无 `limits.fileSize`
- 上传中间件/配置中无 `maxSize`
- 上传中间件/配置中无 `sizeLimit`
**安全替代模式**:
- 默认单文件 ≤10MB
- 类型白名单（如 `image/png`, `image/jpeg`）
- 单次上传数量上限
**输出标记**: `[PERF_GAP_NO_UPLOAD_LIMIT]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### PERF-03 无批量上限

**类别**: performance
**触发条件**: 变更涉及批量删除、批量更新、批量导入/导出或批量循环。
**检测模式**:
- `deleteMany({})` 空条件批量删除
- `updateMany({})` 空条件批量更新
- 批量循环 `for` 无上限控制
- 批量循环 `while` 无上限控制
- 批量循环 `forEach` 无上限控制
**安全替代模式**:
- 单次批量处理上限
- 批量循环必须分批处理或设硬上限
- 空条件批量操作必须明确指定 `where` 过滤条件
**输出标记**: `[PERF_GAP_NO_BATCH_LIMIT]`
**FAIL 条件**: 命中任一检测模式即 FAIL

---

## 安全敏感模块专项检查

触发条件：当变更涉及用户/认证/支付/资金模块文件时触发（命中 `agent/checker.md` 安全敏感关键词表）。

### AUTH-01 明文密码

**类别**: auth
**触发条件**: 变更涉及用户/认证模块且包含密码比较或验证逻辑。
**检测模式**:
- `== password` 直接比较
- `=== password` 直接比较
- `.equals(password)` 直接比较
- `compare(password` 直接比较
- `password ===` 直接比较
- `password ==` 直接比较
**安全替代模式**:
- 使用 `bcrypt.compare` / `argon2.verify` / `hash_password.verify` 等安全哈希验证 API
**输出标记**: `[SECURITY_GAP_PLAINTEXT_PASSWORD]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### AUTH-02 弱哈希

**类别**: auth
**触发条件**: 变更涉及密码哈希、Token 派生、密码存储上下文。
**检测模式**:
- `md5(` 在密码相关上下文出现
- `sha1(` 在密码相关上下文出现
- `sha256(` 在密码相关上下文出现
**安全替代模式**:
- 密码哈希：`bcrypt` / `argon2` / `PBKDF2` + 唯一盐值
- Token 派生：`hmac_sha256` / `bcrypt` 等带密钥算法
**输出标记**: `[SECURITY_GAP_WEAK_HASH]`
**FAIL 条件**: 命中任一检测模式即 FAIL

### AUTH-03 无安全哈希

**类别**: auth
**触发条件**: 变更涉及用户/认证模块且未搜索到任一安全哈希库/函数调用。
**检测模式**（缺失即命中）:
- 仓库内未搜索到 `bcrypt`
- 仓库内未搜索到 `argon2`
- 仓库内未搜索到 `pbkdf2`
- 仓库内未搜索到 `hash_password`
- 仓库内未搜索到 `password_hash`
**安全替代模式**:
- 必须使用 `bcrypt` / `argon2` / `PBKDF2` 之一，且配合唯一盐值存储
- 禁止明文存储；禁止 MD5/SHA1/SHA256 等无盐弱哈希
**输出标记**: `[SECURITY_GAP_NO_HASH]`
**FAIL 条件**: 命中任一检测模式（即任一安全哈希均缺失）即 FAIL

### AUTH-04 无限流

**类别**: auth
**触发条件**: 变更涉及认证/支付路由文件且未搜索到任一限流机制。
**检测模式**（缺失即命中）:
- 认证/支付路由未搜索到 `rate_limit`
- 认证/支付路由未搜索到 `throttle`
- 认证/支付路由未搜索到 `lockout`
- 认证/支付路由未搜索到 `rateLimiter`
- 认证/支付路由未搜索到 `tooManyAttempts`
**安全替代模式**:
- 频率限制：≤5 次/分钟/IP 或等价机制
- 账户临时锁定：如 5 次失败锁定 ≥15 分钟
- 渐进延迟：指数退避
- 支付接口还需幂等性保护（唯一请求 ID 去重、事务原子性）
**输出标记**: `[SECURITY_GAP_NO_RATE_LIMIT]`
**FAIL 条件**: 命中任一检测模式（即任一限流机制均缺失）即 FAIL

---

## checker 调用规范

1. **加载时机**：checker 在执行 L3 安全/性能层核查时，读取本文件作为检测项字典。
2. **执行流程**：
   - 先判断是否命中"触发条件"（用户输入处理 / 查询列表批量 / 安全敏感模块）。
   - 命中则按对应 ID 的"检测模式"逐条用 grep/glob 扫描 diff 及关联文件。
   - 命中即按"输出标记"追加到验证结论，命中即按"FAIL 条件"判定该单元 FAIL。
3. **输出格式**：标记必须带文件位置（如 `src/foo.py:42`），与 `agent/checker.md` 行号要求一致。
4. **扩展规则**：新增检测项必须填写本文件 `## 检测项总览` 表格与对应章节，禁止在 `agent/checker.md` 中再次硬编码。


