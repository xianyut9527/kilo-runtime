---
description: conductor 委派调度 SOP 独立文件。含 §委派包 SOP（6 字段/hard_limit/反模式/正例/T1 直通 minimal_gate）、§路径规范（path.resolve + verifier 6 必做路径断言 + WRITE_MATRIX 三角验证）、§铁律 #9 完整展开（pre/post-dispatch step0-2 + shell-guard/encoding-prescan/timeout-guard + 并行安全边界 + abort 不可恢复）、§MMO 编排 SOP（多模型分析 3 analyst + synthesizer + critic）。由 conductor.md 引用，降低注入单体体积。
---

# conductor-dispatch-sop.md

> 本文件为 agent/conductor.md 拆分产物，承载 conductor 委派调度 SOP 细节（铁律条目标题与核心句留在 conductor.md）。路径基准 ${KILO_CONFIG_DIR}/scripts/。

## 铁律 #9

9. **[工程化防 abort 四连]（step 0 pre-dispatch / step 0c shell-guard+encoding-prescan / step 0d timeout-guard / step 1 log-dispatch / step 2 overload_count）**（替代纯文字 prompt 约束，运行时机械强制）：
   - **step 0: pre-dispatch（合并 0b prompt-check + 0a size-check + 0d[前] timeout-guard start，一次进程）**：conductor 每次 task dispatch 前执行 `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" pre-dispatch <task_id> --agent <name> --tier <Tn> --prompt-chars <N> [--file-count <F>] [--bash-cmd "<cmd>"] [--unit-id <id>] [--key-files <a,b>]`，该命令原子完成"写 dispatch_pending + prompt 规模校验 + size 校验 + bash-guard + 启动 timeout_guard"，返回单一 verdict（替代旧四连**串行调用模式**(子命令仍可用作降级/单点校验)，省 3 次进程启动 + 3 个 reasoning 回合/每次 dispatch）：
   - **unit 派发必带标识（单元去重门禁前置）**：EXECUTING 每单元派发必带 `--unit-id <id>`（涉及显式文件清单时加 `--key-files <a,b>`），否则 dedup_unit_dispatch 门禁不生效（unitId 为空跳过去重，去重防线失电）。
     - exit 0 → 全通过，正常 task dispatch。
     - exit 1（`dispatch_pending` 非法，审计失败）→ 阻断 dispatch，检查 prompt-chars/file-count 参数。
     - exit 2 → 阻断 dispatch。**区分来源看 stdout**：`FAIL dispatch-prompt-check` = prompt 字符数 > `config.dispatch_prompt_threshold`（缺省 4000）或 file_count > max_files_per_task → 压缩 prompt/文件后重试；size 行字符数 > `config.size_check_threshold`（缺省 120000）= task_context 超限 → **自动 archive 归档优先，不机械删除素材**：
       1. **pre-dispatch 收到 size 超限自动调用 archive 子命令**：把 `execution / verification / plan / fixing_history` 细节字段原子转储到 sidecar `$TEMP/kilo/tasks/<id>/<id>.archive-<ts>.json`，主 ctx 这些字段替换为 `{archived:true, path, summary, archived_at_ms}`；**保留 intent / sizing / config / current_stage / quality.verdict / dispatch_log / status**（交付素材归档保护，不删除）。sidecar 写入失败则保持原样、维持 exit 2 阻断，不误归档。
       2. pre-dispatch 内建重测 size。exit 0 → 归档成功，继续 task dispatch。
       3. 仍 exit 2（不可归档字段如 dispatch_log 膨胀导致）→ `[CONTEXT_UNSAFE]` → 强制切 agent_manager worktree（独立 context，不占主会话）。
       4. **手动兜底**：`node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" archive <task_id>` 可独立调用归档（exit 0），供 conductor 离线压缩主 ctx 或恢复素材。
   - **step 0c: shell-guard + encoding-prescan（铁律 #9 新增机械门禁，2026-08-09 框架稳定化）**
     - **shell-guard**：conductor 每次通过 `bash` 工具委派 subagent / 执行写操作命令时，必须先 `node "${KILO_CONFIG_DIR}/scripts/bash-guard.mjs" "<bash_cmd>"` 静态分析。命中（exit 2 + `[BASH_WRITE_BLOCKED]` 或 `[PS51_REGEX_RISK]`）→ 阻断，改用 `glob`/`grep` 只读工具或 `task` 委派 coder（conductor 自身 `edit:deny`/`write:deny`）。
     - **encoding-prescan**：EXECUTING 阶段 coder 完工 / DELIVERING 阶段 conductor 交付前，必须 `node "${KILO_CONFIG_DIR}/scripts/scan-encoding.mjs"`，扫所有 `git diff --name-only HEAD` 改动的 .md/.mjs/.json。命中 BOM/U+FFFD/GBK 残留 → 阻断，标 `[ENCODING_DRIFT]`，coder 重做（PS5.1 必须 `Set-Content -Encoding UTF8` 或 Node `fs.writeFileSync` 显式指定 encoding）。
     - **pre-dispatch `--bash-cmd` 集成**：`node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" pre-dispatch <task_id> --prompt-chars <N> --file-count <F> --bash-cmd "<cmd>"` 一步合并 step 0 + step 0c（bash-guard 子进程）。命中 exit 2 与 dispatch-prompt-check/size-check 任一 exit 2 都阻断 dispatch。
     - **反事故教训**：2026-08 在 culture-applet / kilo_config 项目连续发生 2 次编码侧事故（GBK mojibake + PS5.1 死循环）根因均为 subagent 未跑 scan-encoding/bash-guard。本步骤把已有工具接进机械门禁，禁止软规则口头提醒。
    - **step 0d: timeout-guard（dispatch 前后双段，铁律 #9 新增机械门禁）**
      - **[前]** timeout_guard start 已合并进 pre-dispatch（`--agent --tier` 触发，返回 effectiveSeq）；不再独立调 `agent-timeout-guard.mjs start`。
      - **[后] post-dispatch（合并 step 0d[后] check+clear + step 1 log-dispatch + step 2 overload_count 判定，一次进程）**：task 返回后执行 `node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" post-dispatch <task_id> --dispatch-seq <N> --result pass|fail|timeout --agent <name> --mode task --stage <STAGE>`，该命令原子完成"timeout_guard check + clear + log-dispatch provenance"。
        - exit 0 → 全通过（pass/fail 已清 + provenance 已记），正常继续。
        - exit 4 → `[RETRY]`（timeout 且计数 ≤ agent_timeout_max_retries，同 agent 新会话重跑，dispatch_log +1 条目）。
        - exit 5 → `[ESCALATE]`（timeout 且计数 > agent_timeout_max_retries，按节点 on_fail:escalate）。
        - exit 1/2 → 参数/权限错，检查 --dispatch-seq/--result/--agent/--mode/--stage。
        - abort（provider 硬 kill）→ 同 timeout 路径处理（--result timeout）。
        - **overload_count 判断由 conductor 基于 task 返回长度直接计算**（量字符数 vs 角色 upper-bound，见 output-schema §返回超限约束分档），无需额外脚本：返回 >角色上限 → `[RETURN_OVER_LIMIT]` + `set overload_count +1`；`overload_count >= 3` → `[CONTEXT_UNSAFE]`，先按上述摘要压缩步骤处理，仍超限才切 agent_manager worktree。size-check 过关 + `set overload_count 0` 清零后回退 task。
        - **retry_once 超时重试数据流**：start→post-dispatch 超时 exit4 RETRY 首次（EXECUTING/PLANNING on_fail:retry_once 由此接线生效）；同 agent 新会话重跑仍超时→exit5 ESCALATE 二次，交由节点 on_fail:escalate，不再重试（retry.agent_timeout_max_retries=1）——ESCALATE 终止于 retry.agent_timeout_max_retries=1，同节点不再二次 RETRY。
        - **transition-check 保留为阶段级独立调用**（不合并进 pre-dispatch/post-dispatch，provenance 语义冲突）：跨节点流转前仍执行 `transition-check.mjs <task_id> --from <当前> --to <目标>`，其内置 provenance gate 校验 dispatch_log 是否包含必经智能体。
   - **并行 dispatch 安全边界**（配合铁律 #11 全局默认并行策略）：对每个待 dispatch 的 task——1. pre-dispatch 逐个先行（超限→摘要压缩→仍超限 `[CONTEXT_UNSAFE]`）；2. 同一条消息并行 dispatch（多个 task 调用在同一响应末尾发出，共享一个零输出硬门）；3. 结果返回后逐个 log-dispatch；4. 任一并行 task 返回 >角色上限（见 output-schema §返回超限约束分档） → `overload_count +1`；`>=3` → 摘要压缩→仍超限切 worktree。
   - **abort 不可恢复**：`Tool execution aborted` 出现即视为会话断开，不尝试重试。标 `[AGENT_UNAVAILABLE]` 按节点 on_fail 派发，或降级为 conductor 内建处理（仅限 INIT 内建阶段——conductor 不接管 coder/reviewer 等角色的写代码/审查工作；EXECUTING/QUALITY 阶段 subagent 不可用只能 escalate/pause，因 conductor `edit: deny` 无法代为编码）。

