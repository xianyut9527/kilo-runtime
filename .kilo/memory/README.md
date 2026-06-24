# .kilo/memory 目录

> 本目录存放项目级程序化记忆，借鉴 Hermes Agent 的 MEMORY.md / USER.md 双轨设计。

## 文件说明

| 文件 | 用途 | 写入者 | 字符限制 | 加载时机 |
|------|------|--------|----------|----------|
| `MEMORY.md` | agent 笔记（系统级约束 + 已验证经验） | coderAgent / skills-writer | ≤ 2200 | 任务启动（意图判定后） |
| `USER.md` | 用户档案（偏好 + 约定） | 用户直接编辑 | ≤ 1375 | 同上 |

## 加载机制

coderAgent 在任务启动时（意图判定完成后）执行：

1. 检查 `.kilo/memory/` 目录是否存在
2. 若存在，将 `MEMORY.md` 和 `USER.md` 内容作为冻结快照注入当前会话上下文
3. 注入内容覆盖项目级优先级：MEMORY > USER > 全局 instructions

## 写入权限

- **MEMORY.md**：仅由 `coderAgent` / `skills-writer` 写入；所有条目必须经 `reviewer` 验证
- **USER.md**：仅由用户直接编辑；agent 不得自动写入
- 两者均不得包含敏感信息（见 `USER.md` 安全约束）

## 与 skills 的关系

| 写入目标 | 适用场景 | 决策依据 |
|----------|----------|----------|
| **MEMORY.md** | 跨会话高频复用、架构级约束、系统级安全模式 | "这条经验在多个项目都有用吗？" 是 → MEMORY |
| **SKILL.md** | 项目特定实现技能、模式、最佳实践 | "这条经验只对本项目有用吗？" 是 → SKILL |
| **不写** | 临时调试上下文、易于重新发现的事实 | 无复用价值 |

## 触发条件引用

详细触发条件见 `.kilo/instructions/workflow.md` 的「程序化记忆触发条件」章节。

## 归档与回退

- MEMORY.md 超 2200 字符：触发归档协议（见 MEMORY.md 末尾）
- 完全回退：删除整个 `.kilo/memory/` 目录，agent 退化为无记忆模式
