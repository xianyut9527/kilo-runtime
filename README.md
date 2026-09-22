# kilo_config — KiloCode 全局配置（SSOT）

唯一真源，下发到 `~/.config/kilo/`。只装**改变运行时行为**的东西，编排判断交给 agent（这套原则的由来见下文「架构演变」）。

## 快速开始

Windows（PowerShell 7+，本仓库主环境）：

```powershell
.\install.ps1 -DryRun   # 预览变更（含模板渲染 + JSON 合法性 + 占位符残留校验，不写盘）
.\install.ps1           # 下发（自动备份，幂等）
.\install.ps1 -Check    # 漂移检测（可挂预提交钩子）
```

macOS / Linux（bash）：

```bash
./install.sh --dry-run   # 预览变更
./install.sh             # 下发（自动备份，幂等）
./install.sh --check     # 漂移检测
```

平台口径：

- **目录一致**：配置下发到 `~/.config/kilo`（Windows 即 `C:\Users\<你>\.config\kilo`），数据在 `~/.local/share/kilo`；两个安装器行为一致。
- **维护脚本**：`cleanup.sh` / `db-maintain.sh` 是 bash 脚本——Windows 经 Git Bash 运行，日常走 PowerShell 包装 `scripts\kilo-maintenance.ps1`（见「磁盘垃圾与维护」）；依赖 GNU coreutils（`stat -c` / `find -printf` / `du`），macOS/BSD 语法不同未适配，勿直接跑。

## 架构演变（工作流编排 → 认知中心 + 插件化门禁）

本仓库前身是一套完整的多智能体工作流编排系统，2026-09-14 起收敛为「配置 SSOT + 运行时增强」。
开头那句「编排判断交给 agent」正是这次换层的结论。三段演变如下（细节见 git 历史）：

### V1 · 多智能体工作流编排（2026-05 ~ 2026-09-13，已废弃）

- **ensemble 多模型并行**（2026-05）：AGENTS.md 角色表 + `agent/ensemble.md` 编排流程——单模型修复 ≥3 轮自动升级 @ensemble，executor-{dp,mm,kimi,cx} 多模型 worktree 并行编码 + synthesizer 融合 + 三角验证（对抗性检查专岗）。
- **生命周期状态机**（2026-07 ~ 08）：conductor 单编排者 + lifecycle v6 八阶段（intent→sizing→design→implementation→verification→review→repair→delivering）、委派协议 / 证据契约 / mount 定级挂载，配套 doctor S/H 系列语义校验、transition-check 等机械校验脚本群（lifecycle-doctor 单文件 2100+ 行）；期间还短暂上线过 Holographic / Hermes 记忆系统，上线数日即废弃。
- **MMO 多模型审计**（2026-09）：deep-analyzer 6 智能体编排并入 conductor，13 智能体拓扑 + 编排层断路器降级策略；knowledge-base（FX 条目）+ lessons 三件套做经验沉淀（fact_store 体系 8 月已先行废弃）。

**为什么废弃**（每条都是实证教训，不是口味问题）：
1. **prompt 纪律没有强制力**——编排文档写得再细，模型可以遗忘 / 绕过：「声称测试跑过」「声称审查通过」在运行时无从核实，质量门禁只是文档约定。
2. **机械校验器自己先失真**——doctor / transition-check 本用来防文档漂移，但校验器自身 2100+ 行、内部死引用 22 处，模型路由表比配置先过期，维护校验器成了新的主业。
3. **编排烧上下文与延迟**——每层委派都要裁剪 / 传递上下文包，MMO 一次审计多路模型串并行，简单任务也被套上状态机开销。
4. **建错了层**——断路器、熔断、证据契约全写在 prompt / 编排层，而 Kilo 真正的扩展点（plugin 钩子 / provider / 权限 / instructions 注入）一个都没用上。

### V2 · SSOT 收敛（2026-09-14）

