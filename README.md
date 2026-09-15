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
| `kilo.json.tmpl` | 运行时配置模板 | 核心配置：模型路由 / 权限 / 压缩 / MCP / 实验开关。**必须叫 .tmpl**：模板若叫 kilo.json，在本仓库目录跑 Kilo 任务时会被当项目级配置加载，占位符未渲染 → provider 初始化失败（2026-09-15 实测事故） |
| `INSTRUCTIONS.md` | 每会话注入的质量策略 | 认知中心原则 + 风险分级验证——直接改变模型行为 |
| `agent/verify.md` | 异源验证子代理 | 高风险改动的独立复核视角 |
| `plugin/permission-guard.ts` | 动态权限守护 | 拦截静态规则漏掉的不可逆命令 + 密钥路径；实测有效 |
| `plugin/compaction-anchor.ts` | 压缩锚点 | 长会话压缩后不丢任务连续性 |
| `plugin/moa.ts` | 按需多模型分析 | 高风险判断时 3+1 模型交叉（agent 自主决定调用） |
| `provider/hx-failover/` | 模型故障自动降级 + 流式空闲看门狗 + 流中断自动重试 | Kilo 原生只会同模型退避重试；这是可靠性的核心。流中断专项（2026-09-15）：「200 OK + SSE 中途断开」错误重包装为 isRetryable:true → Kilo 会话级自动重试接管，无需手动重发。⚠️ 降级只覆盖模型级故障，baseURL（natapp 隧道）单点故障全链失效——多端点容灾待规划 |
| `install.*` | 下发器 | 清单驱动 / 幂等 / 备份 / 漂移检测（含 provider dist 新鲜度检查） |
| `db-maintain.sh` | kilo.db 在线瘦身 | 清事件溯源/过期会话（实测 14.2GB→1.1GB），不碰记忆与凭证；分批短事务 + VACUUM 写者门禁 + WAL checkpoint |

## 性能基线（2026-09-15 专项）

体感慢的主因排序：natapp 免费隧道 RTT（70-220ms/请求，根治需换链路）＞ kilo.db/日志膨胀 ＞ 每轮 prefill（MCP schema 常驻）＞ 编辑期固定开销。

已固化的口径：
- **MCP 默认全关**（playwright/context7/gitnexus）：用时 `/mcps` 现开；未索引项目 gitnexus 无用，别为"改代码查 impact"常开。INSTRUCTIONS.md 已配套改为条件表述。
- **安全网不省**：snapshot / formatter 保持 true（曾关，撤回只剩"撤对话不撤文件"、代码风格漂移——质量换速度不值）。
- **超时**：provider timeout 120s、chunkTimeout 60s（原 300s/120s 死等太久；30s 误伤超长思考）。
- **DB 膨胀**：event 表是流式 delta 逐行事件溯源，每两周跑一次 `./db-maintain.sh`（2026-09-14→15 一天即回涨 3GB）。
- **「Failed to execute statement / UnknownError」根因**：Kilo 的 sqlite 连接固定 `PRAGMA busy_timeout = 5000`（二进制内实测），写语句 5s 拿不到锁即失败；Drizzle 把底层 `SqliteError` 包装成这句固定文案，真实 cause 被吞、UI 只显示 UnknownError。触发场景主要是**维护期间并发写**（旧版 db-maintain 在 Kilo 活着时跑单条大 DELETE + VACUUM）。当前脚本对策：删除分批（`--batch` / `--batch-msg`）+ 有写者时拒绝 VACUUM（`--force` 可越权）或 `--no-vacuum`。
  代价口径：`kilo db` 每次调用约 2s 冷启动开销，故批次行数要按「锁时长 × 调用次数」权衡（3GB 事件量按默认 5 万行/批约 15 批、30s 左右）。
- **log 膨胀根因**：CLI 默认 INFO 级把每条 bash 权限评估写进 opencode.log（单日 291MB）。治本：启动 Kilo 的环境里设 `KILO_LOG_LEVEL=WARN`（7.6.2 实测识别；WARN 保住告警信号、滤掉 INFO 噪声）。⚠️ 两个坑：
  - 只认环境变量，`kilo.json` 的 `logLevel` 键实测**无效**（1/3~2/3 概率仍写 INFO），别改成配置方案；
  - 环境变量对**已在运行的 VS Code 进程不生效**（进程继承的是启动时的旧 env），设置后必须重启 VS Code 才看到日志降级——主机已设用户级 `KILO_LOG_LEVEL=WARN`，旧 VS Code 进程的活日志仍是 INFO 属预期。
