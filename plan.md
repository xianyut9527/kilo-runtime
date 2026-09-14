# kilo_config 升级方案（v2 · 可执行）

> 本文取代旧版概念稿。旧稿（946 行）描述了一个「动态认知型 Coding Agent Runtime」的愿景，
> 但没有一条可验收的任务，且大量设想与 Kilo 的实际能力不匹配。本稿把愿景逐条对照
> **Kilo 7.6.2 实测能力**，区分「原生可做 / 绕道可做 / 做不到」，并给出分阶段可执行计划。

---

## 一、目标与判据

**保留的目标**（来自原概念稿，仍然成立）：

- 主 agent 持有完整上下文并自主决策；子代理是**按需调用的工具**，不是流程节点。
- 低算力起步，遇到不确定性再升级（换 agent / 委派专家），不一开始就最大化。
- 验证按风险触发，不做固定验证流水线。
- 经验可沉淀、可复用；上下文只给必要的。
- 更少的 Token + 更少的工具调用 + 更少的人工干预，同时更高的任务成功率。

**明确不做**：

- 不自建编排引擎 / DAG / 阶段门禁（这正是 `afe5001` 删除的那套，删除是对的）。
- 不为了 multi-agent 而 multi-agent。
- 不写只在文档里成立的能力。

**验收判据（可机械校验）**：

| 编号 | 判据 | 校验方式 |
|------|------|----------|
| A1 | 仓库是唯一真源，`install` 全量下发且幂等 | `./install.sh --check` 退出码 0；重复执行「未变化 = 全部条目」 |
| A2 | 下发的 `kilo.json` 被目标运行时的校验器接受 | `kilo debug config` 无 `Configuration is invalid` |
| A3 | 每个 agent 的模型路由在运行时生效 | `kilo debug agent <name>` 输出的 `model` 与 `kilo.json` 一致 |
| A4 | 扩展能力（降级 / MoA / 守护 / 遥测 / 压缩锚点）在运行时被加载 | `kilo debug config` 的 `plugin` 列出 4 个本地插件；`gitnexus`/`context7` 在 `mcp` 中 |
| A5 | 知识与经验可检索 | `node scripts/kb.mjs search <关键词>` 命中条目 |
| A6 | 风险分级策略有书面口径且与 `INSTRUCTIONS.md` 一致 | 人工评审（见 §五） |

---

## 二、实测能力边界（关键结论，全部有实测依据）

> 全部结论来自 `kilo debug config` / `kilo debug agent` / `kilo debug skill` 与
> 隔离家目录（`USERPROFILE`/`HOME` 重定向）下的行为观测，版本 `7.6.2`。

### 2.1 版本前提（**必须先看**）

本机存在**两个不同大版本**的 Kilo，它们对 `kilo.json` 的校验口径不同：

| 来源 | 版本 | 校验口径 | 说明 |
|------|------|----------|------|
| VS Code 扩展 `kilocode.kilo-code-7.6.2` 自带 `bin/kilo.exe` | **7.6.2** | 接受 `privacy_mode` / `web_search` / `subagent_depth` / `agent` / `instructions` … | **你日常实际使用的就是这个**（扩展内嵌） |
| 全局 npm 安装的 `/c/Program Files/nodejs/kilo` | 7.4.16 | 拒绝上述字段（`ConfigV2` 重构后收窄） | 在终端直接敲 `kilo` 走的是它 |

**推论**：在终端里跑 `kilo debug config` 报 `Unrecognized keys: privacy_mode, web_search, subagent_depth`
**不代表配置坏了** —— 那是 7.4.16 在读同一份配置。本方案的验收统一以 **7.6.2** 为准。

> 建议（可选）：把两条 CLI 版本对齐（`kilo upgrade` 升级全局 CLI，或直接不再使用全局 CLI），
> 消除「同一份配置两套结论」的认知负担。

### 2.2 诉求 → 可落地性映射

