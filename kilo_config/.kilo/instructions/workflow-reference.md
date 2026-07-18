---
name: workflow-reference
description: 工作流参考内容 — small_model 触发规则、程序化记忆、需求扩散与同类点扫描（按需读取，不自动注入）
keywords: workflow, reference, small_model, 程序化记忆, 需求扩散
---

# Workflow Reference

> 本文件是 workflow-core.md 的配套参考，按需读取，不自动注入。
> 与 memory 相关的路径统一以 `~/.config/kilo-data/memory.db` 为准（数据目录独立于配置目录，install 同步不会清除）。

## small_model 触发规则

`small_model` 是可选降级路由入口，仅在以下条件**全部满足**时使用：

1. 任务为 1-2 文件的纯表面修改（文案/格式/命名/注释）
2. 无逻辑变更、无跨模块依赖
3. 不需要推理链（搜索、读取确认、机械替换）
4. 不属于安全敏感模块

任一不满足 → 使用 `agent.model` 或更强模型。禁止把 checker/fixer/reviewer 等质量门禁角色路由到 small_model。

## 程序化记忆

记忆系统采用 **全局 sqlite 优先 + 项目 md 兜底** 架构，总开关为 `.kilo/memory/` 目录存在性（含 memory-strategy.md），kilo.json 不再设 memory 字段。

- **schema**：仓库 `.kilo/memory/init.sql`（5 表：fact_store / failure_db / dispatch_log / project_context / model_calibration）
- **初始化**：`~/.config/kilo-data/memory.db` 不存在时，用 sqlite 执行 init.sql 建表
- **查询/写入规则**：见 `.kilo/memory/memory-strategy.md`（任务开始注入 ≤2000 tokens、失败回溯必查、T1+ 结束强制写 dispatch_log）
- **Skill 固化**：fact_store.confidence ≥ 0.8 且 hit_count ≥ 3 → 按 `skill-upgrade.md` 生成升级提案

## 需求扩散与同类点扫描

修改公共规则/公共组件/共享配置时，必须执行同类点扫描，禁止局部补丁。**带失败标记的完整 SOP 与质量门禁已集中在 `workflow-core.md`**：

- **重复模式修复 / 组件化 SOP（UI/前端/跨页行为）**：详见 `workflow-core.md`「重复模式修复 / 组件化 SOP」。
- **规范统一 / 审计类任务 SOP**：详见 `workflow-core.md`「规范统一 / 审计类任务 SOP」。

此处仅保留最小速查：

1. **识别扩散面**：列出该规则的所有消费方（import/引用/复制实现）。
2. **全量命中清单**：用 grep/glob 产出完整清单（文件数+行数），作为验收基准。
3. **同步修改**：所有同类点必须同批修改，禁止"先改一个看看"。
4. **反向验证**：交付前反向 grep 确认旧模式命中数=0；涉及 UI/样式/行为时同步确认未触发 `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`。
