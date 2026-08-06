# 智能体生命周期挂载指南（历史档案 v1）

> **历史档案**：本文档为 `docs/agent-mount-guide.md` 的历史版本中提取的过时/历史内容。
> **当前指南请参考** `docs/agent-mount-guide.md`（v6 文件路由制，frontmatter `mount` 单源声明）。
> **保留原因**：v6 wire-up 修复记录、v2 `order` 废弃说明、v1 实际仓库案例快照等历史参考。

---

## 附录 A：v1 实际仓库案例（历史快照）

> **指针**：当前仓库真实挂载清单由 `node scripts/lifecycle-doctor.mjs --verbose` 实时输出（单源）；本表为历史快照参考。

当前仓库 6 个智能体的挂载分布（v1 历史快照）：

| 智能体 | 挂载点 | 类型 | `when` | `on_fail` | 说明 |
|--------|--------|------|--------|-----------|------|
| `planner` | `PLANNING` | 主槽 | 无 | 默认 | 设计方案 |
| `coder` | `EXECUTING` | 主槽 | 无 | 默认 | 标准编码 |
| `reviewer` | `QUALITY hook:review` | 主图hook | 无 | 默认 | 代码审查 |
| `fixer` | `QUALITY hook:fix` | 主图hook | 无 | 默认 | 定向修复（auto-trigger） |
| `conductor` | — | primary | — | — | 主图编排者（不经 mount） |

> **迁移说明**：v6 wire-up 修复后，智能体清单与挂载点已重新声明。当前以 `lifecycle-doctor.mjs` 实时输出为准。

---

## 附录 B：v6 wire-up 修复记录

> **v6 wire-up 修复**：`INIT` 的 executor 为 `conductor`（内建），主槽由 conductor 占据。`DELIVERING` 与 `INIT` 同为 conductor 内建阶段（`executor: conductor`，无 mount agent）；v6 wire-up 修复后回归内建模式。`pre:`/`post:` 钩子仍可挂载。

修复要点：
- INIT + DELIVERING 阶段声明 `executor: conductor`，主挂载点由内建逻辑占据
- 不经 `task` 启动（内建阶段直接由 conductor 主体处理）
- `pre:` / `post:` 钩子仍可挂载到这两阶段前后

---

## 附录 C：v2 响应式 Hooks 演进

> **v2 响应式 hook**：QUALITY 阶段引入 `hook: verify | fix | review` 字段，实现响应式挂载（deps 变化自动触发）。

迁移要点：
- `hook: verify` — 正向验证（verifier）
- `hook: fix` — 修复（fixer，trigger: onFail 自动触发）
- `hook: review` — 审查（reviewer，trigger: afterPass 保留串行场景）

QUALITY 内部循环：`verify → fix → verify` 自动循环：检查 FAIL 自动触发 fix，修复后代码变化再触发 verify，直到全部 PASS 才流转 DELIVERING。

---

## 附录 D：v2 废弃说明

> **v2 废弃 `order: <数字>` 绝对编号系统**。QUALITY 内部顺序由 `hook` 类型内置定义（`verify → fix → review → fix`），同 hook 类型内默认并行（无 after 依赖时单条消息并行发起），需要相对顺序时用 `after` 声明前驱（有 after 按拓扑串行）。仅 `graph.yaml` 声明 `parallel: true` 的节点保留并行语义。

废弃原因：
- 绝对编号 `order: <数字>` 跨文件维护成本高，新增智能体时需重新洗牌
- 相对依赖 `after: [agent-name]` 声明更直观，零改其他文件
- `hook` 类型内置执行顺序，无需额外声明
