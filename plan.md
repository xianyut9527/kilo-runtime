经过深入调研 Kilo 官方全部核心文档、Gateway SDK 生态、MCP 协议生态、Plugin 系统、社区最佳实践，以及 GitHub 生态工具集成，下面是我给出的"宇宙级编码智能体"完整架构设计方案。

> 状态更新（2026-05）：
>
> - 已落地：高精度默认模型路由、轻量运行时规则、多模型编排链路、全局命令骨架、项目级智能包模板。
> - 已确认不采用：自动学习写规则文件、把项目知识硬编码回全局规则。
> - 暂不默认启用：GitHub MCP（需 `GITHUB_PAT`）、Playwright MCP、插件/生命周期扩展、CI/CD 自动化。
> - 使用原则：先把全局骨架和项目级 context pack 建好，再逐项验证更重的基础设施能力。

---

# 宇宙级 Kilo 编码智能体：完整架构

## 一、总体架构（4 层体系）

```
┌─────────────────────────────────────────────────────────────────┐
│                    第 4 层：CI/CD 与协作层                        │
│  GitHub Actions / Code Review / Deploy / Session Sharing        │
├─────────────────────────────────────────────────────────────────┤
│                    第 3 层：外部能力层（MCP 生态）                │
│  Playwright  │  Database  │  GitHub  │  Filesystem  │  ...  │
├─────────────────────────────────────────────────────────────────┤
│                    第 2 层：智能体编排层                           │
│  coderAgent → architect / engineer / reviewer / ensemble         │
│       ↕  Plugin 系统（自定义 Tools + 生命周期钩子）               │
│       ↕  Agent Manager（worktree + 并行开发）                    │
├─────────────────────────────────────────────────────────────────┤
│                    第 1 层：基础设施层                             │
│  LSP  │  Codebase Indexing  │  Skills  │  Auto Model  │ 记忆  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、第 1 层 — 基础设施（地基）

这是当前配置 **最需要补齐** 的层。以下全部集成到 `kilo.json`：

### 2.1 LSP —— 实时代码智能

```jsonc
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
    },
    "python": {
      "command": ["basedpyright-langserver", "--stdio"],
      "extensions": [".py"],
    },
    "rust": {
      "command": ["rust-analyzer"],
      "extensions": [".rs"],
    },
    "golang": {
      "command": ["gopls"],
      "extensions": [".go"],
    },
    "java": {
      "command": ["jdtls"],
      "extensions": [".java"],
    },
    "css": {
      "command": ["vscode-css-language-server", "--stdio"],
      "extensions": [".css", ".scss", ".less"],
    },
  },
}
```

**为什么是宇宙级**：LSP 是当前你配置中 **最大的单一质量缺口**。启用后，agent 在编码过程中可以获得实时类型检查、定义跳转、引用查找、悬停信息——"边写边检查"而非"写完再查"。这是从 A 级到 S 级的关键一步。

### 2.2 Codebase Indexing —— 语义级代码理解

```jsonc
{
  "indexing": {
    "enabled": true,
    "embeddings": "qwen/qwen3-embedding", // 或 "kilo-auto/balanced"
  },
}
```

Kilo 内置了基于 Tree-sitter 的语义索引系统，将代码块转为向量存入 Qdrant，支持自然语言语义搜索。效果举例：

- 提问 "用户认证逻辑" → 自动找到 `src/auth/login.ts`、`src/middleware/auth.ts`、`src/hooks/useAuth.ts`
- 提问 "处理支付回调的代码" → 找到 `src/api/webhook/payment.ts`

**当前配置缺失**：你虽然有 context7 MCP 但那是查外部文档。内置的 **codebase_search** 工具能搜索你自己的代码库，这对大型系统至关重要。

### 2.3 Skills —— 领域知识注入系统

在 `.kilo/skill/` 下按领域组织：

```
.kilo/skill/
├── project-architecture/
│   └── SKILL.md           # 项目整体架构、模块划分、目录约定
├── coding-standards/
│   └── SKILL.md           # 代码规范、命名规则、测试要求
├── database/
│   └── SKILL.md           # 数据库 Schema、ORM 约定、迁移策略
├── api-design/
│   └── SKILL.md           # API 路由设计、错误处理格式、版本策略
├── security/
│   └── SKILL.md           # 安全红线：输入校验、权限模型、敏感信息处理
└── deployment/
    └── SKILL.md           # 部署流程、环境配置、CI/CD 约定
