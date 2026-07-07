# Hermes Agent 配置同步指南

统一团队/多设备编码体验，一键同步当前 Hermes 配置资产。

---

## 1. 目录结构

```text
repo/
├── hermes_config/        ← 团队通用配置（同步这个目录）
│   ├── config.yaml
│   ├── SOUL.md
│   ├── .hermes.md
│   └── skills/
├── templates/            ← 可选个人模板（仅首次安装初始化）
│   └── memories/
│       ├── MEMORY.md
│       └── USER.md
├── HERMES-GUIDE.md       ← 本文件
├── install-hermes.sh     ← Linux/macOS 同步脚本
└── install-hermes.ps1    ← Windows 同步脚本
```

---

## 2. 设计原则

**Hermes 配置 ≠ 个人记忆**

| 内容 | 是否团队同步 | 说明 |
|------|-------------|------|
| config.yaml | ✅ 团队通用 | 模型、provider、toolsets、MCP |
| SOUL.md | ✅ 团队通用 | 编码智能体身份与强制流程 |
| .hermes.md | ✅ 团队通用 | 项目上下文规则 |
| skills/ | ✅ 团队通用 | 共享反模式、模式、工作流 |
| memories/ | ❌ 个人本地 | 仅首次安装时从 templates/ 初始化，后续不覆盖 |

**为什么 memories 不团队同步？**

Hermes 的真实记忆主要存储在 SQLite 数据库（`memory_store.db`、`state.db`、`sessions/`）和 holographic provider 中。`MEMORY.md` / `USER.md` 只是启动时注入系统提示的**静态补充**，属于个人/设备本地资产。强制团队同步会互相覆盖个人经验。

---

## 3. 新设备安装

### 3.1 安装 Hermes

```bash
# Linux / macOS / WSL2
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# Windows (Python pip)
pip install hermes-agent
```

### 3.2 设置 API Key

```bash
# Linux / macOS / WSL2
export NAT100_API_KEY="your-key"

# Windows PowerShell
$env:NAT100_API_KEY="your-key"
```

### 3.3 同步配置

```bash
# Linux / macOS / WSL2
./install-hermes.sh

# Windows
.\install-hermes.ps1
```

脚本行为：
- 全量覆盖 `config.yaml`、`SOUL.md`、`.hermes.md`、`skills/`
- **仅在 `~/.hermes/memories/` 不存在时**，从 `templates/memories/` 复制模板
- 保留 Hermes 运行时数据：`sessions/`、`memory_store.db`、`state.db`、`logs/` 等

### 3.4 验证

```bash
hermes config check
hermes doctor
hermes
```

---

## 4. 手动同步清单

不想用脚本时，复制这些文件到 `~/.hermes/`（Windows 是 `%LOCALAPPDATA%\hermes\`）：

| 文件/目录 | 目标 | 是否覆盖 |
|-----------|------|---------|
| `hermes_config/config.yaml` | `~/.hermes/config.yaml` | ✅ 覆盖 |
| `hermes_config/SOUL.md` | `~/.hermes/SOUL.md` | ✅ 覆盖 |
| `hermes_config/.hermes.md` | `~/.hermes/.hermes.md` | ✅ 覆盖 |
| `hermes_config/skills/` | `~/.hermes/skills/` | ✅ 覆盖 |
| `templates/memories/` | `~/.hermes/memories/` | ❌ 不覆盖（首次初始化） |

---

## 5. 可选：切换官方 Kimi Provider

如 huixin 转发不稳定，替换 `hermes_config/config.yaml` 中 providers 段：

```yaml
providers:
  kimi:
    name: kimi
    base_url: https://api.moonshot.cn/v1
    key_env: KIMI_API_KEY
    default_model: kimi-k2.7-code
    max_output_tokens: 16384
```

并在 `model` 段把 `provider: custom:huixin` 改为 `provider: custom:kimi`。

---

## 6. 编码统一规则

同步后所有设备默认遵循：

1. 意图判定优先
2. T0-T3 任务定级
3. 7 节点流程日志
4. engineer → checker → fixer 闭环
5. reviewer 总体验收
6. SCOPE_CREEP 反向核对
7. 验收必附映射表

---

## 7. 团队协作要点

| 场景 | 操作 |
|------|------|
| 新成员加入 | clone → 设置 key → 运行 install-hermes 脚本 |
| 个人改通用配置 | 改 `hermes_config/` 后提交 |
| 添加新 skill | 放到 `hermes_config/skills/` 后提交 |
| 更新个人记忆 | 各设备本地用 `memory` / `fact_store` 工具维护，不回传仓库 |

---

*最后更新：2026-07-07*