## 委派包 SOP

> **强制 byte-level**。**反 subagent 虚报(三次子代理虚报根因教训)**:subagent 报告"基于自己意图",与磁盘实际状态可分离。**必须用 byte-level 客观证据作硬门禁**。

### 委派包必含 6 字段(强制，单一规范)

每次 task 委派(coder/verifier/fixer/reviewer/reverse-auditor/plan-reviewer)必须含以下 6 字段（铁律 #6「委派包 = 核心摘要」的完整展开，两套清单合一）：

1. **`goal`** — 1 句目标（可验）
2. **`context_anchor`** — 文件:行号 精确指向（subagent 独立读文件，不传内容复述）
3. **`acceptance_criteria`** — 可验条件（≥1 条）
4. **`forbidden_files`** — 边界外文件禁止触碰
5. **`verification_command`** — 至少 1 条客观命令(Get-Content L 行 / git diff stat / grep 严格匹配)
6. **`return_contract`** — 含 `byte_level`（file/line/SHA256/cmd/exit，`byte_level_required: true` 标记）+ `hard_limit`（角色分档上限）

### 委派包必含 hard_limit 硬指令（防 abort 事前门禁）

每次 task 委派必含 `return_contract.hard_limit: <N>` 字段，N 取自 output-schema §返回超限约束角色分档:
- 执行类(coder/fixer): 4000
- 规划类(planner/plan-reviewer): 4000
- 验证类(verifier): 6000
- 审查类(reviewer/reverse-auditor): 8000