```

每个 SKILL.md 都带 YAML frontmatter：

```markdown
---
name: coding-standards
description: 项目代码规范和最佳实践
---
```

**为什么是宇宙级**：Skills 是 Kilo 的"注入式知识"机制。没有 skills，agent 只能模型记忆。有了 skills，agent 就知道"本项目用 pnpm 而非 npm"、"API 错误格式统一为 `{code, message, details}`"——这相当于把你的团队 Wiki 直接灌进 agent 大脑。

### 2.4 Auto Model —— 任务自适应路由

```jsonc
{
  "model": "deepseek/deepseek-v4-pro",
  "small_model": "minimax-cn-coding-plan/MiniMax-M2.7-highspeed",
}
```

当前建议：

```
高复杂度 / 规划 / 审查 / 多轮推理 → `deepseek/deepseek-v4-pro`
轻量探索 / 简单改动 / 低成本任务   → `minimax-cn-coding-plan/MiniMax-M2.7-highspeed`
```

**与当前配置的关系**：当前仓库先采用“高精度默认 + 轻量补位”的稳定策略。若后续 Kilo 官方提供成熟、可验证的自动路由能力，再评估是否替换。

### 2.5 记忆系统

当前更可靠的长期记忆方式是：`AGENTS.md` + 项目级 skills / commands + 会话管理。

| 机制               | 作用                                           | 持久化范围       |
| ------------------ | ---------------------------------------------- | ---------------- |
| `AGENTS.md`        | 项目级持久上下文：架构决策、编码规范、重要约定 | 跨所有会话       |
| `.kilo/skills/`    | 项目级知识包：架构、契约、领域模型、测试策略   | 跨所有会话       |
| `.kilo/commands/`  | 项目级工作流：review、test、trace、architect   | 跨所有会话       |
| Session 快照       | 单个会话的完整上下文                           | 单次会话生命周期 |
| Context Condensing | 长会话智能压缩历史                             | 自动触发         |

**当前缺失**：不是 `learned/`，而是足够强的项目级 `AGENTS.md`、skills 和 commands。

---

## 三、第 2 层 — 智能体编排

你当前的编排层架构已经很优秀，以下是升级点：

### 3.1 插件系统 —— 自定义工具 + 生命周期钩子

这是 Kilo 官方提供的最强大但最被低估的特性。在 `.kilo/plugin/` 下编写 TypeScript 插件：

```typescript
// .kilo/plugin/my-tools.ts
import { type Plugin, tool } from "@opencode-ai/plugin"

