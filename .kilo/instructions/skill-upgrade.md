---
name: skill-upgrade
description: Skill 升级提案生成（指针文件）。完整逻辑由 workflow-core.md §收尾自检 + docs/memory-ops-reference.md 承载
keywords: skill-upgrade, fact_store, pointer
---

# Skill Upgrade（指针文件）

> **本文档已迁移**：完整升级流程、条件 A/B/C、SKILL.md 生成模板、回归测试由 `docs/memory-ops-reference.md` §M8 Skill 升级检测承载。
>
> 本文件保留作为兼容性指针，新代码请直接引用 `docs/memory-ops-reference.md` §M8 与 `.kilo/instructions/workflow-core.md` §收尾自检。

---

**模块入口**：`.kilo/memory/README.md`（公共 API 文档）
**SQL 模板入口**：`docs/memory-ops-reference.md` §M8
**业务规则入口**：`.kilo/instructions/workflow-core.md` §收尾自检（Skill 升级检测项）