| 原稿诉求 | 判定 | 落地方式 |
|----------|------|----------|
| 动态模型路由 | **原生有限支持** | ① `agent.<name>.model` 按角色绑定不同模型；② `experimental.task_model_selection: true` 允许任务子代理自选模型/推理强度；③ 主模型故障时由 provider 层降级链自动换模型。**不存在**「按任务复杂度自动评分选模型」的原生能力 |
| 动态算力升级 | **绕道可做** | 由 `INSTRUCTIONS.md` 的策略层驱动 agent 显式换档（explore 省算力 → general → 顶级模型），不做自动化评分器 |
| 按需专家调用（B 方案） | **原生支持** | `agent.*` + `mode: subagent` + Task 工具；`explore` 作为省算力探索者；`verify` 作为异源复核者 |
| 多模型并行协作（A 方案） | **绕道可做** | 自带 `moa` 工具（Mixture-of-Agents，按需调用、上限 3 参考 + 1 聚合），由主 agent 决定何时启用 |
| 模型故障自动降级 | **原生不支持 → 已自研** | Kilo 内置重试只在**同一模型**退避重试，绝不换模型（见 `knowledge-base/entries/FX-0001.md`）。已由 `provider/hx-failover` 在 provider 层实现 |
| 项目语义理解（Repo Graph） | **外部 MCP** | 通过 `gitnexus` MCP 提供 impact/调用链查询；`context7` 提供外部文档 |
| 上下文工程（选择/压缩/刷新） | **原生部分 + 自研** | 原生：`compaction`（阈值/保留轮数/预算）、`tool_output` 截断、`watcher.ignore`。自研：`plugin/compaction-anchor.ts` 在压缩时注入「任务目标 / 关键文件 / 未决问题 / 工作区变更」四类锚点 |
| 分层 Memory | **原生部分 + 文件约定** | Session = 会话 + 压缩锚点；Project = 各项目根 `AGENTS.md`（模板见 `docs/templates/AGENTS.project.md`）；Global Engineering = `knowledge-base/`；Skill = `~/.agents/skills/` |
| 动态验证（风险驱动） | **策略层** | `INSTRUCTIONS.md` 定义低/中/高风险的验证动作；`verify` 子代理（异源模型、`edit: deny`）用于高风险 |
| 自动经验沉淀 | **原生不支持 → 已自研** | `scripts/kb.mjs`（增/查/列）+ 仓库 SSOT + 部署副本回收集合 |
| 固定 Agent 角色链 | **明确不做** | 不存在 conductor/planner/coder/verifier DAG |
| 固定验证流水线 | **明确不做** | 不存在强制 `[VERIFIED]` 门禁 |

### 2.3 其他实测事实（写文档时容易踩）

1. **权限规则是「最后一条匹配者生效」**，不是第一条。
   实测：`{"bash":{"*":"allow","git status*":"deny"}}` → 命中 `deny`；
   `{"bash":{"git status*":"deny","*":"allow"}}` → 放行。
   故写权限块时**兜底 `*` 必须放最前**，例外规则放后面。
   （注意：内置技能 `kilo-config` 里写的是 "first match wins"/"last matching rule wins" 自相矛盾，以实测为准。）
2. **Kilo 不展开 `~`**。`instructions` / `skills.paths` / `provider.npm` 里的 `~` 会被当字面量。
   故仓库模板使用 `__KILO_HOME__` 占位符，由 install 脚本替换为**原生正斜杠**家目录（`C:/Users/x`，不是 MSYS 的 `/c/Users/x`）。
3. **`provider.npm` 必须三斜杠**：`file:///C:/...`。`file://C:/...`（两斜杠）会被解析成主机名 `C:`。
4. **本地插件自动加载**：`~/.config/kilo/plugin/*.{ts,js}` 无需在 `plugin` 数组里登记即被加载。
   `plugin: [...]` 只用于 npm 包或显式 `file://` 规格。
5. **`kilo.json` 不接受自定义扩展键**：任何未在 schema 中的键（包括 `"//"` 风格的注释键）都会让配置整体失效，
   报 `Unrecognized keys: ...`。
6. **内置 agent 清单**（7.6.2 schema）：`plan, build, debug, orchestrator, ask, general, explore, scout, title, summary, compaction`，
   另有 `code`。**不要**在内置 agent 名下放同名 `.md`（会整体覆盖内置提示词，见 `FX-0002`）；
   `verify` 等非内置 agent 才是合法的 `.md`/config 新增对象。
7. **`steps` 默认值未知**：原稿曾用 `"steps": 60`，但内置 agent 默认值无从确认，**不设**以免无依据地收紧迭代上限。