**与 overload_count 的关系**: hard_limit 是事前注入（subagent prompt 里就看到上限），overload_count 是事后计数（返回后 conductor 量字符数）。两者互补:
- hard_limit 事前: 让 subagent 在生成时就控制长度，减少超限概率
- overload_count 事后: 超限后的熔断机制（计数 ≥3 切 worktree）
- 优先级: hard_limit 事前 > overload_count 事后（预防优于治疗）

委派包示例:
return_contract:
  hard_limit: 4000  # coder 角色上限
  overflow_instruction: "返回超过 hard_limit 时，只保留 verdict + 证据 file:line + 1 句关键结论，其余落 task_context 后只返回指针"

### 委派包按角色差异化传递上下文

委派时按角色裁剪上下文，只传该角色相关条目，不传无关历史：

- **planner**：传完整过滤包。
- **coder**：只传当前单元相关条目。派发前跑 `node "${KILO_CONFIG_DIR}/scripts/kb.mjs" query "<症状词>"`，命中 top3 注入委派包 context_anchor，无命中省略。
- **verifier**：传失败与验证相关条目。
- **reviewer**：传风险与审查相关条目。
- **fixer**：传失败证据与修复范围条目。派发前跑 `node "${KILO_CONFIG_DIR}/scripts/kb.mjs" query "<症状词>"`，命中 top3 注入委派包 context_anchor，无命中省略。

### 委派包反模式(禁止)

- ❌ "verifier 必验证 PASS/FAIL" — 没说 byte-level,verifier 可虚报
- ❌ "代码要符合现有风格" — 空话,需枚举具体规范
- ❌ "改完后跑 doctor 验证" — doctor 不覆盖所有改动,需 Get-Content L 行
- ❌ "确保全部 PASS" — 无可验证条件

### 委派包正例(强制)

```
goal: "5 文件 12 处真实解耦(byte-level 验证,避免 010 报告虚报)"
byte_level_required: true
forbidden_files: ["lifecycle/", "agent/(除 conductor/planner/verifier).md", "docs/"]
return_contract.byte_level: {
  files_modified: ["README.md", "workflow-core.md", ...],
  critical_lines: [{"file": "README.md", "line": 12, "before": "...", "after": "..."}],
  before_sha: {"README.md": "abc..."},
  after_sha: {"README.md": "def..."}
}
verification_command: "node ${KILO_CONFIG_DIR}/scripts/decouple-check.mjs"
```

### byte-level SOP 文档
见 `.kilo/instructions/byte-level-verify.md`
### T1 直通路径委派包（INIT→EXECUTING 直通边，T1 low/medium）

> 直通边（`lifecycle/graph.yaml` INIT→EXECUTING，`t1_strength ∈ {low, medium}`）生效时，跳过 PLANNING 无 plan 产物。conductor 在派发 coder 前**必写** `plan.minimal_gate` 最小产物（transition-check 直通边校验，缺失 → `[MISSING_MINIMAL_GATE]` 阻断）：

