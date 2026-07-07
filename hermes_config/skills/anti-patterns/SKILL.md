---
name: anti-patterns
description: Hermes 项目反复出现的错误模式、踩坑记录、禁止事项。由 agent 在交付阶段根据验证后的经验写入。
keywords:
  - anti-patterns
  - pitfalls
  - mistakes
  - forbidden
  - scope-creep
  - BOM
  - encoding
  - subagent-empty
  - 反模式
  - 踩坑
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式

> 存放 Hermes 项目中反复出现的错误模式与禁止事项。
> 由 agent 在交付阶段写入，禁止编造未经验证的内容。

## 条目索引

| ID | 标题 | 关键词 |
|----|------|--------|
| AP-001 | Edit 工具 BOM 污染 | BOM, UTF-8, JSON.parse |
| AP-002 | 软约束 vs 硬门禁 | 规则淹没, 嵌套, 平级 |
| AP-003 | pre-checker FAIL 修正后未复验 | 跳步, 复验, 流程日志 |
| AP-004 | 子代理返回空结果未升级 | 空结果, 内联执行, 升级 |
| AP-005 | PowerShell 5.1 GBK 编码根因 | Windows, GBK, 编码 |
| AP-006 | 关联功能遗漏 | 调用方, 同类点, 返工 |
| AP-007 | 多单元 SCOPE_CREEP 全量 diff 误判 | git diff, 单元边界 |
| AP-008 | 验收映射表缺失 | [MISSING_ACCEPTANCE_MAP] |
| AP-009 | PowerShell 双引号意外展开 `$env:` 变量 | PowerShell, env, leak, 泄露 |
| AP-010 | 项目规则只存个人运行时数据 | memory, user, project-rules, sqlite |

## 条目列表

### AP-001: Edit 工具 BOM 污染

**描述**：Windows 下 Edit 工具修改 UTF-8 文件后可能写入 BOM，导致 JSON/YAML 解析失败。

**验证方式**：
- `node -e "let b=require('fs').readFileSync('p'); console.log(b[0]===0xEF?'BOM':'no-BOM')"`
- 修改后必须跑 `JSON.parse` / YAML 验证

---

### AP-002: 软约束 vs 硬门禁

**描述**：核心规则放在嵌套子条款里会被 agent 忽略；应放到平级"强制基线"并声明违反后果。

**验证方式**：
- 检查 agent 是否在高上下文压力下仍遵守该规则
- 违反 1 次记 1 次反模式反馈

---

### AP-003: pre-checker FAIL 修正后未复验

**描述**：pre-checker FAIL 后修正了方案，但未再次调用 pre-checker 验证就进入 engineer，属于跳步违规。

**验证方式**：流程日志中 pre-checker 节点必须出现 2 次（首次 + 复验），第二次为 ✅ PASS。

---

### AP-004: 子代理返回空结果未升级

**描述**：`delegate_task` 连续 2 次返回空结果时，父代理直接内联执行该子代理职责，跳过独立验证。

**验证方式**：
- 2 次空结果后必须标记 `[SUBAGENT_RETURNED_EMPTY]` 并升级（拆细任务 / 换模型 / ensemble）
- 不得直接内联

---

### AP-005: PowerShell 5.1 GBK 编码根因

**描述**：Windows PowerShell 5.1 默认输出编码为 GBK，导致中文乱码。

**验证方式**：
- `[Console]::OutputEncoding.WebName` 应返回 `utf-8`
- 必要时在 profile 中永久设置 UTF-8

---

### AP-006: 关联功能遗漏

**描述**：改 A 时只改最明显的一处，未同步搜索和修改依赖 A 的 B/C/D，导致返工。

**验证方式**：
- engineer 交付检查清单必须包含调用方搜索摘要
- checker L2 必须确认摘要存在

---

### AP-007: 多单元 SCOPE_CREEP 全量 diff 误判

