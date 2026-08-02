# T1 生命周期流程完整性报告

> 生成时间：2026-08-01T15:25+08:00
> 数据来源：`lifecycle/graph.yaml` v2、`lifecycle/config.yaml` v1
> 本报告即 T1 样例任务验收产物
>
> **历史说明（2026-08-01）**：本报告记录的是旧版**子图架构**（MM_SUBGRAPH 节点 + multimodel-graph.yaml）。此后 T3 已重构为**阶段级多模型并行**（multiModel 在 PLANNING 阶段主槽调度 planner-a/b/c 变体），MM_SUBGRAPH 节点、multimodel-graph.yaml、subgraph_status 字段均已移除。以下 E6/E15 边与节点 8 为历史记录，不再存在于当前 graph.yaml；T3 现走 SIZING → PLANNING（multiModel 变体融合）→ EXECUTING → QUALITY → DELIVERING。

---

## 1. 节点映射表（9 节点 → 6 阶段）

graph.yaml v2 注释记载"8 stage → 6 stage"（原 CHECKING+REVIEWING+FIXING 合并为 QUALITY），实际 DAG 含 9 个节点（含虚拟入口/子图/终态）。

| # | 节点 ID | 类型 | 阶段文件 | executor | on_fail | 说明 |
|---|---------|------|----------|----------|---------|------|
| 1 | `START` | virtual | — | — | — | 虚拟入口，立即流转至 INTENT |
| 2 | `INTENT` | stage | `stages/intent.md` | conductor | pause | 意图判定：咨询类/执行类 |
| 3 | `SIZING` | stage | `stages/sizing.md` | conductor | pause | 任务定级 T0-T3，写入 config.agents |
| 4 | `PLANNING` | stage | `stages/planning.md` | — | escalate | 设计门/分析门（T1+ 必经） |
| 5 | `EXECUTING` | stage | `stages/executing.md` | — | retry_once | 编码实现，输出 diff+验收映射表 |
| 6 | `QUALITY` | stage | `stages/quality.md` | — | escalate | 质量保障（响应式 Hooks：verify→fix→review 自动循环） |
| 7 | `DELIVERING` | stage | `stages/delivering.md` | conductor | pause | 交付收尾：记忆写入+分支收尾协议 |
| 8 | `MM_SUBGRAPH` | subgraph | `multimodel-graph.yaml` | provider: multiModel | — | T3 多模型子图入口 |
| 9 | `DONE` | terminal | — | — | — | 终态 |

**6 阶段（stage 类型节点）**：INTENT / SIZING / PLANNING / EXECUTING / QUALITY / DELIVERING

---

## 2. 流转条件矩阵

| 边 | from → to | when 条件 | 说明 |
|----|-----------|-----------|------|
| E1 | START → INTENT | 无条件 | 虚拟入口 |
| E2 | INTENT → SIZING | `intent_type == 'EXECUTION'` | 执行类进入定级 |
| E3 | INTENT → SIZING | `intent_type == 'INQUIRY'` | 咨询类进入定级 |
| E4 | SIZING → EXECUTING | `intent_type == 'EXECUTION' and tier == 'T0'` | T0 极速通道 |
| E5 | SIZING → PLANNING | `intent_type == 'EXECUTION' and tier in ['T1','T2']` | T1/T2 设计门 |
| E6 | SIZING → MM_SUBGRAPH | `intent_type == 'EXECUTION' and tier == 'T3'` | T3 子图 |
| E7 | SIZING → DELIVERING | `intent_type == 'INQUIRY' and tier == 'T0'` | T0 咨询快答 |
| E8 | SIZING → PLANNING | `intent_type == 'INQUIRY' and tier in ['T1','T2','T3']` | T1+ 咨询分析门 |
| E9 | PLANNING → EXECUTING | `intent_type == 'EXECUTION'` | 设计门→编码 |
| E10 | PLANNING → QUALITY | `intent_type == 'INQUIRY'` | 分析门→质量验证 |
| E11 | EXECUTING → DELIVERING | `intent_type == 'EXECUTION' and tier == 'T0'` | T0 直通交付 |
| E12 | EXECUTING → QUALITY | `intent_type == 'EXECUTION' and tier in ['T1','T2','T3']` | T1+ 进入质量保障 |
| E13 | QUALITY → DELIVERING | `quality_verdict == 'PASS'` | 质量通过→交付 |
| E14 | QUALITY → DELIVERING | `quality_verdict == 'CIRCUIT_BREAKER'` | 全局熔断→挂起交付 |
| E15 | MM_SUBGRAPH → EXECUTING | `subgraph_status == 'ready_for_delivery'` | 子图回流主图 |
| E16 | DELIVERING → DONE | gate: `MEMORY_WRITE_COMPLETE` | 记忆写入完成门禁 |

**T1 EXECUTION 完整链路**：INTENT → SIZING → PLANNING → EXECUTING → QUALITY → DELIVERING → DONE

**T1 INQUIRY 完整链路**：INTENT → SIZING → PLANNING → QUALITY → DELIVERING → DONE（跳过 EXECUTING）

