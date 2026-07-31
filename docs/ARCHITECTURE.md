# kilocode 生命周期架构 v2.1（综合导航）

> **定位**：架构设计门落地产物 + 日常运维速查手册。本文档在 `multi-agent-lifecycle-architecture.md`（设计历史）与 `configuration-guide.md`（操作手册）之间，提供**架构全景 + 速查入口**。   
> **更新日期**：2026-07-29   
> **版本**：v2.1（响应式 Hooks + after 相对依赖）   

---

## 1. 架构全景（一句话）

> 6 个语义阶段的主图 DAG + T3 multiModel 子图。智能体通过 `agent/<name>.md` frontmatter `mount` 自注册挂载，新增/替换/排序 = 丢/改一个文件，**零改 `graph.yaml`/`config.yaml`**。

### 1.1 主图 6 Stage（生命周期主干）

```
START
  │
  ▼
INTENT（conductor 内建）→ 区分 INQUIRY / EXECUTION
  │
  ▼
SIZING（conductor 内建）→ 定级 T0–T3，写入 config.agents
  │
  ├─ T0 ────────────────→ EXECUTING → DELIVERING → DONE
  ├─ T1 ──→ PLANNING ──→ EXECUTING → QUALITY → DELIVERING → DONE
  ├─ T2 ──→ PLANNING ──→ EXECUTING → QUALITY → DELIVERING → DONE
  └─ T3 ────────────────→ MM_SUBGRAPH → EXECUTING → QUALITY → DELIVERING → DONE
```

| 阶段 | 类型 | 执行者 | 必配角色 | 挂载点 | 说明 |
|------|------|--------|----------|--------|------|
| **INTENT** | stage | conductor | — | `pre:INTENT` / `INTENT` / `post:INTENT` | 意图判定 |
| **SIZING** | stage | conductor | — | `pre:SIZING` / `SIZING` / `post:SIZING` | 任务定级 |
| **PLANNING** | stage | — | `[planner]` | `pre:PLANNING` / `PLANNING` / `post:PLANNING` | 设计门 |
| **EXECUTING** | stage | — | `[coder]` | `pre:EXECUTING` / `EXECUTING` / `post:EXECUTING` | 编码实现 |
| **QUALITY** | stage | — | `[verifier, reviewer]` | `QUALITY hook:verify` / `hook:fix` / `hook:review` | 响应式 Hooks（合并原 CHECKING+REVIEWING+FIXING） |
| **DELIVERING** | stage | conductor | — | `pre:DELIVERING` / `DELIVERING` / `post:DELIVERING` | 交付 + 记忆写入 |
| **DONE** | terminal | — | — | `on:done` | 终态 |

> **挂载点命名空间**（派生，零声明）：节点存在即挂载点存在。`pre:<NODE>`（主槽前）/ `<NODE>`（主槽）/ `post:<NODE>`（主槽后、流转前）。QUALITY 内部额外派生 `hook:verify` / `hook:fix` / `hook:review`。子图节点（MM_*）同样派生三挂载点。

### 1.2 QUALITY 内部响应式 Hooks 循环

QUALITY 不是"一个阶段做三件事"，而是**一个响应式容器**，内部 hooks 按数据变化自动触发：

```
EXECUTING（coder 产出 execution.code）
  │
  ▼
QUALITY 容器内自动循环：
  │
  ├─ hook: verify（串行组：verifier + reverse-auditor? + 自定义智能体）
  │   │   deps: [execution.code, plan]
  │   │   无 after → 串行组（按 agent 文件名字典序逐个启动，避免并发 task 调度 abort）
  │   ▼
  │   任一 FAIL → hook: fix（fixer + 自定义 fixer，trigger: onFail）
  │   全 PASS   → hook: review（串行组：reviewer + side-checker? + 自定义智能体，trigger: afterPass）
  │
  ├─ hook: review（串行组）
  │   │   deps: [execution.code]
  │   ▼
  │   任一 FAIL → hook: fix（同一 fixer，trigger: onFail）
  │   全 PASS   → quality_verdict=PASS → DELIVERING
  │
  └─ 熔断：quality.round ≥ hooks.quality.max_total_cycles → CIRCUIT_BREAKER → DELIVERING（带降级标记）
```

### 1.3 T3 multiModel 子图