**描述**：多单元在同一工作区执行时，checker 用 `git diff HEAD~1` 或 `git diff --stat` 做全量比对，把前置单元已 PASS 的合法变更误判为当前单元 SCOPE_CREEP。

**验证方式**：
- 用 `git status --short` 确认实际改动
- 用 `git diff -- <本单元文件>` 限定范围

---

### AP-008: 验收映射表缺失

**描述**：交付时未提供验收标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态 的映射表，导致 checker 无法客观验证。

**验证方式**：engineer 输出必须包含验收映射表；缺失判 `[MISSING_ACCEPTANCE_MAP]` FAIL。

---

### AP-009: PowerShell 双引号意外展开 `$env:` 变量

**描述**：PowerShell 中双引号字符串会展开 `$env:VAR`。在脚本提示语中写 `"Set $env:FOO = '...'"` 时，运行时会展开成真实环境变量值，可能泄露 API key 等敏感信息。

**关键细节**：
- `反斜杠` \ 不是 PowerShell 转义符，加 `\$env:FOO` 仍会被展开
- PowerShell 转义符是 `反引号`，但更容易错过的做法是使用单引号字符串

**正确做法**：
```powershell
# 对带 $env: 的提示语使用单引号
Write-Host 'Set API key env: $env:NAT100_API_KEY = "<your-key>"'

# 或显式转义（但单引号更简洁）
Write-Host "Set API key env: `$env:NAT100_API_KEY = \"<your-key>\""
```

**验证方式**：
1. 设置 fake key：`$env:NAT100_API_KEY = 'sk-FAKE-TEST-12345'`
2. 运行 PowerShell 脚本
3. 检查 stdout/stderr 不含 `sk-FAKE-TEST-12345`

**影响场景**：任何在 PowerShell 脚本中打印环境变量提示语的安装/配置脚本。

---

### AP-010: 项目规则只存个人运行时数据

**描述**：把项目级流程、编码标准、安全约束、模式/反模式只存在个人运行时数据中（如 SQLite 数据库、`.env`、logs、sessions 等），而不写入版本控制的 `SOUL.md`、`.hermes.md` 或 `skills/`。这会导致项目规则无法团队同步、不可审计、换设备即丢失。

**典型错误内容**：
- "User wants Hermes and kilo to remain independent agents..."
- "single strong model + dual checker + triple-reviewer..."
- "禁止写入 API Key / 内部 URL / PII"
- "Kilo-legacy-free + team-syncable"

**正确位置**：

| 内容 | 正确位置 |
|------|----------|
| 项目流程 / 编码标准 / 交付格式 | `SOUL.md` / `.hermes.md` |
| 项目特定反模式 / 踩坑 / 模式 | `skills/anti-patterns/` / `skills/patterns/` |
| 跨项目通用约束 | 版本控制的 `skills/...` 或 `SOUL.md` |
| 个人偏好 | 个人运行时数据（如 SQLite fact_store） |

**修复动作**：
1. 识别个人运行时数据中的项目规则内容
2. 迁移到 `SOUL.md`、`.hermes.md` 或对应 `skills/`
3. 清空个人运行时数据中的重复内容

**验证方式**：
- 搜索 `%LOCALAPPDATA%\hermes\` 或 `~/.hermes/` 下的 SQLite 数据库、日志、会话中是否出现项目规则关键词：
  ```bash
  # Windows
  grep -RiE "kilo|dual checker|triple-reviewer|team-syncable|single strong model|SCOPE_CREEP|7 节点" "$LOCALAPPDATA/hermes/"
  ```
- 结果应为空；若命中，按 SOP 迁移

**相关条目**：patterns/SKILL.md#PAT-004, .hermes.md#项目规则存储边界

---

## 回写指引

产生值得沉淀的经验时：
1. 确认已通过 checker/reviewer 验证
2. 按条目模板追加
3. 在"相关条目"中建立链接
