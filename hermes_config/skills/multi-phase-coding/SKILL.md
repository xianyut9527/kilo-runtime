---
name: multi-phase-coding
description: 多阶段编码工作流，在 Hermes 单 agent 架构下最大化编码质量。模拟 Kilo 级强制编排，利用 delegate_task 并行能力实现多方案 ensemble，超越单一路径编码。
keywords:
  - multi-phase
  - ensemble
  - coding
  - delegate_task
  - parallel-engineer
  - synthesis
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: coding
---

# 多阶段编码工作流

## 触发条件

用户任务包含以下动作之一，且 **非 T0 级**：
- 创建 / 修改 / 删除 / 重构 / 修复 / 实现 / 添加 / 优化

T0（≤2 行表面修改）跳过本 skill，直接执行。

## 阶段 1：分析（当前 agent）

1. **意图判定**：咨询类 → 只分析不改；执行类 → 继续
2. **T0-T3 定级**
3. **需求扩散检查**：命中"所有/任何/全部/同类/模块/互斥/唯一/全局/统一/联动/权限/角色" → 先形成扩散包
4. **输出 7 节点流程日志**（必须输出表格）

## 阶段 2：规划（T2+ 必做）

如 T2+ 或跨模块：
1. `delegate_task` architect 子代理，toolsets `["file"]`
2. architect 输出：技术方案 + 文件清单 + 依赖分析 + 风险点
3. 当前 agent 确认方案，必要时用户澄清

T1 及以下可跳过，由当前 agent 直接规划。

## 阶段 3：并行实现（核心）

**T1**：delegate_task 1 个 engineer，标准实现。

**T2+**：delegate_task **2-3 个 engineer 并行**，每个独立实现：

```
delegate_task(tasks=[
  {
    "goal": "方案A：保守实现，最小改动，优先兼容性",
    "context": "完整任务描述 + architect 方案 + 目标文件路径"
  },
  {
    "goal": "方案B：激进实现，重构关联代码，优先整洁度",
    "context": "完整任务描述 + architect 方案 + 目标文件路径"
  },
  {
    "goal": "方案C：中间路线，局部重构 + 向后兼容",
    "context": "完整任务描述 + architect 方案 + 目标文件路径"
  }
])
```

**关键**：每个 engineer **不知道**其他 engineer 存在，独立输出完整代码。

## 阶段 4：合成（当前 agent）

1. 对比 2-3 个 engineer 输出
2. 选择标准：
   - 最符合项目现有代码风格
   - 改动范围最小（防 SCOPE_CREEP）
   - 测试覆盖最完整
   - 无调试残留
3. 如方案冲突，选择**最简洁**的（KISS 原则）
4. 如全部有缺陷，标记 `[NEEDS_FIX]` 进入阶段 7

## 阶段 5：验证（自动化优先）

当前 agent 用 `execute_code` 批量跑：

```python
# 验证脚本模板
from hermes_tools import terminal, search_files

# 1. 语法检查
terminal("python -m py_compile <file>")

# 2. 类型检查（如有 mypy）
terminal("mypy <file>")

# 3. 测试
terminal("pytest -x <相关测试>")

# 4. 安全扫描
terminal("bandit -r <dir>")

# 5. 调用方确认
search_files(pattern="modified_symbol", target="content")

# 6. diff 范围
cd repo && git diff --
```

**T1 及以下**：跑到这里通过即可交付，不创建 checker 子代理。

## 阶段 6：审查（T2+）

delegate_task reviewer 子代理，明确要求：

```
请按 reviewer 三视角审查以下代码改动：

1. 安全视角：输入校验 / 鉴权 / 敏感信息泄露 / SQL 注入 / XSS
2. 架构视角：分层是否合理 / 接口契约 / 循环依赖 / 重复实现
3. 简化视角：是否有不必要的抽象 / debug 残留 / 过度设计

输出格式：
- 通过项：列表
- 不通过项：问题描述 + 严重级别 + 建议修复
- 总体结论：PASS / NEEDS_FIX / BLOCKER
```

## 阶段 7：修复（如需）

1. 根据阶段 5/6 结果修复
2. **最多 3 轮**
3. 连续 2 轮同症状 → 升级 reviewer，加入 architect 重新评估
4. 连续 3 轮无法收敛 → **Circuit Breaker**：停止修复，输出选项等用户决策

## 阶段 8：交付

必须包含：
1. ✅/⚠️/❌ 标记
2. **验收映射表**：每条标准 → 实现位置 → 验证证据 → 状态
3. **git diff -- 范围确认**
4. **多方案对比摘要**（仅 T2+）：为什么选方案 X 而非 Y/Z
5. **经验回写**：
   - 新坑 → `skill_manage` 到 anti-patterns
   - 最佳实践 → `skill_manage` 到 patterns
   - 流程改进 → `skill_manage` 到 workflow
   - 用户偏好 → `memory`

## 禁止事项

- ❌ 单 engineer 实现 T2+ 任务（必须并行 ensemble）
- ❌ 跳过验证直接交付
- ❌ 未附验收映射表
- ❌ 未清理调试代码
- ❌ 编造未验证的经验