---

## 三、分层架构（SSOT → 下发 → 运行时）

```
E:\AI\agent\kilo_config                 ← SSOT：唯一真源，入库
├─ install.manifest                     ← 下发清单（唯一的文件列表真源）
├─ install.sh / install.ps1             ← 下发器：占位符替换 + 幂等 + 备份 + 漂移检测
├─ kilo.json                            ← 运行时配置模板（__KILO_HOME__ 占位）
├─ INSTRUCTIONS.md                      ← 全局工程原则（策略层：认知中心 / 风险验证 / 边界）
├─ agent/verify.md                      ← 异源验证子代理
├─ plugin/                              ← 4 个本地插件（压缩锚点 / MoA / 动态守护 / 本地遥测）
├─ scripts/                             ← kb.mjs（经验库）/ metrics-report.mjs（遥测汇总）
├─ knowledge-base/                      ← 跨项目工程经验库（SSOT）
├─ docs/templates/AGENTS.project.md     ← 项目级 AGENTS.md 模板
├─ provider/hx-failover/                ← 自研 provider：模型失败自动降级
└─ plan.md                              ← 本文件
                    │  ./install.sh（幂等、可回滚）
                    ▼
~/.config/kilo/                         ← 部署副本（Kilo 全局配置根）
├─ kilo.json（已替换占位符）             │  运行时读取
├─ plugin/ agent/ scripts/ knowledge-base/ provider/
                    │
                    ▼
~/.local/share/kilo/                    ← 运行时数据（kilo.db / auth.json / failover-events.jsonl / log）
```

**数据流三类**：

| 方向 | 机制 |
|------|------|
| 下发 | `install.sh`/`install.ps1` 读 `install.manifest`，渲染占位符后逐文件比对写入 |
| 采集 | 运行时 `kb.mjs add` 写入**部署副本**的 `knowledge-base/`（不进各业务仓库） |
| 回收 | `install.sh --check` 报漂移 → 人工判断是否把运行时新增的经验条目**回写仓库**并提交 |

---

## 四、分阶段计划

### 阶段 0：仓库归位（已完成 ✅）

| 任务 | 状态 | 证据 |
|------|------|------|
| 把现网已验证的资产收回仓库（插件/agent/KB/scripts/provider/docs 模板/INSTRUCTIONS） | ✅ | 仓库现有 20 个下发条目 |
| `kilo.json` 收敛为单一规范化版本（仓库不再落后于现网） | ✅ | 见 §五 验收 |
| 清单驱动下发器（bash + PowerShell 双实现） | ✅ | 幂等：二次执行「未变化 20 / 差异 0」 |
| 漂移检测 | ✅ | 人为改一个文件后 `--check` 退出码 1 |
| 占位符替换可移植性（`__KILO_HOME__` → 原生正斜杠路径） | ✅ | 隔离根渲染结果 `C:/Users/hzhb/...` |
| provider 包自包含构建（esbuild bundle） | ✅ | `node build.mjs` → `dist/index.js` 827KB |

### 阶段 1：能力面补齐（下一批，按需取用）

| 编号 | 任务 | 验收 |
|------|------|------|
| T1.1 | 版本对齐：决定全局 CLI（7.4.16）去留，消除双口径 | 终端 `kilo debug config` 与扩展内 `kilo.exe` 结论一致 |
| T1.2 | 把实测事实回写 `knowledge-base`（权限末位生效 / `~` 不展开 / 三斜杠 / 扩展键非法） | 每条 `kb.mjs search` 可检索 |
| T1.3 | `kilo.jsonc` 迁移评估：`jsonc` 支持注释，可把散落在 `plan.md` 的字段说明就地内联 | 若迁移，`kilo debug config` 仍通过 |
| T1.4 | 遥测落地验证：`telemetry-local` 产出 `.kilo/metrics/telemetry-*.jsonl`，`metrics-report.mjs` 可汇总 | 跑一次真实会话后报表有数据 |
| T1.5 | 降级链真实故障演练：人为把主模型改错，确认注入 `⚠️ [failover]` 通知且落到链上后继模型 | `failover-events.jsonl` 出现 `fallback` 记录 |
| T1.6 | `verify` 子代理端到端演练（高风险改动触发一次异源复核） | `kilo debug agent verify` 模型为异源，且实际返回判定 |

