# 新手上手指南（GUIDE）

> 面向第一次接触本仓库的使用者：这是什么、怎么用、改配置（尤其模型 API）、改完如何同步生效。
> 原理细节与历史演变见根目录 [README.md](../README.md)，本指南只讲"怎么做"。

---

## 1. 这是什么（1 分钟版）

本仓库是你电脑上 **Kilo（AI 编程助手）的全局配置总仓库**。

Kilo 运行时读取的配置分散在两个目录：

| 目录 | 内容 |
|------|------|
| `~/.config/kilo/`（配置目录） | kilo.json（主配置）、插件、agent 定义、全局命令、provider 包 |
| `~/.local/share/kilo/`（数据目录） | 会话数据库、记忆、凭证 auth.json、遥测日志 |

**关键设计**：这两个目录里的文件都是"部署副本"，直接改会在下次下发时被仓库覆盖。本仓库才是唯一真源（SSOT）——**要改配置，先改仓库，再跑安装脚本下发**。

```
本仓库（真源）                    你的电脑（运行时）
├── kilo.json.tmpl  ──install──▶  ~/.config/kilo/kilo.json
├── plugin/*.ts      ──install──▶  ~/.config/kilo/plugin/
├── provider/...     ──install──▶  ~/.config/kilo/provider/
└── INSTRUCTIONS.md  ──install──▶  ~/.config/kilo/INSTRUCTIONS.md
```

## 2. 系统架构（5 分钟版）

```
Kilo 运行时
│
├── kilo.json（由 kilo.json.tmpl 渲染生成）—— 唯一配置真源
│   ├── 模型路由：主模型 / 小模型 / 子代理各用什么模型
│   ├── provider.hx：模型 API 网关 + 故障降级链 + 多模型审查配置
│   ├── permission：工具权限规则
│   └── mcp / compaction / experimental 等运行时开关
│
├── provider/hx-failover（自研模型网关客户端）
│   └── 可靠性核心：流式直通、三级超时、断路器、故障自动降级、
│       推理门控（thinking 模型推理吃光预算时自动扩预算重试）
│
├── plugin/（7 个插件，随 Kilo 进程启动自动加载）
│   ├── quality-gate   三层交付质量门禁（防"声称完成但没做"）
│   ├── dual-review    双向异源审查（正向查遗漏 × 反向红队 + 第三方裁决）
│   ├── moa            多模型交叉分析（高风险决策）
│   ├── permission-guard  动态拦截危险命令与密钥路径
│   ├── compaction-anchor  长会话压缩后保留任务锚点
│   └── memory-bootstrap  git 项目自动启用原生记忆
│
└── 全局命令（~/.config/kilo/command/）
    └── /evolve（复盘进化）、/memory-setup（记忆启用排查）
```

一句话：**kilo.json 管行为，provider 管可靠性，plugin 管质量门禁**。三者都从本仓库下发。

## 3. 第一次安装（无脑三步）

前置：本机已装 VS Code + Kilo 扩展。

Windows（PowerShell，主环境）：

```powershell
# ① 预览：会改哪些文件，不写盘（校验模板渲染 + JSON 合法性）
.\install.ps1 -DryRun

# ② 下发：真实部署（自动备份旧配置，保留最近 2 份）
.\install.ps1

# ③ 验证：确认配置合法、能跑通一个真实任务
.\install.ps1 -Check
```

⚠️ 第 ③ 步只是漂移检测，完整验收建议再跑一次冒烟（见第 6 节）。

macOS / Linux：

```bash
./install.sh --dry-run
./install.sh
./install.sh --check
```

装完**重载一次 VS Code 窗口**（`Ctrl+Shift+P` → Reload Window）——插件和 provider 随 Kilo 后台进程启动加载，已在运行的进程不会自动加载新代码。

## 4. 如何改配置

### 4.1 铁律（改之前 10 秒读一遍）

1. **只改仓库里的 `kilo.json.tmpl`，永远不要直接改 `~/.config/kilo/kilo.json`**——后者是渲染产物，下次 install 会被覆盖。
2. 模板注释只写**「行首 `//`」整行**。行尾注释和 `/* */` 会让部署产物变成非法 JSON。
3. `kilo.json` 不允许任何自定义键（加了整份配置失效）；权限规则**最后一条匹配者生效**（兜底 `*` 放最前，deny 放后面）。
4. 改完必须 `install.ps1 -DryRun` 验证，绿了再下发，下发后真跑一次任务。

