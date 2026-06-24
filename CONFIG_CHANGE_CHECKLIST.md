# 配置变更检查清单

> 用于修改全局配置时保持单一事实来源和跨文件一致性。

## 单一事实来源

| 信息类型 | 主文档 | 其他位置 |
|---------|--------|----------|
| 智能体清单与架构设计 | `AGENTS.md` | 只做索引或引用 |
| 运行时通用规则 | `.kilo/instructions/*.md` | agent 只引用，不复制正文 |
| 单个 agent 职责差异 | `agent/{name}.md` | 不维护全局流程 |
| 模型、权限、MCP | `kilo.json` | `README.md` 只说明 |
| 安装脚本 | `install.sh` / `install.ps1` | 双平台同步 |
| 目录结构 | `README.md` | 必须与文件系统一致 |
| 程序化记忆 | `.kilo/memory/*.md` | 仅在本文档做引用 |

## 修改检查

| 修改内容 | 必查项 |
|---------|--------|
| 新增/删除/改名 agent | 同步 `AGENTS.md` 清单、`README.md` 目录树、`agent/` 文件（必须含完整 YAML frontmatter：`description` / `mode` / `hidden` / `color` / `permission` / `steps`），参考现有 `agent/architect.md` 或 `agent/review-security.md` 的写法 |
| 修改 `.kilo/instructions/*` | 检查 agent 是否只引用规则源，没有复制旧规则 |
| 修改 `agent/*.md` | 确认只包含该 agent 的职责差异和关键门禁 |
| 修改 `kilo.json` | 同步 `README.md` 中模型、MCP、instructions 说明 |
| 修改安装脚本 | `install.sh` 与 `install.ps1` 保持路径和复制逻辑一致 |

### 程序化记忆相关

- [ ] 修改 `.kilo/memory/` 模板时是否同步 README.md 目录树？
- [ ] 修改 memory 触发条件时是否同步 `.kilo/instructions/workflow.md` 的「程序化记忆触发条件」章节？
- [ ] 是否同步更新 `agent/coderAgent.md` / `agent/skills-writer.md` / `agent/reviewer.md` 的相关职责描述？

## 已集中维护的规则

- fixer 轮次、升级阈值、Circuit Breaker：`.kilo/instructions/workflow.md`
- 三层错误恢复：`.kilo/instructions/reflection.md`
- 交付和验证底线：`.kilo/instructions/core.md` + `workflow.md`
- 需求扩散、同类点扫描、局部补丁拦截：`.kilo/instructions/workflow.md`
- 修复方法论（全链路审计、完整阅读、验证剩余路径、推测与验证区分）：`.kilo/instructions/workflow.md` + `core.md` + `reflection.md`
- pre-checker 预审、checker 分层、fixer 权限约束：`.kilo/instructions/workflow.md`
- Skills 生命周期管理（触发条件、回写流程、分类规范）：`.kilo/instructions/skills-lifecycle.md`
- **memory 触发条件** → 集中维护在 `.kilo/instructions/workflow.md`「程序化记忆触发条件」章节和 `.kilo/memory/README.md`；其他文件只做引用。
- **SKILL.md frontmatter 规范**（agentskills.io 合规）→ 集中维护在 `.kilo/instructions/core.md` 和 `.kilo/skills/*/SKILL.md`；name 必须与目录名一致。

修改这些规则时，优先改主文档；agent 文件只保留必要引用和角色化执行要求。

> 与 `AGENTS.md`「修改本仓库时的注意事项」章节交叉对照；两份清单内容必须保持一致。