```
SIZING（定级 T3）
  │
  ▼
MM_SUBGRAPH（multiModel 主控接管）
  │
  ├─ MM_INIT → MM_EXECUTING（coder-a/b/c 并行，各自独立 worktree）
  ├─ MM_CHECKING（verifier 交叉验证）
  ├─ MM_FUSING（synthesizer-fusion 独立融合）
  ├─ MM_FCHECK（verifier 验证融合产物）
  └─ MM_ARCHIVED（写 subgraph_status=ready_for_delivery）
  │
  ▼
回流主图 EXECUTING（coder 按融合方案 git merge + 实现）
  │
  ▼
QUALITY hooks（标准 verify→fix→review→fix 循环）
```

---

## 2. 智能体清单（14 个职能智能体 + 2 个编排者）

> 模型统一在 `kilo.json` `agent.<name>.model` 配置（单源真相），能力倾向参考 `docs/model-registry.md`。
> 下表不硬编码模型，避免配置漂移。

| 智能体 | 挂载点 / hook | after | trigger | when | 职责 |
|--------|--------------|-------|---------|------|------|
| **conductor** | —（内建） | — | — | — | 编排者：意图判定→定级→挂载调度→流转裁判 |
| **multiModel** | —（lifecycle_provider） | — | — | — | T3 子图编排者 |
| **planner** | `PLANNING` | — | — | — | 设计门、DAG、验收点 |
| **coder** | `EXECUTING` | — | — | — | 编码实现、三件套 |
| **verifier** | `QUALITY hook:verify`, `MM_CHECKING`, `MM_FCHECK` | — | — | — | 正向验证（L1/L2/L3） |
| **reverse-auditor** | `QUALITY hook:verify` | — | — | `config.agents.reverse_auditor` | 反向审计（T2+） |
| **reviewer** | `QUALITY hook:review` | — | — | — | 代码审查（四视角） |
| **side-checker** | `QUALITY hook:review` | — | — | `config.agents.side_checker` | 侧向验证（T2+） |
| **fixer** | `QUALITY hook:fix` | — | `onFail` | — | 定向修复（auto-trigger） |
| **plan-reviewer** | `post:PLANNING` | — | — | — | 方案硬门审查 |
| **coder-a** | `MM_EXECUTING` | — | — | — | 逻辑推理派 |
| **coder-b** | `MM_EXECUTING` | — | — | — | 安全边界派 |
| **coder-c** | `MM_EXECUTING` | — | — | — | 代码生成派 |
| **synthesizer-fusion** | `MM_FUSING` | — | — | `config.agents.synthesizer_fusion` | 融合编辑（T3） |

---

## 3. 核心能力确认（三问三答）

### Q1：支持在任意阶段挂载智能体？

✅ **是**。挂载点从 `lifecycle/graph.yaml` 节点**自动派生**，零声明——节点存在即挂载点存在。

| 挂载点格式 | 触发时机 | 典型用途 |
|-----------|----------|---------|
| `on:bootstrap` | 装配完成后、INTENT 前（一次性） | 全局初始化钩子 |
| `pre:<NODE>` | 节点主槽执行**前** | 前置准备（需求澄清、上下文收集） |
| `<NODE>` | 节点主槽（阶段本体） | 阶段核心执行者（planner/coder） |
| `post:<NODE>` | 节点主槽执行**后**、edges 流转**前** | 后置审查（plan-reviewer）、风险检查 |
| `QUALITY hook:*` | QUALITY 内部响应式 Hooks | verify / fix / review |
| `MM_*` | multiModel 子图节点 | MM_EXECUTING / MM_CHECKING / MM_FUSING / MM_FCHECK |
| `on:done` | DELIVERING 完成后、DONE 前（一次性） | 收尾钩子 |

> 新增智能体 = 丢一个 `agent/<name>.md` + `kilo.json` 绑模型。graph.yaml / config.yaml / stages 全不动（除非引入新必配角色才需改该阶段 `required_roles`）。

### Q2：支持小单元完成任务？

✅ **是**。`planner` 产出 `unit_dag`，每个 unit 包含：
- `unit_id`、`goal`、`key_files`、`dependencies`、`acceptance_criteria`
- 每单元独立闭环：`coder` 实现 → `QUALITY` 验证 → `fixer` 修复 → 重新验证
- `forbidden_files` 边界声明防止越界

### Q3：支持交叉验证、循环确认直到高质量一次性完成？

✅ **是**。四视角交叉验证 + 自动循环 + 熔断：

