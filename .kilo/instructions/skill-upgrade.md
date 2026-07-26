---
name: skill-upgrade
description: Skill 升级提案生成（指针文件）。完整逻辑已迁移到 .kilo/memory/policy/skill_upgrade.md
keywords: skill-upgrade, fact_store, pointer
---

# Skill Upgrade（指针文件）

> **本文档已迁移**：完整升级流程、条件 A/B/C、SKILL.md 生成模板、回归测试已全部迁移到 `.kilo/memory/policy/skill_upgrade.md`。
>
> 本文件保留作为兼容性指针，新代码请直接引用 `.kilo/memory/policy/skill_upgrade.md`。

---

**模块入口**：`.kilo/memory/README.md`（公共 API 文档）
**策略入口**：`.kilo/memory/policy/skill_upgrade.md`（完整内容）
**关联策略**：`.kilo/memory/policy/fact_dedup.md`（fact_store 写入 → 升级检测的输入）