### 阶段 2：运维与卫生（与配置无关但影响可用性）

| 编号 | 任务 | 说明 |
|------|------|------|
| T2.1 | **`kilo.db` 体积治理** | 实测 `~/.local/share/kilo/kilo.db` = **14.2 GB**，WAL 597 MB。属运行时数据，建议定期归档/清理（需确认 Kilo 是否提供 `kilo db` 子命令） |
| T2.2 | `~/.config/kilo/*.bak.*` 清理 | 现网有 11 个历史 `kilo.json` 备份（新版下发器自带 tar 备份，旧散件可归档） |
| T2.3 | `docs/` 与 `agent/` 的模板漂移检查纳入 CI/预提交 | 可用 `install.sh --check` 作为钩子 |

### 阶段 3：只在确有收益时再做

| 编号 | 任务 | 触发条件 |
|------|------|----------|
| T3.1 | Model Router 的**显式策略**（不写评分器，只写「什么时候换哪个 agent」的判定表） | 若实际使用中发现换档判断不一致 |
| T3.2 | 为 `moa` 增加成本护栏（调用计数/预算） | 若遥测显示 moa 调用超预期 |
| T3.3 | 技能层沉淀（把本项目自身的工作流写成 skill） | 若同类升级再来一次 |

---

## 五、验收与回归（当前已通过项）

在隔离家目录（`USERPROFILE`/`HOME` 重定向 + 全新 `.config/kilo`）中，对 7.6.2 运行：

```
model/small/default_agent : hx/glm-5.3-flash / hx/minimax-m3 / code
subagent_model / depth    : hx/glm-5.3-flash / 2 | web_search: true
agents                    : code=glm-5.3-flash  plan=kimi-k2.6  general=glm-5.2
                            explore=minimax-m3  orchestrator=deepseek-v4.1-flash
                            verify=deepseek-v4.1-flash (mode=subagent, edit=deny)
providers                 : hx → file:///C:/Users/hzhb/provider/hx-failover
                            models=[deepseek-v4-flash, deepseek-v4.1-flash, glm-5.2, glm-5.3-flash, kimi-k2.6, minimax-m3]
mcp                       : playwright, context7, gitnexus
plugin(自动加载)          : compaction-anchor.ts, moa.ts, permission-guard.ts, telemetry-local.ts
skills                    : { paths: [C:/Users/hzhb/.agents/skills] }
experimental              : task_model_selection, shared_agent_board, batch_tool（openTelemetry=false）
```

配置校验：**通过**（无 `Configuration is invalid`）。

---

## 六、风险与边界

| 风险 | 说明 | 缓解 |
|------|------|------|
| 双 CLI 版本并存 | 同一配置两套结论，易误判 | 见 T1.1 |
| 自研扩展键静默失效 | `options.failover` / `options.moa` 是自研键，写错名不会报错 | 契约固化在 `FX-0004`；改动后跑 §五 验收 |
| 权限兜底位置写反 | 兜底放后面会吞掉例外（尤其 `deny`） | 已固化「兜底在前、例外在后」并写入 `INSTRUCTIONS.md` 与本节 |
| 内置 agent 提示词被覆盖 | 在内置名下放 `.md` 会整体覆盖 | `FX-0002`；只对非内置 agent 用 `.md` |
| 降级链掩盖真实故障 | 自动换模型可能让「主模型坏了」不易察觉 | `failover-events.jsonl` + 可见 `⚠️ [failover]` 通知 |
| 经验库泄漏敏感信息 | 入库内容可能含 key / 内网地址 | `knowledge-base/README.md` 的脱敏要求（入库前逐条自查） |

---

## 七、Hermes 的定位

按原稿结论：**不与 Hermes 重复造轮子**。Hermes 作为 Agent Harness / 执行层
（Session、Memory、Skill、Tool、Subagent、Browser、Terminal），本仓库只承载
**Kilo 侧的配置与策略**（模型路由、降级、MoA、压缩锚点、权限守护、经验库）。
两者的重叠面（skill 目录 `~/.agents/skills/`）由同一份物理目录共享，不复制。