| 视角 | 智能体 | 核心问题 | 输入隔离 |
|------|--------|----------|---------|
| 正向验证 | verifier | 产物是否满足验收标准？ | 不读 execution.verification |
| 反向审计 | reverse-auditor | 从产物反推是否遗漏需求？ | 不读 plan / verification.forward |
| 侧向验证 | side-checker | 边界/安全/性能/兼容性？ | 不读 verification.forward/reverse |
| 代码审查 | reviewer | 架构/简化/SCOPE_CREEP？ | 不读 verification.* |

**循环机制**：任一视角 FAIL → 自动触发 `hook: fix`（fixer）→ code 变化 → 自动重新触发 `hook: verify` → 全 PASS → `hook: review` → 全 PASS → `quality_verdict=PASS` → DELIVERING。

**信任传递防护**：
- `isolation.forbid_read` 物理隔离（各验证智能体不见其他视角结论）
- `execution.verification` 写入边界硬门（仅 verifier 可写）
- `quality.verdict` 仅 QUALITY hooks 框架自动管理（conductor 禁手工 set）
- `trust-transfer-check.mjs` 检测信任传递措辞 → `[TRUST_TRANSFER]`

**熔断**：
- `quality.round`（每次进入 QUALITY 时 +1）
- `quality.max_rounds = hooks.quality.max_total_cycles`（当前值 4）
- `quality.round ≥ 4` → `[CIRCUIT_BREAKER]` → PAUSED 等用户决策

---

## 4. 配置速查

### 4.1 新增一个智能体（2 步）

**步骤 1**：创建 `agent/my-agent.md`

```yaml
---
description: 一句话职责
mode: subagent
hidden: true
color: "#8B5CF6"
steps: 80
permission:
  bash: allow
  read: allow
  edit: deny
  task: deny
  glob: allow
  grep: allow
subagent_type: my-agent

mount:
  - at: QUALITY
    hook: verify               # 或 review / fix
    # 无 after = 与同 hook 类型其他 agent 串行（按 agent 文件名字典序逐个启动，避免并发 task 调度 abort）
    # after: [verifier]        # 如需串行，声明前驱
    # when: "config.agents.my_agent"  # 如需按 tier 开关
    on_fail: degrade           # 可选视角用 degrade，必配用默认

task_context:
  read: [plan, execution.diffs]
  write: [verification.my_report]
  forbid_write: [execution.verification]

isolation:
  forbid_read: [verification.forward, verification.reverse]
---
```

**步骤 2**：`kilo.json` 加模型绑定

```json
"my_agent": {
  "mode": "subagent",
  "model": "hx/kimi-k2.6",
  "prompt": "你是 my-agent..."
}
```

完成。运行 `node scripts/lifecycle-doctor.mjs` 验证。

### 4.2 调整执行顺序（相对依赖）

```yaml
# 同 hook 类型默认串行（省略 after，按 agent 文件名字典序逐个启动）
mount:
  - at: QUALITY
    hook: verify
    # 无 after → 与 verifier / reverse-auditor 串行（按 agent 文件名字典序逐个启动，避免并发 task 调度 abort）

# 需要相对顺序时声明 after（只引用前驱，零改其他文件）
mount:
  - at: QUALITY
    hook: verify
    after: [verifier]           # 等 verifier 完成后再执行
```

> v2 废弃 `order: 10/20/30/40` 绝对编号。QUALITY 内部顺序由 `hook` 类型内置定义：`verify → fix → review → fix`。同 hook 类型内用 `after` 声明前驱。

### 4.3 调整定级组合（tier_defaults）

```yaml
# lifecycle/config.yaml
tier_defaults:
  T1:
    agents:
      my_agent: true        # ← 加这一行
    review_mode: full
```

### 4.4 改熔断阈值

```yaml
# lifecycle/config.yaml（唯一真相）
hooks:
  quality:
    max_total_cycles: 4       # QUALITY 总轮次上限（唯一熔断阈值，4 轮修不好=方案/需求有问题）
    auto_fix: true
```

### 4.5 改模型绑定

```json
// kilo.json（唯一模型绑定来源）
"verifier": {
  "model": "hx/kimi-k2.7-code"    // ← 改这里
}
```

---

## 5. 文件索引（速查）

### 架构核心（**先看这些**）

