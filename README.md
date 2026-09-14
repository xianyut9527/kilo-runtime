# kilo_config — KiloCode 全局配置（SSOT）

本仓库是 Kilo 全局配置的**唯一真源**。所有改动在这里做，然后用下发器同步到
`~/.config/kilo/`。不做固定工作流、不做阶段门禁 —— 只提供**能力、策略与护栏**，
编排判断交给 agent 自己。

## 快速开始

```bash
# 预览将要发生的变更（不写盘）
./install.sh --dry-run

# 下发（改动前自动打包备份目标目录）
./install.sh

# 只检测漂移（仓库 vs 部署），有漂移退出码 1 —— 可挂到预提交钩子
./install.sh --check

# Windows 原生（等价实现）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

## 仓库结构与职责

| 路径 | 职责 | 下发目标 |
|------|------|----------|
| `install.manifest` | **下发清单（唯一文件列表真源）** | — |
| `install.sh` / `install.ps1` | 下发器：占位符替换 + 幂等 + 备份 + 漂移检测 | — |
| `kilo.json` | 运行时配置模板（含 `__KILO_HOME__` 占位符） | `~/.config/kilo/kilo.json` |
| `INSTRUCTIONS.md` | 全局工程原则（认知中心 / 风险验证 / 边界） | `~/.config/kilo/INSTRUCTIONS.md` |
| `agent/` | 非内置 agent 的提示词（当前：`verify`） | `~/.config/kilo/agent/` |
| `plugin/` | 本地插件（压缩锚点 / MoA / 权限守护 / 本地遥测） | `~/.config/kilo/plugin/` |
| `scripts/` | `kb.mjs`（经验库 CLI）、`metrics-report.mjs`（遥测汇总） | `~/.config/kilo/scripts/` |
| `knowledge-base/` | 跨项目工程经验库（症状→根因→修复） | `~/.config/kilo/knowledge-base/` |
| `docs/templates/` | 项目级 `AGENTS.md` 模板 | `~/.config/kilo/docs/templates/` |
| `provider/hx-failover/` | 自研 provider：模型失败自动沿链降级 | `~/.config/kilo/provider/hx-failover/` |
| `plan.md` | 升级方案与能力边界（含实测结论） | — |

**不下发**：`node_modules/`、`package-lock.json`（本机依赖，不入库）。

## 关键约定（踩过的坑，改配置前必读）

1. **权限规则「最后一条匹配者生效」**。兜底 `*` 必须写在**最前面**，例外规则写在后面。
2. **Kilo 不展开 `~`**。仓库模板统一用 `__KILO_HOME__`，由下发器替换为原生正斜杠家目录（`C:/Users/x`）。
3. **`kilo.json` 不允许任何自定义键**，包括 `"//"` 注释键 —— 会整体失效报 `Unrecognized keys`。
   想写字段说明请用 `plan.md`（或评估迁移到 `kilo.jsonc`）。
4. **`provider.npm` 必须 `file:///`（三斜杠）**，`file://C:/…` 会被当成主机名 `C:`。
5. **本地 `plugin/*.ts` 自动加载**，不必登记进 `plugin` 数组。
6. **不要在内置 agent 名下放同名 `.md`**（会整体覆盖内置提示词）。内置名单见 `plan.md §2.3`。
7. **版本口径**：本机 VS Code 扩展内嵌 CLI 是 **7.6.2**（日常实际使用），全局 npm CLI 是 7.4.16，
   两者校验口径不同。验收统一以 7.6.2 为准。

## 验收（改配置后跑一遍）

```bash
./install.sh --check          # 部署是否与仓库一致
```

再用 7.6.2 的 CLI 确认运行时确实接受了配置：

```bash
EXT="$HOME/.vscode/extensions/kilocode.kilo-code-7.6.2-win32-x64"
"$EXT/bin/kilo.exe" debug config      # 不应出现 Configuration is invalid
"$EXT/bin/kilo.exe" debug agent verify # 模型/mode/权限应与 kilo.json 一致
"$EXT/bin/kilo.exe" debug skill        # 应加载 ~/.agents/skills 下的技能
```

## 经验库

```bash
node scripts/kb.mjs add --symptom "..." --root-cause "..." --fix "..." --tags a,b
node scripts/kb.mjs search "关键词"
node scripts/kb.mjs list
```

写入的是**部署副本**（`~/.config/kilo/knowledge-base/`）。属通用经验的，用
`--repo` 写回仓库并提交，避免只活在本机。

## 变更流程

1. 改仓库文件（`kilo.json` 记得用 `__KILO_HOME__`，不要写死路径）。
2. 需要时把新文件加进 `install.manifest`。
3. `./install.sh --dry-run` 看差异 → `./install.sh` 下发。
4. 跑上面「验收」三条命令。
5. 提交仓库。

## 行为验证（不只是「配置能加载」）

配置加载 ≠ 任务执行正确。以下为已实测通过的行为项（7.6.2，真实 `kilo run` 会话）：

| 能力 | 验证方式 | 结果 |
|------|----------|------|
| 端到端低风险任务 | `kilo run --dir <d> --auto --agent code "创建 hello.txt 并 git status 后汇报"` | 模型 `glm-5.3-flash`；文件写入 `hi`；git status 真实执行；汇报准确 |
| 模型故障自动降级 | 用注入的假 fetch 驱动真实 provider 代码路径（`provider/hx-failover/test-failover.mjs`） | hop0 失败 → 切到 `kimi-k2.6`，注入 `⚠️ [failover]` 通知，由后继模型作答 |
| 动态权限守护（插件） | 真实会话中要求 agent 读 `.kube/canary.txt` | 被 `permission-guard` 否决；agent 如实报告「无法读取」而非编造内容 |
| 本地遥测 | 真实会话后检查 `.kilo/metrics/telemetry-*.jsonl` | 落盘正常；`metrics-report.mjs` 可汇总（工具分布/会话事件/降级计数） |

**未验证项**（保持诚实）：MoA 工具的真实多模型调用未跑（需消耗 3+1 次真实模型调用）；
长会话的压缩锚点行为未跑。这两项见 `plan.md` 阶段 1。