单日三连提交完成换层：删 13 个编排 / 审查 agent 文档与校验脚本群 → 收敛为 SSOT 仓库 + install 双平台全量下发器（插件、`agent/verify.md`、INSTRUCTIONS.md、provider/hx-failover 收回仓库）→ 再删 knowledge-base / telemetry / AGENTS 模板等过程性组件（经验固化进 INSTRUCTIONS.md——每会话注入优于偶发检索）。原则收敛为一句话：**只装改变运行时行为的东西，编排判断交给 agent**；验收口径也随之从「文档齐全、校验全绿」变成「真实任务端到端跑通」。

### V3 · 认知中心 + 插件化运行时增强（2026-09-14 至今，现行）

旧体系的目标全部保留，实现整体下沉一层：

| 目标 | 旧实现（prompt / 编排层） | 现实现（运行时层） |
|------|---------------------------|---------------------|
| 质量门禁 | 三层门禁体系、双 checker、证据契约（文档约定） | `plugin/quality-gate.ts` 三层硬门禁——层 1 步骤符合性 / 层 2 验证实证（只认末次编辑后 exit 0，fail-closed 否决「全部完成」）/ 层 3 双向审查闭环（不过即阻断交付）；模型绕不过 |
| 多模型审查 | ensemble 交叉审查、三角验证、MMO 审计 | `plugin/dual-review.ts` 异源双向（正向查遗漏 × 反向红队）+ 第三方裁决，交付节点自动触发 |
| 可靠性 | 编排层断路器 / 熔断阈值（prompt 约定） | `lib/hx-client.ts` + `provider/hx-failover`——三级超时、断路器、failover 降级链、reasoningEcho 协议兜底 |
| 经验沉淀 | knowledge-base FX / fact_store / lessons 三件套 | Kilo 原生记忆（memory-bootstrap 自举）+ `/evolve` 复盘 + GLOBAL-NOTES.md 跨项目经验层 |
| 模型路由 | agent frontmatter + plan.md 路由表（先过期失真） | `kilo.json.tmpl` 唯一真源，plugin / provider 代码零内置默认（2026-09-20 起） |

配套纪律（固化进 INSTRUCTIONS.md）：主 agent 持完整上下文自主决策，子代理是按需调用的工具；扇出 ≤3（2026-09-17 实测 6 子代理扇出 60s 内全 abort）；审查走 `dual_review`，不自组子代理面板；验证按风险触发；**不新建编排引擎、DAG 或阶段门禁**。

## 资产清单（全部有明确运行时职责）