| 文件 | 职责 | 变更频率 |
|------|------|---------|
| `lifecycle/graph.yaml` | 主 DAG 纯拓扑（节点 + 边 + when/gate） | **永不改**（新增阶段除外） |
| `lifecycle/stages/quality.md` | v2 响应式 Hooks 核心定义（hook/after/trigger） | 低 |
| `lifecycle/stages/README.md` | 阶段索引 + 扩展指南（新增智能体/阶段速查） | 低 |
| `lifecycle/config.yaml` | 定级组合 + 熔断阈值 + 超时 | 中（改 tier/阈值时） |
| `kilo.json` | 模型绑定 + compaction + MCP + provider | 低 |
| `agent/conductor.md` | 编排者铁律 + 挂载规则 + 异常处理派发表 | 低 |

### 智能体行为（按需读取）

| 文件 | 职责 |
|------|------|
| `agent/planner.md` | 设计门、DAG、验收点 |
| `agent/coder.md` | 编码实现、三件套 |
| `agent/verifier.md` | 正向验证（L1/L2/L3） |
| `agent/reverse-auditor.md` | 反向审计（T2+） |
| `agent/reviewer.md` | 代码审查（四视角） |
| `agent/side-checker.md` | 侧向验证（T2+） |
| `agent/fixer.md` | 定向修复（auto-trigger） |
| `agent/plan-reviewer.md` | 方案硬门审查（post:PLANNING） |
| `agent/multiModel.md` | T3 子图编排者 |
| `agent/synthesizer-fusion.md` | 融合编辑（MM_FUSING） |

### 校验与调试

| 文件 | 用途 |
|------|------|
| `scripts/lifecycle-doctor.mjs` | 全量装配校验（56 项）：图/挂载/契约/配置/矩阵 |
| `scripts/e2e-smoke.mjs` | 流转回归测试（38 场景）：T0/T1/T2/T3/熔断/gate |
| `scripts/task-context.mjs` | task_context 读写 + 权限硬门 |
| `scripts/transition-check.mjs` | 状态流转裁判 + 熔断判定 |

### 参考文档

| 文件 | 职责 |
|------|------|
| `docs/configuration-guide.md` | 操作手册：新增智能体/阶段/模型/定级调整 |
| `docs/multi-agent-lifecycle-architecture.md` | 设计历史：v1→v2 迁移、架构决策记录 |
| `docs/agent-mount-guide.md` | 挂载指南：frontmatter 字段详解、示例、FAQ |
| `docs/model-registry.md` | 模型能力倾向矩阵（人工维护，无机械校验） |
| `docs/memory-ops-reference.md` | 记忆操作 SQL 模板 |
| `CONFIG_CHANGE_CHECKLIST.md` | 配置变更一致性检查清单 |

---

## 6. 验证命令

```powershell
# 全量装配校验（56 项）
node scripts/lifecycle-doctor.mjs --verbose

# 流转回归测试（38 场景）
node scripts/e2e-smoke.mjs

# 记忆层健康度
python scripts/memory.py check

# 视角物理隔离校验（T2+）
node scripts/trust-transfer-check.mjs <task_id> [--round N]
```

---

## 7. 设计原则速记

1. **文件制自动注册**：丢一个 `agent/<name>.md` = 自动注册，类似 Next.js 文件路由
2. **语义 ID**：`INTENT/SIZING/PLANNING/EXECUTING/QUALITY/DELIVERING`，禁数字前缀
3. **零改框架扩展**：新增智能体只需 2 步（agent .md + kilo.json 绑模型），graph.yaml/config.yaml/stages 全不动
4. **单一真相**：模型绑定 → kilo.json；定级组合 → config.yaml；图结构 → graph.yaml；智能体行为 → agent/*.md
5. **视角物理隔离**：`isolation.forbid_read` 防止确认偏误，各验证智能体不见其他视角结论
6. **写入边界硬门**：`execution.verification` 仅 verifier 可写，`quality.round` 仅框架自动管理
7. **机械汇总**：conductor 组合判定只读各视角 `verdict` 做 AND 运算，不做主观判定
8. **永不投票制**：每个视角都是硬门，任一 FAIL 必须修复

---

> **历史迁移**：v1 的 CHECKING/REVIEWING/FIXING 已合并为 QUALITY（响应式 Hooks）；`order: 10/20/30/40` 已废弃为 `hook` 类型 + `after` 相对依赖。旧配置在 `archive/` 目录保留为 `.md.v1`。   
> **稳定大框架**：`graph.yaml` 不出现任何智能体名/角色名，智能体增减永不改本文件。
