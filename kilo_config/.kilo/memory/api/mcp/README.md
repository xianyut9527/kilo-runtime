# memory-mcp v3.0（备用通道）

> **状态**：预埋代码，**默认不启用**
> **主通道**：bash + sqlite3 CLI（见 `.kilo/memory/policy/bash_sqlite_template.md`）

## 为什么需要这个

Kilo 之前依赖第三方 sqlite MCP server，但社区实现存在严重内存泄漏（在 Windows 下尤为明显），导致 Kilo 进程内存爆炸。已删除该 MCP，但记忆模块铁律 1 要求"其他模块只能通过 sqlite MCP 工具与记忆交互"，通道被切断了。

**主通道修复**：所有 policy 改用 `bash` + `sqlite3` CLI 直接执行 SQL（见 `bash_sqlite_template.md`）。这是当前默认通道，零依赖、零常驻进程、零额外内存。

**备用通道（v3.0，本文件）**：自建 MCP server，使用 Node 22 内置 `node:sqlite`（零原生依赖）+ `@modelcontextprotocol/sdk`（纯 JS）。仅在主通道临时不可用时启用。

## 设计原则

1. **零原生依赖**：只用 `node:sqlite`（Node 22 内置同步 API）+ `@modelcontextprotocol/sdk`（纯 JS）。**禁止** better-sqlite3 / sqlite3 npm 包。
2. **同步 API**：避免事件循环泄漏（用户刚被异步 MCP 内存爆炸坑过）。
3. **FTS5 优雅降级**：Node 22.14 的 `node:sqlite` 不含 FTS5 module（实测 `no such module: fts5`），所有 `MATCH` 查询自动回退 LIKE；`insertFact` 临时禁用 fact_fts 触发器再重建，保证主通道（sqlite3 CLI）看到完整 FTS5 索引。
4. **单例 db 连接**：懒加载 + 优雅关闭（SIGINT/SIGTERM），进程退出时自动 close。
5. **默认不启用**：代码就位但 `kilo.json` 不注册或 `enabled: false`，由用户手动激活。

## 6 个 Tool

| Tool | 对应节点 | 描述 |
|---|---|---|
| `query_facts` | M1 注入 | 按关键词检索 fact_store（FTS5 MATCH → LIKE fallback） |
| `query_failures` | M2 回溯 | 按症状检索 failure_db（FTS5 → LIKE fallback） |
| `insert_fact` | M4 写入 | 去重 INSERT/UPDATE fact_store（事务内临时禁用 FTS5 触发器） |
| `log_dispatch` | M7 写入 | INSERT OR REPLACE dispatch_log |
| `update_calibration` | M8 写入 | UPSERT model_calibration（rolling-average success_rate） |
| `health_check` | 守门员 | 执行 `.kilo/memory/contracts/health_check.sql` 16 项检查 |

## 启用步骤

### 1. 安装依赖（首次）

```powershell
cd D:\work\kilo_config\kilo_config\.kilo\memory\api\mcp
npm install
```

### 2. 单元测试

```powershell
node test.js
```

期望输出：`通过: 17+` / `失败: 0`。

### 3. 内存稳定性测试

```powershell
node --expose-gc test-stability.js
```

期望输出：`✓ 内存稳定: 增长 < 50 MB`。**任何一次增长 > 50MB 立即停止启用流程**。

### 4. 手动注册 kilo.json

打开 `kilo.json`，在 `mcp` 块末尾追加：

```json
"memory": {
  "type": "local",
  "command": [
    "node",
    "D:\\work\\kilo_config\\kilo_config\\.kilo\\memory\\api\\mcp\\memory-mcp.js"
  ],
  "enabled": true,
  "timeout": 15000
}
```

注意：上一行（playwright 的闭合 `}` 后）必须加逗号 `,`。

### 5. 重启 Kilo + 观察

- Kilo 启动后查看进程内存（应 < 200MB，包含 Kilo 基础开销）
- 跑一个 T1 任务，看 dispatch_log 是否自动写入
- 跑完一个任务后，看 fact_store 的 helpful_rate / hit_count 是否更新

## 回滚步骤

### 软回滚（保留代码）

`kilo.json` 中 `mcp.memory.enabled` 改为 `false`，重启 Kilo。主通道（bash）不受影响。

### 硬回滚（完全移除）

```powershell
# 1. 移除 kilo.json 中 mcp.memory 块
# 2. 删除目录
Remove-Item -Recurse -Force D:\work\kilo_config\kilo_config\.kilo\memory\api\mcp
```

## 已知约束

- **FTS5 性能降级**：Node 22.14 的 `node:sqlite` 无 FTS5 module，query 走 LIKE 全表扫描。fact_store < 1000 条时性能可接受（< 10ms）；如规模增长到 10000+ 条，需要切回主通道（bash + sqlite3 CLI，享受完整 SQLite 库的 FTS5 索引）。
- **node:sqlite 实验性**：Node 仍标记为 experimental API，未来行为可能变化。如升级 Node 后 `node:sqlite` 行为破坏，立即启用主通道作为兜底。
- **写入并发**：单进程内 db 连接单例，不支持多进程并发写入（SQLite WAL 模式可缓解但不能完全避免）。如果 Kilo 多 worker 场景，需切回主通道。

## 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| `no such module: fts5` | 已知：node:sqlite 缺 FTS5 | 正常，会自动 fallback |
| `memory.db not found` | 数据库文件不存在 | 跑 `policy/init_check.md` 步骤 1+2 |
| 写入后 FTS5 索引丢失 | 触发器重建失败 | 跑 `INSERT INTO fact_fts(fact_fts) VALUES('rebuild');` |
| 进程内存持续增长 | 内存泄漏 | 立即启用回滚（`enabled: false`）+ 提交 issue |

## 相关文件

- `memory-mcp.js` — MCP server 主文件（654 行）
- `test.js` — 单元测试（直接 import tool 函数，不走 MCP 协议）
- `test-stability.js` — 内存稳定性测试（200 次循环）
- `package.json` — 依赖声明（只依赖 `@modelcontextprotocol/sdk`）
- `../../../policy/bash_sqlite_template.md` — 主通道命令模板
- `../../../contracts/health_check.sql` — health_check tool 消费的契约