export default (async (ctx) => {
  return {
    // 自定义工具：查询内部 API
    tool: {
      query_internal_api: tool({
        description: "查询内部微服务 API 文档和端点信息",
        args: {
          service: tool.schema.string().describe("服务名称，如 user-service"),
          endpoint: tool.schema.string().optional().describe("端点路径"),
        },
        async execute({ service, endpoint }) {
          // 读取内部 API 规范文档
          const spec = await fetch(`http://api-specs/${service}/openapi.json`)
          const data = await spec.json()
          return JSON.stringify(data.paths[endpoint] ?? data.paths, null, 2)
        },
      }),

      // 自定义工具：读取 Sentry 错误
      get_sentry_errors: tool({
        description: "获取指定时间范围内的 Sentry 错误列表",
        args: {
          hours: tool.schema.number().describe("过去多少小时").default(24),
          level: tool.schema.string().optional().describe("错误级别"),
        },
        async execute({ hours, level }) {
          // 调用 Sentry API
          const url = `https://sentry.io/api/0/projects/.../events/?statsPeriod=${hours}h${level ? `&level=${level}` : ''}`
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${process.env.SENTRY_TOKEN}` }
          })
          return await res.text()
        },
      },
    },

    // 拦截 LLM 参数：编码 agent 用低温度
    "chat.params": async (input, output) => {
      if (input.agent === "engineer") output.temperature = 0.1
      if (input.agent === "architect") output.temperature = 0.7
      if (input.agent === "executor-cx") output.temperature = 0.3
    },

    // 拦截权限：危险命令自动拒绝
    "permission.ask": async (permission, output) => {
      if (permission.tool === "bash") {
        const cmd = permission.patterns.join(" ")
        if (cmd.includes("rm -rf") || cmd.includes("drop table") || cmd.includes(":(){ :|:& };:")) {
          output.status = "deny"
        }
      }
    },

    // 事件响应示意：更适合做日志、审计或提示，而不是自动改写长期规则文件
    event: async ({ event }) => {
      if (event.type === "message.completed") {
        // 在这里记录审计日志或触发外部通知
      }
    },
  }
}) satisfies Plugin
```

**支持的插件功能全景**：

| 钩子             | 作用                                                |
| ---------------- | --------------------------------------------------- |
| `tool`           | 注册自定义工具，agent 可自动调用                    |
| `chat.params`    | 拦截每次 LLM 调用，修改 temperature / max_tokens 等 |
| `permission.ask` | 自定义权限策略（比 kilo.json 更细粒度）             |
| `event`          | 监听 session.completed / message.completed 等事件   |

### 3.2 Agent Manager —— Worktree 并行开发

当前你已经有 ensemble / executor 的设计，但所有 executor 的 `worktree` 字段（`dp` / `minimax` / `kimi`）目前可能未与真实的 `git worktree` 机制联动。

正确的 worktree 工作流：

```
创建 worktree → 并行实现 → 自测 → 合并回主分支
                         ↓
                   失败时隔离，不污染主工作区
```

需要补充的内容：在 `engineer.md` 和 executor agent 的 prompt 中，明确说明 worktree 路径规则、合并策略、冲突处理流程。当前 `engineer` 没有 worktree 相关的提示，它是在主分支直接修改的。

### 3.3 自定义命令体系 —— 高频操作捷径

在 `.kilo/command/` 下创建：

```yaml
# .kilo/command/test.md
---
description: Run tests for the project and fix failures
agent: engineer
---
Run the test command for this project: `$1`.
If tests fail, analyze the failures and fix them.
After fixing, run tests again to confirm all pass.
```

```yaml
# .kilo/command/review.md
---
description: Review the current changes
agent: reviewer
---
Review the current git diff against the main branch.
Focus on: correctness, security, edge cases, and performance.
```

```yaml
# .kilo/command/architect.md
---
description: Design architecture for a feature
agent: architect
---
Design the architecture for: $ARGUMENTS
Output: module decomposition, interfaces, data flow, risk assessment.
```

**使用效果**：在对话中直接输入 `/test`、`/review`、`/architect user auth system` 即可触发。

---

## 四、第 3 层 — MCP 外部能力层

这是将你的智能体从"代码编辑器"升级为"全栈自动开发者"的核心。

### 4.1 必装 MCP 服务器

| MCP 服务器     | 能力                                               | 配置方式                                        |
| -------------- | -------------------------------------------------- | ----------------------------------------------- |
| **Playwright** | 浏览器自动化：导航、点击、截图、表单填写、E2E 测试 | `npx -y @playwright/mcp@latest`                 |
| **GitHub**     | PR 管理、Issue 操作、代码搜索、仓库管理            | `remote: https://api.githubcopilot.com/mcp/`    |
| **Filesystem** | 安全文件读写、目录操作                             | `npx @modelcontextprotocol/server-filesystem .` |
| **Database**   | 数据库 Schema 探查、查询执行（只读）               | 自定义或社区 MCP                                |
| **Docker**     | 容器管理、镜像构建、日志查看                       | 社区 MCP                                        |

完整配置：

```jsonc
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest"],
      "enabled": true,
      "timeout": 60000,
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:GITHUB_PAT}",
      },
      "timeout": 30000,
    },
  },
}
```

### 4.2 Playwright 带来的宇宙级能力

启用 Playwright MCP 后，你的 agent 可以：

- **E2E 测试自动修复**：运行 Playwright 测试 → 截图分析失败 → 修复代码 → 重新验证
- **UI 变更自检**：修改前端代码后，自动打开浏览器截图验证
- **跨服务流程测试**：自动填写表单、点击按钮、验证跳转

这是从"纯代码智能体"升级到"行为验证智能体"的关键。

### 4.3 自定义 MCP 服务器（自己写）

当 Kilo Plugin 不够用时，可以编写自己的 MCP 服务器暴露给 agent：

```typescript
// my-mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  {
    name: "my-corp-tools",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "query_internal_knowledge_base",
      description: "查询内部知识库",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "query_internal_knowledge_base") {
    // 调用内部知识库 API
    return {
      content: [{ type: "text", text: "查询结果..." }],
    };
  }
  throw new Error("Unknown tool");
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 五、第 4 层 — CI/CD 与协作

### 5.1 GitHub Actions 集成

```yaml
# .github/workflows/kilo-auto-fix.yml
name: Kilo Auto Fix

on:
  issue_comment:
    types: [created]

jobs:
  kilo:
    if: contains(github.event.comment.body, '/kc')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - name: Run Kilo
        uses: Kilo-Org/kilocode/github@latest
        with:
          model: deepseek/deepseek-v4-pro
          kilo_api_key: ${{ secrets.KILO_API_KEY }}
```

效果：在 GitHub PR 中评论 `/kc fix the bug in login flow` → Kilo 自动分析 → 修改代码 → 提交到 PR。

### 5.2 自动化 Code Review Pipeline

当 PR 创建时，自动触发 Kilo Code Review Agent，从以下维度审查：

- 安全扫描（review-security）
- 架构合规（review-architecture）
- 简化审查（review-simplification）
- 测试覆盖率检查

### 5.3 Autonomous Mode 批处理

```bash
# 定时自动执行维护任务
kilo run --auto "Run security audit on the codebase and fix critical vulnerabilities"
kilo run --auto "Update all dependencies to latest compatible versions"
kilo run --auto "Generate API documentation from OpenAPI specs"
```

---

## 六、Agent Prompt 升级方向

当前 `agent/*.md` 的 prompt 已经很优秀，但以下方向可以升级：

### 6.1 Engineer —— 加入 LSP 感知

```markdown
## 编码流程（升级版）

1. **读取**：先读相关文件、LSP 诊断、codebase search
2. **定位**：使用 LSP 工具获取类型定义和引用关系
3. **编码**：增量修改，优先复用现有资产
4. **验证**：运行测试 + 类型检查 + Lint + 构建
5. **修复**：根据 LSP 诊断和测试失败信息精准修复
6. **自检**：运行 LSP 检查确认无新错误
```

### 6.2 Architect —— 加入 codebase search 感知

```markdown
## 设计前强制步骤

1. 使用 codebase_search 按功能语义搜索现有实现
2. 使用 LSP 追踪关键函数的调用链和引用关系
3. 使用 Grep 扫描配置文件和类型定义
4. 使用 Glob 发现所有相关文件
```

### 6.3 新增 —— `auto-fix` agent

专门针对"运行测试/构建 → 失败 → 修复"循环的专用 agent，配合 Playwright MCP 做端到端验证修复。

---

## 七、宇宙级配置最终形态

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",

  // === 模型路由 ===
  "model": "deepseek/deepseek-v4-pro",
  "small_model": "minimax-cn-coding-plan/MiniMax-M2.7-highspeed",
  "default_agent": "coderAgent",

  // === 代码智能 ===
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
    },
    "python": {
      "command": ["basedpyright-langserver", "--stdio"],
      "extensions": [".py"],
    },
    "rust": { "command": ["rust-analyzer"], "extensions": [".rs"] },
    "golang": { "command": ["gopls"], "extensions": [".go"] },
  },

  // === MCP 外部能力 ===
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest"],
      "enabled": true,
      "timeout": 60000,
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:GITHUB_PAT}" },
      "timeout": 30000,
    },
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true,
      "timeout": 8000,
    },
  },

  // === 自定义命令 ===
  "command": {
    "test": {
      "template": "Run tests and fix any failures",
      "description": "Run and fix tests",
      "agent": "engineer",
    },
    "review": {
      "template": "Review current changes for $ARGUMENTS",
      "description": "Code review",
      "agent": "reviewer",
    },
    "architect": {
      "template": "Design architecture for: $ARGUMENTS",
      "description": "Architecture design",
      "agent": "architect",
    },
    "fix": {
      "template": "Fix: $ARGUMENTS",
      "description": "Fix issues",
      "agent": "engineer",
    },
    "deploy": {
      "template": "Deploy to $1 environment",
      "description": "Deploy application",
      "agent": "engineer",
    },
  },

  // === 权限精细控制 ===
  "permission": {
    "bash": {
      "npm *": "allow",
      "pnpm *": "allow",
      "yarn *": "allow",
      "git *": "allow",
      "docker *": "ask",
      "rm *": "ask",
      "*": "ask",
    },
    "edit": {
      "*.md": "allow",
      "*.ts": "allow",
      "*.tsx": "allow",
      "*.json": "allow",
      ".env*": "deny",
      "*": "ask",
    },
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "task": "allow",
  },

  // === 上下文管理 ===
  "instructions": [
    "./.kilo/instructions/core.md",
    "./.kilo/instructions/workflow.md",
  ],
  "snapshot": true,
  "compaction": { "auto": true, "prune": true },

  // === Provider ===
  "provider": {
    "hsyq": {
      "name": "hsyq",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://ark.cn-beijing.volces.com/api/plan/v3" },
      "models": {
        "glm-5.1": { "name": "glm-5.1", "reasoning": true },
        "kimi-k2.6": { "name": "kimi-k2.6", "reasoning": true },
        "doubao-seed-2.0-mini": { "name": "doubao-seed-2.0-mini" },
      },
    },
  },
}
```

---

## 八、实施路线图

| 阶段                      | 内容                                                                                         | 预计效果提升                         |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Phase 1（已执行）**     | 主模型切换为高精度优先路由 + 保留轻量模型处理轻任务 + 继续使用 `context7` 作为文档入口       | 复杂任务理解更稳，中文推理质量提升   |
| **Phase 2（已执行）**     | 提供项目级智能包模板（`AGENTS.md` + `.kilo/skills/` + `.kilo/commands/`） + 提供全局命令骨架 | 项目上下文可复制、可沉淀、可持续增强 |
| **Phase 3（待项目接入）** | 按真实项目补齐 3-5 个高价值 skills，并启用项目级 `/test`、`/review`、`/trace`、`/architect`  | agent 对具体系统的理解显著提升       |
| **Phase 4（按需启用）**   | 配置 GitHub MCP、Playwright MCP、Managed Indexing / Codebase Indexing                        | 从静态代码理解扩展到协作与行为验证   |
| **Phase 5（后置）**       | 插件、生命周期扩展、自定义 MCP、CI/CD 自动化审查                                             | 面向超大系统的深度定制与自动化闭环   |

---

## 九、与当前配置的差距总结

| 能力                  | 当前状态                 | 宇宙级状态                       | 差距         |
| --------------------- | ------------------------ | -------------------------------- | ------------ |
| **LSP 代码智能**      | ❌ 未启用                | ✅ 多语言 LSP 实时诊断           | **关键缺口** |
| **Codebase Indexing** | ❌ 未启用                | ✅ 语义搜索整个代码库            | **关键缺口** |
| **Skills 知识注入**   | 🟡 已有模板，待项目填充  | ✅ 5+ 领域 Skill 文件            | **关键缺口** |
| **Plugin 系统**       | ❌ 暂未启用              | ✅ 自定义工具 + 生命周期         | **后置能力** |
| **Auto Model 路由**   | 🟡 高精度默认 + 轻量补位 | ✅ 按任务自适应模型路由          | **显著提升** |
| **Playwright MCP**    | ❌ 未启用                | ✅ 浏览器自动化和 E2E 验证       | **能力扩展** |
| **自定义命令**        | 🟡 已提供全局骨架        | ✅ /test /review /architect      | **效率提升** |
| **GitHub MCP**        | 🔴 `enabled: false`      | ✅ 启用 + PAT 认证               | **配置调整** |
| **权限精细控制**      | 🟡 bash 全放行           | ✅ 分级 glob 匹配                | **安全提升** |
| **CI/CD 集成**        | ❌ 未配置                | ✅ GitHub Actions + Auto Review  | **能力扩展** |
| **记忆系统**          | 🟡 AGENTS.md + 项目模板  | ✅ 项目知识包 + 经确认的长期规则 | **补全**     |
| **Ensemble 多模型**   | ✅ 优秀                  | ✅ 保持，补全 worktree 联动      | **微调**     |

---

## 十、最终结论

你的当前配置在 **ensemble 多模型并行** 和 **编排系统** 上已经处于 Kilo 生态中非常前沿的水平。要到达"宇宙级"，核心需要补足的并非更多的 agent，而是 **基础设施层的 4 大件**：

1. **项目级 Skills / Commands / AGENTS** → 先让 agent 懂你的项目
2. **Indexing / GitHub / Playwright** → 再补足检索、协作和行为验证
3. **插件与自动化** → 最后做深度定制和自动化闭环
4. **多模型编排** → 继续保留，但只用于高复杂度和高风险任务

这 4 个能力的组合，加上你已经有的 ensemble 多模型 + reviewer 专审体系 + checker 门禁，将构成一个 **在 Kilo 生态中达到顶级水准的通用编码智能体系统**。
