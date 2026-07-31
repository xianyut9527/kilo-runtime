# Bash + sqlite3 CLI 统一命令模板（v2.5-过渡版主通道）

> **模块位置**：`.kilo/memory/policy/bash_sqlite_template.md`
> **职责**：为所有记忆 SQL 提供统一的 bash 执行模板；其他 policy 文件引用本文件，不再重复描述通道细节
> **依赖**：本机已安装 `sqlite3` CLI（Windows: `winget install SQLite.SQLite` / `choco install sqlite`；Linux/macOS: 系统自带或包管理器安装）

## 数据库路径

| 平台 | 路径 |
|---|---|
| Windows | `$env:USERPROFILE\.config\kilo-data\memory.db` |
| Linux / macOS | `${HOME}/.config/kilo-data/memory.db` |

> 统一语义：`${HOME}/.config/kilo-data/memory.db`，由 Kilo 运行时解析，install 阶段不替换。

## 模板 1：简单 SQL（单行）

### Windows (PowerShell)

```powershell
$db = "$env:USERPROFILE\.config\kilo-data\memory.db"
sqlite3 $db "SELECT COUNT(*) FROM fact_store;"
```

### Linux / macOS

```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" "SELECT COUNT(*) FROM fact_store;"
```

## 模板 2：复杂 SQL（含多层引号 / 多行）

**推荐**：写入临时 `.sql` 文件后用 `.read`，避免命令行转义陷阱。

### Windows (PowerShell)

```powershell
$db = "$env:USERPROFILE\.config\kilo-data\memory.db"
$sql = @"
INSERT INTO dispatch_log (dispatch_id, thread_id, agent, task_summary, status, created_at)
VALUES ('disp-test-001', 'thread-x', 'coderAgent', '示例', 'DONE', datetime('now'));
"@
$tmp = Join-Path $env:TEMP "mem_$(New-Guid).sql"
$sql | Set-Content -Path $tmp -Encoding UTF8
sqlite3 $db ".read $tmp"
Remove-Item $tmp -ErrorAction SilentlyContinue
```

### Linux / macOS

```bash
DB="${HOME}/.config/kilo-data/memory.db"
TMP=$(mktemp --suffix=.sql)
cat > "$TMP" <<'EOF'
INSERT INTO dispatch_log (dispatch_id, thread_id, agent, task_summary, status, created_at)
VALUES ('disp-test-001', 'thread-x', 'coderAgent', '示例', 'DONE', datetime('now'));
EOF
sqlite3 "$DB" ".read $TMP"
rm -f "$TMP"
```

## 模板 3：执行仓库中的 .sql 文件

### Windows (PowerShell)

```powershell
sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" ".read .kilo/memory/schema/init.sql"
# 或输入重定向（cmd.exe 风格，PowerShell 不支持 <，用 .read）
```

### Linux / macOS

```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/schema/init.sql
# 或
sqlite3 "${HOME}/.config/kilo-data/memory.db" ".read .kilo/memory/schema/init.sql"
```

## 模板 4：查询结果格式化（注入 agent 上下文用）

```powershell
# 列模式 + 表头（便于人读）
sqlite3 -header -column $db "SELECT fact_id, confidence, hit_count FROM fact_store LIMIT 5;"

# JSON 输出（便于程序解析，sqlite3 ≥ 3.38）
sqlite3 -json $db "SELECT fact_id, confidence FROM fact_store LIMIT 5;"

# CSV（便于管道处理）
sqlite3 -csv -header $db "SELECT * FROM v_high_confidence_facts;"
```

## 临时文件位置

所有临时 `.sql` 文件必须写入 `$env:TEMP`（Windows）或 `/tmp/`（Linux/macOS），禁止污染项目目录。用完即删（`Remove-Item` / `rm -f`）。

## 错误处理速查

| 症状 | 原因 | 修复 |
|---|---|---|
| `sqlite3: 命令未找到` / `不是内部或外部命令` | CLI 未安装 | 见顶部依赖说明 |
| `Error: unable to open database` | 目录不存在 | 执行 `policy/init_check.md` 步骤 1 |
| `no such table: fact_store` | 未执行 schema | 执行 `policy/init_check.md` 步骤 2 |
| 中文乱码 | 文件编码非 UTF-8 | `Set-Content -Encoding UTF8` 或 `chcp 65001` |

## 与其他 policy 的关系

- `init_check.md` 步骤 2 引用本模板执行 `schema/init.sql`
- `dispatch_recorder.md` M7 INSERT 引用本模板
- `fact_dedup.md` / `failure_recorder.md` / `model_calibration.md` / `m6_validation.md` 中的 SQL 均通过本模板执行
- 其他 policy 文件不再重复描述通道细节，只写 SQL 模板本身
