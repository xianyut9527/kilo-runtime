---
name: output-schema
description: 统一交付输出规范 — 最小公共字段与标记语言
keywords: output-schema, deliverable, marker, verdict
---

# Output Schema

## 最小公共字段

所有 agent 交付输出必须包含：

| 字段 | 含义 | 位置 | 取值 |
|------|------|------|------|
| **结论** | 任务最终状态 | 交付文本最前部 | `PASS` / `FAIL` / `有条件通过` / `未完成` / `通过` / `不通过` |
| **阻塞问题** | 未解决的 blocker 列表 | 结论之后 | `[严重/警告] [文件:位置] [问题] → [建议] \| 证据:[片段]` |
| **证据片段** | 命令输出、代码路径、测试结果 | 紧跟所属字段 | `\| 证据:` 前缀，≤200 字符 |
| **覆盖矩阵** | 验收标准映射表 | engineer 强制 | `验收标准 \| 实现位置 \| 验证方式 \| 边界覆盖 \| 状态` |

## 各 agent 最小骨架

### engineer
```
## 需求理解
## 变更摘要
## 验收映射表（强制）
## 验证
## 遗留风险
## 前提条件（必填）
等待 checker 验证
```

### checker
```
## 验证结论
## 动态验证
## 覆盖检查
## 阻塞问题
```

### reviewer
```
## 审查结论
## 专审视角
- 安全: [通过/有问题/未涉及]
- 架构: [通过/有问题/未涉及]
- 简化: [通过/有问题/未涉及]
## 问题清单
```

### fixer
```
## 修复策略
## 修复结果
## 根因回传（强制）
```

## 标记语言

| 标记 | 含义 | 使用 agent |
|------|------|-----------|
| `[PASS]` / `[FAIL]` | 验证通过/失败 | checker |
| `[通过]` / `[有条件通过]` / `[不通过]` | 审查结论 | reviewer |
| `[MISSING_ACCEPTANCE_MAP]` | 验收映射表缺失 | checker |
| `[FAKE_CONTEXT]` | 已读取文件清单虚假 | checker |
| `[SCOPE_CREEP]` | diff 中超范围改动 | checker |
| `[PROCESS_VIOLATION]` | 流程跳步 | 任意 |
| `[CHECKPOINT_MISSED]` | 编码前检查点未执行 | 任意 |
| `[CIRCUIT_BREAKER]` | 连续 3 次无法收敛 | 任意 |
| `[SECURITY_GAP_*]` | 安全检测项未通过 | checker |
| `[PERF_GAP_*]` | 性能检测项未通过 | checker |
| `[MISSING_STATUS_SIGNAL]` | engineer/executor 未输出状态信号 | checker |
| `[NEEDS_REVIEW]` | fixer 连续 2 轮同症状，需升级 reviewer | fixer |
| `[PLAN_DEVIATION]` | 执行中计划偏差 | architect/coderAgent |
| `[DESIGN_GATE_PASS]` / `[DESIGN_GATE_MISS]` | 设计门通过/未过 | architect/coderAgent |
| `[BLOCKED]` | engineer/executor 遇阻塞需升级 | engineer/executor |
| `[NEEDS_CONTEXT]` | engineer/executor 缺少上下文 | engineer/executor |
| `[DONE_WITH_CONCERNS]` | 完成功能但有遗留风险 | engineer/executor |

**写法规则**：全大写，下划线分隔；就近引用；路径格式 `文件:行号`；空值显式写 `无`。
