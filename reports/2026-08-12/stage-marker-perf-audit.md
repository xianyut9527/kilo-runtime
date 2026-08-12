# 性能审计报告：stage-marker 优化收益量化

> 日期：2026-08-12 ｜ 范围：`scripts/task-context.mjs` / `scripts/lib/stage-i18n.mjs` / `scripts/build-derivations.mjs` / `scripts/lib/derived-cache.mjs`
> 目标：回答「运行时是否过重、有无冗余、编译时能做什么」，量化本次优化收益。

---

## 1. 运行时是否过重

**结论：脚本层不过重。** 真正的性能瓶颈不在脚本，而在每轮 LLM reasoning 回合 + 输出 token（秒级），脚本层是毫秒级噪声。

### 实测数据（Windows / Node，`Measure-Command`）

| 场景 | 实测耗时 | 说明 |
| --- | --- | --- |
| `node scripts/task-context.mjs --help`（冷启动） | **55.41 ms** | 含 Node 进程启动 + ESM 加载 + 静态派生加载 |
| `node scripts/task-context.mjs get T20260812-001 status`（单次 get） | **57.50 ms** | 冷启动 + 读 context JSON + 点路径取值 |
| 删除 `scripts/lib/.generated/` 后 `--help`（回退路径） | **56.03 ms** | 回退 `cachedDerive` 全量扫描 agent/*.md |

**关键观察**：
- 冷启动稳定在 **~55ms 级**，与是否命中编译时预生成差异仅 ~0.6ms（55.41 vs 56.03），说明 Node 进程启动本身占绝对主导，静态派生加载是次要项。
- 单次 `get` 仅比 `--help` 多 ~2ms，context 文件读写开销可忽略。
- 对比：一次 LLM reasoning 回合通常 **1–10 秒**，输出 token 流式生成亦为秒级。脚本层 55ms 相对 LLM 秒级占比 <1%，**不构成运行时瓶颈**。

---

## 2. 本次优化收益量化（3 项）

### U1 输出精简：三行标识「每轮」→「阶段流转点」

- **改动**：`agent/conductor.md` §10.1a 将三行标识（`[TIER]`/`[STAGE]`/`[STATUS]`）从「每轮输出」收窄为「阶段流转点输出」（INIT 首轮 / transition-check 成功后 / DELIVERING 首轮），阶段内部委派轮次不再重复输出。
- **收益**：每轮省 **~3 行**输出 token（三行标识 + 空行）。一个 T2 任务约 **5–8 轮** conductor 响应，省 **~15–24 行**冗余输出。
- **量化**：按每行 ~40 token 估算，单任务省 **~600–960 token** 输出；对长任务（多阶段、多 subagent 往返）收益线性放大。

### U2 formatTriple 重排 + STATUS 可选

- **改动**：`scripts/lib/stage-i18n.mjs#formatTriple` 输出顺序 **TIER 前置**（`[TIER]` → `[STAGE]` → `[STATUS]`），符合用户「任务等级在前」诉求；`agent/conductor.md` §10.1 将 **STATUS 降为可选**（仅状态变化时输出），INTENT 降为可选。
- **收益**：STATUS 无变化时省 1 行/次；TIER 前置提升可读性与下游 grep 锚点稳定性。`formatTriple` 成为 **Format A 唯一渲染入口**（§10.1 唯一来源），消除多套手写枚举路径。

### U3 编译时预生成：静态 JSON 优先加载

- **改动**：`scripts/build-derivations.mjs` 将 `WRITE_MATRIX` / `graph` / `config` 派生数据预生成为 `scripts/lib/.generated/derivations.json`；`task-context.mjs` 用 `fs.readFileSync` 探测 + `JSON.parse` 加载（`loadWriteMatrixFromGenerated`），失败透明回退 `cachedDerive`。
- **收益**：
  - 省 **mtime stat + cache 文件读**（`derived-cache.mjs` 的 `sourceSignature` 对每个源文件 statSync + 读 tmp 缓存），实测 ~0.6ms 级。
  - **消除 tmp 文件依赖**：不再依赖 `os.tmpdir()/kilo/derived-cache.json` 的进程间缓存，改为仓库内确定性产物。
  - **确定性收益**：`derivations.json` 带 `fingerprint`（源文件 mtime 指纹），源文件变化即失效重建，语义与 mtime 缓存一致但更可控。

---

## 3. 有无冗余

### 已合并/已消除的冗余

| 项 | 状态 | 说明 |
| --- | --- | --- |
| pre-dispatch / post-dispatch 单进程 | ✅ 已合并 | `git log 7303095`：pre-dispatch 写合并优化，减少进程启动次数 |
| `cachedDerive` mtime 缓存 | ✅ 已落地 | `derived-cache.mjs`：进程间缓存，命中 <10ms，源文件变化自动失效 |
| `WRITE_MATRIX` 静态派生 | ✅ 已落地 | 编译时预生成，运行期不再全量扫描 agent/*.md |
| 三行标识每轮重复输出 | ✅ 已消除 | U1 收窄为阶段流转点 |

### 剩余可选优化（标注，不在本次落地）

- **graph.yaml / config.yaml 预编译为 JS 模块**：当前 `derivations.json` 已含 graph/config 派生数据，但 `lifecycle-doctor` 等仍直接解析 yaml。可进一步将 graph/config 预编译为 `.mjs` 模块（顶层 import 加载），省 JSON.parse + 运行时解析。**标注为后续可选**，本次不落地（涉及 doctor 多入口改造，收益 ~ms 级，性价比低）。

---

## 4. 编译时能做的最好编译时做

- **U3 已落地**：`build-derivations.mjs` 编译期预生成 `derivations.json`，运行期 `fs.readFileSync` + `JSON.parse` 加载，失败回退 `cachedDerive`（fail-closed 语义不破坏）。
- **后续可选**：graph.yaml / config.yaml 预编译为 JS 模块（见 §3），消除运行期 yaml 解析；但当前收益仅 ~ms 级，非瓶颈，暂缓。

---

## 附：实测命令与证据

- 冷启动：`Measure-Command { node scripts/task-context.mjs --help }` → **55.41 ms**
- 单次 get：`Measure-Command { node scripts/task-context.mjs get T20260812-001 status }` → **57.50 ms**
- 回退路径：删除 `.generated/` 后 `--help` → **56.03 ms**
- 证据文件：`scripts/task-context.mjs:156-170`（generated 加载）、`scripts/lib/stage-i18n.mjs:94-101`（formatTriple）、`scripts/build-derivations.mjs`（预生成）、`scripts/lib/derived-cache.mjs`（mtime 缓存）、`agent/conductor.md:126-148`（§10.1/§10.1a）