### 4.2 标准改配置流程（固定三步）

```powershell
# 第 1 步：编辑 kilo.json.tmpl（VS Code 打开本仓库自动有 JSONC 高亮）
# 第 2 步：预览校验，不写盘
.\install.ps1 -DryRun
# 第 3 步：校验通过后真实下发 + 重载 VS Code 窗口
.\install.ps1
```

### 4.3 改模型 API 配置（最常用场景）

模型 API 相关配置全部集中在 `kilo.json.tmpl` 的两处，**改模型只动这个文件**（插件/provider 代码零内置默认）：

#### ① 换上游网关地址 / API Key（`baseURL` 与凭证）

```
位置：kilo.json.tmpl → provider.hx.options.baseURL
```

- `baseURL` 是上游 OpenAI 兼容网关地址（当前指向本机代理隧道 `http://127.0.0.1:9527/v1`）。
- **API Key 不在配置文件里**：key 只存 `~/.local/share/kilo/auth.json`（`hx.key` 字段），运行时读取，凭证零入库。换 key 直接改 `auth.json` 的 `hx.key`，**不需要**重新 install。
- 改 `baseURL` 后走 4.2 三步流程即可。

#### ② 换主模型 / 各角色模型

```
位置：kilo.json.tmpl 顶部 + agent 段
model:          "hx/glm-5.3-flash"     ← 主执行模型
small_model:    "hx/deepseek-v4.1-flash" ← 标题/摘要等轻任务
agent.code.model / agent.plan.model / ... ← 各 agent 角色路由
```

模型名格式 `hx/<模型名>`；新模型还需在 `provider.hx.models` 注册表里登记（声明 `reasoning` / `variants` / `limit.context` / `limit.output`）。

#### ③ 换故障降级链 / 审查模型

```
provider.hx.options.failover.chain.models  ← 主模型失败后依次切换的模型链
provider.hx.options.moa                    ← 多模型交叉分析（references + aggregator）
provider.hx.options.dual_review            ← 双向审查（positive/negative/aggregator）
```

⚠️ 降级链 / moa / dual_review 的模型列表**必须与 `models` 注册表里的登记一致**，写了未注册的模型名会在调用时失败。

#### ④ 改模型后的完整动作清单

```powershell
.\install.ps1 -DryRun        # 校验
.\install.ps1                # 下发
# 重载 VS Code 窗口（provider 是本地包，随进程启动加载，必须重载才生效）
# 跑一次冒烟任务确认（见下节）
```

## 5. 如何同步更新（改了仓库 → 各机器生效）

本机更新（改配置或拉了新代码后）：

```powershell
git pull origin main          # 若改动来自远端
.\install.ps1 -DryRun         # 预览
.\install.ps1                 # 下发（幂等，自动备份）
.\install.ps1 -Check          # 漂移检测：仓库与部署副本是否一致
```

**漂移检测**是日常体检工具：手动改过部署副本、或忘了下发导致两边不一致时，`-Check` 会列出差异文件。出现漂移 → 重跑 `.\install.ps1` 即可归位。

多台机器：仓库用 git 同步，每台机器 clone 后各自跑一次 install（占位符按本机路径渲染）。日常更新 = `git pull` + `install.ps1` + 重载窗口。

更新 provider 代码的特殊情况（改了 `provider/hx-failover/src/`）：

```powershell
cd provider\hx-failover
npm run build                 # 必须先重建 dist
node test-failover.mjs        # 跑回归（21 例）
node test-reasoning-gate.mjs  # 推理门控回归（12 例）
cd ..\..
.\install.ps1
```

install 自带 dist 新鲜度检查：`src` 比 `dist` 新时下发会被拦截，逼你先 build。

## 6. 验证安装成功（冒烟测试）

```powershell
# 配置合法性（不报 "Configuration is invalid" 即通过）
$EXT = (Get-ChildItem "$HOME\.vscode\extensions" -Directory -Filter 'kilocode.kilo-code-*' |
    Sort-Object Name -Descending | Select-Object -First 1).FullName
& "$EXT\bin\kilo.exe" debug config

# 端到端冒烟（模型真实响应"就绪"才算通）
New-Item -ItemType Directory -Force "$env:TEMP\kilo-smoke" | Out-Null
& "$EXT\bin\kilo.exe" run --dir "$env:TEMP\kilo-smoke" --auto "回答：就绪"
```