| 路径 | 职责 | 为什么留 |
|------|------|----------|
| `kilo.json.tmpl` | 运行时配置模板 | 核心配置：模型路由 / 权限 / 压缩 / MCP / 实验开关。**必须叫 .tmpl**：模板若叫 kilo.json，在本仓库目录跑 Kilo 任务时会被当项目级配置加载，占位符未渲染 → provider 初始化失败（2026-09-15 实测事故） |
| `INSTRUCTIONS.md` | 每会话注入的质量策略 | 认知中心原则 + 风险分级验证——直接改变模型行为 |
| `agent/verify.md` | 异源验证子代理 | 高风险改动的独立复核视角 |
| `plugin/permission-guard.ts` | 动态权限守护 | 拦截静态规则漏掉的不可逆命令 + 密钥路径；实测有效 |
| `plugin/compaction-anchor.ts` | 压缩锚点 | 长会话压缩后不丢任务连续性 |
| `plugin/quality-gate.ts` | 三层交付检查（层 1+2+层 3 调度与闭环） | 层 1：todo completed 时核对执行痕迹（防空口声明）；层 2（fail-closed，2026-09-22 结果实证）：编辑过代码但未跑验证命令否决「全部完成」，且**只认末次代码编辑后 exit 0 的验证命令**——跑了但失败（exit 非 0）同样拦下要求修复重跑；退出码三段契约采集（output 字段→metadata→文本解析，落空/`|| true` 等遮蔽形态降级旧口径放行不误杀，逃生门 verify-skipped）；编辑后静态检查**异步防抖**（5s 单飞后台跑 + tsc `--incremental`，tsbuildinfo 存 Kilo 数据目录按项目哈希隔离，编辑路径零阻塞），诊断积压由交付节点强制冲刷回注；交付节点（todo 全 completed + 高风险文件，或含代码改动且跨≥5 文件——纯文档不烧审查费；2026-09-22 由 ≥3 上调，每次自动审查墙钟 2~4min，触发过频不划算）直调 dual-review 自动执行层 3，审查素材范围限定本会话：编辑文件清单 + `git diff HEAD -- <本会话编辑的代码文件>`（含已暂存，pathspec ≤100 防 Windows 命令行超长）+ diff 未覆盖的未跟踪新文件全文（≤8 个×4000 字）+ 无 git 降级为脱敏会话证据池，素材截断 24k——多会话共享工作区不再把别会话的累积改动/tmp 脚本审进来（2026-09-17 事故）——素材 sha1 与上次一致时**复用既有裁决**（hash 命中不重烧 2~4min），裁决未通过**阻断交付**，修复后自动再审直到通过（上限 2 轮，超限放行并回注残余项升级人工；逃生门 review-accepted） |
| `plugin/dual-review.ts` | 层 3 双向异源审查 | 正向（查遗漏）×反向（红队找错）异源模型并行 + 第三方裁决；被 quality-gate 在交付节点自动调用（无 ctx 时进度降级 stderr，阶段切换即时可见，30s 心跳兜首字死区），也可经 `dual_review` 工具手动发起（permission=allow）。单路失败不做单路裁决（返回幸存方原文）；聚合输入截断（subject 8k / 单路结论 10k）；输出限长（正/反 ≤800 字、裁决 ≤600 字，2026-09-22 墙钟 5~8min→2~4min）；模型读 kilo.json 零内置默认 |
| `scripts/test-quality-gate.mjs` | 门禁离线回归（不联网、不起 Kilo） | `node scripts/test-quality-gate.mjs`：esbuild 打包后测 parseReviewVerdict/VERIFY_CMD_RE/HIGH_RISK_RE/reviewSubject/exitCodeOf/exitMasked/hasVerified·verifyFailureOf/hasSkipMarker·hasAcceptMarker/makeTitle/bridgeProgress 共 78 例——门禁正则、裁决解析、结果实证判定与进度通道选择的任何回归（含 CJK 腐化）立即变红 |
| `scripts/test-circuit-breaker.mjs` | 断路器离线回归（不联网、不起 Kilo） | `node --experimental-strip-types scripts/test-circuit-breaker.mjs`：动态 import lib/hx-client.ts（`?r=` 击穿 ESM 缓存取全新断路器状态），网络层打桩，18 场景——trip/fail fast/probe 锁/跨代迟到回调隔离/冷却起点/401 与网络错不触发 |
| `lib/hx-client.ts` | hx 上游共享客户端（非插件） | moa 与 dual-review 的公共层：kilo.json options + auth.json hx.key 读取（60s 缓存）+ SSE 流式请求——三层超时（首字节 / chunk 空闲 / 总时长）、网络类失败重试 2 次指数退避、HTTP 400/401/403/404/422 确定性失败不重试、`onDelta` 进度回调；最终失败写 failover-events.jsonl 遥测（`kind:"hx-client"`，只记模型/状态/错误摘要/耗时，不含内容——moa「N 轮失败」从此可回溯）（改凭证与 baseURL 规则只改这里） |
| `plugin/moa.ts` | 按需多模型分析 | 高风险判断时 N 参考 + 1 聚合交叉（默认取 kilo.json `provider.hx.options.moa`，单次上限 3 参考 + 1 聚合；SSE 流式 + 工具卡进度标题 + 每路结论截断 12k；agent 自主决定调用） |
| `plugin/memory-bootstrap.ts` | 记忆自举 | git 项目首个 session.created 自动启用原生记忆（scaffold 与官方 /memory/enable 产物逐字节一致；create-if-missing，绝不改已有状态） |
| `scripts/memory-enable.mjs` | 记忆批量启用/体检 | 部署到 `~/.config/kilo/scripts/`：无参=全量状态体检，`<dir>`=显式启用（含非 git 目录），`--db`=从 kilo.db 项目表批量启用；`/memory-setup` 命令的执行体 |
| `command/memory-setup.md` | 全局命令 | 非 git 目录显式启用记忆 + 排查修复自举失效 |
| `command/evolve.md` | 全局命令 | 复盘进化：蒸馏近期会话入库 + 修正过期记忆 + 反哺 SSOT（改动需确认） |
| `provider/hx-failover/` | 模型故障自动降级 + 全链路 SSE 流式 + 三级超时 + thinking 协议兜底 | Kilo 原生只会同模型退避重试；这是可靠性的核心。**SSE 流式**（2026-09-19）：上游流式直通 + 进度可视，超时拆三级（首字节 / chunk 空闲 `chunkTimeout` / 总时长）。**流中断专项**（2026-09-15）：「200 OK + SSE 中途断开」错误重包装为 isRetryable:true → Kilo 会话级自动重试接管，无需手动重发。**reasoning_content 400 专项**（2026-09-21）：DeepSeek V4/K2.6/GLM-5.x/MiniMax thinking 模式要求历史 assistant 消息回传 reasoning_content，Kilo 重放丢失 → 工具循环续跑 400 直达用户（400 不重试不降级、降级日志无痕）；`reasoningEcho: true` 出站补空串兜底 + fatal 错误入 failover-events.jsonl 遥测（5MB 轮转）。**模型唯一真源**：降级链 / moa / dual_review 全部读 kilo.json `provider.hx.options`，代码零内置默认（未配链 = 仅当前模型直通 + stderr 告警）。⚠️ 降级只覆盖模型级故障，baseURL（natapp 隧道）单点故障全链失效——多端点容灾待规划。⚠️ provider 随 kilo server 进程启动加载（file:// 包整包入内存）：更新 dist 并 install 后，**必须重载 VS Code 窗口才生效**（2026-09-16 实测：9:22 部署的断流修复因 9:20 启动的旧进程未重载，当日仍裸穿报错） |
| `provider/hx-failover/test-failover.mjs` | provider 离线回归（21 例，不打真实网络） | `node provider/hx-failover/test-failover.mjs`：假 fetch 驱动真实 doStream——降级切换/通知注入/冷却不污染/看门狗触发/流中断 isRetryable/reasoningEcho 补写/fatal 透传+遥测落盘/扩展键剥除全覆盖；改 `src/index.js` 后先 `npm run build` 再必跑（测的是 dist 行为） |
| `install.*` | 下发器 | 清单驱动 / 幂等 / 备份 / 漂移检测（含 provider dist 新鲜度检查）；备份只保留最近 2 个（`KILO_KEEP_BACKUPS` 可调，需 ≥1 整数；非法值告警后按默认 2，绝不中断下发）。`install.sh` 用 `--dry-run/--check`，`install.ps1` 用 `-DryRun/-Check`，**参数风格不同** |
| `.vscode/settings.json` | 仓库级编辑器体验 | 把 `kilo.json.tmpl` 关联为 `jsonc`——模板获得语法高亮 / 括号匹配 / 语法错误红线（VS Code 打开本仓库即生效）；非运行时资产，不进 `install.manifest` |
| `db-maintain.sh` | kilo.db 在线瘦身 | 清事件溯源/过期会话（实测 14.2GB→1.1GB），不碰记忆与凭证；分批短事务 + VACUUM 写者门禁 + WAL checkpoint |
| `cleanup.sh` | 运行痕迹清理 | Kilo 托管临时目录内过期条目 + `%TEMP%` 下 `kilo*` 兄弟项 + `~/.config/kilo.backup-*` 保留上限；**默认 dry-run** |
| `scripts/kilo-maintenance.ps1` | 维护调度入口 | 组合上面两个脚本 + 到期判断 + 登录自启/计划任务；VACUUM 保持人工 |

