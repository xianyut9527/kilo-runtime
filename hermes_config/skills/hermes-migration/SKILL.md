---
name: hermes-migration
description: Kilo → Hermes Agent 迁移工具包。当用户决定全面 Hermes 化（C 档方案）时使用。包含迁移映射表、SOUL.md 模板、config.yaml 模板、skills 迁移步骤、MCP 迁移步骤、模型路由迁移、验证清单。迁移后保留 Kilo 编排哲学精华，获得 Hermes 47 工具+execute_code+session_search+prompt caching+delegate_task+checkpoint+RL 训练等框架级 SOTA 能力。
keywords:
  - hermes
  - migration
  - soul
  - config-yaml
  - delegate-task
  - execute-code
  - session-search
  - prompt-caching
  - checkpoint
  - rl-training
  - acp
  - vscode
  - trae
  - 迁移
  - Hermes
  - C 档
license: MIT
compatibility:
  - hermes-agent >= 2026
  - target: hermes-agent >= 2026
  - requires WSL2 on Windows
metadata:
  version: "1.0"
  category: workflow
---

# Kilo → Hermes 迁移工具包

> 当用户决定全面 Hermes 化（C 档方案）以获得框架级 SOTA 能力时使用本技能。
> 迁移后保留 Kilo 编排哲学精华（T0-T3 定级、7 节点流程日志、checker/reviewer 门禁），获得 Hermes 47 工具+execute_code+session_search+prompt caching+delegate_task+checkpoint+RL 训练。

## 关键认知：kilo 与 Hermes 的关系

**kilo 与 Hermes 是两套独立的 AI Agent 框架**，不是同一套系统的不同配置。

- **kilo** 是旧的 Agent 运行时（基于 `kilo.json` + `AGENTS.md` + `.kilo/instructions/`）
- **Hermes** 是新的 Agent 运行时（基于 `config.yaml` + `SOUL.md` + 47 工具）
- Hermes 启动时可以**参考/继承** kilo 里沉淀的编排规则、skills、memory，但运行时互不依赖
- 把 kilo 的精华迁移到 Hermes 后，Hermes 的 `config.yaml` 里可能还残留指向 kilo 目录的 `external_dirs`，这只是配置层面的快捷方式，**删除后不影响 Hermes 独立运行**

> 一句话：旧车的零件和驾驶经验已经搬到新车上了，但两辆车的发动机、油箱、电路系统是独立的。

## 何时使用本技能

- 用户明确要求"全面 Hermes 化"或"抛弃 Kilo 用 Hermes"
- 用户价值排序为"质量 > 工具忠诚度"
- 用户愿意安装 WSL2（Windows）或已在使用 Linux/macOS

## 迁移映射表

| Kilo 当前 | Hermes 化后 | 迁移方式 |
|-----------|-------------|----------|
| `AGENTS.md`（全局指令入口） | `.hermes.md` 或 `AGENTS.md`（Hermes 自动发现两者） | 直接复用 |
| `.kilo/instructions/core.md` + `workflow-core.md` + `reflection.md` | `~/.hermes/skills/workflow/SKILL.md`（按需加载技能） | 转为 Hermes skill，渐进式披露 |
| `agent/coderAgent.md`（主控 prompt） | `SOUL.md`（Hermes 身份文件，系统提示首个组成部分） | 核心身份写入 SOUL.md |
| `agent/engineer.md` / `checker.md` / `reviewer.md` 等 subagent | Hermes `delegate_task` 委派模板（每次委派传 goal+context+toolsets） | 13 个 agent 文件 → 委派模板片段 |
| `kilo.json` provider 配置 | Hermes `config.yaml` custom endpoint（OpenAI 兼容） | base_url + api_key 迁移 |
| `.kilo/skills/patterns` + `anti-patterns` + `workflow` | `~/.hermes/skills/`（与 Hermes 内置技能同级） | 直接复制，frontmatter 已对齐 agentskills.io |
| `.kilo/memory/MEMORY.md` + `USER.md` | Hermes 原生 `MEMORY.md` + `USER.md`（完全兼容，2200/1375 字符限制一致） | 直接复用 |
| `kilo.json` compaction 配置 | Hermes `config.yaml` compression（threshold/target_ratio/protect_last_n） | 参数迁移，算法更强 |
| GitNexus MCP | Hermes MCP 集成（stdio/HTTP） | `mcp_servers` 配置迁移 |
| T0-T3 定级 + 7 节点流程日志 | SOUL.md 中的编排规则 + skills 中的工作流规则 | **核心编排哲学完整保留** |
| checker/reviewer 门禁循环 | delegate_task 创建子代理做验证（独立上下文） | 用 Hermes 的真独立子代理实现 |
| `kilo_local_recall` 跨会话搜索 | Hermes `session_search`（SQLite+FTS5 全文检索所有会话） | Hermes 原生更强 |