**挂载点命名空间**（graph.yaml:45-53）：`on:bootstrap`（装配后/INTENT前）、`on:done`（DELIVERING后/DONE前）、`pre:<NODE>`（节点主槽前）、`<NODE>`（节点主槽）、`post:<NODE>`（主槽后/edges流转前）。子图节点同样派生三挂载点。智能体在 `agent/*.md` frontmatter `mount` 声明挂载点+hook/after/when/on_fail。

---

## 3. on_fail 策略表

### 3.1 节点级 on_fail（graph.yaml 声明）

| 节点 | on_fail | 语义 |
|------|---------|------|
| INTENT | pause | 内建阶段失败挂起，输出选项等人决策 |
| SIZING | pause | 内建阶段失败挂起，输出选项等人决策 |
| PLANNING | escalate | 设计门失败→升级人工决策或补上下文 |
| EXECUTING | retry_once | 主槽智能体异常/超时→重跑 1 次，再失败 escalate |
| QUALITY | escalate | 连续失败→升级根因分析/人工 |
| DELIVERING | pause | 内建阶段失败挂起（不自动 commit/push） |
| MM_SUBGRAPH | — | 子图异常处理主权在 multiModel，不适用主图 on_fail 派发 |

### 3.2 默认值规则（config.yaml §on_fail）

| 节点类型 | 默认 on_fail | 说明 |
|----------|-------------|------|
| required 必配阶段 | escalate | 升级路径见 conductor.md 异常处理派发表 |
| 可选挂载视角 | degrade | 跳过该视角 + DEGRADED |
| executor 内建 | pause | 挂起 task_context，输出选项等人 |
| START/DONE/terminal | abort | 硬停，标 [STAGE_ABORT] |

### 3.3 取值语义

| 值 | 语义 |
|----|------|
| `abort` | 硬停，标 [STAGE_ABORT]，等用户决策 |
| `retry_once` | 同智能体重跑 1 次（新会话，清空前次上下文），再失败 escalate |
| `degrade` | 跳过该视角 + DEGRADED（仅可选视角节点） |
| `escalate` | 升级：T1→T2 加视角，T2→人工；QUALITY 连续失败→reviewer 根因分析 |
| `pause` | 挂起 task_context，输出选项等用户决策 |

### 3.4 挂载点级 on_fail（mount[].on_fail，与节点级互不干涉）

| 值 | 语义 |
|----|------|
| `abort` | 中止流转 |
| `warn` | 告警放行 |
| `skip` | 静默跳过 |
| `degrade` | 跳过 + 标 DEGRADED |

### 3.5 熔断阈值（config.yaml convergence + hooks）

| 阈值 | 值 | 说明 |
|------|-----|------|
| `mm_fusion_max_rounds` | 3 | **[已废弃]** 旧 multiModel 子图内部熔断轮次上限；T3 改用 worktree 副本竞赛 |
| `hooks.quality.max_total_cycles` | 4 | QUALITY 总轮次上限（4 轮修不好→escalate） |
| `hooks.quality.auto_fix` | true | 自动触发 fix hooks |

### 3.6 时间预算（config.yaml timeouts）

| 阈值 | 值 | 说明 |
|------|-----|------|
| `timeouts.agent_startup_s` | 90s | task 工具启动智能体等待上限 |
| `timeouts.stage_default_s` | 600s | 单阶段默认预算 |
| `timeouts.retry.agent_timeout_max_retries` | 1 | timeout 后最多重试次数 |

---

## 4. 验收映射表（本报告自验收）

| # | 验收标准 | 实现位置 | 验证方式 |
|---|---------|----------|----------|
| AC1 | 报告存在且含 9 节点映射表（含类型标注） | 本文件 §1 节点映射表 | 目视：9 行，每行含 id/type/阶段文件/executor/on_fail |
| AC2 | 流转条件矩阵覆盖全链 | 本文件 §2 流转条件矩阵 | 目视：E1-E16 覆盖 START→DONE 全路径，含 when 条件 |
| AC3 | on_fail 策略表含 5 种策略说明 | 本文件 §3 on_fail 策略表 | 目视：§3.1-3.6 含 abort/retry_once/degrade/escalate/pause 定义+节点映射+默认规则+熔断阈值+时间预算 |
| AC4 | 含验收映射表 | 本文件 §4 验收映射表 | 目视：4 行 AC1-AC4，每行含标准→位置→验证方式 |
| AC5 | 不修改 scripts/ lifecycle/ agent/ 文件与 kilo.json | 本任务未修改 forbidden 文件；kilo.json 预存变更为任务前已有，非本任务产物 | `git diff --stat` 确认无 forbidden 文件变更 |

---

## 5. 观测数据占位

> 本任务 dispatch 无 abort、无 overload_count 增长。
> 以下字段由 conductor 在 DELIVERING 阶段补填最终观测：

| 字段 | 占位值 | 补填时机 |
|------|--------|----------|
| `dispatch_abort_count` | 0 | DELIVERING |
| `overload_count` | 0 | DELIVERING |
| `task_context.execution.verification` | — | QUALITY verifier 写入 |
| `memory_write_status` | — | DELIVERING conductor 写入 |