```yaml
plan.minimal_gate:
  goal: "1 句"                          # 必填，非空字符串
  context_anchor: "文件:行号"            # 必填，非空字符串（精确指向）
  acceptance_criteria: ["≥2 条"]        # 必填，≥1 条（用户显式验收 + 强度判定推导）
  forbidden_files: ["..."]              # 必填，数组（可为空）
  verification_method: ["≥1 条客观命令"] # 必填，≥1 条可机械回放命令
```

- **写入命令**：`node "${KILO_CONFIG_DIR}/scripts/task-context.mjs" set <task_id> plan.minimal_gate '<json>' --agent conductor`（conductor frontmatter `task_context.write` 已含 `plan.minimal_gate`）。
- **验收推导**：acceptance_criteria 至少含用户显式验收 + 由 t1_strength 判定推导的强度相关验收。
- **与委派包关系**：minimal_gate 是直通边的最小 plan 产物，替代完整 plan.task_dag；派发 coder 的委派包仍按 §委派包 SOP 必含 6 字段（含 hard_limit）。


## 路径规范

> **强制**。**反 verifier 路径错 + 漏 sync 教训**:subagent 委派包必用 `path.resolve()` 相对项目根,禁止硬编码 `lifecycle-doctor/`(实际是 `scripts/lifecycle-doctor/`)。

### 委派包必含路径字段

- **`key_files`**:必用 `path.resolve(<file>)` 相对项目根(即当前工作目录，path.resolve() 的解析基准)
- **`forbidden_files`**:必用绝对路径或 path.resolve()
- **`return_contract.byte_level.path_normalized: true`**:标志此委派需路径断言

### 路径反模式(禁止)

- ❌ 硬编码 `lifecycle-doctor/`(实际 `scripts/lifecycle-doctor/`,差一级)
- ❌ 路径不带 `scripts/` 前缀(verifier 误报)
- ❌ 用相对路径 `./check.mjs` 而非 `path.resolve()`
- ❌ 不验证路径存在(Test-Path)就委派

### 路径正例(强制)

```
key_files: [path.resolve('scripts/decouple-check.mjs')]
forbidden_files: [path.resolve('lifecycle/'), path.resolve('agent/(除 conductor/planner/verifier/coder).md')]
return_contract.byte_level: {path_normalized: true}
verification_command: "Test-Path scripts/lifecycle-doctor/checks/decouple-audit.mjs"
```

### 6 必做 verifier 路径断言

verifier 接收委派包后必:
1. `path.resolve()` 规范化 key_files
2. `Test-Path <resolved>` 验证文件存在
3. `git ls-files <resolved>` 验证 git 追踪(若需)
4. `path.normalize()` 对比磁盘实际字节
5. 报 FAIL 若 `path_normalized: false`
6. 禁止"信任 coder 报告"的路径声明

### byte-level SOP 引用

见 `.kilo/instructions/byte-level-verify.md` §8 路径陷阱（落地交付）



### WRITE_MATRIX 三角验证

- **conductor**: 可写 [intent, sizing, status, convergence, quality.verdict, quality.max_rounds, config, current_stage, dispatch_log, overload_count, dispatch_pending, execution.kb_write, execution.prior_lessons_used]
- **verifier**: 可写 [verification.forward, execution.verification] — verification.forward 必含 byte_level 字段
- **fixer**: 可写 [fixing_history, execution.diffs] — fixing_history 必含 byte-level 证据
- **coder**: 可写 [execution.*, plan, ...] — execution.changes 必含 byte-level 字段


## MMO 编排 SOP

> **多模型分析编排，独立能力，不进入任务生命周期。**
> deep-analyzer 是独立智能体，不挂载任何 stage，不写 task_context。
> 但 conductor 是唯一编排者——识别到多模型触发词后，由 conductor 直接编排
> 3 analyst + synthesizer + critic 流水线（类比 dispatch planner/coder/verifier，
> 都是编排，不违反"不亲为"铁律）。
> deep-analyzer.md 保留为编排描述文档，实际编排由 conductor 执行。

### 触发词识别

用户消息命中以下任一触发词时，进入多模型分析编排路径（**不走正常 T0-T2 生命周期**）：

| 触发词 | 语义 |
|---|---|
| "用多模型分析 X" / "多模型分析" | 多视角深度分析 |
| "深度分析 X" / "深度审查 X" | 深度分析 |
| "多角度审查 X" / "多角度分析 X" | 多视角审查 |
| "三角验证 X" | 三角验证 |
| "交叉验证 X" | 交叉验证 |

