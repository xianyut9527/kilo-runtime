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
7. [实际仓库案例](#7-实际仓库案例)
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

挂载点从 `lifecycle/graph.yaml` 节点**自动派生**，零声明——节点存在即挂载点存在。

### 主图挂载点

| 类型 | 格式 | 触发时机 |
|------|------|----------|
| 生命周期钩子 | `on:bootstrap` | 装配完成后、进入 INTENT 前（一次性） |
| 阶段前钩子 | `pre:INTENT`, `pre:SIZING`, `pre:PLANNING`, `pre:EXECUTING`, `pre:QUALITY`, `pre:DELIVERING` | 阶段主槽执行**前** |
| 阶段主槽 | `INTENT`, `SIZING`, `PLANNING`, `EXECUTING`, `QUALITY`, `DELIVERING` | 阶段本体执行时 |
| 阶段后钩子 | `post:INTENT`, `post:SIZING`, `post:PLANNING`, `post:EXECUTING`, `post:QUALITY`, `post:DELIVERING` | 阶段主槽执行**后**、edges 流转**前** |
| QUALITY 内部 hooks | `QUALITY hook:verify`, `QUALITY hook:fix`, `QUALITY hook:review` | v2 响应式 Hooks：hook 类型定义顺序，`after` 声明相对依赖；数据驱动自动触发（deps 变化/FAIL/PASS） |
| 生命周期钩子 | `on:done` | DELIVERING 完成后、DONE 前（一次性） |

> **注意**：`INTENT`、`SIZING`、`DELIVERING` 的 executor 为 `conductor`（内建），主槽本身由 conductor 占据，但 `pre:`/`post:` 钩子仍可挂载自定义智能体。
> **v2 QUALITY hooks**：QUALITY 阶段内部不使用 `pre:`/`post:` 挂载，而是通过 `hook` + `after` + `deps` + `trigger` 声明响应式挂载——`verify → fix → review → fix` 自动循环。

### T3 阶段级多模型并行

T3 走主图 `PLANNING→EXECUTING→QUALITY→DELIVERING` 全链路（与 T1/T2 一致），无独立 DAG。PLANNING 阶段由 `multiModel` 调度 3 个 planner 变体（kimi-k2.6 / deepseek-v4-pro / glm-5.2）出方案并融合选优，写入 `plan`；EXECUTING 单路 coder 按融合方案实现；QUALITY 四视角交叉验证不变。

---

## 3. frontmatter `mount` 字段详解

`mount` 是**数组**，每个元素是一个挂载点条目。同一 `.md` 可挂一个或多个点。

```yaml
mount:
  - at: QUALITY                  # 挂载点名称（必填）
    hook: verify                 # v2 响应式 hook：verify | fix | review
    deps: [execution.code, plan] # hook 依赖（deps 变化时自动触发）
    after: [other-agent]          # 可选相对依赖（省略 = 与同 hook 类型其他 agent 串行，按 agent 文件名字典序逐个启动）
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

# T3 阶段级并行
at: PLANNING                  # multiModel 调度 planner-a/b/c 三变体
```

### `after`（可选）

同 hook 类型 / 同挂载点多个智能体时的**相对依赖声明**。声明 `after: [agent-name]` 表示在本智能体之前必须执行指定 agent；省略 = **串行组成员**（按 agent 文件名字典序逐个启动，避免并发 task 调度 abort）。

```yaml
# 相对依赖执行（after 引用前驱 agent 名）
mount:
  - at: QUALITY
    hook: verify
    after: [verifier]            # 在 verifier 之后执行（reverse-auditor 场景）

# 串行执行（都省略 after，按 agent 文件名字典序逐个启动）
mount:
  - at: QUALITY       # reviewer
    hook: review
  - at: QUALITY       # side-checker（与 reviewer 串行，after: [reviewer]）
    hook: review
```

> **T3 阶段级并行场景**（如 3 个 planner 变体在 PLANNING 阶段由 multiModel 调度，`graph.yaml` 声明 `provider: multiModel`）省略 `after`，由 multiModel 按最大并行度执行。主图同 hook 类型默认串行，声明 `after` 控制相对顺序。

> v2 废弃 `order: <数字>` 绝对编号系统。QUALITY 内部顺序由 `hook` 类型内置定义（`verify → fix → review → fix`），同 hook 类型内默认串行（避免并发 task 调度 abort），需要相对顺序时用 `after` 声明前驱。仅 `graph.yaml` 声明 `parallel: true` 的节点保留并行语义。

### `when`（可选）

**条件挂载表达式**。SIZING 阶段按 `lifecycle/config.yaml` 的 `tier_defaults` 写入 `task_context.config.agents`，运行时求值：

```yaml
# 条件挂载：仅当 SIZING 写入 config.agents.reverse_auditor = true 时加载
when: "config.agents.reverse_auditor"

# 恒定挂载（省略 when）：图拓扑可达即加载，无需开关
# 适用于：planner/coder/verifier/reviewer/fixer 等必配角色
```

`when` 语法：
- `"config.agents.<key>"` —— 查 `task_context.config.agents.<key>` 布尔值
- 无 `when` = **恒定挂载**（推荐默认方式）

> **config.agents 键名规则**：agent 文件名去 `.md` 后连字符转下划线。`reverse-auditor.md` → `reverse_auditor`。

### `on_fail`（可选）

**挂载点级失败策略**。智能体超时/异常/`BLOCKED`/`NEEDS_CONTEXT` 时的处理方式：

| 取值 | 行为 | 适用场景 |
|------|------|----------|
| `abort` | 标记 `[SLOT_ABORT]`，**中止进入该阶段主槽** | `post:PLANNING` 方案硬门审查 |
| `warn` | 输出警告，**继续执行** | `pre:`/`post:`/`on:` 钩子的默认行为 |
| `skip` | 静默跳过该智能体 | 非关键辅助智能体 |
| `degrade` | 标记 `DEGRADED`，跳过该视角，**主流程继续** | 可选视角（reverse-auditor / side-checker） |

> **默认值**：`pre:`/`post:`/`on:` 挂载点默认 `warn`；主槽挂载点由阶段 `required_roles` 决定（必配角色失败 → escalate，可选视角失败 → degrade）。

> **节点级 `on_fail` 与挂载点 `mount[].on_fail` 是两套独立系统**：节点级 5 值（`abort|retry_once|degrade|escalate|pause`）在 `graph.yaml` 中声明，控制**整个阶段**的失败策略；挂载点 `on_fail` 4 值（`abort|warn|skip|degrade`）在 frontmatter 中声明，控制**单个智能体**在该挂载点的失败行为。二者互不干涉。

---

## 4. 条件挂载（`when`）

仅当需要**同阶段按 tier 差异化加载**时才使用 `when`。当前仓库只有 3 个可选视角使用条件挂载：

| 智能体 | `when` 声明 | T0 | T1 | T2 | T3 |
|--------|------------|----|----|----|----|
| `reverse-auditor` | `config.agents.reverse_auditor` | ❌ | ❌ | ✅ | ✅ |
| `side-checker` | `config.agents.side_checker` | ❌ | ❌ | ✅ | ✅ |


开关声明在 `lifecycle/config.yaml`：

```yaml
tier_defaults:
  T0:
    agents: {}                    # 无可选视角
    review_mode: none
  T1:
    agents: {}                    # 无可选视角
    review_mode: full
  T2:
    agents:
      reverse_auditor: true        # T2 加载反向审计
      side_checker: true         # T2 加载侧向验证
    review_mode: full
  T3:
    agents:
      reverse_auditor: true
      side_checker: true
    review_mode: full
  T3:
    agents:
      reverse_auditor: true
      side_checker: true
    review_mode: full
     provider: multiModel          # T3 走阶段级并行
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

# side-checker：可选视角，失败降级跳过
mount:
  - at: QUALITY
    hook: review
    when: "config.agents.side_checker"
    on_fail: degrade
```

### 节点级（`graph.yaml` 节点 `on_fail`）

控制**整个阶段**的失败策略，与 `mount[].on_fail` 独立：

```yaml
# lifecycle/graph.yaml 片段
- id: PLANNING
  type: stage
  executor: default
  on_fail: escalate          # planner 整体失败 → 升级处理
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

在 PLANNING 结束后、edges 流转到 EXECUTING **前**执行。它是 `post:PLANNING` 目前唯一挂载的智能体，无需 `after` 声明；`on_fail: abort` 表示审查 FAIL 则中止进入 EXECUTING。

### 示例 C：跨阶段多挂载

`agent/verifier.md`：

```yaml
mount:
  - at: QUALITY                  # 主图验证
    hook: verify
```

同一智能体可挂载多个点，无 `when`（恒定挂载），无 `after`（每个点独立，不与其他 verifier 竞争）。

### 示例 D：条件挂载 + 降级

`agent/side-checker.md`：

```yaml
mount:
  - at: QUALITY
    hook: review
    when: "config.agents.side_checker"
    on_fail: degrade
```

仅当 `config.agents.side_checker = true` 时挂载（T2+ 默认 true）。失败时跳过该视角，标记 `DEGRADED`，不阻塞 QUALITY hooks 主流程。

### 示例 E：QUALITY 四视角挂载示例

`agent/verifier.md`、`agent/reviewer.md`、`agent/fixer.md`：

```yaml
# verifier.md
mount:
  - at: QUALITY
    hook: verify

# reviewer.md
mount:
  - at: QUALITY
    hook: review

# fixer.md
mount:
  - at: QUALITY
    hook: fix
    trigger: onFail
```

三者分别挂载 QUALITY 的 verify/review/fix hooks，按 hook 类型内置顺序执行（verify → fix → review → fix）。同 hook 类型默认串行（按 agent 文件名字典序逐个启动），避免并发 task 调度触发 `Tool execution aborted`。

---

## 7. 实际仓库案例

当前仓库 14 个智能体的挂载分布：

| 智能体 | 挂载点 | 类型 | `when` | `on_fail` | 说明 |
|--------|--------|------|--------|-----------|------|
| `planner` | `PLANNING` | 主槽 | 无 | 默认 | 设计方案 |
| `coder` | `EXECUTING` | 主槽 | 无 | 默认 | 标准编码 |
| `verifier` | `QUALITY hook:verify` | 主图hook | 无 | 默认 | 正向验证 |
| `reviewer` | `QUALITY hook:review` | 主图hook | 无 | 默认 | 代码审查 |
| `fixer` | `QUALITY hook:fix` | 主图hook | 无 | 默认 | 定向修复（auto-trigger） |
| `plan-reviewer` | `post:PLANNING` | 后钩子 | 无 | `abort` | 方案硬门审查 |
| `reverse-auditor` | `QUALITY hook:verify` | 主图hook | `config.agents.reverse_auditor` | `degrade` | 反向审计（可选） |
| `side-checker` | `QUALITY hook:review` | 主图hook | `config.agents.side_checker` | `degrade` | 侧向验证（可选） |
| `multiModel` | `PLANNING` | primary | — | `config.agents.multiModel` | T3 阶段级并行调度者（mount: PLANNING，内部调度 planner-a/b/c） |
| `conductor` | — | primary | — | — | 主图编排者（不经 mount，内建执行 INTENT/SIZING/DELIVERING） |

> **multiModel** 与 **conductor** 是 `mode: primary` 智能体。conductor 不经 mount（内建执行）；multiModel 经 `mount: PLANNING` + `when: config.agents.multiModel` 挂载（T3 时激活）。

---

## 8. 校验与调试

### 静态校验（部署前）

```bash
# 全量装配校验：图/挂载/契约/配置/矩阵 drift
node scripts/lifecycle-doctor.mjs

# 带详细输出（列出每个 agent 的 mount 点）
node scripts/lifecycle-doctor.mjs --verbose
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
mountPoint QUALITY hook:verify: [verifier, reverse-auditor(when:config.agents.reverse_auditor)]
mountPoint QUALITY hook:review: [reviewer, side-checker(when:config.agents.side_checker)]
mountPoint QUALITY hook:fix: [fixer(trigger:onFail)]
mountPoint post:PLANNING: [plan-reviewer(on_fail:abort)]
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
| `[DIVERSITY_VIOLATION]` | T3 planner-a/b/c 模型 (vendor, architecture) 不两两不同 | 在 `kilo.json` 绑定不同 vendor 的模型 |
| `DEGRADED` | 可选视角（reverse-auditor/side-checker）挂载失败 | 检查模型可用性或降级为单机模式 |
| `${HOME}` 占位符残留 | `install.ps1`/`install.sh` 替换不完整 | 确保脚本替换 `${KILO_CONFIG_DIR}` 和 `${HOME}` |
| 全局未同步 | 提交后漏跑 install | 提交后执行 `./install.ps1` 或 `./install.sh`，重启 Kilo |

---

## 附录：完整 frontmatter 模板

```yaml
---
description: 一句话说明智能体职责
mode: subagent                    # primary | subagent
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
---
```

> **模型绑定不在 frontmatter 中声明**，统一在 `kilo.json` `agent.<name>.model` 配置。能力倾向参考 `docs/model-registry.md` 人工维护。
