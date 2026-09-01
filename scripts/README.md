# scripts/ — 工具脚本集

Kilo 框架工具集，19 个顶层 `.mjs`（Node ESM，零 npm 依赖，Windows PowerShell 5.1 兼容）。
所有脚本仅使用 `node:fs / node:path / node:os / node:process / node:url / node:child_process` 内置模块，stderr 输出仅 ASCII 防 PS5.1 GBK 乱码。

> 子目录：`lib/`（4 个工具模块，供顶层脚本 ESM import）+ `lifecycle-doctor/`（框架静态装配 + runtime 引擎 + 7 个 check 子项）。

## 核心工具（19 个顶层 `.mjs`）

| 脚本 | 职责 | CLI 用法 | 退出码 | 关键依赖 |
|---|---|---|---|---|
| `sync-agent-prompt.mjs` | `agent.prompt` ↔ `agent/*.md` description 同步 | `--check / --force / --verbose` | 0/1 | `sanitize-agent-description` |
| `validate-agent-prompt.mjs` | prompt 健康度校验（zod 优先 + fallback） | `[<config.json>]` 默认根 `kilo.json` | 0/2 | zod 可选 |
| `sanitize-agent-description.mjs` | description 治本清洗（去控制字符/限长/XML warn/GBK warn） | `<agent.md path> / --test` | 0/2 | — |
| `scan-encoding.mjs` | 编码健康度扫描（BOM / U+FFFD / GBK 残留） | `[<files...>]` 默认 `git diff HEAD` | 0/1/2 | — |
| `bash-guard.mjs` | bash 命令静态分析（写拦截 + PS5.1 regex） | `"<bash cmd>"` | 0/1/2 | — |
| `task-context.mjs` | `task_context` CRUD + pre-dispatch size-check + 状态断言 | 多子命令（`init/get/set/validate/assert/size-check/log-dispatch/delete`） | 0/1/2 | WRITE_MATRIX 派生自 agent/*.md frontmatter |
| `task-context-runtime.mjs` | 纯运行时层（零副作用，供其他脚本 ESM import） | （库文件，无 CLI） | — | `lib/derived-cache.mjs` |
| `transition-check.mjs` | 阶段流转门禁（DAG 合法性 + quality.round 机械递增 + 熔断 + T1 强度门禁(INIT 出口校验 t1_strength + 直通边 minimal_gate)） | `<task_id> --from X --to Y` | 0/1/2/3 | `error-codes.mjs` |
| `flow-audit.mjs` | 流程合规审计（T1/T2 必经链路 + T1 按强度分流 + dispatch_log 完整性） | `[<task_id> / --all / --clean-stale]` | 0/1 | `lifecycle/stages/*.md` required_roles |
| `acceptance-check.mjs` | 机械验收门（A 层第一门，verify_command exit code 硬门） | `<task_id>` | 0/1/2 | `task_context.execution.acceptance_map` |
| `diff-boundary-check.mjs` | SCOPE_CREEP / FORBIDDEN_TOUCH 机械边界门 | `<task_id>` | 0/1/2 | `task_context.plan.task_dag.units[].key_files/forbidden_files` |
| `trust-transfer-check.mjs` | convergence-auditor 三步校验（独立 evidence / 信任传递措辞 / fresh 性） | `<task_id> [--round N]` | 0/1 | — |
| `search-discipline-check.mjs` | 搜索纪律机械门（无 include / pattern 爆炸 / PCRE 不支持特性） | `<task_id>` | 0/1/2 | — |
| `decouple-check.mjs` | 扫全仓第三方 MCP 工具名残留（gitnexus/context7/playwright） | （无 args） | 0/1/2 | 自豁免 |
| `agents-smoke-test.mjs` | 7 subagent 端到端冒烟测试调度（Node 18+ fetch） | 见脚本注释 | 0/1 | `kilo.json` provider/agent 配置 |
| `error-codes.mjs` | 错误码单一来源（transition-check / 文档同源） | （库文件，无 CLI） | — | — |
| `new-agent.mjs` | 新 agent 脚手架（写 .md + kilo.json + 改 EXPECTED_SUBAGENTS） | `<name> "<description>" [model]` | 0/2 | — |
| `new-stage.mjs` | 新 stage 脚手架（写 stages/<id>.md + 改 graph.yaml） | `<id> "<description>" [executor]` | 0/2 | — |
| `new-validator.mjs` | 新 transition validator 脚手架（写 error-codes + 改 transition-check） | `<code> "<desc>" <from> <to>` | 0/2 | — |

## 三件套（框架级安全门禁 v6）

Kilo 框架在每个项目跑任务时自动跑：

- `scan-encoding.mjs` — 编码健康度检测器（扫 BOM / U+FFFD / GBK），命中 → `[ENCODING_DRIFT]`
- `bash-guard.mjs` — bash 命令静态分析拦截器（含 PS5.1 复杂 regex），命中 → `[PS51_REGEX_RISK]` / `[BASH_WRITE_BLOCKED]`
- `lifecycle-doctor/checks/encoding-safety.mjs` — lifecycle-doctor 静态装配 check 之一，292 项编码安全

详见 `.kilo/instructions/core.md` 框架级安全门禁章节。

## 机械门分类

- **A 层（模型无关机械门，零 LLM 判定）**：`acceptance-check` / `diff-boundary-check` / `trust-transfer-check` / `search-discipline-check` / `transition-check`
- **B 层（静态扫描 / 软建议）**：`scan-encoding` / `bash-guard` / `decouple-check` / `flow-audit` / `lifecycle-doctor` 全套
- **C 层（写工具 / 派生工具）**：`sync-agent-prompt` / `sanitize-agent-description` / `validate-agent-prompt` / `new-agent` / `new-stage` / `new-validator` / `agents-smoke-test`
- **D 层（库文件，无 CLI）**：`task-context-runtime` / `error-codes` / `lib/*.mjs`

## 增量工具（本任务新增，2026-08-10）

- `sanitize-agent-description.mjs` — description 治本清洗器（`sync-agent-prompt.mjs` 的安全网，写 kilo.json 前必经）
- `lifecycle-doctor/checks/sanitize-self-test.mjs` — 监控 sanitize 自身健康度

## 设计原则

1. **零 npm 依赖**：仅 Node 内置模块，便于跨项目直接 `node scripts/<name>.mjs` 跑。
2. **跨平台兼容**：Windows PowerShell 5.1 + Linux bash；stderr 仅 ASCII 防 PS5.1 GBK 乱码。
3. **退出码硬门**：0=PASS / 1=usage/建议性 / 2=FAIL / 3=熔断（少数脚本）；CI 与 pre-dispatch 钩子可直接 `&& exit $?` 串联。
4. **纯函数导出 + CLI 双模式**：核心逻辑 export，CLI 仅为薄壳；便于单元测试与其他脚本 import 复用（见 `sanitize-agent-description.mjs` 8/8 self-test）。
5. **单一真相源**：`error-codes.mjs` 错误码表 / `agent/*.md` frontmatter / `lifecycle/stages/*.md` required_roles — 脚本按源派生，禁止复制。