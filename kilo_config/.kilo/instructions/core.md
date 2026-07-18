---
name: core
description: 通用基线规则 — 意图分类、安全约束、编码前检查点、流程强制基线
keywords: core, 意图判定, 安全约束, 检查点, 流程基线
---

# Core Runtime Rules

## 意图与边界

### 意图分类

用户请求分为两类，**存疑时归为咨询，不动手**。

- **咨询类**：提问、了解、分析、比较、建议、排障、解释。只给结论，**禁止改文件**。
- **执行类**：明确要求创建、修改、删除、重构、修复、实现。

### 判定规则

1. 无明确动作指令 → **咨询类**："为什么"/"怎么理解"/"看看这个" → 只分析不改。
2. 有动作指令但模糊/矛盾/高风险 → **先澄清再动手**。
3. 咨询类中用户确认"改吧"/"执行" → **转为执行类**，按确认范围执行。

### 硬性约束

- 意图判定完成前，**不得调用修改性工具**。
- 违反 → `[PROCESS_VIOLATION]`，暂停修正。

## 实施原则

- 先定位后修改，先读后写，先复用后新建。
- **组件化优先 / 重复模式拦截**：当同一 UI/样式/行为问题在 ≥2 个页面/组件出现，或用户提示存在同类问题时，禁止逐页复制粘贴式修复。必须先扫描全仓同类点，优先通过共享组件、布局、design token、全局样式、mixin 统一修复；无法组件化时须在验收映射表中说明原因并请求用户确认。
- 最小必要改动：不多改无关逻辑，但需求覆盖完整性优先于 diff 最小化。
- 禁止整文件重写；用增量编辑。
- 删除文件/模块后，必须全仓搜索残留引用并同步修正。

## 项目探测

- 陌生项目先看构建配置、入口目录、关键导出、测试/Lint 命令。
- 优先使用项目级 `AGENTS.md` 和 `.kilo/skills/`。

### Memory 探测

记忆系统采用 **全局 sqlite 优先 + 项目 md 兜底** 架构：

**sqlite 层**（全局共享，`~/.config/kilo-data/memory.db`，通过 `sqlite` MCP 访问；数据目录独立于配置目录，install 同步不会清除）：
- `fact_store`：结构化经验教训（PATTERN / ANTIPATTERN / RECIPE / WARNING）
- `failure_db`：失败案例库（含根因、修复策略、复发次数）
- `dispatch_log`：全链路任务日志
- `project_context`：项目专属架构决策与约束
- `model_calibration`：模型能力积累与偏差补偿

**md 层**（项目级静态规则）：
- `.kilo/memory/MEMORY.md`：系统级约束、归档索引
- `.kilo/memory/USER.md`：用户偏好、安全约束

**全局 Skill 层**（跨项目复用）：
- `~/.config/kilo/.kilo/skills/`：全局通用 Skill（与 install.ps1 实际安装路径一致；另通过 `kilo.json` `skills.external_dirs` 接入 `~/.agents/skills/` 社区技能源）
- `.kilo/skills/`：项目专属 Skill（覆盖全局同名 Skill）

**初始化检查**：`~/.config/kilo-data/memory.db` 不存在时，按 `.kilo/memory/policy/init_check.md` 4 步 SOP 完成建表（mkdir → 建表 → 验证 → model_calibration 基线），再开始使用。模块入口：`.kilo/memory/README.md`。

`gitnexus_*`：代码图谱（调用链/影响面）—— 由 `kilo.json` `mcp.gitnexus.enabled` 独立控制。

## 自进化触发点

`.kilo/memory/` 目录存在时，以下条件命中后**强制**执行回溯查询，再决定修复策略：

1. checker/reviewer FAIL 且错误为方法层/需求层
2. fixer 连续 2 轮同症状
3. 用户反馈"还是有问题/不对/遗漏"
4. Circuit Breaker 触发（连续 3 次无法收敛）

### 强制回溯查询（优先级顺序）

**第一步：sqlite 查询（必须）**
```sql
-- 查同类失败
SELECT symptom, root_cause_level, fix_strategy, fix_location 
FROM failure_db 
WHERE symptom LIKE '%关键词%' AND verified = 1 
ORDER BY created_at DESC LIMIT 3;

-- 查相关反模式
SELECT trigger, condition, action, confidence 
FROM fact_store 
WHERE category = 'ANTIPATTERN' AND tags LIKE '%关键词%' 
ORDER BY confidence DESC LIMIT 3;

-- 查模型校准
SELECT compensation_prompt, success_rate 
FROM model_calibration 
WHERE agent_role = '当前角色' AND task_type LIKE '%当前类型%' 
ORDER BY sample_count DESC LIMIT 1;
```

**第二步：kilo_local_recall（补充）**
- 搜索历史同类问题
- 对比历史修复方案

**第三步：gitnexus 验证（影响面确认）**
- `gitnexus_*` 验证修改影响面

**未执行 sqlite 查询 → `[MISSING_RECALL]`，不得进入修复阶段。**

`.kilo/memory/` 目录不存在时，跳过 sqlite 查询，`kilo_local_recall` 仍可作为独立工具手动调用。

## 验证与安全

- 修改后运行可用测试、构建、类型检查、Lint。
- 验证失败不得交付，必须修复或上报阻塞。
- 不暴露密钥、Token、密码或敏感配置。

