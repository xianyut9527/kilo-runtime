# Kilo Runtime 使用指南

<div align="center">

**简体中文** | [English](GUIDE-EN.md)

</div>

这份指南面向**使用 Kilo Runtime 的人**，按“安装 → 跑通任务 → 日常使用 → 理解能力 → 修改配置”的顺序组织。只想快速安装可看[仓库首页](../README.md)；架构演变和维护者细节在 [HISTORY](HISTORY.md)。

## 1. 它是什么

Kilo Runtime 是 Kilo 的全局配置与运行时增强包，不是独立 IDE，也不是多智能体编排界面。安装后，你可以继续在 Kilo GUI 客户端、VS Code + Kilo 扩展或 Kilo CLI 中工作：

- `kilo.json.tmpl` 定义模型、网关、权限和行为开关；
- 安装脚本把仓库资产渲染并下发到 `~/.config/kilo/`；
- provider 负责模型请求、流式异常保护和故障切换；
- plugin 负责质量门禁、审查、危险命令防护和记忆；
- 会话、记忆和凭证保存在 `~/.local/share/kilo/`，不属于仓库配置。

最重要的使用原则：**仓库是唯一真源，部署目录只读**。修改 `~/.config/kilo/kilo.json` 会在下次 install 时被覆盖。

## 2. 安装并跑通第一个任务

### 2.1 前置条件