## 迁移步骤

### 1. 安装 Hermes

```bash
# Linux / macOS / WSL2
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
```

### 2. 配置 provider

```bash
hermes model    # 选 custom endpoint
```

或手动编辑 `~/.hermes/config.yaml`：

```yaml
provider:
  custom:
    base_url: "https://huixin.nat100.top/v1"  # 从 kilo.json provider.hx.options.baseURL 迁移
    api_key: "${HX_API_KEY}"
    model: "kimi-k2.7-code"  # 主模型
```

### 3. 生成 SOUL.md（从 coderAgent.md 提取）

```bash
mkdir -p ~/.hermes
cat > ~/.hermes/SOUL.md << 'EOF'
# 编码智能体身份

你是默认入口和流程主控。只做需求澄清、路由、上下文传递、验证跟踪和最终交付；不直接编码。

## 编排规则（从 Kilo 迁移）

- 意图判定优先：咨询类只分析不改文件；执行类进入定级流程。
- T0-T3 定级：T0 极速通道（≤2行无逻辑）；T1 单元闭环；T2 跨模块+architect；T3 安全敏感+ensemble。
- 7 节点流程日志：意图判定→定级→pre-checker→engineer→checker→fixer→reviewer。
- checker/reviewer 门禁循环：engineer 不自验，必须过 checker；T1+ 必须过 reviewer。
- SCOPE_CREEP 反向核对：checker L2 扫描 diff 中验收标准未声明的改动。
- 验收映射表：每条验收标准 → 实现位置 → 验证方式 → 边界覆盖 → 状态。
- 同症状防空转：连续 2 轮 fixer 命中同症状 → 自动升级 reviewer。
- 自进化触发：方法层/需求层失败、用户反馈"不对"→ 调用 session_search 检索历史。

## 独立上下文声明

委派 subagent 时必须传完整 context（goal+context+toolsets），subagent 不继承父会话。
EOF
```

### 4. 迁移 skills

```bash
# Kilo skills 已对齐 agentskills.io 标准，直接复制
cp -r .kilo/skills/* ~/.hermes/skills/
```

### 5. 迁移 memory

```bash
cp .kilo/memory/MEMORY.md ~/.hermes/memories/MEMORY.md
cp .kilo/memory/USER.md ~/.hermes/memories/USER.md
```

### 6. 迁移 MCP

编辑 `~/.hermes/config.yaml`：

```yaml
mcp_servers:
  gitnexus:
    command: npx
    args: ["gitnexus", "mcp"]
```

### 7. 配置 compression（升级版）

```yaml
compression:
  enabled: true
  threshold: 0.50        # 50% 触发（比 Kilo 70% 更早，Hermes 算法更强）
  target_ratio: 0.20
  protect_last_n: 20     # 对齐 Kilo tail_turns:20
```

### 8. 编辑器集成

#### VS Code（ACP，完整体验）

```bash
pip install -e '.[acp]'
hermes acp
```

在 VS Code 配置 ACP 客户端指向 Hermes。

#### Trae（两种路径）

1. **ACP 原生**（若 Trae 支持）：Trae 设置 → 搜索 "ACP" 或 "Agent Client Protocol" → 配置 `hermes acp` 端点。
2. **API 服务器**（通用后备）：`hermes api-server`，在 Trae AI 面板配置自定义 OpenAI 端点指向 `http://localhost:PORT/v1`。质量不变，编辑器集成降级（无文件 diff 视图）。

### 9. 验证

```bash
hermes doctor    # 诊断配置
hermes           # 启动，确认欢迎横幅显示模型/工具/技能
```

试跑一个真实编码任务，对比 Kilo 的输出质量。

## 迁移后获得的 SOTA 能力

| 能力 | Kilo | Hermes | 质量影响 |
|------|------|--------|----------|
| execute_code | ❌ | ✅ | 多步骤压缩成 1 次 LLM 往返，推理预算翻倍 |
| session_search | kilo_local_recall（轻量） | ✅ SQLite+FTS5 | 跨所有会话全文检索 |
| prompt caching | ❌ | ✅ Anthropic system_and_3 | 省 75% input token |
| 双层结构化压缩 | 单层 | ✅ 网关85%+代理50% | 长任务不丢关键决策 |
| 真独立子代理 | prompt 声明 | ✅ delegate_task | 子代理全新上下文+独立终端 |
| checkpoint/rollback | ❌ | ✅ /rollback | 改坏了能一键回滚 |
| 47 工具+19 工具集 | ~10 工具 | ✅ | 浏览器/终端/Docker/SSH/MCP |
| RL 训练+轨迹生成 | ❌ | ✅ Atropos | 真正的"自进化" |
| Skills Hub | external_dirs | ✅ 7 个注册中心 | openai/skills、anthropics/skills、skills.sh... |

