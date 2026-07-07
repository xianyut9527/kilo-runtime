---
name: patterns
description: Hermes 项目可复用的实现范式、最佳实践、推荐写法。由 agent 在交付阶段根据验证后的经验写入。
keywords:
  - patterns
  - best-practice
  - implementation-pattern
  - reusable
  - coding-style
  - guideline
  - linkage-check
  - 模式
  - 最佳实践
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "1.0"
  category: knowledge
---

# 代码模式

> 存放 Hermes 项目中可复用的实现范式与最佳实践。
> 由 agent 在交付阶段写入，禁止编造未经验证的内容。

## 条目列表

### PAT-001: 关联功能评估检查清单

**描述**：修改函数、常量、枚举或接口后，必须执行本检查清单，确认关联功能已同步调整，避免"改了A漏了B"的返工。

**检查清单**：
1. **调用方搜索**：修改对象在项目中还有哪些调用方？是否需要同步调整？
2. **平行实现搜索**：同类功能在其他模块是否有平行实现？是否也需要修改？
3. **三层同步检查**：UI 层、接口层、数据层是否都涉及同一规则？
4. **配置/枚举/状态复用检查**：修改项是否在多处被引用？引用处是否同步更新？

**验证方式**：
- engineer 交付检查清单中必须汇报执行结果
- checker L2 核查清单是否被填写、发现项是否已处理

**相关条目**：anti-patterns/SKILL.md#AP-006

---

### PAT-002: 配置去重与单一事实来源

**描述**：不要在多个地方重复相同规则字面句。通用规则应集中到 `SOUL.md` / `.hermes.md` / skills 中，子代理 prompt 只保留角色锚点关键词。

**示例（错的）**：
```markdown
# engineer.md
你是 engineer，必须执行以下 10 条流程...
# checker.md
你是 checker，必须执行以下 10 条流程...
```

**示例（对的）**：
```markdown
# SOUL.md
## 强制流程日志
...
## 质量门禁
...

# engineer.md
> 通用规则由 SOUL.md、.hermes.md 和 skills 注入。
> 你是 engineer，负责实现。
```

**验证方式**：
- 搜索重复规则字面句
- 长任务中观察是否因重复字面句被压缩冲掉

---

### PAT-003: Hermes 编辑器接入路径选择

**描述**：把 Hermes 接入 VS Code / Trae 等编辑器时，常见三种路径。需先探测当前 Hermes 版本的真实能力，再推荐最小可行路径，避免假设它支持 OpenAI 兼容 API。

**决策树**：

1. **ACP（首选）**
   - 命令：`pip install "hermes-agent[acp]"` → `hermes acp --check` → `hermes acp`
   - 编辑器要求：安装 ACP Client 扩展（如 Jun Han 的 ACP Client）
   - 配置：`command: hermes`, `args: ["acp"]`
   - 体验：完整 Agent 协议，支持文件 diff、工具调用
   - 前提：扩展支持 Hermes ACP

2. **MCP（次选）**
   - 命令：`hermes mcp serve`
   - 编辑器要求：支持 MCP server（Cursor、Claude Desktop、部分 Trae 版本）
   - 体验：工具协议，聊天自由度受限

3. **Web Dashboard（保底）**
   - 命令：`hermes serve --port 9119 --skip-build`
   - 浏览器访问 `http://127.0.0.1:9119`
   - 体验：完整 UI，但不是编辑器内嵌

**关键验证**：
- `hermes serve` 不是 OpenAI 兼容 API：`GET /v1/models` 返回 HTML，`POST /v1/chat/completions` 可能返回 `Method Not Allowed`
- 不要假设 `/v1` 路径是 OpenAI API；应查 `http://127.0.0.1:9119/openapi.json` 或 `--help` 确认真实端点

**常见误区**：
- 把 `hermes serve` 当作 OpenAI 后端配置到 Trae/Continue/Cline 里 → 失败
- 忽略 `hermes proxy` 仅用于 OAuth provider 转发，不是通用 API 服务

**相关条目**：anti-patterns/SKILL.md#AP-009（PowerShell env 变量泄露，在写安装脚本时也会遇到）

---

### PAT-004: 项目规则必须进版本控制

**描述**：项目级流程、编码标准、安全约束、模式/反模式必须写入版本控制的 `SOUL.md`、`.hermes.md` 或 `skills/`，不能只存在个人运行时数据（如 SQLite 数据库、`.env`、logs、sessions 等）。这能确保团队同步、可审计、换设备不丢失。

**边界定义**：

| 内容类型 | 写入位置 | 是否团队同步 | 例子 |
|----------|----------|--------------|------|
| 项目流程 / 编码标准 / 交付格式 | `SOUL.md` / `.hermes.md` / `skills/` | ✅ | T0-T3 定级、7 节点流程日志 |
| 项目特定反模式 / 模式 / 经验 | `skills/anti-patterns/` / `skills/patterns/` / `skills/workflow/` | ✅ | AP-010、PAT-004 |
| 个人偏好 | 个人运行时数据 | ❌ | "用户偏好简洁中文回复" |

**ACTION 触发条件**：
- 在个人运行时数据（SQLite、`.env`、logs、sessions）中发现项目流程、编码标准、安全约束、Kilo 相关规则、验证方式、反模式条目
- 出现 "User wants..."、"single strong model"、"dual checker"、"team-syncable" 等项目级关键词

**修复 SOP**：
1. 识别越界内容
2. 迁移到 `SOUL.md`、`.hermes.md` 或对应 `skills/`
3. 清空个人运行时数据中的重复内容
4. 运行 `install-hermes.sh` / `install-hermes.ps1` 同步 skills
5. 用搜索验证个人运行时数据中不再出现项目规则关键词

**验证方式**：
- 搜索个人运行时数据中的关键词：
  ```bash
  # Windows
  grep -RiE "kilo|dual checker|triple-reviewer|team-syncable|single strong model|SCOPE_CREEP|7 节点" "$LOCALAPPDATA/hermes/"
  ```
- 结果应为空；若命中，按 SOP 迁移

**相关条目**：anti-patterns/SKILL.md#AP-010, .hermes.md#项目规则存储边界

---

## 回写指引

产生值得沉淀的经验时：
1. 确认已通过 checker/reviewer 验证
2. 按条目模板追加
3. 在"相关条目"中建立链接
