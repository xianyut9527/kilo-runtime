# 配置变更检查清单

> 本文件用于保障修改全局配置时的跨文档一致性。修改任何配置前请先阅读本节，修改完成后按清单逐项检查。

## 单一事实来源约定

| 信息类型 | 主文档（唯一权威） | 其他位置的规则 |
|---------|------------------|---------------|
| 智能体清单与架构设计 | `AGENTS.md` | 只做索引与引用，不写详细规则 |
| 各智能体详细行为规则 | `agent/{name}.md` | 禁止在其他 agent 文件中重复维护相同规则 |
| 运行时核心规则 | `.kilo/instructions/*.md` | agent 文件只能引用，不能复制规则正文 |
| 配置项（模型、权限、MCP） | `kilo.json` | `README.md` 只做说明，不充当配置源 |
| 安装脚本 | `install.sh` / `install.ps1` | 双平台脚本逻辑必须保持同步 |
| 目录结构说明 | `README.md` | 必须与文件系统完全一致 |

**核心原则**：同一规则只在一处完整维护，其他位置使用链接、引用或索引方式指向主文档。禁止为了方便而复制粘贴规则正文。

## 修改检查矩阵

| 修改的文件 | 必须检查的关联文件 | 检查要点 |
|-----------|------------------|---------|
| `AGENTS.md` | `agent/*.md` | 新增/删除/改名 agent 时，目录文件必须同步存在或移除；职责描述与 frontmatter `description` 必须语义一致 |
| `agent/*.md` 行为规则 | 其他 `agent/*.md` | 跨 agent 协同规则（如 fixer 轮次、升级阈值、三层框架、交付要求）若已在多处出现，修改时必须全量同步 |
| `.kilo/instructions/*.md` | `agent/*.md` | 禁止在 agent 文件中重复维护运行时规则；检查引用是否指向最新路径 |
| `kilo.json` | `README.md` | 模型、MCP、权限说明与 `kilo.json` 实际配置是否一致；instructions 列表是否完整 |
| `install.sh` | `install.ps1` | 双平台脚本的复制路径、目录结构、权限设置是否保持同步 |
| `README.md` 目录树 | 文件系统 | 目录树必须与实际文件系统一致，包括新增/删除的文件和目录层级 |

## 跨文件重复规则（高风险区）

以下规则主题当前在多个 agent 文件中重复维护，**修改时必须全量同步，否则会导致行为不一致**：

1. **fixer 轮次策略**
   - 涉及文件：`agent/coderAgent.md`、`agent/ensemble.md`、`agent/fixer.md`
   - 核心内容：默认 2 轮，第 3 轮条件触发（阻塞问题下降 ≥50% 且局部可修），3 轮后上报 `[BLOCKED]`

2. **升级阈值与 Circuit Breaker**
   - 涉及文件：`agent/coderAgent.md`、`agent/ensemble.md`
   - 核心内容：fixer 3 轮仍 FAIL → reviewer → ensemble → Circuit Breaker 暂停

3. **三层框架（执行层/方法层/需求层）**
   - 涉及文件：`agent/coderAgent.md`、`agent/ensemble.md`、`.kilo/instructions/reflection.md`
   - 核心内容：执行层直接修正、方法层换策略重试最多 2 次、需求层问用户不猜测

4. **交付要求**
   - 涉及文件：`agent/coderAgent.md`、`agent/engineer.md`、`.kilo/instructions/core.md`
   - 核心内容：变更文件/影响范围/验证结果/需求覆盖度对照/遗留风险
