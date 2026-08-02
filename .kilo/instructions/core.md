---
name: core
description: 通用基线规则 — 核心理念、意图分类、安全约束、流程强制基线
keywords: core, 核心理念, 意图判定, 安全约束, 流程基线
---

# Core Runtime Rules

## 核心理念：编写智能体 = 对话式编程

- 每个智能体是可独立测试、迭代、强化的工程单元；质量提升靠工程化手段（生命周期 DAG、视角物理隔离、响应式 hooks 循环、独立验证、记忆自进化），不靠习惯说教。
- 新增或强化智能体 = 升级整个编码智能体的能力。

## 意图与边界

- **咨询类**：提问、了解、分析、比较、建议、排障、解释。只给结论，**禁止改文件**。
- **执行类**：明确要求创建、修改、删除、重构、修复、实现。
- 存疑时归为咨询，不动手。意图判定完成前不得调用修改性工具。

## 实施原则

- 最小必要改动；禁止整文件重写，用增量编辑。
- 删除文件/模块后必须全仓搜索残留引用并修正。

## 项目探测

- 陌生项目先看构建配置、入口目录、关键导出、测试/Lint 命令。
- 优先使用项目级 `AGENTS.md` 和 `.kilo/skills/`。

### Memory 探测

- 全局 SQLite 记忆：`~/.config/kilo-data/memory.db`，主通道 `python scripts/memory.py`。
- 入口：`.kilo/memory/README.md`（公共 API）、`docs/memory-ops-reference.md`（SQL 模板）。

## 验证与安全

- 修改后运行可用测试、构建、类型检查、Lint。
- 不暴露密钥、Token、密码或敏感配置。
- 注入防护等安全清单见 `security-checklist.md`。

## 流程强制基线

1. 禁止跳步；跳步即上报 `[PROCESS_VIOLATION]` 并升级。
2. 自验无效：不得以自身验证替代 verifier。
3. 交付必审：确认流程日志完整覆盖全生命周期。

## 资源与性能约束

- 外部 HTTP/文件处理/长计算必须有超时（如 30s）和降级/重试策略。
- 分页、上传大小/类型/数量上限、批量操作上限、查询 LIMIT 强制要求不合理高负载时拒绝。
- 临时文件写入系统临时目录（`/tmp/` / `$env:TEMP`），任务结束前清理；禁止写入项目根目录、`src/`、`lib/`、`dist/`。

## Context Engine 自动查询规则

| 场景 | 强制工具 |
|------|----------|
| 修改 ≥3 个文件 | `gitnexus_impact` |
| 修改 API/Router/Handler | `gitnexus_route_map` 或 `gitnexus_api_impact` |
| 使用陌生第三方库 | `context7_query-docs` |
| 修复失败/报错 | `kilo_local_recall` |

未执行 → `[MISSING_CONTEXT_QUERY]`。

## 编码前强制检查点（Kilo 独有）

1. 已确认任务等级（T0/T1/T2/T3）。
2. 已搜索现有实现和同类模式，确认可复用点。
3. 已按 Context Engine 规则调用必要工具。

未执行 → `[CHECKPOINT_MISSED]`，暂停编码。

## 压缩后结构化恢复

上下文压缩触发 `[RECOVERED_FROM_INSTRUCTIONS]` 时，输出恢复摘要（Goal/Progress/Key Decisions/Relevant Files/Next Steps），标注 `[PROCESS_VIOLATION]`（若存在跳步）。