| 环境 | 要求 |
|------|------|
| Kilo | Kilo GUI 客户端、VS Code + Kilo 扩展，或 Kilo CLI（任选其一） |
| Windows | PowerShell 7+ |
| macOS / Linux | bash |
| 运行时工具 | Node.js 22+；Bun 可选 |
| 模型供应商 | [OpenLlamas](https://openllamas.com) API Key |

仓库已包含 provider 构建产物，**日常安装不需要 `npm install`**。只有重新构建 provider 时才需要安装它的开发依赖。Windows 日常使用也不需要 Git Bash；只有 `cleanup.sh`、`db-maintain.sh` 等 bash 维护脚本需要它。

### 2.2 预览并安装

在仓库根目录执行。

Windows：

```powershell
.\install.ps1 -DryRun   # 渲染、校验并列出差异，不写盘
.\install.ps1           # 正式下发，写盘前自动备份
.\install.ps1 -Check    # 日后检查仓库与部署副本是否漂移
```

macOS / Linux：

```bash
./install.sh --dry-run
./install.sh
./install.sh --check
```

默认目标是 `~/.config/kilo/`。安装是幂等的：内容相同的文件会跳过，确有写入时才备份。已有个人定制时先看 Dry Run，避免清单内文件被意外替换。

需要安装到其他目录时，Windows 用 `.\install.ps1 -Target D:\path\kilo`，bash 用 `./install.sh --target /path/kilo`。模板中的绝对路径会按目标目录重新渲染。

### 2.3 配置 OpenLlamas API Key

模型请求通过 **OpenLlamas** 网关转发。先在 [OpenLlamas 官网](https://openllamas.com) 获取 API Key，再编辑：

```text
~/.local/share/kilo/auth.json
```

合并 `openllamas.key`，不要覆盖已有的其他 provider 凭证：

```json
{
  "openllamas": {
    "key": "你的 API Key"
  }
}
```

Key 只存在运行时数据目录，不进入 git。修改 Key 不需要重新 install；`moa` / `dual_review` 的共享请求层最多缓存配置 60 秒，遇到 401 会立即失效缓存。若正在运行的 Kilo 仍持旧凭证，重载或重启 Kilo 后再试。

### 2.4 重载并验证

1. 重载或重启 Kilo，确保新插件和 provider 被加载；VS Code 用户可执行 `Developer: Reload Window`。
2. 在所选客户端中打开任意项目，新建 Kilo 会话。
3. 确认默认 agent 是 `code`，模型来自 `openllamas`。
4. 发送只读任务：

   > 阅读当前项目结构，告诉我如何安装依赖和运行测试；不要修改文件。

随后再试一个小型代码任务，例如：

> 修复当前最相关的测试失败，修改后运行对应测试，并总结根因与改动。

只读问答验证模型链路；代码任务验证编辑、权限和质量门禁链路。配置解析成功不等于任务可运行，因此首次安装至少应跑通一个真实任务。

## 3. 日常怎么用

### 3.1 两种主要入口

- **`code`**：默认执行入口，用于读代码、改代码、跑命令和交付任务。
- **`plan`**：用于方案设计与分析；确认方案后再切回 `code` 实现。

复杂任务可以直接描述目标、限制和验收要求，不需要手动编排子代理。例如：

> 给这个模块补充分页接口。保持现有 API 风格，增加正常页、越界页和空结果测试；不要修改无关模块。

### 3.2 提交任务后自动发生什么

```text
你描述任务
   │
   ▼
主 agent 分析并执行（读取、编辑、运行命令，按需委派）
   │  ├─ permission-guard：拦截高风险命令与凭证写入
   │  ├─ compaction-anchor：长会话压缩时保留任务锚点
   │  └─ quality-gate：核对执行痕迹、测试结果和未完成待办
   ▼
交付检查
   │  ├─ 普通代码改动：要求末次编辑后有真实通过的验证
   │  └─ 高风险文件或 ≥3 个代码文件：自动 dual_review
   │      （正向查遗漏 + 反向找错 + 裁决终审）
   ▼
返回改动、验证结果，以及审查/降级/显式跳过记录
```

纯文档改动不触发代码测试硬门禁或自动交付审查。审查不通过时会要求先修复必须项；自动审查最多两轮，显式跳过验证或接受残余风险都会留下可审计记录。

### 3.3 常见操作

| 需求 | 入口 |
|------|------|
| 修改模型或行为配置 | 编辑仓库 `kilo.json.tmpl` → Dry Run → install |
| 检查是否部署完整 | `install.ps1 -Check` 或 `install.sh --check` |
| 启用非 git 目录的项目记忆 | 在 Kilo 中运行 `/memory-setup` |
| 定期复盘、修正和沉淀经验 | 在 Kilo 中运行 `/evolve` |
| 查看故障切换记录 | `~/.local/share/kilo/failover-events.jsonl` |
| 清理与数据库维护 | 见 [HISTORY 的维护章节](HISTORY.md#磁盘垃圾与维护2026-09-15-专项) |

## 4. 模型、降级与审查

### 4.1 模型配置只看一个文件

所有具体绑定都在 `kilo.json.tmpl`。其中的模型是作者的一套默认选择，不是唯一答案：模型怎么选由用户自己的偏好决定，按需改任意角色的 `model` / `variant` 即可。

| 要改什么 | 字段 |
|---------|------|
| 默认主模型 | 顶部 `model` |
| 轻任务 / 子代理缺省模型 | `small_model` / `subagent_model` |
| 规划、执行、复核等角色 | `agent.<name>.model`，推理档位用 `variant` |
| 网关地址 | `provider.openllamas.options.baseURL` |
| 故障切换后备列表 | `provider.openllamas.options.failover.chain.models` |
| 多模型分析席位 | `provider.openllamas.options.moa` |
| 双向审查席位与回退 | `provider.openllamas.options.dual_review` |
| 新模型能力、窗口和 variants | `provider.openllamas.models` |

新模型必须先在 `provider.openllamas.models` 注册，再被路由引用。文档不复制当前模型名和数量，避免配置更新后再次失真；角色职责如下：

| 角色 | 职责 |
|------|------|
| `code` | 日常实现与命令执行 |
| `plan` | 方案设计与规划 |
| `general` | 高风险、跨文件或深度实现子任务 |
| `explore` | 只读粗扫与定位 |
| `orchestrator` | 任务拆解与分派 |
| `compaction` | 会话压缩与摘要 |
| `verify` | 异源、只读独立复核 |
| `single` | 单模型能力测试入口（不用于交付，见第 5 节） |

### 4.2 故障切换的正确口径

`failover.chain.models` 不是完整调用链，而是**当前模型之后的后备模型列表**。provider 会把本次请求的当前模型放在链首并去重，因此 `code`、`plan`、`verify` 等 agent 的实际链长和顺序可能不同。

失败模型会进入冷却；持续故障时后续请求可跳过已知不可用模型。切换时会注入可见的 failover 提示，同一冷却窗口内重复提示会去重。全链不可用时会失败并保留上游错误信息，不会把问题包装成难以定位的自定义文案。

### 4.3 多模型审查不是默认每次必跑

- `moa`：需要多视角判断时按需调用，多个参考模型分析后由聚合模型综合。
- `dual_review`：复杂交付自动触发，也可手动用于特定方案；正向与反向并行，之后由裁决席终审。
- 三席的当前模型与回退顺序以配置为准。回退可能导致席位与被审主体同族，此时结果应标注“降级复核”，不能算作完整的独立异源审查。
- 审查会额外消耗上游调用与时间，因此简单、低风险改动不会机械触发。

## 5. 单模型能力测试模式

该模式用于观察**一个模型从头到尾独立完成任务**的能力，不用于正常交付。有两种进入方式：日常用模式选择器直接进入；需要严格隔离时用命令行锁定。

### 5.1 模式选择器进入（日常）

1. 在 Kilo 模式选择器中选择「单模型测试」（`single`）；
2. 在模型选择器中选定要测试的模型与思考档位；
3. 直接下达任务——会话由该模型执行，不需要改配置或重载。

该路径的隔离边界与残余影响：

- `single` 模式的权限禁用 task 委派、moa/dual_review 多模型审查、Agent Manager、todo/goal、技能与记忆工具；quality-gate 的回合出口兜底对 `single` 会话不注入提示，层 1/2/3 门禁因 todo 工具被禁而天然不触发；
- 模型与档位跟随模型选择器的当前选择，换模型即换测试对象；
- 全局 instructions 与项目记忆仍会注入，failover 链仍然生效——所选模型故障时回复流首会出现「⚠️ [failover]」并切换到备用模型，出现该提示的测试结果作废；
- 会话标题/摘要与自动压缩等后台任务使用配置中的轻量模型，不参与任务执行。

### 5.2 命令行锁定（严格隔离）

需要清空 failover、把注册表收敛到单一模型、清空 instructions/skills 并让 quality-gate 整体旁路时，使用锁定模式。进入后：

- 主模型、轻任务、子代理、项目记忆、全部 agent、failover、moa 和 dual_review 都固定到同一模型；
- 其他 primary agent 变为 hidden subagent，包括未写入 `kilo.json` 的内置 `ask/debug/summary/title` 等，主界面只保留 `single`；
- 清空附加 `instructions` 与 `skills`，禁止 task 委派、多模型审查、Agent Manager、todo/goal、技能和记忆工具；
- 关闭自动压缩、`task_model_selection` 与 reasoningGate。

以下命令在两平台都可执行（PowerShell 与 bash 都支持 `$HOME` 和正斜杠路径）：

```bash
# 1. 查看部署配置中已注册的模型与 variants
node "$HOME/.config/kilo/scripts/single-model.mjs" list

# 2. 预览进入后的配置；把 MODEL_ID / VARIANT 换成 list 输出的值
node "$HOME/.config/kilo/scripts/single-model.mjs" enter --model MODEL_ID --variant VARIANT --dry-run

# 3. 正式进入
node "$HOME/.config/kilo/scripts/single-model.mjs" enter --model MODEL_ID --variant VARIANT

# 4. 重载 VS Code 窗口/Kilo，新建会话后检查状态
node "$HOME/.config/kilo/scripts/single-model.mjs" status

# 5. 测试结束恢复原始配置，并再次重载
node "$HOME/.config/kilo/scripts/single-model.mjs" restore
```

`enter` 会备份部署配置为 `kilo.json.bak-single-*`，状态写入 `~/.local/share/kilo/single-model.json`。`restore` 默认拒绝覆盖进入模式后的手工修改；确认丢弃这些修改时才使用 `--force`，需要保留备份时可用 `--keep-backup`。

锁定模式活动期间，两个安装器都会拒绝覆盖配置。要恢复日常配置修改流程，必须先 `restore`。

## 6. 配置维护与开发

### 6.1 修改模板的固定步骤

1. 只改仓库 `kilo.json.tmpl`。
2. 运行 Dry Run，确认渲染与 JSON 校验通过。
3. 正式 install。
4. 修改 plugin/provider 后重载 VS Code 窗口；模型路由调整后新建会话核对实际模型。
5. 跑一个真实任务，不只依赖配置解析结果。

模板注释只能使用**行首 `//` 整行注释**。不要添加自定义 `"//"` 键，也不要假设 Kilo 会展开 `~`；需要路径时使用现有 `__KILO_HOME__` / `__KILO_CONFIG__` 占位符。

VS Code 模型选择器保存的模型或 variant 可能覆盖 `agent.*` 路由，已打开的会话也不会因修改模板而自动切回，这是“配置正确但行为没变”的常见原因。

### 6.2 修改 provider 后

在仓库根目录执行：

```bash
# 仅首次构建或依赖锁变化时需要
npm --prefix provider/hx-failover ci

# src/index.js 修改后必须重建 dist，再运行针对 dist 的离线回归
npm --prefix provider/hx-failover run build
node provider/hx-failover/test-failover.mjs
node provider/hx-failover/test-reasoning-gate.mjs
```

然后再 Dry Run、install、重载并跑真实任务。安装器会检查 src 与 dist 的构建指纹，旧 dist 不能冒充新实现。

完整测试与插件契约命令见 [HISTORY 的验收章节](HISTORY.md#验收)。

## 7. 架构速览

```text
┌─ 仓库（唯一真源）──────────────────────────────┐
│ kilo.json.tmpl / plugin / provider / agent    │
│ command / lib / INSTRUCTIONS.md / scripts     │
└──────────────────┬─────────────────────────────┘
                   │ install（渲染、校验、备份、下发）
                   ▼
        ~/.config/kilo/（运行时配置副本）
                   │
                   ▼
       Kilo GUI 客户端 / VS Code 扩展 / CLI
                   │
                   ▼
       provider / lib ──▶ OpenLlamas 模型网关

~/.local/share/kilo/：会话库、项目与全局记忆、API Key、故障事件
```

各资产的完整职责、历史决策和性能数据不放在使用指南里，统一见 [HISTORY](HISTORY.md)。

## 8. 故障排查与隐私边界

### 常见问题

| 现象 | 优先检查 |
|------|----------|
| 模型列表为空、provider 初始化失败 | install 是否成功；是否重载窗口；`provider.npm` 是否仍含未渲染占位符 |
| 401 / Invalid token | `openllamas.key` 是否正确，Key 与 `baseURL` 是否匹配同一网关 |
| 配置改完没有变化 | `-Check` / `--check`、窗口重载、新会话、模型选择器覆盖 |
| 修改 provider 后行为仍旧 | 是否重新 build、install 并重载；dist 指纹是否与 src 一致 |
| 故障切换为何发生 | 查看 `failover-events.jsonl` 的模型、状态码和错误摘要 |
| 单模型锁定模式无法 install | 先运行 single-model `status`，再 `restore` |

### 数据与隐私

- 对话和代码任务会发往配置的模型网关；`moa` / `dual_review` 还会把任务描述、diff 等审查素材发送给相应模型。
- API Key 只应在 `auth.json`，不要提交进仓库或贴进任务。
- `failover-events.jsonl` 只记录模型、动作、状态与错误摘要，不记录对话正文。
- `GLOBAL-NOTES.md` 是全局记忆编译产物，不要手工编辑；写入使用 `mem_add`，检索使用 `mem_search`。
- 完整出网链路、遥测和维护边界见 [HISTORY 的隐私与安全边界](HISTORY.md#隐私与安全边界)。