⚠️ `debug config` 通过 ≠ 能跑任务——provider 路径错误时 debug 不报错，冒烟必跑。

## 7. 日常使用速查

| 场景 | 操作 |
|------|------|
| 正常使用 | VS Code 里直接用 Kilo，无需任何手动步骤 |
| 换模型/改配置 | 改 `kilo.json.tmpl` → `-DryRun` → `install.ps1` → 重载窗口 |
| 会话变慢/膨胀 | `.\scripts\kilo-maintenance.ps1 -Status` 看状态；`bash cleanup.sh --status` 看垃圾 |
| 数据库瘦身（每两周） | `bash db-maintain.sh --status` 体检 → 关闭全部 Kilo 后 `bash db-maintain.sh` |
| 记忆没生效 | 新会话重开；仍不行跑 `node scripts\memory-enable.mjs` 体检 |
| 复盘沉淀经验 | 会话里输入 `/evolve` |
| 模型 API 换 key | 改 `~/.local/share/kilo/auth.json` 的 `hx.key`（唯一凭证存放处） |
| 模型请求失败自动切换 | 无需操作，provider 自动降级（流首会显示 ⚠️ [failover] 提示） |

## 8. 常见问题（FAQ）

**Q：改了 kilo.json.tmpl 但没生效？**
没重载 VS Code 窗口。插件/provider 随 Kilo 后台进程启动加载，重载（Reload Window）后生效。

**Q：在 Kilo 会话里本仓库的任务全部失败？**
历史踩坑：模板若叫 `kilo.json`（无 .tmpl 后缀），会被当项目级配置加载，占位符未渲染 → provider 初始化失败。本仓库内永远用 `kilo.json.tmpl` 这个名字。

**Q：UI 报"模型未提供结束原因"？**
provider spec 版本问题，必须声明 `v3`（已是默认，别改回 v2）。

**Q：`kilo run` 报 Configuration is invalid 但配置看起来没问题？**
99% 是 kilo.json 里出现了自定义键（哪怕一个注释键 `"//"`）→ 整份配置失效。字段说明写文档，别写进 JSON。

**Q：权限询问太频繁/想永久放行某命令？**
改 `kilo.json.tmpl` 的 `permission` 段。规则从上到下匹配，**最后一条匹配者生效**：`*` 兜底放最前，deny/例外放后面。

**Q：备份在哪、能恢复吗？**
每次 `install.ps1` 写盘前自动备份到部署目录旁的 `kilo.backup-<时间戳>.zip`（即 `~/.config/kilo.backup-*`），保留最近 2 份（`KILO_KEEP_BACKUPS` 可调）；`cleanup.sh --run` 会按保留策略清理。

## 9. 目录地图（哪些能动、哪些别碰）

```
kilo_config/
├── kilo.json.tmpl        ★ 主配置模板——改配置就改它
├── INSTRUCTIONS.md       ★ 每会话注入的工程原则——策略改动改它
├── install.ps1 / .sh     ★ 下发器——所有改动的落地出口
├── install.manifest      ★ 下发清单——新增文件必须登记这里
├── plugin/               插件源码（自动加载，改后需重载窗口）
├── provider/hx-failover/ 模型网关客户端（改 src 后 npm run build）
├── lib/hx-client.ts      moa/dual_review 共享 HTTP 客户端
├── scripts/              离线回归测试 + 维护工具
├── command/              全局命令（/evolve、/memory-setup）
├── agent/verify.md       异源验证子代理定义
├── docs/GUIDE.md         本指南
└── README.md             架构原理与完整约定（进阶必读）

~/.config/kilo/           部署副本（别直接改，会被覆盖）
~/.local/share/kilo/      数据目录（会话/记忆/凭证，脚本不碰）
```

---

维护约定速记：改模板只写行首 `//` 注释 · 模型唯一真源是 kilo.json.tmpl · 改完必跑 DryRun + 下发 + 重载 + 冒烟 · 凭证只存 auth.json · 新增文件登记 install.manifest