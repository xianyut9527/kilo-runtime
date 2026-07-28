---
description: 生命周期阶段 REVIEWING — 审查。侧向验证（条件加载）+ 四视角审查，多视角交叉，不直接修复。
model_capability: deep-reasoning
token_budget: 10000        # × 智能体数
# required_roles：本阶段主槽必配角色契约（阶段语义内聚，单一真相）
required_roles: [reviewer]
---

# lifecycle/stages/reviewing

> 通用规则由运行时注入的 `core.md` 和 `workflow-core.md` 提供。流转关系见 `lifecycle/graph.yaml`（纯拓扑）；必配角色契约见本文件 frontmatter `required_roles`。智能体经 frontmatter `mount` 自注册挂载。本阶段主槽必配角色：审查（`required_roles: [reviewer]` 角色）；可选视角（侧向验证）由 `config.agents` 开关条件挂载。

## 输入

> **视角物理隔离**：侧向验证视角只读 `plan + execution.diffs/changes/acceptance_map + project_context`，**禁止读 `verification.forward/reverse`**。审查角色只读 `execution.diffs + plan + acceptance_criteria + project_context`，**禁止读 `verification.forward/reverse` 的报告结论**。各视角独立形成判断，不从众。

- 完整 diff
- 设计门方案（T1+）
- 验收标准清单
- project_context（tech_stack / security_keywords）
- **不注入**正向验证/反向审计的 PASS 结论或报告

## 交叉验证（侧向验证 + 审查，条件并行）

### 侧向验证（条件加载）
运行时行为视角验证。详见 `agent/side-checker.md`（履行侧向验证角色的智能体，默认 T2 加载）。

### 四视角审查（必配角色，T1+ 统一 full）

#### 安全视角（静态：安全编码模式是否落实）
- 输入校验代码**是否存在**：表单、请求体、URL 参数、文件上传、Header 是否有逐字段校验并净化的代码（不验证校验是否真的能挡攻击，那是侧向验证角色的职责）
- 认证/授权代码**是否存在**：路由/方法前是否有鉴权检查代码
- 敏感信息**硬编码**：代码中是否硬编码密钥、Token、密码、PII
- 外部接口**防御性代码是否存在**：超时、降级、重试策略代码是否存在；是否有 SSRF 限制代码

#### 架构视角
- 分层与依赖方向：是否破坏既有分层；依赖是否单向；有无循环依赖
- 接口契约一致性：输入/输出/异常/兼容性是否与所有调用方一致
- 跨模块同步影响：是否同步影响所有消费者
- 业务不变量落点：是否落在共享规则/单一事实来源
- 新抽象必要性：是否与已有能力重复；是否预埋未来功能

#### 简化视角
- 重复实现 / 局部补丁：同类实现模式 ≥2 处却逐处复制粘贴 → `[LOCAL_PATCH]` / `[COPY_PASTE_FIX]`（UI 与非 UI 同等适用）
- 扫描与防复发缺失：未产出全量同类点扫描清单 → `[MISSING_SCAN]`
- 不必要抽象/依赖/配置
- diff 噪声：格式化噪声、无关改名、调试代码残留
- 修得过窄：跨模块规则只改一个入口，漏掉同类点

#### SCOPE_CREEP 视角
- 反向核对 diff 范围与设计门 DAG 一致性：diff 中每个改动是否都能映射到 DAG 中某个 unit
- **职责边界**：本视角仅做"diff ↔ 设计门 DAG 一致性"核对。diff 范围是否超出验收标准由正向验证角色 L2 负责；语义范围是否超出用户需求由反向审计角色负责。本视角不重复这两个判定。

## 两阶段审查（T1+）

**第一阶段：spec 合规审查**
- 实现是否匹配需求/验收标准？
- 有无遗漏的功能点或边界？
- 需求扩散每条是否有结论？

**第二阶段：代码质量审查**
- 安全视角是否逐条完成？
- 架构视角是否发现分层/依赖/契约问题？
- 简化视角是否发现重复/不必要抽象？

> 第一阶段阻塞问题未解决前，不进入第二阶段。

## 反馈分级

- **Critical**：必须立即修复（安全编码模式严重缺失、数据丢失、功能完全损坏、编译/测试失败）
- **Important**：必须在合并/交付前修复（架构违背、回归风险、安全编码模式缺失）
- **Minor**：记录备忘（命名风格、注释、格式、非阻塞优化）

## 输出信号

```yaml
status_signal: "PASS" | "CONDITIONAL_PASS" | "FAIL"
transition_context:
  unit_id: "string"
  review_mode: "full"
quality_gate:
  side_result: "PASS" | "FAIL" | "N/A"  # 侧向验证角色（条件加载，未加载时 N/A）
  review_result: "PASS" | "CONDITIONAL_PASS" | "FAIL"  # 审查角色
  verdict: "通过" | "有条件通过" | "不通过"
  risk: "LOW" | "MEDIUM" | "HIGH"
  critical_count: int
  important_count: int
  minor_count: int
```

## 路由规则（边定义见 graph.yaml）

- `PASS` / `CONDITIONAL_PASS`（侧向+审查全 PASS，无 Critical）→ `DELIVERING`
- `FAIL`（任一视角含 Critical/Important）→ `FIXING`
- T1 路径：侧向验证角色不加载，`side_result` 字段输出 `N/A`，仅审查角色四视角审查决定 PASS/FAIL
- T2/T3 路径：侧向验证角色 + 审查角色并行，两者全 PASS 才进入 `DELIVERING`
- 连续 2 轮同症状修复失败 → 升级人工决策
