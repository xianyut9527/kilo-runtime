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

> sqlite3 CLI 不会自动创建不存在的父目录。目录缺失是导致首次执行失败最常见的原因。

### 2. 建表（执行 schema/init.sql）

通过 bash 调用 sqlite3 CLI 执行仓库中的初始化脚本（v2.5-过渡版主通道）：

```bash
# Linux / macOS
sqlite3 "${HOME}/.config/kilo-data/memory.db" < ".kilo/memory/schema/init.sql"

# Windows (PowerShell) — 方式 A：输入重定向
sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db" ".read .kilo/memory/schema/init.sql"

# Windows (PowerShell) — 方式 B：管道
Get-Content ".kilo/memory/schema/init.sql" -Raw | sqlite3 "$env:USERPROFILE\.config\kilo-data\memory.db"
```

Windows 若无 `sqlite3` CLI，通过 `winget install SQLite.SQLite` 或 `choco install sqlite` 安装；临时降级可用 Node 22 内置 `node:sqlite` 写一次性执行脚本。

### 3. 验证表存在（执行 contracts/health_check.sql）

```sql
-- 由 contracts/health_check.sql 标准化
SELECT name FROM sqlite_master WHERE type='table';
```

应至少返回：`fact_store`、`failure_db`、`dispatch_log`、`project_context`、`model_calibration`。

### 4. 初始化 model_calibration 基线数据（可选）

首次部署后，可插入各 agent 的初始占位记录，便于后续动态校准计算成功率。详见 `model_calibration.md` §基线初始化。

### 5. v2.3 project_context 种子（自动执行）

首次部署时，`schema/init.sql` 末尾的种子段自动执行 `INSERT OR IGNORE INTO project_context ...`（8 条种子），无需单独执行。如需在已部署 v2.2 DB 上补齐，手动执行：

```bash
sqlite3 "${HOME}/.config/kilo-data/memory.db" < .kilo/memory/api/seed_project_context.sql
```

详细维护规则见 `policy/project_context_seed.md`。

### 6. v2.2 → v2.3 schema 迁移（升级场景）

从 v2.2 升级到 v2.3 时，如 memory.db 已在 v2.2 部署，按以下顺序执行迁移（每步独立可重跑；`ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS`，shell 包装器必须容忍 "duplicate column name" 错误）：

| 步骤 | 迁移脚本 | 影响表 |
|---|---|---|
| 6.1 | `api/migrate_add_scope_column.sql` | fact_store + scope / project_name 列 + idx_fact_scope 索引 |
| 6.2 | `api/migrate_compensation_columns.sql` | model_calibration + compensation_prompt_set_at / compensation_prompt_consumed_count 列 |
| 6.3 | `api/migrate_dispatch_compensation_columns.sql` | dispatch_log + compensation_prompt_used / compensation_calibration_id 列 |
| 6.4 | `api/migrate_skill_upgrade_log.sql` | skill_upgrade_log（v2.3 新表自动 CREATE）+ 回填 DRAFT 行 |
| 6.5 | `api/seed_project_context.sql` | project_context + 8 条种子（幂等 INSERT OR IGNORE） |
| 6.6 | `api/trial_archive.sql` | fact_store + 清理 14 天过期 trial 行（advisory，可选） |

新部署（首次 `schema/init.sql`）已包含 v2.3 所有 DDL + 8 条种子，无需跑 6.x 迁移。

## 失败处理

| 错误 | 原因 | 修复 |
|---|---|---|
| `sqlite3: 命令未找到` / `不是内部或外部命令` | sqlite3 CLI 未安装 | `winget install SQLite.SQLite` 或 `choco install sqlite`；临时降级用 Node 22 `node:sqlite` 脚本 |
| 首次执行报"无法打开数据库文件" | 目录不存在 | 执行步骤 1 |
| `no such table: fact_store` | 未执行 schema | 执行步骤 2 |
| 6 表任一缺失（v2.3） | init.sql 不完整 | 检查 `schema/init.sql`，重新执行 |
| `sample_count = 0` 除零 | 未插基线 | 执行步骤 4 |
| check17 `REQUIRED_TABLES_MISSING`（v2.3，actual=5） | v2.2 → v2.3 升级未跑 6.4 | 执行 `api/migrate_skill_upgrade_log.sql`（含 CREATE TABLE IF NOT EXISTS） |
| check17 `FACT_STORE_SCOPE_COLUMN_PRESENT` fail | v2.2 → v2.3 升级未跑 6.1 | 执行 `api/migrate_add_scope_column.sql` |
| check17 `PROJECT_CONTEXT_SEEDED` fail | 项目级 DB 首次部署但种子未应用 | 执行 `api/seed_project_context.sql` |
| check17 `TRIAL_EXPIRED_PENDING` fail | 14 天过期 trial 未归档 | 执行 `api/trial_archive.sql` |
| check17 `COMPENSATION_PROMPT_STALE` fail | model_calibration 设置补偿 prompt 后 30 天未消费 | 人工 review 失修 prompt；可考虑清除 |

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