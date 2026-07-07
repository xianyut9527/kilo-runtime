# Hermes delegate_task 委派模板

> 从 Kilo agent/*.md 提取核心职责，适配 Hermes `delegate_task` 格式。
> 每个模板对应一个 `delegate_task` 调用的 goal + context + toolsets。
> Hermes 子代理：独立上下文 + 独立终端 + 迭代预算 50 + 深度限制 2 + 最多 3 并发。

## 通用委派包格式

```
delegate_task(
    goal="<角色目标>",
    context="<上下文锚定 + 关键文件 + 验收标准 + 已知失败>",
    toolsets=["terminal", "file"]  # 按角色选择
)
```

---

## engineer（实现者）

```
delegate_task(
    goal="实现以下验收标准对应的代码，完成读取→编码→测试→修复闭环。交付可运行的代码。",
    context="""
任务等级: <T0/T1/T2>
验收标准: <逐条列出，每条必须可验证>
关键文件: <允许修改的文件/模块>
约束: <禁止触碰的范围 + 项目风格 + 命名约定>
已知失败: <命令 + 关键片段，若有>
需求扩散包: <触发时必填：业务不变量 + 影响面 + 覆盖矩阵>
""",
    toolsets=["terminal", "file"]
)
```

**engineer 子代理必须输出**：
1. 变更摘要（文件/函数级别）
2. 验收映射表（验收标准 | 实现位置 | 验证方式 | 边界覆盖 | 状态）
3. 验证结果（命令 + 结论）
4. 遗留风险
5. 已读取文件清单（checker 将反向核对，虚假路径标记 [FAKE_CONTEXT] FAIL）
6. "等待 checker 验证"（不自验）

---

## checker（验证者）

```
delegate_task(
    goal="客观验证以下变更是否满足验收标准，输出 PASS/FAIL 结论。只验证不修复。",
    context="""
diff 或变更文件列表: <文件 + 行号>
预期修改范围: <声明边界>
验收标准: <逐条>
验证命令: <测试/构建/类型检查/Lint>
需求扩散包: <触发时必填>
流程日志: <7 节点表>
""",
    toolsets=["terminal", "file"]
)
```

**checker 子代理分层验证**：
- L1 语法/编译/格式：运行测试、构建、类型检查、Lint
- L2 逻辑/边界：逐条验收标准读取代码路径 + SCOPE_CREEP 反向核对 + 验收映射表存在性 + 已读取文件清单真实性
- L3 覆盖/安全（T2/T3）：需求扩散覆盖矩阵 + API/数据兼容性 + 安全检测

**FAIL 条件**：测试失败 / [MISSING] / [UNVERIFIED] / [PARTIAL_IMPLEMENTATION] / [MISSING_ACCEPTANCE_MAP] / [SCOPE_CREEP] / [FAKE_CONTEXT] / [PROCESS_VIOLATION] / 安全 GAP

---

## fixer（定向修复者）

```
delegate_task(
    goal="只修复 checker/reviewer 明确指出的阻塞问题。不做架构调整或范围外重构。",
    context="""
阻塞问题: <checker/reviewer 指出的具体问题 + 证据片段>
验证命令: <修复后需运行的验证>
反馈报告: <重试/升级时必填：根因层 + 修复点 + 同症状复发判断>
""",
    toolsets=["terminal", "file"]
)
```

**fixer 权限约束**：只修改 checker/reviewer 明确指出的问题；遇架构级问题上报父代理转回 engineer；连续 2 轮同症状 → 自动升级 reviewer。

---

## reviewer（审查者）

```
delegate_task(
    goal="总体验收审查，输出通过/有条件通过/不通过结论。只审查不修复。",
    context="""
diff: <最终 diff>
验收标准: <逐条>
需求扩散包: <触发时必填>
流程日志: <7 节点表>
checker 结论: <PASS/FAIL + 阻塞问题>
""",
    toolsets=["terminal", "file"]
)
```

**reviewer 三视角自检**：
- 安全：外部输入校验 / 认证授权 / 敏感信息 / 外部接口 / memory 敏感信息
- 架构：分层依赖 / 接口契约 / 跨模块同步 / 业务不变量落点 / 新抽象必要性
- 简化：重复实现 / 不必要抽象 / diff 噪声 / 修得过窄 / 更直接实现

---

## architect（规划者）

```
delegate_task(
    goal="只读代码和规则，输出任务 DAG + 单元划分。不写代码不改文件。",
    context="""
需求: <用户原始需求>
约束: <技术约束 + 业务约束>
关键文件: <相关文件列表>
已知冲突: <模块间依赖冲突，若有>
""",
    toolsets=["file"]
)
```

**architect 输出**：任务 DAG（单元 ID / 目标 / 验收标准 / 关键文件 / 依赖单元 / 冲突资源 / 验证方式 / 完成定义）+ 并行规则（无冲突单元可并行）。

---

## pre-checker（方向预审）

```
delegate_task(
    goal="快速验证需求理解无偏差、单元边界无遗漏、验收标准可验证。只输出 PASS/FAIL。",
    context="""
单元 DAG: <architect 产出>
验收标准: <逐条>
需求扩散包: <触发时必填>
""",
    toolsets=["file"]
)
```

**pre-checker 检查清单**：
1. 每个单元的验收标准是否有明确代码路径和验证方式
2. 单元间依赖和冲突是否在 DAG 中正确声明
3. 需求扩散覆盖矩阵是否有遗漏入口
4. 是否存在"只在某一层改、但规则可能在其他层也有实现"的盲区

---

## ensemble（多模型并行）

Hermes 原生支持最多 3 并发 `delegate_task`，对应 Kilo ensemble：

```
delegate_task(tasks=[
    {"goal": "<executor-A 目标>", "context": "<完整委派包>", "toolsets": ["terminal", "file"]},
    {"goal": "<executor-B 目标>", "context": "<完整委派包>", "toolsets": ["terminal", "file"]},
    {"goal": "<executor-C 对抗审查目标>", "context": "<完整委派包>", "toolsets": ["terminal", "file"]}
])
```

候选评估优先级：验证完成度 → 需求覆盖 → 同类点覆盖 → 阻塞风险 → 聚焦度 → 复杂度。候选互补且冲突可控时调用 synthesizer 合并；否则选最接近通过的候选进入门禁。