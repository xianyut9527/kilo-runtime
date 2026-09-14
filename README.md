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
