# 智能体生命周期挂载指南（v6 文件路由制）

> **核心原则**：新增/修改智能体 = 只动一个 `agent/<name>.md` 文件 + `kilo.json` 绑模型。**零改 `graph.yaml`、`stages/*.md`、`config.yaml` 或任何清单文件**。装配期由 conductor bootstrap 自动扫描 frontmatter 注册，运行时按阶段查表启动。

---

## 目录

1. [快速开始：两步配置法](#1-快速开始两步配置法)
2. [挂载点全集](#2-挂载点全集)
3. [frontmatter `mount` 字段详解](#3-frontmatter-mount-字段详解)
4. [条件挂载（`when`）](#4-条件挂载when)
5. [失败策略（`on_fail`）](#5-失败策略on_fail)
6. [多阶段挂载示例](#6-多阶段挂载示例)
7. [实际仓库案例（已抽离）](#7-实际仓库案例已抽离)
8. [校验与调试](#8-校验与调试)
9. [常见错误速查](#9-常见错误速查)

---

## 1. 快速开始：两步配置法

### 步骤 1：创建 `agent/my-agent.md`

在仓库根目录创建文件，frontmatter 写生命周期声明，正文写行为规则：

```yaml
---
description: 我的智能体。一句话说明职责。
mode: subagent        # 或 primary（仅编排者）
hidden: true          # 不在 Kilo TUI 列表中展示
steps: 80             # 预估步数（调度参考）
permission:
  bash: allow
  read: allow
  edit: deny          # 只读型智能体禁止 edit
  task: deny
mount:
  - at: EXECUTING
    on_fail: warn

task_context:
  read: [plan, execution.diffs]
  write: [verification.my_report]
---

# 行为正文

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 智能体定位

**生命周期阶段**：EXECUTING（主槽）
**加载条件**：图拓扑可达即加载（无 `when` = 恒定挂载）

## 做什么
...
```

### 步骤 2：`kilo.json` 绑定模型

```json
{
  "agent": {
    "my_agent": {
      "mode": "subagent",
      "model": "hx/kimi-k2.6"
    }
  }
}
```

**规则**：键名 = agent 文件名去 `.md` 后连字符转下划线。`my-agent.md` → `my_agent`。

完成。提交后运行 `./install.ps1`（Windows）或 `./install.sh`（macOS/Linux）部署到全局，重启 Kilo 即生效。

---

## 2. 挂载点全集

> **指针**：速查见 `lifecycle/stages/README.md` 阶段索引 + 挂载机制；本节为完整 mount 指南。

挂载点从 `lifecycle/graph.yaml` 节点**自动派生**，零声明——节点存在即挂载点存在。

### 主图挂载点

| 类型 | 格式 | 触发时机 |
|------|------|----------|
| 生命周期钩子 | `on:bootstrap` | 装配完成后、进入 INIT 前（一次性） |
| 阶段前钩子 | `pre:INIT`, `pre:PLANNING`, `pre:EXECUTING`, `pre:QUALITY`, `pre:DELIVERING` | 阶段主槽执行**前** |
| 阶段主槽 | `INIT`, `PLANNING`, `EXECUTING`, `QUALITY`, `DELIVERING` | 阶段本体执行时 |
| 阶段后钩子 | `post:INIT`, `post:PLANNING`, `post:EXECUTING`, `post:QUALITY`, `post:DELIVERING` | 阶段主槽执行**后**、edges 流转**前** |
| QUALITY 内部 hooks | `QUALITY hook:verify`, `QUALITY hook:fix`, `QUALITY hook:review` | 响应式 Hooks：hook 类型定义顺序，`after` 声明相对依赖；数据驱动自动触发（deps 变化/FAIL/PASS） |
| 生命周期钩子 | `on:done` | DELIVERING 完成后、DONE 前（一次性） |

> **注意**：`INIT` 的 executor 为 `conductor`（内建），主槽由 conductor 占据。`DELIVERING` 与 `INIT` 同为 conductor 内建阶段（`executor: conductor`，无 mount agent）。`pre:`/`post:` 钩子仍可挂载。v6 wire-up 修复记录见 `docs/archive/agent-mount-guide-v1.md` 附录 B。
> **QUALITY hooks 循环**：QUALITY 阶段内部通过 `hook` + `after` + `deps` + `trigger` 声明响应式挂载——`verify → fix → verify` 自动循环：检查（verify/review）FAIL 自动触发 fix，修复后代码变化再触发 verify，直到全部 PASS 才流转 DELIVERING。

---

## 3. frontmatter `mount` 字段详解

> **指针**：frontmatter 字段权威定义见 `lifecycle/stages/README.md` + 各 `agent/*.md` frontmatter（单一真相）；本节为人类速查手册。

`mount` 是**数组**，每个元素是一个挂载点条目。同一 `.md` 可挂一个或多个点。

```yaml
mount:
  - at: QUALITY                  # 挂载点名称（必填）
    hook: verify                 # 响应式 hook：verify | fix | review（v2 引入，见 archive 附录 C）
    deps: [execution.code, plan] # hook 依赖（deps 变化时自动触发）
    after: [other-agent]          # 可选相对依赖（省略 = 与同 hook 类型其他 agent 并行，按 agent 文件名字典序组织并行组，单条消息并行发起）
    trigger: onChange             # 触发时机：onChange（默认）| afterPass | onFail
    when: "config.agents.xxx"    # 条件挂载（可选）
    on_fail: degrade              # 失败策略（可选）
```

### `at`（必填）

挂载点名称，必须从 §2 挂载点全集中选取。示例：

```yaml
# 单个阶段
at: EXECUTING

# 阶段前钩子
at: pre:PLANNING

# 阶段后钩子
at: post:QUALITY

# 子图节点
```

### `after`（可选）

同 hook 类型 / 同挂载点多个智能体时的**相对依赖声明**。声明 `after: [agent-name]` 表示在本智能体之前必须执行指定 agent；省略 = **并行组成员**（无 after 依赖时按 agent 文件名字典序组织并行组，单条消息并行发起）。

```yaml
# 相对依赖执行（after 引用前驱 agent 名）
mount:
  - at: QUALITY
    hook: verify

# 并行执行（都省略 after，按 agent 文件名字典序组织并行组，单条消息并行发起）
mount:
  - at: QUALITY       # reviewer
    hook: review
    hook: review
```


> QUALITY 内部顺序由 `hook` 类型内置定义（`verify → fix → review → fix`），同 hook 类型内默认并行（无 after 依赖时单条消息并行发起），需要相对顺序时用 `after` 声明前驱（有 after 按拓扑串行）。仅 `graph.yaml` 声明 `parallel: true` 的节点保留并行语义。`order` 字段废弃历史见 `docs/archive/agent-mount-guide-v1.md` 附录 D。

### `when`（可选）

**条件挂载表达式**。INIT 阶段按 `lifecycle/config.yaml` 的 `tier_defaults` 写入 `task_context.config.agents`，运行时求值：

```yaml

# 恒定挂载（省略 when）：图拓扑可达即加载，无需开关
# 适用于：planner/coder/verifier/reviewer/fixer 等必配角色
```

`when` 语法：
- `"config.agents.<key>"` —— 查 `task_context.config.agents.<key>` 布尔值
- 无 `when` = **恒定挂载**（推荐默认方式）

### `tiers`（可选，替代 when 的定级挂载）

**定级挂载字段**。按当前任务的 `sizing.tier` 求值，仅当 `tier ∈ tiers` 才在声明挂载点加载该智能体。替代 `when: "config.agents.<key>"` 开关挂载：

```yaml
mount:
  - at: post:PLANNING
    tiers: [T2]        # 仅 T2 加载（T1 关闭、T2 开启方案审查）
    on_fail: abort
```

`tiers` 语法：
- `[T2]` —— 单 tier；`[T1, T2]` —— 多 tier（逗号分隔，去空格）
- 每项必须 ⊆ {T0, T1, T2}（lifecycle-doctor B4 校验）
- **互斥**：`when` 与 `tiers` 不得同时声明（同时出现 → lifecycle-doctor B4 `[FAIL]`）。tiers 优先作为定级挂载的唯一声明方式。
- 无 `when` 且无 `tiers` = **恒定挂载**（推荐默认方式，图拓扑可达即加载）


### `on_fail`（可选）

**挂载点级失败策略**。智能体超时/异常/`BLOCKED`/`NEEDS_CONTEXT` 时的处理方式：

| 取值 | 行为 | 适用场景 |
|------|------|----------|
| `abort` | 标记 `[SLOT_ABORT]`，**中止进入该阶段主槽** | `post:PLANNING` 方案硬门审查 |
| `warn` | 输出警告，**继续执行** | `pre:`/`post:`/`on:` 钩子的默认行为 |
| `skip` | 静默跳过该智能体 | 非关键辅助智能体 |

> **默认值**：`pre:`/`post:`/`on:` 挂载点默认 `warn`；主槽挂载点由阶段 `required_roles` 决定（必配角色失败 → escalate，可选视角失败 → degrade）。

> **节点级 `on_fail` 与挂载点 `mount[].on_fail` 是两套独立系统**：取值集与默认值规则见 `lifecycle/graph.yaml` L30-39 + `lifecycle/config.yaml` L208-218；二者互不干涉。

---

## 4. 条件挂载（`when`）

仅当需要**同阶段按 tier 差异化加载**时才使用 `when`。框架当前未内置可选视角（用户自建示例）：

| 智能体 | `when` 声明 | T0 | T1 | T2 |
|--------|------------|----|----|----|
| `my-auditor`（用户自建示例） | `config.agents.my_auditor` | ❌ | ❌ | ✅ |

开关声明在 `lifecycle/config.yaml`：

```yaml
tier_defaults:
  T0:
    agents: {}                    # 无可选视角
  T1:
    agents: {}                    # 无可选视角
  T2:
    agents:
      my_auditor: true            # 用户自建可选视角示例
```

> **新增智能体默认零配置**：恒定挂载（无 `when`）的智能体无需在 `config.yaml` 声明，图拓扑可达即加载。

---

## 5. 失败策略（`on_fail`）

### 挂载点级（`mount[].on_fail`）

控制**单个智能体**在该挂载点的失败行为：

```yaml
# post:PLANNING 方案审查 FAIL 必须中止进入 EXECUTING
mount:
  - at: post:PLANNING
    on_fail: abort

mount:
  - at: QUALITY
    hook: review
    on_fail: degrade
```

### 节点级（`graph.yaml` 节点 `on_fail`）

控制**整个阶段**的失败策略，与 `mount[].on_fail` 独立：

```yaml
# lifecycle/graph.yaml 片段
- id: PLANNING
  type: stage
  executor: default
  on_fail: retry_once        # planner 偶发超时重跑 1 次，再失败 escalate
```

| 取值 | 行为 |
|------|------|
| `abort` | 停止该阶段，输出状态等用户决策 |
| `retry_once` | 同智能体重跑 1 次 |
| `degrade` | 降级处理 |
| `escalate` | 升级路径（3 分支） |
| `pause` | 挂起，等用户决策 |

---

## 6. 多阶段挂载示例

> **指针**：扩展模式 + 用户自建阶段/挂载详见 `lifecycle/stages/README.md` 扩展指南；本节为典型示例集合。

### 示例 A：单点挂载（最简）

`agent/coder.md`：

```yaml
mount:
  - at: EXECUTING
```

只挂载到 EXECUTING 主槽，无 after（无同槽竞争）、无 when（恒定挂载）、无 on_fail（默认）。

### 示例 B：钩子挂载（阶段前后）

`agent/<custom-reviewer>.md`：

```yaml
mount:
  - at: post:PLANNING
    on_fail: abort
```

在 PLANNING 结束后、edges 流转到 EXECUTING **前**执行。用户自建方案审查智能体可挂载此点；`on_fail: abort` 表示审查 FAIL 则中止进入 EXECUTING。

### 示例 C：QUALITY hook 挂载

`agent/verifier.md`：

```yaml
mount:
  - at: QUALITY                  # 主图检查
    hook: verify
```

同一智能体挂载 QUALITY verify hook，无 `when`（恒定挂载），无 `after`（同 hook 类型按字典序组织并行组，单条消息并行发起）。

### 示例 D：条件挂载 + 降级


```yaml
mount:
  - at: QUALITY
    hook: review
    on_fail: degrade
```


### 示例 E：用户自建独立阶段/挂载

框架只内置 5 个阶段；需要额外阶段（如安全审计、多模型并行）时，用户自行编写智能体挂载到现有挂载点（`pre:`/`post:`/`hook`），或在 `lifecycle/graph.yaml` 新增节点 + `stages/<id>.md`：

```yaml
mount:
  - at: post:EXECUTING           # 编码完成后插入自定义检查
    on_fail: warn
```

---

## 7. 实际仓库案例（已抽离）

> **指针**：当前仓库真实挂载清单由 `node scripts/lifecycle-doctor/index.mjs --verbose` 实时输出（单源）。
> v1 时期的智能体挂载快照已抽离至 `docs/archive/agent-mount-guide-v1.md` 附录 A，作为历史参考。

---

## 8. 校验与调试

### 静态校验（部署前）

```bash
# 全量装配校验：图/挂载/契约/配置/矩阵 drift
node scripts/lifecycle-doctor/index.mjs

# 带详细输出（列出每个 agent 的 mount 点）
node scripts/lifecycle-doctor/index.mjs --verbose
```

校验项：
- **A5**：`agent/*.md` frontmatter `mount` 语法合法 + `at` 命中派生挂载点
- **A6**：每个 `required_roles` 角色有 ≥1 个智能体在主槽履行
- **A7**：`config.yaml timeouts` 键名与 agent 文件一一对应

### 动态扫描（运行时）

重启 Kilo 后，新会话 bootstrap 会输出：

```
bootstrap: scanning agent/*.md frontmatter...
mountPoint PLANNING: [planner]
mountPoint EXECUTING: [coder]
mountPoint QUALITY hook:fix: [fixer(trigger:onFail)]
```

### 部署后 blob 级验证

```powershell
# Windows
$files = @("agent/my-agent.md", "kilo.json")
foreach ($f in $files) {
    $db = git hash-object "$env:USERPROFILE\.config\kilo\$f"
    $hb = git rev-parse "HEAD:$f"
    Write-Host "$f global==HEAD: $($db -eq $hb)"
}
```

---

## 9. 常见错误速查

| 错误 | 原因 | 修复 |
|------|------|------|
| `[ASSEMBLY_FAIL]` mount[].at 无效 | `at` 不在派生挂载点全集内 | 对照 §2 挂载点全集修正名称 |
| `[ASSEMBLY_FAIL]` 角色无人履行 | 某 `required_roles` 角色无智能体在主槽注册 | 创建 `agent/<role>.md` 并挂载到对应主槽 |
| `[SLOT_ABORT]` | `post:PLANNING` 的 `on_fail: abort` 触发 | 检查方案审查输出，修复方案后重试 |
| `[AGENT_TIMEOUT]` | wall-clock 超过 `timeout_s` | 检查 `config.yaml timeouts.per_agent_s` 是否过小 |
| `${HOME}` 占位符残留 | `install.ps1`/`install.sh` 替换不完整 | 确保脚本替换 `${KILO_CONFIG_DIR}` 和 `${HOME}` |
| 全局未同步 | 提交后漏跑 install | 提交后执行 `./install.ps1` 或 `./install.sh`，重启 Kilo |

---

## 附录：完整 frontmatter 模板

```yaml
---
description: 一句话说明智能体职责
mode: subagent                    # primary | subagent | lifecycle_provider
hidden: true                      # true = 不在 TUI 展示
steps: 80                         # 预估步数（调度参考）
color: "#8B5CF6"                  # TUI 展示颜色（hidden=true 时可省略）
permission:
  bash: allow
  read: allow
  edit: deny                      # 只读型禁止 edit；编码型允许 edit
  task: allow
  glob: allow
  grep: allow
subagent_type: my_agent           # 对应 task 工具 subagent_type

# ---- 生命周期路由声明（v6 单源：manifest 与行为文件合二为一）----

# mount：可挂载一个或多个点（数组）
mount:
  - at: EXECUTING                 # 挂载点（必填，见 §2 全集）
    when: "config.agents.xxx"     # 条件挂载（可选，省略 = 恒定挂载）
    on_fail: warn                 # 失败策略（可选，pre:/post:/on: 默认 warn）
  - at: post:EXECUTING            # 第二个挂载点（可选）

# task_context：读写边界声明（运行时强制隔离）
task_context:
  read: [plan, execution.diffs]           # 可读切片
  write: [verification.my_report]         # 可写切片
  forbid_write: [execution.verification]  # 禁写切片（写入边界硬门）

# isolation：视角物理隔离（防止确认偏误）
isolation:
  forbid_read: [verification.forward, verification.reverse]

# type: lifecycle_provider 专用（普通 subagent 不需要）
# handoff:
#   enter: "..."
#   exit: "..."
# invariants:
#   - "..."
---
```

> **模型绑定不在 frontmatter 中声明**，统一在 `kilo.json` `agent.<name>.model` 配置。能力倾向参考 `docs/model-registry.md` 人工维护。


-NoNewline