### 编排流程（conductor 直接执行，不经过 INIT/PLANNING/EXECUTING/QUALITY/DELIVERING）

```
触发词命中
  ↓
[不初始化 task_context] [不执行 init-gate] [不执行 apply-tier-auto]
[不走 transition-check] [不写 task_context 任何字段]
  ↓
Step 1: 并行 dispatch 3 路 analyst（单条响应消息内 3 个 task 调用）
  ├─ task: analyst-1（goal: 从逻辑基线视角分析 <用户输入对象>）
  ├─ task: analyst-2（goal: 从全局关联视角分析 <用户输入对象>）
  └─ task: analyst-3（goal: 从语义落地视角分析 <用户输入对象>）
  ↓ 等三路全部返回（零输出硬门，同铁律 #11 并行组规则）
Step 2: dispatch synthesizer（串行，等 analyst 全部返回后）
  └─ task: analyst-synthesizer（goal: 融合三路 analyst 独立结论，产出 5 维 × 3 视角矩阵）
  ↓
Step 3: dispatch critic（串行，等 synthesizer 返回后）
  └─ task: analyst-critic（goal: 反向审计 synthesis 偏误/遗漏/过度自信）
  ↓
Step 4: conductor 整合三阶段输出，直接输出分析报告给用户
  - 不经过 DELIVERING 阶段
  - 不写 task_context
  - 报告含：summary + dimension_matrix + findings + optimization_opportunities + critic_audit
```

> **dispatch 门禁接线（--ephemeral）**：MMO 路径不初始化 task_context，但铁律 #9 防 abort 门禁不豁免。
> 每次 analyst/synthesizer/critic dispatch 前后仍执行：
> - pre-dispatch：`node "<KILO_CONFIG_DIR>/scripts/task-context.mjs" pre-dispatch <task_id> --agent <name> --tier T1 --prompt-chars <N> --ephemeral`
>   （task_context 未 init 时仅内存级 prompt/size 校验 + bash-guard，出口 stdout 标 `[ephemeral]`，exit 0 放行）
> - post-dispatch：`node "<KILO_CONFIG_DIR>/scripts/task-context.mjs" post-dispatch <task_id> --dispatch-seq <N> --result pass --agent <name> --mode task --stage PLANNING --ephemeral`
>   （task_context 未 init 时仅参数校验后 noop，stdout 标 `[ephemeral]`/`noop`，exit 0 放行）
> 若已 init（误初始化）`--ephemeral` 忽略并走常规路径（fail-safe，防误降级）。

### 与正常生命周期的边界

| 维度 | 正常 T0-T2 任务 | 多模型分析 |
|---|---|---|
| task_context 初始化 | ✅ init | ❌ 不初始化 |
| init-gate 装配自检 | ✅ 执行 | ❌ 跳过 |
| apply-tier-auto 定级 | ✅ 执行 | ❌ 跳过 |
| transition-check 流转 | ✅ 执行 | ❌ 跳过 |
| graph.yaml DAG | ✅ 走 5 阶段 | ❌ 不走 |
| task_context 写入 | ✅ 各角色写 | ❌ 不写 |
| 铁律 #9 pre/post-dispatch | ✅ 执行 | ✅ **仍执行**（防 abort 门禁不豁免）——**pre/post-dispatch 必加 `--ephemeral`**（task_context 未 init，脚本对缺失 ctx 走内存校验/noop，exit 0 放行，不 die 不写盘） |
| 铁律 #6b 完工即写 task_context | ✅ 执行 | ❌ 跳过（无 task_context） |
| 铁律 #6.5 拒绝 narrative-only PASS | ✅ 执行 | ✅ **仍执行** |
| 铁律 #11 并行组规则 | ✅ 执行 | ✅ **Step 1 三 analyst 并行适用** |

### 委派包（每个 analyst / synthesizer / critic）

按 §委派包 SOP 核心摘要传递：
- goal: 1 句（分析目标 + 视角）
- context_anchor: 用户输入对象（文件路径 / 代码片段 / 架构描述）
- acceptance_criteria: ["产出 verdict + 5 维度覆盖 + file:line 证据"]
- forbidden_files: ["agent/", "lifecycle/", "docs/", "scripts/"]（只分析不修改）
- return_contract.hard_limit: 4000（analyst/synthesizer/critic 均为 4000）
- verification_command: "无（分析任务，无机械验证命令）"

### 成本声明

多模型分析涉及 6 次模型调用（3 analyst + 1 synthesizer + 1 critic + conductor 编排），token 成本约为普通任务的 3-4 倍。**只在用户显式 invoke 时执行，不自动触发**。
