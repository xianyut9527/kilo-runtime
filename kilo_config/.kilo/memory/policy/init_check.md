# Init Check 策略

> **模块位置**：`.kilo/memory/policy/init_check.md`（业务规则唯一源）
> **模块架构**：本文件由 `.kilo/memory/` 模块统一管理，schema 见 `../schema/init.sql`，健康度见 `../contracts/health_check.sql`
> **职责**：定义 memory.db 首次部署的初始化 SOP

## 触发场景

首次启动或 `${HOME}/.config/kilo-data/memory.db` 不存在时。

## 4 步初始化 SOP

### 1. 确保数据目录存在

```bash
# Linux / macOS
mkdir -p "${HOME}/.config/kilo-data"

# Windows (PowerShell)
New-Item -ItemType Directory -Path "${env:USERPROFILE}\.config\kilo-data" -Force
```

> `mcp-sqlite` 不会自动创建不存在的父目录。目录缺失是导致 MCP 启动超时最常见的原因。

### 2. 建表（执行 schema/init.sql）

通过 sqlite MCP 执行仓库中的初始化脚本：

```sql
-- 方式 A：让 sqlite MCP 读取并执行仓库中的 init.sql
.read ${KILO_CONFIG_DIR}/.kilo/memory/schema/init.sql
```

或在命令行直接用 `sqlite3`：

```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" < ".kilo/memory/schema/init.sql"
```

Windows 若无 `sqlite3` CLI，可通过 sqlite MCP 的交互式查询逐条执行 `schema/init.sql` 中的 `CREATE TABLE` 语句。

### 3. 验证表存在（执行 contracts/health_check.sql）

```sql
-- 由 contracts/health_check.sql 标准化
SELECT name FROM sqlite_master WHERE type='table';
```

应至少返回：`fact_store`、`failure_db`、`dispatch_log`、`project_context`、`model_calibration`。

### 4. 初始化 model_calibration 基线数据（可选）

首次部署后，可插入各 agent 的初始占位记录，便于后续动态校准计算成功率。详见 `model_calibration.md` §基线初始化。

## 失败处理

| 错误 | 原因 | 修复 |
|---|---|---|
| MCP 启动超时 | 目录不存在 | 执行步骤 1 |
| `no such table: fact_store` | 未执行 schema | 执行步骤 2 |
| 5 表任一缺失 | init.sql 不完整 | 检查 `schema/init.sql`，重新执行 |
| `sample_count = 0` 除零 | 未插基线 | 执行步骤 4 |

## 模块完整性

本文件是初始化路径的唯一入口。如需扩展（如新增表、修改字段），必须：

1. 改 `../schema/init.sql`
2. 同步 `../contracts/health_check.sql` 验证表名清单
3. 在本文件「失败处理」表追加新错误类型
4. 跑 `node ../../../../validate-config.mjs` 确认 check17 PASS

## 相关策略

- `../schema/init.sql` — DDL 唯一源
- `../contracts/health_check.sql` — 健康度 SQL
- `../../../../validate-config.mjs` check17 — 模块健康度校验入口