# 实现单元 DAG + 审核检查清单（历史档案）

> 本文件为 `docs/multi-agent-lifecycle-architecture.md` 的历史实现单元 DAG 与审核检查清单，迁移至 `docs/archive/`。
> 这些单元已在 v2 落地后归档，不再维护；新增任务请参考 `docs/ARCHITECTURE.md` 当前架构。

---

## 实现单元 DAG（供后续 engineer 执行）

| 单元 | 内容 | 依赖 | 验收标准 |
|------|------|------|----------|
| U1 | kilo.json 更新：coderAgent → conductor | 无 | kilo.json 合法 + validator PASS |
| U2 | agent/ 新建 8 个智能体 .md 文件 | U1 | 8 文件存在 + frontmatter 合规 |
| U3 | agent/coderAgent.md 重命名为 conductor.md + 内容更新 | U2 | 引用一致 |
| U4 | agent/capabilities/ 合并到智能体文件 + 删除目录 | U2,U3 | capabilities/ 不存在 + validator PASS |
| U5 | agent/lifecycle/*.md frontmatter 加 agents 字段 + 内容更新 | U2,U4 | 8 阶段文件 agents 字段完整 |
| U6 | agent/lifecycle/README.md 状态机图更新 | U5 | 状态图标注智能体 |
| U7 | agent/models/registry.md 更新为按智能体选择 | U2 | 模型矩阵更新 |
| U8 | AGENTS.md + README.md + CONFIG_CHANGE_CHECKLIST.md 更新 | U3,U5 | 索引一致 |
| U9 | workflow-core.md 术语映射注释更新 | U3,U5 | 角色名 → 智能体名 |
| U10 | `lifecycle-doctor.mjs` 新增 check23/24/25 | U2,U5 | 25/25 PASS |
| U12 | task_context 机制文档化（conductor.md 中定义读写规则） | U3 | conductor.md 含 task_context 章节 |

---

## 审核检查清单

- [ ] 智能体清单是否符合"规划/编码/检查等独立智能体"意图
- [ ] 交叉验证四视角是否覆盖"正向/反向/侧向/审查"
- [ ] task_context 共享机制是否满足"不重复从0开始"
- [ ] 可插拔机制是否满足"自定义决定加载哪些智能体"
- [ ] T0-T2 定级保留是否影响兼容性
- [ ] 文件迁移方案是否可接受（8 个 capabilities 删除 + 8 个 agent 新建）
- [ ] 降级策略是否足够

> **用户审核通过后，按 U1-U12 单元 DAG 依次委派 engineer 执行，每单元 verifier 验证 + reviewer 审查。**
