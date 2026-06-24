# Hermes-Inspired Integration Plan for kilo_config

> 方向 3 混合模式：保留 kilo multi-agent 编排骨架，借鉴 Hermes skills/memory 机制 + agentskills.io frontmatter + Anthropic 5 大工作流模式。

## 设计目标

1. 补全所有 subagent 的 prompt 运行时锚点，消除上下文压缩导致的角色盲区。
2. 引入 MEMORY/USER 冻结快照机制，将跨会话经验与用户偏好持久化为系统级记忆。
3. 统一 SKILL.md 元数据标准（agentskills.io 合规），支持 skills 跨项目复用。
4. 显式映射 Anthropic 5 大工作流模式到 kilo agent 角色，强化 reviewer 自检与流程合规。
5. 全部改动保持 kilo.json 向后兼容，不破坏现有 instructions 数组和 agent 路由语义。

---

## 四层加固总览

| 层名 | 目标 | 关键改动 | 风险等级 | 验收手段 |
|------|------|----------|----------|----------|
| **Layer A** | 基础加固 | kilo.json 补全 9 个缺失 prompt + 增强 4 个现有 prompt；5 个 SKILL.md 前置 YAML frontmatter；workflow.md 追加流程日志规范与违规恢复协议 | 低 | JSON / MD 格式与字段存在性检查 |
| **Layer B** | 程序化记忆 | 新建 `.kilo/memory/` 目录（MEMORY.md + USER.md + README.md）；workflow.md 定义记忆读写触发条件；coderAgent.prompt 追加记忆加载锚点 | 中 | 文件存在性、字符限制、触发条件引用检查 |
| **Layer C** | Skills 跨项目复用 | kilo.json 新增 `skills.external_dirs` 可选数组，允许扫描外部 skill 目录 | 低 | JSON Schema 验证、默认值空数组 |
| **Layer D** | 工作流模式显式化 | workflow.md 新增 Anthropic 5 大模式 → kilo agent 显式映射表；reviewer.prompt 与 reviewer.md 追加自检清单 | 低 | 文档一致性、映射表完整性检查 |

---

## 每个文件的改动要点

### `kilo.json`
- **补全 9 个缺失 prompt**：architect / checker / pre-checker / fixer / review-security / review-architecture / review-simplification / executor-A / executor-B / executor-C / synthesizer / ensemble 各补充 2-6 行 prompt，注入角色定位、核心行为锚点与渐进式披露级别（Level 0/1/2）标记。
- **增强 4 个现有 prompt**：
  - coderAgent：追加 MEMORY/USER 加载触发 + 违规恢复锚点（`[RECOVERED_FROM_INSTRUCTIONS]`）
  - engineer：追加 skills frontmatter 中 `allowed-tools`/`compatibility` 识别
  - reviewer：追加自检清单触发条件
  - skills-writer：追加 external_dirs 扫描范围说明与 memory 写入分类决策
- **A1 单元涵盖 executor-A/B/C、ensemble、synthesizer 的 prompt 补充**（其 .md 正文保持不变）
- **新增 `skills.external_dirs`**：默认空数组，可选外部 skill 目录扫描路径。

### `agent/coderAgent.md`
- 「skills 协作」章节追加 MEMORY/USER 读取时机（任务启动意图判定后）。
- 「交付阶段」追加 memory 评估路径：跨会话复用价值评估。

### `agent/engineer.md`
- 编码前读取 skills 章节追加 frontmatter 识别说明（`allowed-tools` / `compatibility`）。
- 交付检查清单追加 memory 标注项。

### `agent/checker.md`
- 必查追加 skills frontmatter 合规检查。
- 必查追加 memory 字符限制检查（MEMORY ≤2200 / USER ≤1375）。

### `agent/fixer.md`
- 原则追加 memory/skills 修复约束（禁止整文件重写 SKILL/MEMORY）。

### `agent/architect.md`
- 计划文件输出追加 memory 引用字段。

### `agent/reviewer.md`
- **新增「自检清单」章节**：四项自检（安全敏感 / 流程日志 / 同类点覆盖 / memory-skills 合规）。
- 追加对 MEMORY.md 的评估职责标注。

### `agent/pre-checker.md`
- 检查清单追加第 6 项：MEMORY/USER 加载与 external_dirs 引用检查。

### `agent/skills-writer.md`
- 分类决策追加 memory 分类。
- 约束追加 external_dirs 写入限制（仅项目工作区）。

