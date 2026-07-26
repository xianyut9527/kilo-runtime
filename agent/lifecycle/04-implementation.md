---
description: 生命周期阶段 04 — 实现。读取→编码→测试→修复，交付可运行代码。
stage_id: S07_EXECUTING
agents:
  - coder
previous_stage: S06_PLAN_APPROVED
next_stage: S09_CHECKING
---

# lifecycle/04-implementation

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。

## 阶段定义

| 字段 | 值 |
|------|-----|
| **阶段 ID** | `S07_EXECUTING` |
| **上一阶段** | `S06_PLAN_APPROVED`（设计门通过）或 `S03_SIZING`（T0 直达） |
| **下一阶段** | `S09_CHECKING`（T1+）或 `S16_DELIVERING`（T0 直达，跳过验证/审查） |
| **加载智能体** | `coder`（`agent/coder.md`，T0+ 加载） |
| **模型偏好** | `registry:code-generation`（编码专精） |
| **token 预算** | 按单元拆分，每单元 ≤ 16000 |

## 输入

- `S05` 输出的任务 DAG（T1+）或用户请求（T0）
- 设计门方案（T1+）
- 验收标准清单
- 已知失败模式（来自 `fact_store` / `failure_db`，M1 注入）
- 禁止触碰的边界声明（`forbidden_files`）

## 处理流程

1. **重述验收标准**：原标准 → 我的理解 → 实现位置/验证方式。
2. **编码前知识获取**：
   - T0：读取目标文件，简短搜索确认范围。
   - T1+：优先用 GitNexus 分析执行流、调用链和影响面；涉及 API 时用 `gitnexus_api_impact`。
   - 重复模式扫描：涉及 UI/样式/布局/交互时，用 grep/glob 扫描同类症状；命中 ≥2 处必须走组件化/共享抽象方案。
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

## 路由规则

- `DONE` → 进入 `S09_CHECKING`
- `DONE_WITH_CONCERNS` → 附带风险说明进入 `S09_CHECKING`
- `NEEDS_CONTEXT` / `BLOCKED` → 停止并回传，不推进

## 硬规则

- **完成声明三件套**：每条"通过/修复/完成"声明 MUST 同时附：完整命令字符串、数字 exit code、stdout/stderr 关键行截取 ≤5 行。
- **禁止信任传递**：不得以"agent X 报告成功"替代独立验证。
- **编码健康度扫描**：对修改过的文件跑 `node scripts/scan-encoding.mjs`。
- **组件化拦截**：涉及 UI/样式/行为且同类症状 ≥2 处时，必须按 `component-driven-fixes` skill 执行。