## 记忆与进化架构（2026-09-15 专项）

原生记忆（7.6.2）规格完备但默认 `enabled:false`、工具按前缀 `kilo_memory_` 过滤隐藏——不启用等于零能力。现已全线打通：

- **存储布局**：`<data>/memory/<basename>-<sha1(realpath(canonical))[:12]>/`（state.json / index.kmem / project.md / environment.md / corrections.md / sessions/ / manifest.json）；worktree 经 `.git` gitdir 归并主仓，共享同一份记忆。
- **启用通道三层**：① `plugin/memory-bootstrap.ts` 自动（git 项目，session.created 触发）；② `/memory-setup` 命令（非 git 目录/排查，调部署副本 `scripts/memory-enable.mjs`）；③ 官方兜底（TUI `/memory` 或 `kilo serve` + `POST /memory/enable?directory=...`）。scaffold 产物已与官方 enable 逐字节比对。
- **生效语义**：工具表随会话启动定型——启用后**新会话**才有 `kilo_memory_*` 工具与注入（会话结束自动沉淀 turnClose、开场自动注入索引，上限 8KB）。
- **进化回路**：会话内主动沉淀（INSTRUCTIONS.md 策略）+ `/evolve` 周期复盘（蒸馏 → correct/forget 修正 → 通用教训反哺本仓库，改动需确认）。
- **全局经验层 `GLOBAL-NOTES.md`**（`~/.config/kilo/`，kilo.json instructions 第二入口）：跨项目教训**全自动追加**（一行一条带日期，追加前检索去重，总量 ~1KB 封顶），/evolve 定期修剪 + 成熟条目升格进 INSTRUCTIONS（需确认）。属运行时状态**不进下发清单**——install 不清理清单外文件，不会被覆盖；新机器由 memory-bootstrap 插件按模板自愈创建（已实测 instructions 引用缺失文件不报错）。追加通道用 node 单行脚本（bash `node *` allow），不用 edit 工具（会触发 external_directory 询问）。
- **验证**：`node scripts/memory-enable.mjs`（全量状态表）；新会话调 `kilo_memory_recall mode=catalog` 应列出已入库条目。
- **全局命令目录**（二进制实证）：`~/.config/kilo/command/*.md`；`.kilo/command/` 是项目级，部署在 `~/.config/kilo/.kilo/` 下的旧资产不会被加载。
- **插件生效时机**：插件随 kilo server 进程启动加载——扩展长驻 server 需**重载 VS Code 窗口**一次才会加载 memory-bootstrap；CLI（kilo run/serve）每次进程新起，天然生效。