- **思考档位**：agent 级 variant 保持默认（不设），需要深推理时在模型选择器手动切——high/max 每轮工具调用先深度思考，多轮累积延迟明显。

**已删**（评估过，非运行时资产）：
- knowledge-base（知识已固化进 INSTRUCTIONS.md）、telemetry/metrics 脚本（被动诊断）、AGENTS 模板（未接线）。
- `plan.md` 架构决策记录（2026-09-15）：硬约束已固化进本 README + INSTRUCTIONS.md，模型路由表反而先过期失真；不再保留会漂移的副本。

## 关键约定（改配置前必读）

1. **模板文件名必须是 `kilo.json.tmpl`**。Kilo 会自动加载工作目录的 `kilo.json` 作为项目级配置——模板含占位符，一旦被加载，provider 路径渲染成 `file:///__KILO_CONFIG__/...`（不存在）→ `Failed to initialize provider: hx`。installer 渲染后部署为 `kilo.json`。
2. **权限规则「最后一条匹配者生效」**。兜底 `*` 放最前，例外/`deny` 放后面。
3. **Kilo 不展开 `~`**。模板用 `__KILO_HOME__` / `__KILO_CONFIG__` 占位符，installer 替换为原生正斜杠路径。
4. **`kilo.json` 不允许任何自定义键**（含 `"//"` 注释）→ 整份配置失效。字段说明写文档。
5. **`provider.npm` 必须 `file:///`（三斜杠）**。
6. **本地 `plugin/*.ts` 自动加载**，不必登记进 `plugin` 数组。
7. **自研 provider 必须声明 LanguageModel spec `v3`**（依赖 `@ai-sdk/openai-compatible` ^2）。声明 `v2` 会走 Kilo 兼容桥，整轮丢失 finishReason + usage → 落库 `step-finish.reason="unknown"`、tokens 全 0、UI 报「回合已结束，模型未提供结束原因」（2026-09-15 实测，见 `provider/hx-failover/src/index.js` 头部说明）。
8. **不要在内置 agent 名下放同名 `.md`**（整体覆盖内置提示词）。内置（`kilo agent list` 实测）：`ask / code / compaction / debug / explore / general / orchestrator / plan / summary / title`。自定义 agent（`verify` 等）才用 `.md`。
   ⚠️ 别照抄 `kilo.json` schema 注解里的 agent 键名 —— 那里含已过期的 `build` / `scout`，实测不存在；判定内置与否只认 `kilo agent list`。
9. **改配置后必须真跑一次任务**（`kilo run --dir <d> --auto "..."`）——`debug config` 通过 ≠ 能执行任务（踩过：provider 路径错导致所有任务失败，debug 不报错）。

## 验收

```bash
./install.sh --check
# 扩展目录随版本变化，用通配符取最新，勿写死版本号
EXT="$(ls -d "$HOME"/.vscode/extensions/kilocode.kilo-code-*/ 2>/dev/null | sort -V | tail -1)"
"${EXT}bin/kilo.exe" debug config          # 无 Configuration is invalid
"${EXT}bin/kilo.exe" debug agent verify
mkdir -p /tmp/smoke && "${EXT}bin/kilo.exe" run --dir "$(cygpath -m /tmp/smoke)" --auto "回答：就绪"
```

PowerShell 原生等价：

```powershell
.\install.ps1 -Check
$EXT = (Get-ChildItem "$HOME\.vscode\extensions" -Directory -Filter 'kilocode.kilo-code-*' |
    Sort-Object Name -Descending | Select-Object -First 1).FullName
& "$EXT\bin\kilo.exe" debug config         # 无 Configuration is invalid
& "$EXT\bin\kilo.exe" debug agent verify
New-Item -ItemType Directory -Force "$env:TEMP\kilo-smoke" | Out-Null
& "$EXT\bin\kilo.exe" run --dir "$env:TEMP\kilo-smoke" --auto "回答：就绪"
```

## 变更流程

1. 改仓库（新文件加进 `install.manifest`）
2. `--dry-run` 看差异 → `./install.sh` 下发
3. 跑验收三条
4. 提交
