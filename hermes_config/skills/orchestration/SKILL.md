---
name: orchestration
description: 编码自律清单。T0-T3 定级简化 + 编码前/后自检 + 压缩恢复模板。无子代理委派。
keywords:
  - orchestration
  - T0-T3
  - self-checklist
  - recovery
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "3.0"
  category: orchestration
---

# 编码自律清单

> 单会话内自己完成，不假装有子代理。
> 所有"engineer/checker/reviewer"都是同一模型的不同自我要求。

## 一、T0-T3 定级（简化）

```
用户请求
  ├── 咨询类 → 只分析，不改文件
  └── 执行类 → 复杂度量化
       ├── T0: ≤2 行，无逻辑，单文件 → 直接编码
       ├── T1: 2-5 文件，单模块 → 编码 + 自检
       ├── T2: 跨模块 / 命中安全敏感词 → 编码 + 自检 + 三视角审查
       └── T3: 安全/权限/核心 → 编码 + 自检 + 三视角 + 用户确认
```

安全敏感词：user, account, auth, login, password, token, jwt, session, payment, checkout, wallet, balance, fund, transfer

## 二、T2+ Ensemble 触发

T2/T3 判定后，主代理不直接编码，触发 ensemble：

```
T2/T3 → execute_code 运行 skills/ensemble/scripts/ensemble.py
              ↓
        并行 engineer-A (kimi-k2.6) + engineer-B (MiniMax-M3)
              ↓
        checker (glm-5.2) 独立审查择优
              ↓
        主代理应用最优方案 → 四门门禁验证
```

T0/T1 跳过 ensemble，直接编码。

加载方式：任务前缀加 `ensemble:` 或在 T2/T3 判定后自动触发。

## 三、编码前自检（调用 patch/write_file 前必须）

- [ ] `search_files` 搜目标符号定义和引用
- [ ] `search_files` 搜同类平行实现
- [ ] **如有已知符号**，`gitnexus_context` 查调用链 + `gitnexus_impact` 查影响面
- [ ] **如涉及表变更**，`gitnexus_data_impact` 确认数据层影响
- [ ] 确认临时文件放 `/tmp/` 或 `$env:TEMP`

**未完成上述检查 → 标记 `[CHECKPOINT_MISSED]`，补检查后继续。**

**优先级**：`gitnexus_*` 优先，`search_files` 补充漏网。

## 三、编码后自检

- [ ] 语法检查通过（`python -m py_compile` / `tsc --noEmit` 等）
- [ ] 测试通过（如有）
- [ ] `git diff --stat` 确认改动范围符合预期
- [ ] `search_files` 搜索调用方确认兼容

## 四、T2+ 三视角审查（模型自己执行）

### 安全视角
- [ ] 外部输入校验（表单、参数、文件上传）
- [ ] 敏感信息未泄露到代码/日志/错误
- [ ] 外部接口有超时/降级/重试

### 架构视角
- [ ] 未破坏既有分层
- [ ] 接口输入/输出/异常兼容
- [ ] 跨模块规则同步更新

### 简化视角
- [ ] 无重复实现
- [ ] 无不必要抽象/依赖
- [ ] diff 无噪声（无格式化/无关改名）

## 五、压缩恢复模板

上下文压缩后，模型必须输出：

```
## [RECOVERED] 任务恢复摘要
### Goal
[用户想要完成什么]

### Progress
- Done: [已完成]
- In Progress: [正在进行]
- Blocked: [阻塞]

### Key Decisions
[重要决策及原因]

### Relevant Files
[读取/修改/创建的文件]

### Next Steps
[下一步]
```

## 六、强制标记（Prompt Markers）

| 标记 | 触发条件 | 处理 |
|------|----------|------|
| `[CHECKPOINT_MISSED]` | patch 前未 search_files | 补检查后继续 |
| `[PROCESS_VIOLATION]` | 跳步/流程日志缺失 | 修正后复验 |
| `[RECOVERED_FROM_INSTRUCTIONS]` | 上下文压缩 | 按模板输出摘要 |
| `[RULE_CONFLICT]` | 新经验与现有规则矛盾 | 保留新旧规则，等审计 |
| `[NEEDS_CLARIFICATION]` | 需求模糊/矛盾/高风险 | 先澄清，再编码 |
| `[NEEDS_RECALL]` | 应搜索历史但未搜索就直接诊断 | 调用 session_search |
| `[NEW_PATTERN]` | session_search 未找到历史方案 | 任务成功后评估回写 skills |
| `[UNCOVERABLE_REQUIREMENT]` | 需求扩散后仍无法覆盖 | 标记并说明，等用户决策 |
| `[PARTIAL_IMPLEMENTATION]` | 同类点遗漏/局部补丁 | 回到需求扩散包补齐 |
| `[ROLLBACK]` | 修复后验证变差 | 回滚本轮改动 |
| `[MISSING_ACCEPTANCE_MAP]` | 交付无验收映射表 | 补充后重新交付 |
| `[SCOPE_CREEP]` | diff 中有验收标准未声明的改动 | 撤销多余改动 |
| `[PATH_DEVIATION]` | 实际执行路径与定级结论不一致 | 修正或重新定级 |

## 七、session_search 规范

1. 用具体错误消息片段搜索
2. 至少检索 3 个历史会话
3. 输出「历史检索摘要」

未找到 → 标记 `[NEW_PATTERN]`，任务成功后评估回写 skills。