## 迁移后解耦 kilo（关键收尾步骤）

迁移完成后，Hermes 的 `config.yaml` 里可能还残留指向 kilo 目录的 `external_dirs` 引用，例如：

```yaml
skills:
  external_dirs:
    - ~/.agents/skills
    - ~/.config/kilo/.kilo/skills   # ← 迁移后应移除
```

这条引用只是配置层面的快捷方式，让 Hermes 启动时额外扫描 kilo 目录。由于 Hermes 本地 `~/.hermes/skills/` 已经完整复制了 kilo 的精华（甚至可能比 kilo 目录的版本更新），保留该引用会带来**隐式不同步风险**而没有任何收益。

### 解耦步骤

1. **备份原配置**
   ```bash
   cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak.$(date +%Y%m%d-%H%M%S)
   ```

2. **移除 kilo 引用**
   ```yaml
   skills:
     external_dirs:
       - ~/.agents/skills
   # 删除 ~/.config/kilo/.kilo/skills
   ```

3. **验证无 kilo 残留**
   ```bash
   grep -i kilo ~/.hermes/config.yaml || echo 'NO_KILO_REFS'
   ```

4. **验证本地 skills 完整**
   ```bash
   ls ~/.hermes/skills/
   # 至少包含：anti-patterns、patterns、workflow、hermes-migration
   ```

5. **验证 memory 一致**
   ```bash
   diff -q ~/.hermes/memories/MEMORY.md <kilo-repo>/.kilo/memory/MEMORY.md
   diff -q ~/.hermes/memories/USER.md <kilo-repo>/.kilo/memory/USER.md
   ```

### 解耦后的架构边界

| 组件 | Hermes 路径 | kilo 路径 | 关系 |
|------|-------------|-----------|------|
| 运行时配置 | `~/.hermes/config.yaml` | `kilo.json` | 独立 |
| 记忆数据库 | `~/.hermes/memory_store.db` | 无 | 独立 |
| 冻结记忆 | `~/.hermes/memories/` | `.kilo/memory/` | Hermes 已复用，需显式同步 |
| skills | `~/.hermes/skills/` | `.kilo/skills/` | Hermes 已复制，不再依赖扫描 |
| 跨会话搜索 | `session_search` | `kilo_local_recall`（规划） | 独立且更强 |

> 一句话：解耦后 kilo 仓库可以作为**历史备份/参考源**，但 Hermes 不再通过 `external_dirs` 隐式依赖它。后续若要从 kilo 同步更新，应 diff 后显式合并到 `~/.hermes/skills/` 和 `~/.hermes/memories/`。

## 迁移后性能优化

迁移解耦完成后，建议进一步开启 Hermes 的自动记忆提取和核心工具集，把框架潜力释放出来。

> 完整快照见 `references/hermes-config-snapshot.yaml`。

### 推荐配置

```yaml
delegation:
  max_iterations: 50
  default_toolsets:
    - terminal
    - file
    - web
    - browser
    - code_exec

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  provider: holographic

plugins:
  enabled:
    - hermes-memory-store
  hermes-memory-store:
    db_path: null
    auto_extract: true
    default_trust: 0.5
```

### 关键变更说明

| 配置 | 作用 |
|------|------|
| `browser` 工具集 | 需要查网页/调试前端时默认可用 |
| `code_exec` 工具集 | 复杂多步逻辑通过 Python 脚本一次完成 |
| `hermes-memory-store` plugin | 自动从对话中提取事实写入 `fact_store` |
| `auto_extract: true` | 记忆管理从手动变为半自动 |

### 验证命令

```bash
hermes config check
hermes skills list
hermes
```

## 团队/多设备同步清单

将 Hermes 配置复制到新设备或分发给团队时，同步以下文件即可保证编码一致性：

```bash
# 安装 Hermes
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# 同步配置
rsync -av ~/.hermes/config.yaml        <target>~/.hermes/
rsync -av ~/.hermes/SOUL.md            <target>~/.hermes/
rsync -av ~/.hermes/.hermes.md         <target>~/.hermes/
rsync -av ~/.hermes/memories/          <target>~/.hermes/memories/
rsync -av ~/.hermes/skills/            <target>~/.hermes/skills/

# 安装依赖
npm install -g gitnexus

# 在新设备上设置环境变量
export NAT100_API_KEY=<key>   # 或 KIMI_API_KEY，取决于 provider

# 验证
hermes config check
hermes
```

> 环境变量（`NAT100_API_KEY` / `KIMI_API_KEY`）不包含在配置文件中，需单独分发。

## 回退方案

迁移后若质量不如预期，可回退到 Kilo B 档配置（当前仓库状态）。Kilo 配置仓库作为"编排规则备份"保留。