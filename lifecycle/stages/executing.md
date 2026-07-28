---
description: 生命周期阶段 EXECUTING — 实现。读取→编码→测试→修复，交付可运行代码。
model_capability: code-generation
token_budget: 16000        # 按单元拆分，每单元 ≤ 16000
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
required_roles: [coder]
---

# lifecycle/stages/executing

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`；智能体经 frontmatter `mount` 自注册挂载。

## 输入

- `PLANNING` 输出的任务 DAG（T1/T2）或用户请求（T0）
- 设计门方案（T1/T2）
- **T3 回流场景**：`plan`（聚合方案等价物）+ `execution.fused_output`（聚合产物指针：fusion worktree 路径/分支/commit_sha），由 multiModel 子图 MM_ARCHIVED 后回流；coder 执行 `git merge mm-<tid>-fusion` 分支将聚合代码产物应用到主工作区，不读取 `execution.mm_outputs`/`mm_artifacts`（子图原始 3 份产物）
- 验收标准清单
- 已知失败模式（来自 `fact_store` / `failure_db`，M1 注入）
- 禁止触碰的边界声明（`forbidden_files`）

## 处理流程

1. **重述验收标准**：原标准 → 我的理解 → 实现位置/验证方式。
2. **编码前知识获取**：
   - T0：读取目标文件，简短搜索确认范围。
   - T1+：优先用 GitNexus 分析执行流、调用链和影响面；涉及 API 时用 `gitnexus_api_impact`。
   - 重复模式扫描：用 grep/glob 扫描本次改动模式在代码库的同类实现（UI 与非 UI 同等适用，不限于样式/布局/交互）；命中 ≥2 处必须走组件化/共享抽象方案。
3. **编码**：最小改动原则，遵循现有代码风格，修改后搜索调用方确认兼容性。
4. **自测自修**：改代码 → 跑测试 → 修复 → 再跑。TDD 模板：红→绿→重构。
5. **运行验证**：测试、构建、类型检查、Lint、编码扫描（`node scripts/scan-encoding.mjs`）。
6. **输出**：变更摘要、验收映射表、验证结果（含命令+exit code+关键输出片段）、遗留风险。

## 输出信号

```yaml
status_signal: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED"
transition_context:
  unit_id: "string"
  files_modified: ["string"]
  tests_run: ["string"]
quality_gate:
  acceptance_map_complete: true | false
  verification_fresh: true | false   # 是否本轮 fresh 证据
  encoding_clean: true | false       # scan-encoding.mjs 通过
  no_debug_leftovers: true | false
```

## 路由规则（边定义见 graph.yaml）

- `DONE` → T1+ 进入 `CHECKING`；T0 直达 `DELIVERING`
- `DONE_WITH_CONCERNS` → 附带风险说明进入 `CHECKING`
- `NEEDS_CONTEXT` / `BLOCKED` → 停止并回传，不推进
- **T3 回流**：`MM_SUBGRAPH → EXECUTING`（`subgraph_status == 'ready_for_delivery'`），coder 执行 `git merge mm-\u003ctid\u003e-fusion` 应用聚合代码产物到主工作区，然后走标准 `CHECKING ⇄ FIXING → REVIEWING ⇄ FIXING → DELIVERING`（验证 merge 后代码产物）

## 硬规则

- **完成声明三件套**：每条"通过/修复/完成"声明 MUST 同时附：完整命令字符串、数字 exit code、stdout/stderr 关键行截取 ≤5 行。
- **禁止信任传递**：不得以"agent X 报告成功"替代独立验证。
- **编码健康度扫描**：对修改过的文件跑 `node scripts/scan-encoding.mjs`。
- **架构意识（编码前必过）**：落点识别（目标文件所属层，不越层）→ 依赖方向（符合项目既有分层方向）→ 影响面分析（高扇入符号改动列影响清单）→ 复用优先（先扫描同类抽象再新建）→ 扩展点评估（高频变更领域留扩展点/slot/策略接口/配置驱动）→ 组件化前摄扫描（grep/glob 同类实现 ≥1 处命中需评估）。违反任一项 → 输出 `BLOCKED`/`NEEDS_CONTEXT`，由 conductor 判断是否回流 PLANNING 阶段。
- **T3 隔离原则**：主图 coder 不读取 `execution.mm_outputs`/`execution.mm_artifacts`（子图原始 3 份 coder 产物），只读取 `plan` + `execution.fused_output`（聚合产物指针：fusion worktree 路径/分支）；主操作为 `git merge mm-<tid>-fusion` 分支 + 解决残留冲突 + 运行验证
- **T3 产物级场景**：multiModel 子图 v2 产物级聚合模式下，主图 EXECUTING coder 主操作为 `git merge <fusion_branch>` + 解决冲突 + 运行验证；fusion worktree 由主图 DELIVERING 阶段清理（`git worktree remove --force`）
- **T3 产物级场景（merge 前预检）**：coder 执行 `git merge mm-<tid>-fusion` 前，可先执行 `git merge --no-commit --no-ff mm-<tid>-fusion` 预演，检查冲突；若冲突不可解决，立即 abort（`git merge --abort`）并回传 `BLOCKED`。这是 multiModel 子图 MM_FCHECK「预 merge 验证」安全增强的主图落地动作。
- **worktree 注册表失效**：fusion worktree 由主图 DELIVERING 清理后，`execution.mm_worktrees` 注册表状态不再更新（子图已退出，注册表失效）。