## 性能基线（2026-09-15 专项）

体感慢的主因排序：natapp 免费隧道 RTT（70-220ms/请求，根治需换链路）＞ kilo.db/日志膨胀 ＞ 每轮 prefill（MCP schema 常驻）＞ 编辑期固定开销。

已固化的口径：
- **MCP 默认全关**（playwright/context7/gitnexus）：用时 `/mcps` 现开；未索引项目 gitnexus 无用，别为"改代码查 impact"常开。INSTRUCTIONS.md 已配套改为条件表述。
- **remote_control 默认关闭**（2026-09-20）：常驻云端中继连接是会话事件转发通道，属「快→慢」同期嫌疑项；不用手机端盯任务就关，需要时 `/remote` 临时开。
- **安全网不省**：snapshot / formatter 保持 true（曾关，撤回只剩"撤对话不撤文件"、代码风格漂移——质量换速度不值）。
- **超时**：`options.timeout` 300s 仅作 MoA/dual_review 分析调用总上限（主模型循环**不消费**该键——DB 实证 27 例 >120s step-finish 正常完成，2026-09-21）；主链路靠 chunkTimeout 60s 空闲看门狗（30s 误伤超长思考）。
- **DB 膨胀**：event 表是流式 delta 逐行事件溯源，每两周跑一次 `./db-maintain.sh`（2026-09-14→15 一天即回涨 3GB）。
- **「Failed to execute statement / UnknownError」根因**：Kilo 的 sqlite 连接固定 `PRAGMA busy_timeout = 5000`（二进制内实测），写语句 5s 拿不到锁即失败；Drizzle 把底层 `SqliteError` 包装成这句固定文案，真实 cause 被吞、UI 只显示 UnknownError。触发场景主要是**维护期间并发写**（旧版 db-maintain 在 Kilo 活着时跑单条大 DELETE + VACUUM）。当前脚本对策：删除分批（`--batch` / `--batch-msg`）+ 有写者时拒绝 VACUUM（`--force` 可越权）或 `--no-vacuum`。
  代价口径：`kilo db` 每次调用约 2s 冷启动开销，故批次行数要按「锁时长 × 调用次数」权衡（3GB 事件量按默认 5 万行/批约 15 批、30s 左右）。
