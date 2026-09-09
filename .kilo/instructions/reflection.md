---
name: reflection
description: 反思与错误恢复
keywords: reflection, 根因回溯, Circuit Breaker
---

# 反思与错误恢复

## 三层判定

错误发生时，按以下层次判定根因：

| 层次 | 特征 | 修复策略 |
|------|------|----------|
| **执行层** | 代码逻辑错误、边界遗漏、实现偏差 | 直接修复代码 |
| **方法层** | 搜索不全、分析偏差、验证遗漏 | 改进方法，补充搜索/验证 |
| **需求层** | 需求理解错误、范围不清、验收标准缺失 | 重新澄清需求，调整验收标准 |

### 强制跨会话根因回溯

以下条件命中后，agent 必须跑 `kilo_local_recall` 跨会话根因回溯再进入修复阶段：

**强制触发**：
1. verifier/reviewer FAIL 且错误为方法层/需求层
2. fixer 连续 2 轮同症状
3. 用户反馈"还是有问题/不对/遗漏"
4. Circuit Breaker 触发

回溯动作（**未跑 kilo_local_recall 不得进入修复阶段**）：
- `kilo_local_recall` 搜索历史同类问题（轻量级，本机所有会话）
- `gitnexus_*` 验证影响面
- **第 3 步 检索 knowledge-base**：`<GLOBAL_ROOT>/knowledge-base/index.md`（继承 AGENTS.md 全局根解析基准，即 `~/.config/kilo/knowledge-base/index.md`，禁止硬编码盘符）。机械检索：`node "<GLOBAL_ROOT>/scripts/kb.mjs" query "<症状诱因词>"`（GLOBAL_ROOT 语义=全局配置根，禁止硬编码盘符）；命中 exit 0 → 读对应 `fixes/FX-*.md` 全文并打 `[KB_HIT]`；exit 1 → `[KB_MISS]` 并在经验收敛后按 `knowledge-base/index.md` 模板回写新增 FX

## Circuit Breaker

连续 3 次无法收敛 → **停止修复**，输出：

```
[CIRCUIT_BREAKER]
- 已尝试次数：3
- 根因层：执行层/方法层/需求层
- 建议选项：
  A. 重新澄清需求
  B. 降低验收标准
  C. 人工介入
  D. 回滚到上一版本
```

## 反馈格式

```
## 根因回传
- 根因层: 执行层 / 方法层 / 需求层
- 本次修复点: [文件:行号] [改动摘要]
- 是否同症状复发: 是 / 否
```
