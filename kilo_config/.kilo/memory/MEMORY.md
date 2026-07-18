---
name: memory
description: 项目级静态规则与归档索引兜底。存放用户偏好、安全约束、通用约定等低频变更内容，以及指向全局 sqlite 记忆的归档索引。经验沉淀的主目标仍是全局 sqlite（dispatch_log / fact_store / failure_db / model_calibration）。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "2.0"
  char_limit: 2200
  category: memory
---

# MEMORY.md（静态规则 / 归档索引兜底）

> 本文件是项目级静态规则与归档索引兜底，**不是**经验沉淀的主要载体。
> 经验沉淀的主目标：全局 sqlite（`${HOME}/.config/kilo-data/memory.db`）中的 `dispatch_log`、`fact_store`、`failure_db`、`model_calibration`。
> 本文件仅存放：用户偏好、安全约束、通用约定、指向 sqlite 或 `archive/` 的索引。
> 字符限制：**≤ 2200 字符**（约 500–700 tokens）。
> 加载机制：由 `.kilo/memory/AGENTS.md` 统一调度（v2.0 模块入口），按 **[tag]** 按需注入，未命中当前任务标签的条目不注入，文件保留，不报错。
>
> 兼容路径：`.kilo/memory/memory-strategy.md` 保留为指针文件，AGENTS.md 中 `strategy: "memory-strategy.md"` 仍可命中。

## 系统级约束 [tag:config]

> 触发条件：跨 2 次以上任务重复出现 / reviewer 确认为系统级 / 修复不收敛时
> 入选条目：M-001

### M-001: kilo_config 全局配置运行约束  [memory:fact_id=AP-001,AP-005]
- `kilo.json` / `*.yaml` / `*.csv` 修改后必须 `node -e "JSON.parse(...)"` 严格解析（无 BOM 容忍）
- 详细触发场景 / 推荐做法：`SELECT trigger, action FROM fact_store WHERE fact_id IN ('AP-001', 'AP-005');`
- Windows + PowerShell 5.1 默认 GBK 编码 → install.ps1 已永久化 UTF-8
- **v2.1 起**：本条目不再指向 `skills/anti-patterns/SKILL.md` 全文（避免 md 无限膨胀 + token 爆炸），改为指向 fact_id，agent 通过 sqlite MCP 按需查询

## 已验证静态规则

> 本节仅收录**不适合写入 sqlite 结构**的静态规则：用户偏好、安全约束、跨项目通用约定、指向 sqlite 具体记录的归档索引。
> 可复用的模式/反模式、失败案例、模型校准数据应直接进入全局 sqlite（`fact_store` / `failure_db` / `model_calibration`），不在本节重复沉淀。
> 单次发生的任务瑕疵、本次任务具体细节，不写入本节（归入本任务 commit message 或 SKILL 反思笔记）。
> 触发条件与写入权限见 `.kilo/instructions/workflow-reference.md`「程序化记忆触发条件」章节。

## 归档协议 [tag:general]

超过 2200 字符时，由 coderAgent 触发压缩：
- 将最旧的低频条目迁移到 `archive/YYYY-MM/` 子目录
- 在原位置保留 1 行索引（如 `[已归档] 详见 archive/2026-06/foo.md`）
- 总长度回到 ≤ 1800 字符后停止归档
