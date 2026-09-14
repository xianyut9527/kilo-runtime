# kilo_config — KiloCode 全局配置（SSOT）

唯一真源，下发到 `~/.config/kilo/`。只装**改变运行时行为**的东西，编排判断交给 agent。

## 快速开始

```bash
./install.sh --dry-run   # 预览变更
./install.sh             # 下发（自动备份，幂等）
./install.sh --check     # 漂移检测（可挂预提交钩子）
# Windows 原生：install.ps1（同参数）
```

## 资产清单（全部有明确运行时职责）

| 路径 | 职责 | 为什么留 |
|------|------|----------|
| `kilo.json` | 运行时配置模板 | 核心配置：模型路由 / 权限 / 压缩 / MCP / 实验开关 |
| `INSTRUCTIONS.md` | 每会话注入的质量策略 | 认知中心原则 + 风险分级验证——直接改变模型行为 |
| `agent/verify.md` | 异源验证子代理 | 高风险改动的独立复核视角 |
| `plugin/permission-guard.ts` | 动态权限守护 | 拦截静态规则漏掉的不可逆命令 + 密钥路径；实测有效 |
| `plugin/compaction-anchor.ts` | 压缩锚点 | 长会话压缩后不丢任务连续性 |
| `plugin/moa.ts` | 按需多模型分析 | 高风险判断时 3+1 模型交叉（agent 自主决定调用） |
| `provider/hx-failover/` | 模型故障自动降级 | Kilo 原生只会同模型退避重试；这是可靠性的核心 |
| `install.*` | 下发器 | 清单驱动 / 幂等 / 备份 / 漂移检测 |
| `plan.md` | 架构决策记录 | 精简版：能力边界 + 硬约束（防重复踩坑） |

**已删**（评估过，纯过程性）：knowledge-base（知识已固化进 INSTRUCTIONS.md）、telemetry/metrics 脚本（被动诊断）、AGENTS 模板（未接线）。

## 关键约定（改配置前必读）

1. **权限规则「最后一条匹配者生效」**。兜底 `*` 放最前，例外/`deny` 放后面。
2. **Kilo 不展开 `~`**。模板用 `__KILO_HOME__` / `__KILO_CONFIG__` 占位符，installer 替换为原生正斜杠路径。
3. **`kilo.json` 不允许任何自定义键**（含 `"//"` 注释）→ 整份配置失效。字段说明写文档。
4. **`provider.npm` 必须 `file:///`（三斜杠）**。
5. **本地 `plugin/*.ts` 自动加载**，不必登记进 `plugin` 数组。
6. **不要在内置 agent 名下放同名 `.md`**（整体覆盖内置提示词）。内置（`kilo agent list` 实测）：`ask / code / compaction / debug / explore / general / orchestrator / plan / summary / title`。自定义 agent（`verify` 等）才用 `.md`。
   ⚠️ 别照抄 `kilo.json` schema 注解里的 agent 键名 —— 那里含已过期的 `build` / `scout`，实测不存在；判定内置与否只认 `kilo agent list`。
7. **改配置后必须真跑一次任务**（`kilo run --dir <d> --auto "..."`）——`debug config` 通过 ≠ 能执行任务（踩过：provider 路径错导致所有任务失败，debug 不报错）。

## 验收

```bash
./install.sh --check
EXT="$HOME/.vscode/extensions/kilocode.kilo-code-7.6.2-win32-x64"
"$EXT/bin/kilo.exe" debug config          # 无 Configuration is invalid
"$EXT/bin/kilo.exe" debug agent verify
mkdir -p /tmp/smoke && "$EXT/bin/kilo.exe" run --dir "$(cygpath -m /tmp/smoke)" --auto "回答：就绪"
```

## 变更流程

1. 改仓库（新文件加进 `install.manifest`）
2. `--dry-run` 看差异 → `./install.sh` 下发
3. 跑验收三条
4. 提交