- **log 膨胀根因**：CLI 默认 INFO 级把每条 bash 权限评估写进 opencode.log（单日 291MB）。治本：启动 Kilo 的环境里设 `KILO_LOG_LEVEL=WARN`（7.6.2 实测识别；WARN 保住告警信号、滤掉 INFO 噪声）。⚠️ 两个坑：
  - 只认环境变量，`kilo.json` 的 `logLevel` 键实测**无效**（1/3~2/3 概率仍写 INFO），别改成配置方案；
  - 环境变量对**已在运行的 VS Code 进程不生效**（进程继承的是启动时的旧 env），设置后必须重启 VS Code 才看到日志降级——主机已设用户级 `KILO_LOG_LEVEL=WARN`，旧 VS Code 进程的活日志仍是 INFO 属预期。
- **「未完成前已达到响应限制」根因**（2026-09-15 DB 实证 80 例）：上游网关返回 `finish_reason=length` → Kilo 记 `finishReason="length"` → UI 显示该提示。两类：真撞输出上限（output 恰好 32000，网关真实上限**是 32000 而非 catalog 声明的 32768**，已全部对齐为 32000）；早截断（output <5k，网关侧零星问题——各模型常规处理 180-200k+ 总量时正常 stop，证明 context 200k 没有高估，**勿因早截断下调 context**，否则无谓增加压缩频率）。早截断无法配置侧根治，发生后需手动继续轮次。
- **思考档位**：agent 级 variant 保持默认（不设），需要深推理时在模型选择器手动切——high/max 每轮工具调用先深度思考，多轮累积延迟明显。

## 磁盘垃圾与维护（2026-09-15 专项）

**内置清理只管两处**（7.6.2 二进制内实测）：
- `tool-output-cleanup`：只删 `~/.local/share/kilo/tool-output/tool_*`，保留 7 天、每小时一次（`KILO_DISABLE_PRUNE` 可关）；
- `remote-attachments`：会话关闭时删该会话的抓取暂存目录。

**除此之外没有任何回收**：Kilo 把子进程的 `TMP/TMPDIR` 指向 `$TEMP/kilo`（`kilo debug paths` 的 `tmp`），agent 在里面写的脚本/测试库、`install` 每次下发产生的配置备份、`kilo.db` 事件流水，都无人清理。实测 `%TEMP%` 下 `kilo*` 累计 **2.5GB**（含一份 1.33GB 的 `kilo.db` 沙箱副本）。`storage`(200MB)/`snapshot`/`cache` 也未见保留策略。

手动入口（都不需要管理员；bash 块在 Git Bash 运行，Windows 日常建议直接用下面 PowerShell 包装）:

```bash
./cleanup.sh              # 预览：临时目录 + 配置备份的可删清单与体积
./cleanup.sh --run        # 实删（临时兄弟项留 3 天、$TEMP/kilo 内部留 7 天、配置备份留最近 2 个）
./cleanup.sh --status     # 只打印各处占用
./db-maintain.sh --status # DB 体检（只读）
```

自动入口（二选一）：

```powershell
# A. 免管理员：登录自启 + 到期判断（清理 >1 天、DB 瘦身 >7 天）
.\scripts\kilo-maintenance.ps1 -InstallStartup
#   ⚠️ 快捷方式用绝对路径指向本仓库，脚本靠固定路径生效 —— 仓库被移动/删除后自启失效，需重新 -InstallStartup

# B. 需管理员：系统计划任务（每日 04:00 清理；每周日 04:30 清理 + DB 瘦身）
.\scripts\kilo-maintenance.ps1 -Register

.\scripts\kilo-maintenance.ps1 -Status      # 看到期时间/任务状态/最近日志
.\scripts\kilo-maintenance.ps1 -RunOnce     # 立即执行一次
.\scripts\kilo-maintenance.ps1 -AutoIfDue   # 按到期规则执行（自启调用的就是它）
```

**event 表是无条件清空的**：`db-maintain.sh` 对 `event`（纯事件溯源流水，`--days` 对它无效）一律 `DELETE` 全表并顺带清空 `event_sequence`；`--days` 只作用于 `message`/`session`/`todo`。这符合设计——已结束会话的内容不依赖 event 重放。