## 流程强制基线

1. **禁止跳步**：按任务定级声明的执行路径执行。
2. **过程可追溯**：维护强制流程日志，缺步即违规。
3. **跳步即上报**：发现 `[PROCESS_VIOLATION]` 并升级。
4. **自验无效**：不得以自身验证替代 checker。
5. **交付必审**：确认流程日志完整覆盖全生命周期。

## 通用安全约束

1. **输入校验与净化**：外部输入必须校验类型/长度/格式/范围，使用白名单，上下文净化（HTML 转义、SQL 参数化、命令参数化）。
2. **敏感信息保护**：不暴露密钥、Token、密码到代码、日志、错误、返回值。
3. **注入防护**：SQL 注入 / XSS / 命令注入 / 路径遍历 —— 详见 `security-checklist.md`。

## 资源与性能约束

1. **超时与降级**：外部 HTTP、文件处理、长计算必须有超时控制（如 30s）和降级/重试策略。
2. **拒绝不合理高负载**：不限制/无限制/不限大小/全部加载等需求 → 拒绝并给出分页/限流/上限替代方案。
3. **资源限制**：分页强制、上传大小/类型/数量上限、批量操作上限、查询 LIMIT —— 详见 `security-checklist.md`。

## 资源生命周期管理

1. **临时文件清理**：任务结束前清理所有临时文件、脚本、构建产物。
2. **存放位置**：系统临时目录（`/tmp/` / `$env:TEMP`），禁止写入项目根目录、`src/`、`lib/`、`dist/`。
3. **违规标记**：发现残留临时文件 → `[FOUND_ORPHAN_ARTIFACT: 路径]`。

## 智能体通用执行原则

### 编码与修改

1. **先读后写**：搜索现有实现，优先复用或扩展。
2. **最小增量编辑**：保持项目既有风格、分层和命名。
3. **边界覆盖**：每个函数包含正常路径、空值/边界、错误/异常路径。缺失 → `[MISSING_EDGE_CASE]`。
4. **检查调用方与同类点**：修改后搜索调用方和同类平行实现，确认兼容性和同步调整。若同一问题在 ≥2 处出现，必须按 workflow-core.md「重复模式修复 / 组件化 SOP」执行，禁止逐页复制样式。

### 验证与交付

1. **运行验证**：修改后跑测试、构建、类型、Lint。
2. **不自验不自审**：编码后输出"等待 checker 验证"，不得自行标注"已验证"。
3. **验收映射表**：交付必附，列固定为「验收标准 | 实现位置 | 验证方式 | 边界覆盖 | 状态」。
4. **已读取文件清单**：列出实际读取的调用方文件、同类点来源文件、复用实现文件。checker 反向核对；虚假路径 → `[FAKE_CONTEXT]`。
5. **清理交付**：任务结束前清理临时文件。

## Context Engine 自动查询规则

以下场景必须**自动**调用对应工具（不得省略）：

| 场景 | 强制工具 | 说明 |
|------|----------|------|
| 修改 ≥3 个文件 | `gitnexus_impact` | 影响面分析 |
| 修改 API/Router/Handler | `gitnexus_route_map` 或 `gitnexus_api_impact` | 接口消费方检查 |
| 修改数据库表/字段 | `gitnexus_data_impact` | 上下游数据流分析 |
| 修改核心工具/配置 | `gitnexus_query` | 架构约束检索 |
| 修改 UI/样式/行为且同类症状 ≥2 处 | `grep` / `glob` / `gitnexus_query` | 全量扫描同类点，优先组件化/共享抽象修复 |
| 使用陌生第三方库 | `context7_query-docs` | 文档查询 |
| 修复失败/报错 | `kilo_local_recall` | 历史同类问题回溯 |

未执行 → `[MISSING_CONTEXT_QUERY]`

## 编码前强制检查点

编码前必须显式输出确认，不可跳过：

1. **规则确认**：已读取通用安全约束、资源约束、生命周期基线。
2. **等级确认**：已确认任务等级（T0/T1/T2/T3），非 T0 绝不跳过 checker。
3. **搜索确认**：已搜索现有实现和同类模式，确认可复用点。
4. **Context 确认**：已按「Context Engine 自动查询规则」调用必要工具，确认影响面。
5. **重复点/同类模式扫描确认**：已用 grep/glob/gitnexus 扫描同类实现，确认修复策略（共享组件 vs 单点例外）并记录理由。
6. **清理确认**：已确认临时文件存放位置（$env:TEMP / /tmp/）。

未执行 → `[CHECKPOINT_MISSED]`，暂停编码。

## 压缩后结构化恢复

上下文压缩触发 `[RECOVERED_FROM_INSTRUCTIONS]` 时，按以下模板输出恢复摘要：

```
## [RECOVERED_FROM_INSTRUCTIONS] 任务恢复摘要
### Goal
[用户想要完成什么]
### Progress
#### Done
[已完成的工作 — 具体文件路径、命令、结果]
#### In Progress
[正在进行的工作]
#### Blocked
[遇到的阻塞或问题]
### Key Decisions
[重要的技术决策及原因]
### Relevant Files
[读取/修改/创建的文件 — 简要说明]
### Next Steps
[下一步需要做什么]
```

恢复后立即输出当前进度快照（7 节点流程日志），标注 `[PROCESS_VIOLATION]`（若存在跳步）。