### `agent/executor-A.md`, `executor-B.md`, `executor-C.md`
- kilo.json prompt 字段补充：A/B 读取 MEMORY/USER；C 额外检查候选是否违反 memory 约束。

### `agent/ensemble.md`, `synthesizer.md`
- ensemble prompt：合并候选与 MEMORY.md 架构约束一致。
- synthesizer prompt：合并时优先 USER.md 偏好。

### `agent/review-security.md`, `review-architecture.md`, `review-simplification.md`
- review-security：检查 memory 文件敏感信息泄露。
- review-architecture：检查 external_dirs 依赖方向。
- review-simplification：检查 memory 超限和 `[SPECULATIVE]` 残留。

### `.kilo/instructions/core.md`
- 「项目探测」追加 memory 探测。
- 「流程强制基线」追加 memory 一致性。

### `.kilo/instructions/workflow.md`
- **新增「流程日志规范」章节**（Layer A）：状态枚举、7 节点输出、违规恢复协议。
- **新增「程序化记忆触发条件」章节**（Layer B）：MEMORY/USER 写入触发条件。
- **新增「Anthropic 工作流模式映射」章节**（Layer D）：5 模式 → kilo agent 显式映射表。
- 「交付」追加 MEMORY 回写说明。

### `.kilo/instructions/reflection.md`
- 三层判定「方法层」追加 memory 回溯。
- 推测与验证追加 memory 引用规范。

### `.kilo/skills/{architecture,patterns,anti-patterns,contracts,testing}/SKILL.md`
- 每个文件顶部添加标准 YAML frontmatter（`name` 与目录名一致，kebab-case；`description` ≤1024 字符；可选 `license` / `compatibility` / `metadata`）。
- 保留现有正文结构。

### 新增 `.kilo/memory/MEMORY.md`（模板）
- 顶部含 YAML frontmatter（`name: memory`，`description` 概括用途）。
- 正文分「系统级约束」和「已验证经验」两节。
- 末尾标注建议字符限制：≤2200 字符。

### 新增 `.kilo/memory/USER.md`（模板）
- 顶部含 YAML frontmatter（`name: user`）。
- 正文分「用户偏好」和「项目约定」两节。
- 末尾标注建议字符限制：≤1375 字符。

### 新增 `.kilo/memory/README.md`
- 说明 MEMORY/USER 区别、加载机制、字符限制、写入触发条件、编辑权限。

### `README.md`
- 目录结构树新增 `.kilo/memory/` 分支。
- 「使用」章节补充 memory 机制说明。

### `AGENTS.md`
- 智能体清单保持不变。
- 「项目级接入」最小结构追加 `.kilo/memory/`。
- 「修改本仓库时的注意事项」追加 memory 维护要求。

### `CONFIG_CHANGE_CHECKLIST.md`
- 单一事实来源表新增「程序化记忆」一行。
- 修改检查表新增 memory 修改同步项。
- 已集中维护的规则追加 memory 触发条件条目。

---

## kilo.json 兼容性约束

| 约束类型 | 具体说明 |
|----------|----------|
| **必须保持的字段** | `$schema`, `model`, `small_model`, `default_agent`, `instructions`（3 项可扩展不可删）, `snapshot`, `compaction`, `agent`（13 个不可缺失/重命名）, `commit_message`, `mcp`, `provider` |
| **不允许破坏的语义** | `instructions` 路径必须有效；`agent.*.mode` 枚举值不变；`agent.*.prompt` 为字符串；`compaction` 阈值与保留 tokens 语义不变 |
| **允许新增的字段** | 顶层 `skills` 对象（含 `external_dirs` 数组）、各 agent prompt 增量文本 |
| **不允许删除的字段** | 现有 agent 键名、provider/model 键名、MCP 配置 |

---

## SKILL.md frontmatter 模板

```yaml
---
name: architecture
description: 本 SKILL 存放本项目在模块划分、依赖方向、跨层限制、新逻辑落点方面的长期知识。由 skills-writer 根据验证后的经验写入，禁止手动编造未经验证的内容。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
---
```

合规要求（agentskills.io）：
- `name`：1–64 字符，小写字母/数字/连字符，不以连字符开头/结尾，不含连续 `--`，必须与所在目录名一致。
- `description`：1–1024 字符。
- `license` / `compatibility` / `metadata`：可选。

---