安全边界：`cleanup.sh` 绝不删 `$TEMP/kilo` 本身（Kilo 运行时还在往里写），也绝不碰 `~/.local/share/kilo`（会话/记忆/凭证）与 `~/.config/kilo`（配置本体）；判定只看 mtime 且逐条打印。
**VACUUM 故意不自动化**：它需要独占锁并整体重写文件，Kilo 活着时执行必然打断并发会话（见下条根因）。自动化只跑 `db-maintain.sh --no-vacuum`（分批短锁）；需要回收文件空间时关掉全部 Kilo 后人工跑 `./db-maintain.sh`。
维护日志落在 `~/.local/state/kilo/maintenance/*.log`，自身保留最近 14 份；到期状态记在 `state.json`（`cleanup.sh` 无状态，到期判断由包装脚本负责）。
**失败可观测**：登录自启是隐藏进程，任何未捕获异常都会写入 `maintenance/error.log`（`-Status` 会带出最近 3 条）——自启「看起来没跑」时先看这里，常见原因：仓库被移动（快捷方式指向绝对路径）或 Git Bash 缺失。

**本次清理实测**：删除 195 项、释放约 **2.7GB**（其中 `%TEMP%\kilo\fktest\kilo.db` 单文件 1.33GB，是一次 DB 演练留下的副本沙箱），`kilo.db` 事件表 2.3 万行 → 71 行。

**两个已知坑（都已修，改了别再踩）**：
1. **备份裁剪必须「先裁剪、后创建」**。若先创建再裁剪，新备份会参与排序，而同秒产生的备份 `LastWriteTime` 并列，靠排序排除会把自己删掉（实测 `install.ps1` 把刚建的 zip 删了）。`install.sh` / `install.ps1` 现均为先裁剪后创建，且裁剪只在真实写盘模式（`--dry-run` / `-Check` 不删任何文件）。
2. **PowerShell 5.1 的两个静默陷阱**：`Compress-Archive` 在目标目录为空时**既不报错也不产出文件**（必须回查产物再打印路径，否则会报一个并不存在的「成功」备份）；`Compare-Object -DifferenceObject $null` 直接抛异常（空目录漂移检测需显式 `@()` 包住管道结果）。另外 `$MyInvocation.MyCommand.Path` 在函数体内是空串，脚本自身路径要用 `$PSCommandPath`（曾导致自启快捷方式生成 `-File ""` 却打印「已安装」）。

**已删**（评估过，非运行时资产）：
- knowledge-base（知识已固化进 INSTRUCTIONS.md）、telemetry/metrics 脚本（被动诊断）、AGENTS 模板（未接线）。
- `plan.md` 架构决策记录（2026-09-15）：硬约束已固化进本 README + INSTRUCTIONS.md，模型路由表反而先过期失真；不再保留会漂移的副本。

## 模板编辑体验（kilo.json.tmpl）

模板是带「行首 `//`」注释的 JSONC，`.tmpl` 后缀默认无高亮——本仓库内置 `.vscode/settings.json` 已把它关联为 `jsonc`，VS Code 打开仓库即获得语法高亮、括号匹配与语法错误红线。

维护回路（改模板的固定三步）：

1. 改模板。注释纪律：**只写「行首 `//`」整行**——jsonc 语法允许 `/* */` 与行尾 `//`，但 install 只剥行首 `//`（行内 `//` 不动，防误伤 URL），其余形式会让部署产物变成非法 JSON；
2. `.\install.ps1 -DryRun`（bash：`./install.sh --dry-run`）——渲染 + JSON 合法性 + 占位符残留三项校验一步完成，不写盘，即改即验；
3. 绿了再真实下发，并跑「验收」命令。

## 隐私与安全边界

