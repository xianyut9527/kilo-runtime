---
name: workflow-reference
description: 工作流参考内容 — small_model 触发规则、需求扩散与同类点扫描（按需读取，不自动注入）
keywords: workflow, reference, small_model, 需求扩散
---

# Workflow Reference

> 本文件是 workflow-core.md 的配套参考，按需读取，不自动注入。

## small_model 触发规则

`small_model` 是可选降级路由入口，仅在以下条件**全部满足**时使用：

1. 任务为 1-2 文件的纯表面修改（文案/格式/命名/注释）
2. 无逻辑变更、无跨模块依赖
3. 不需要推理链（搜索、读取确认、机械替换）
4. 不属于安全敏感模块

任一不满足 → 使用 `agent.model` 或更强模型。禁止把 verifier/fixer/reviewer 等质量门禁角色路由到 small_model。

## 需求扩散与同类点扫描

修改公共规则/公共组件/共享配置时，必须执行同类点扫描，禁止局部补丁。**带失败标记的完整 SOP 与质量门禁已集中在 `workflow-core.md`**：

- **重复模式修复 / 组件化 SOP（UI 与非 UI 通用）**：详见 `workflow-core.md`「重复模式修复 / 组件化 SOP」。
- **规范统一 / 审计类任务 SOP**：详见 `workflow-core.md`「规范统一 / 审计类任务 SOP」。

此处仅保留最小速查：

1. **识别扩散面**：列出该规则的所有消费方（import/引用/复制实现）。
2. **全量命中清单**：用 grep/glob 产出完整清单（文件数+行数），作为验收基准。
3. **同步修改**：所有同类点必须同批修改，禁止"先改一个看看"。
4. **反向验证**：交付前反向 grep 确认旧模式命中数=0；同步确认未触发 `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]` / `[MISSING_SCAN]` / `[MISSING_PREVENTION]`（UI 与非 UI 同等适用）。