## MEMORY/USER 字符限制与触发条件

| 文件 | 建议上限 | 触发条件 |
|------|----------|----------|
| **MEMORY.md** | ≤2200 字符 | (1) 跨 2 次以上任务重复出现的架构约束/安全模式；(2) reviewer 确认为系统级经验；(3) 修复不收敛时发现的根因模式 |
| **USER.md** | ≤1375 字符 | (1) 用户明确要求的持久化偏好；(2) 用户指定的特殊验证命令或环境要求；(3) 用户直接编辑写入 |

**加载机制**：coderAgent 在任务启动时（意图判定完成后）自动检测 `.kilo/memory/` 存在性；若存在，将 MEMORY.md 和 USER.md 内容注入当前会话上下文。

**超限处理**：MEMORY.md 超过 2200 字符时，skills-writer 触发压缩/归档，将最旧条目迁移到 `.kilo/memory/archive/` 并更新索引。

---

## 风险与回退方案

| 风险 | 等级 | 回退方法 |
|------|------|----------|
| kilo.json prompt 膨胀 | 低 | 每个 prompt 控制在 2–8 行；若导致 compaction 提前触发，降级为仅补 1–2 行定位句 |
| MEMORY.md 写入失控 | 中 | workflow.md 硬上限 + skills-writer 归档协议；回退：删除 `.kilo/memory/` 目录 |
| external_dirs 引入外部冲突 | 低 | 默认空数组；按 `name` 去重，项目级 skills 优先 |
| workflow.md 追加章节锚点偏移 | 低 | 新增章节追加在文件末尾，不改现有标题和结构 |
| SKILL.md frontmatter 解析器不兼容 | 低 | 标准 YAML；若不支持，frontmatter 仅作元数据展示，不影响正文可读性 |
| install 脚本未同步新目录 | 低 | S1 单元显式检查 install.ps1 / install.sh 复制逻辑 |

---

## 验收标准（可被 checker 客观验证）

| 编号 | 验收标准 | 验证方式 |
|------|----------|----------|
| AC1 | kilo.json 中 13 个 agent 均含非空 `prompt` 字段 | 逐条读取 agent 节点确认 `prompt` 长度 >0 |
| AC2 | 5 个 `.kilo/skills/*/SKILL.md` 以 `---` YAML frontmatter 开头，含 `name` 和 `description` | 读取前 10 行确认 |
| AC3 | `.kilo/memory/` 存在 MEMORY.md / USER.md / README.md，且 MEMORY/USER 标注字符限制 | 文件存在性 + grep "2200" 和 "1375" |
| AC4 | workflow.md 含 "Anthropic 5 大模式" 映射表、"流程日志规范"、"程序化记忆触发条件" 章节 | grep 关键字 |
| AC5 | agent/reviewer.md 含 "自检清单" 章节，≥4 条具体检查项 | 读取确认 |
| AC6 | kilo.json 含 `skills.external_dirs` 字段（可空数组） | JSON 路径检查 |
| AC7 | README.md 目录结构树含 `.kilo/memory/` | grep |
| AC8 | AGENTS.md 和 CONFIG_CHANGE_CHECKLIST.md 均提及 `.kilo/memory/` 维护要求 | grep |
| AC9 | 6 个核心 agent 文件（coderAgent/engineer/checker/fixer/architect/pre-checker）均含 memory 引用或新增职责段 | 读取确认 6 个文件含相关关键字 |
| AC10 | 4 个专业 agent 文件（review-security/review-architecture/review-simplification/skills-writer）均含 memory 评估或 external_dirs 写入限制段 | 读取确认 4 个文件含相关关键字 |
| AC11 | `core.md` / `reflection.md` 含 memory 探测 / memory 回溯段 | grep 关键字 |

---

## 任务 DAG