- **本仓库按私有资产管理**：`kilo.json.tmpl` 含真实上游网关域名（内网穿透入口，且已存在于 git 提交历史）。外发/开源前必须 ① 替换域名、② 重写历史（如 `git filter-repo`）——只改当前文件不等于删历史。文档一律不出现完整域名。
- **凭证零入库**（2026-09-22 全仓扫描确认）：API key 只存 `~/.local/share/kilo/auth.json` 运行时读取；代码/配置无硬编码凭证；git 历史无凭证文件；`.gitignore` 已兜底运行时产物。
- **出网链路明示**（敏感代码仓库先评估再触发）：
  - 模型主链路 + failover：对话内容发往上游网关；
  - `dual_review` / `moa`：审查素材（diff 片段、任务描述）额外发往上游参考/裁决模型（单次共 3 次调用）；
  - `web_search` / `webfetch` 已放行；Kilo 自身遥测已关（`privacy_mode: true`）。
- **failover 遥测口径**：`~/.local/share/kilo/failover-events.jsonl` 只记模型名/动作/HTTP 状态/错误摘要（≤200 字），**不含对话与 prompt 内容**；5MB 轮转只保一代。
- **破坏性操作默认安全**：`cleanup.sh` 默认 dry-run 逐条打印；`db-maintain.sh` 分批短事务、VACUUM 仅人工；install 写盘前自动备份（保留 2 份）；agent 权限三道防线（permission-guard 动态拦截 → 静态规则 → deny 兜底）。

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
10. **模型唯一真源 = `kilo.json.tmpl`**（2026-09-20 起）：agent 路由、failover 降级链、moa、dual_review 的模型全部只在该模板配置（`agent` 段 + `provider.hx.options.{failover,moa,dual_review}`）；plugin 与 provider 代码零内置默认——换模型只改模板再下发，别改代码。

## 验收

```bash
./install.sh --check
# 扩展目录随版本变化，用通配符取最新，勿写死版本号
EXT="$(ls -d "$HOME"/.vscode/extensions/kilocode.kilo-code-*/ 2>/dev/null | sort -V | tail -1)"
"${EXT}bin/kilo.exe" debug config          # 无 Configuration is invalid
"${EXT}bin/kilo.exe" debug agent verify
mkdir -p /tmp/smoke && "${EXT}bin/kilo.exe" run --dir "$(cygpath -m /tmp/smoke)" --auto "回答：就绪"
```

PowerShell 原生等价（**Windows 主环境用这个**）：

```powershell
.\install.ps1 -Check
$EXT = (Get-ChildItem "$HOME\.vscode\extensions" -Directory -Filter 'kilocode.kilo-code-*' |
    Sort-Object Name -Descending | Select-Object -First 1).FullName
& "$EXT\bin\kilo.exe" debug config         # 无 Configuration is invalid
& "$EXT\bin\kilo.exe" debug agent verify
New-Item -ItemType Directory -Force "$env:TEMP\kilo-smoke" | Out-Null
& "$EXT\bin\kilo.exe" run --dir "$env:TEMP\kilo-smoke" --auto "回答：就绪"

# 维护链路（只读：到期时间/任务状态 + DB 体检，不写盘、不锁库）
.\scripts\kilo-maintenance.ps1 -Status
.\scripts\kilo-maintenance.ps1 -DbStatus

# 记忆链路（全量状态体检；本仓库应 enabled=true 且 records>0）
node scripts\memory-enable.mjs

# quality-gate 纯函数回归（离线，不联网；改 quality-gate.ts/正则后必跑）
node scripts\test-quality-gate.mjs

# provider 离线回归（改 provider/hx-failover/src 后先 npm run build 再跑；测的是 dist 行为）
node provider\hx-failover\test-failover.mjs
```

`cleanup.sh` / `db-maintain.sh` 是 bash 脚本，Windows 在 Git Bash 里直接跑（`bash cleanup.sh --status`），或经上面的 PowerShell 包装调用。
依赖 GNU coreutils/findutils（`stat -c` / `find -printf` / `du`），Git Bash 自带；macOS/BSD 的 find/stat 语法不同，未经适配勿直接跑。

## 变更流程

1. 改仓库（新文件加进 `install.manifest`；改 `provider/hx-failover/src` 后先 `npm run build`——install 的 dist 新鲜度检查会拦旧 dist）
2. `.\install.ps1 -DryRun`（bash：`./install.sh --dry-run`）看差异 → `.\install.ps1` 下发
3. 跑验收三条
4. 提交
