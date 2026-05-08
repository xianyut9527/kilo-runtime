# AGENTS.md

> 通用 AI 代理配置标准与设计参考。当前运行时精简指令已迁移到 `./.kilo/instructions/`，本文件保留为全量规范说明与人工维护参考。

## 动态项目上下文

若项目信息占位符未填充，Agent 应主动通过以下方式探测当前项目上下文：

1. 读取项目根目录 `package.json` 推断技术栈与验证命令
2. 扫描常见配置文件（`vue.config.js`, `vite.config.ts`, `webpack.config.js`, `tsconfig.json`, `eslint.config.*`, `pyproject.toml`, `Cargo.toml`, `pom.xml` 等）确定构建与检查命令
3. 将探测到的验证命令用于编码后的自测与审查

## 全量智能体清单

| 智能体                | 类型           | 模式     | 职责                                                                       |
| --------------------- | -------------- | -------- | -------------------------------------------------------------------------- |
| coderAgent            | 单模型编排     | all      | 任务理解、委派、跟踪、交付                                                 |
| architect             | 单模型规划     | subagent | 需求分析、架构设计、任务拆解                                               |
| engineer              | 单模型实现     | subagent | 读取→编码→测试→修复                                                        |
| reviewer              | 主审查者       | subagent | 主审查 + 按需并行专审 + findings 汇总                                      |
| review-security       | 安全专审       | subagent | 专注输入边界、权限控制、敏感信息与危险副作用                               |
| review-architecture   | 架构专审       | subagent | 专注分层、依赖方向、接口契约与跨模块影响                                   |
| review-simplification | 简化专审       | subagent | 专注重复实现、复杂度膨胀、过度抽象与范围外修改                             |
| ensemble              | 多模型并行编排 | all      | 需求解析 → 并行编码 → 候选评估 → checker/reviewer 双门禁 → 异常修复 → 交付 |
| executor-dp           | 多模型执行 A   | subagent | 正向实现，偏稳健正确性与回归控制                                           |
| executor-mm           | 多模型执行 B   | subagent | 简洁构建，偏更小 diff、更高复用、更清晰实现                                 |
| executor-cx           | 多模型执行 C   | subagent | 对抗性检查，补足边界条件、兼容性、失败路径与隐藏遗漏                       |
| synthesizer           | 多模型合并     | subagent | 基于基准评分智能合并多版本代码                                             |
| checker               | 客观验证门禁   | subagent | 运行测试/构建/类型检查/Lint，并检查范围、聚焦度与需求映射                  |
| fixer                 | 多模型修复     | subagent | 根据审查意见精准修复                                                       |

## 工作流选择

### 路径 A：单模型智能体链（默认）

适用：日常开发、中等复杂度任务。由 `coderAgent` 编排，按需升级：

用户 → coderAgent（编排者）→ architect / engineer / reviewer

### 路径 B：多模型并行（ensemble）

适用：关键模块、高质量要求任务。由 `ensemble` 编排：

用户 → ensemble（多模型编排）
         ├→ 步骤1: 需求解析 + 范围锁定
         ├→ 步骤2: 创建 worktree + 并行编码（默认 executor-dp + executor-mm + executor-cx）
         ├→ 步骤3: 候选评估与必要融合
         ├→ 步骤4: 双重质量门禁（checker + reviewer + 按需专审）
         ├→ 步骤5: 定向修复（默认 1 轮，最多 2 轮）
         └→ 步骤6: 交付

### 选择原则

- 日常快速开发 → `@coderAgent`
- 核心模块/资金安全/算法关键 → `@ensemble`
- 单模型路径连续 3 轮未能解决 → 自动升级 `@ensemble`

## 输出规范

### 通用要求

- 无内容章节可省略
- 优先保留高信号内容
- 验证结果只保留关键命令、结论和失败片段
- 禁止复述用户输入、重复背景

### 沟通规范

- 向用户提问时一次性列出所有问题
- 输出关键结论使用加粗或列表提升可读性
- 禁止碎片化追问

### 输出示例

#### ❌ 不良输出
```
## 变更摘要
- src/utils.ts: 优化了工具函数
- src/api.ts: 修复了接口问题
```

问题：未说明具体改了哪个函数、为什么改、影响范围。

#### ✅ 良好输出
```
### src/utils.ts
- **修改函数**: `formatDate()`, `parseAmount()`
- **变更前**: `formatDate` 不支持时区参数；`parseAmount` 对负数处理有误
- **变更后**: `formatDate` 新增 `timezone` 可选参数（默认 UTC）；`parseAmount` 修复负数正则匹配
- **变更原因**: 需求 #3 要求支持多时区显示；bug #12 修复金额负数
- **影响范围**: 3 个调用方（Dashboard、Report、Export）自动兼容，无需修改

### src/api.ts
- **修改函数**: `fetchUserList()` 异常处理分支
- **变更前**: 网络错误时直接 throw，上层无 try-catch
- **变更后**: 新增 `ApiError` 类型包装，上层统一处理
- **变更原因**: 修复接口超时未捕获导致的白屏问题（bug #15）
- **影响范围**: 仅影响 `fetchUserList` 调用链，其他 API 函数不受影响
```