| 单元ID | 目标 | 关键文件/模块 | 依赖单元 | 冲突资源 | 可并行组 | 验收标准 | 验证方式 | 完成定义 |
|--------|------|--------------|----------|----------|----------|----------|----------|----------|
| **A1** | 补全 kilo.json 全部 subagent prompt（9 缺失 + 4 增强） + 添加 `skills.external_dirs` | `kilo.json` | - | `kilo.json` | G1 | AC1, AC6 | JSON 语法校验；逐 agent 确认 | JSON 有效；13/13 agent 有 prompt；`skills.external_dirs` 存在 |
| **A2a** | 为 `architecture` / `patterns` 两个 SKILL.md 添加 frontmatter | 2 个 SKILL.md | - | 上述 2 文件 | G1 | AC2 | 读取确认 | frontmatter 合规；`name` 匹配目录名 |
| **A2b** | 为 `contracts` / `testing` / `anti-patterns` 三个 SKILL.md 添加 frontmatter | 3 个 SKILL.md | - | 上述 3 文件 | G1 | AC2 | 读取确认 | 5/5 skills 均有 frontmatter |
| **B1** | 创建 MEMORY.md / USER.md / README.md 模板 | `.kilo/memory/*` | - | 新文件无冲突 | G1 | AC3 | 读取确认 | 3 文件存在；含 frontmatter；标注字符限制 |
| **D2** | 在 `agent/reviewer.md` 增加自检章节 + MEMORY.md 评估职责标注 | `agent/reviewer.md` | - | `agent/reviewer.md` | G1 | AC5 | 读取确认 | 含自检章节；≥4 条检查项；含 MEMORY.md 评估职责标注 |
| **A3** | 6 个核心 agent .md 文件增量更新（coderAgent / engineer / checker / fixer / architect / pre-checker） | 6 个 agent/*.md | - | 上述 6 文件 | G1 | AC9 | 读取确认 | 6/6 文件含 memory 引用或新增职责段 |
| **A4** | 4 个专业 agent .md 文件增量更新（review-security / review-architecture / review-simplification / skills-writer） | 4 个 agent/*.md | - | 上述 4 文件 | G1 | AC10 | 读取确认 | 4/4 文件含 memory 评估或 external_dirs 写入限制段 |
| **I1** | 2 个 instructions 文件增量更新（core.md 加 memory 探测 / reflection.md 加 memory 回溯） | 2 个 instructions | - | 上述 2 文件 | G1 | AC11 | grep 关键字 | 含 memory 探测 / memory 回溯段 |
| **W1** | workflow.md 追加：流程日志规范、违规恢复、memory 触发条件、5 大模式映射、交付 MEMORY 回写说明 | `workflow.md` | A1, B1 | `workflow.md` | - | AC4 | 读取 + grep | 含 5 模式映射表；memory 触发条件；恢复协议；交付部分含 MEMORY 回写说明 |
| **S1** | 同步 README/AGENTS/CHECKLIST/install.* 反映 memory、frontmatter、agent 变化；install 脚本同步 `.kilo/memory/` 目录 | README, AGENTS, CHECKLIST, install.* | W1 | 上述文件 | - | AC7, AC8 | 读取 + 脚本检查 | README 目录树含 memory；AGENTS 接入指南含 memory；CHECKLIST 含 memory 和 frontmatter 检查项；install 脚本复制逻辑含 `.kilo/memory/` |

### 调度建议

**G1 并行组**（无文件冲突）：
- A1（kilo.json） 
- A2a（2 个 SKILL.md）
- A2b（3 个 SKILL.md）
- B1（3 个新 memory 文件）
- D2（agent/reviewer.md）
- A3（6 个核心 agent .md）
- A4（4 个专业 agent .md）
- I1（2 个 instructions）

**串行依赖**：
- W1 → 软依赖 A1（kilo.json 中 coderAgent prompt 已含 memory 加载锚点，但 W1 可独立验证），强依赖 B1（memory 文件模板已存在）
- S1 → 依赖所有实现单元完成（文档与最终文件系统一致）

---

## 关键风险（3-5 条）

1. **kilo.json prompt 膨胀风险**：一次性为 9 个 agent 新增 prompt + 增强 4 个，可能导致 JSON 体积显著增加。应对：每个 prompt 严格控制在 2-8 行。
2. **workflow.md 追加章节与既有锚点冲突**：workflow.md 已有大量 agent/*.md 引用。应对：所有新增章节追加在文件末尾，不修改现有标题。
3. **MEMORY.md 写入失控与敏感信息泄露**：memory 作为冻结快照注入，若被误写入密钥将持久化泄露。应对：review-security 检查 memory 文件敏感信息。
4. **skills.external_dirs 引入外部冲突**：外部目录 SKILL.md 可能命名冲突。应对：默认空数组，按 `name` 去重，项目级优先。
5. **install 脚本未同步新目录**：install.ps1/install.sh 若用显式文件列表将导致 memory 模板缺失。应对：S1 单元显式检查安装脚本逻辑。
