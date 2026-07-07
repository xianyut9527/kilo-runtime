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
├── HERMES-GUIDE.md       ← 本文件
├── install-hermes.sh     ← Linux/macOS 同步脚本
└── install-hermes.ps1    ← Windows 同步脚本
```

---

## 2. 设计原则

**Hermes 配置 ≠ 个人运行时数据**

| 内容 | 是否团队同步 | 说明 |
|------|-------------|------|
| config.yaml | ✅ 团队通用 | 模型、provider、toolsets、MCP |
| SOUL.md | ✅ 团队通用 | 编码智能体身份与强制流程 |
| .hermes.md | ✅ 团队通用 | 项目上下文规则 |
| skills/ | ✅ 团队通用 | 共享反模式、模式、工作流 |

**为什么项目规则必须进版本控制？**

Hermes 的记忆主要存储在 SQLite 数据库（`memory_store.db`、`state.db`、`sessions/`）和 holographic provider 中，这些都是个人/设备本地资产。团队共享的项目规则必须写入 `SOUL.md`、`.hermes.md` 或 `skills/`，才能跨设备同步、可审计、不丢失。

Windows 本地资产路径：`%LOCALAPPDATA%\hermes\`
Linux/macOS 本地资产路径：`~/.hermes/`

团队同步不会覆盖个人运行时数据。

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
- 合并式更新：只覆盖 `SOUL.md`、`config.yaml`、`.hermes.md`、`skills/`
- 自动启用 `config.yaml` 中声明的 plugins（如 `security-guidance`）
- **不触碰个人运行时数据：`.env`、数据库、logs、sessions 等**
- 保留 Hermes 运行时数据：`sessions/`、`memory_store.db`、`state.db`、`logs/` 等

### 3.4 验证

```bash
hermes config check
hermes doctor
hermes
```

---

## 4. 策略说明

本配置采用**单强模型 + 双重验证 + 三视角审查**策略：

- **单强模型**：所有任务默认使用 `kimi-k2.7-code`，不启用多模型路由，避免分配判断引入噪声。
- **双重 checker**：正向 checker 验证需求满足度、语法、逻辑、边界、安全；反向 checker 扫描 SCOPE_CREEP、调试残留、重复实现。
- **三视角 reviewer**：安全 / 架构 / 简化。
- **一次性完成判定**：正向 checker PASS + 反向 checker PASS + reviewer 无 blocker + 无 fixer 轮次。

---

## 5. 手动同步清单

不想用脚本时，复制这些文件到 `~/.hermes/`（Windows 是 `%LOCALAPPDATA%\hermes\`）：

| 文件/目录 | 目标 | 是否覆盖 |
|-----------|------|---------|
| `hermes_config/config.yaml` | `~/.hermes/config.yaml` | ✅ 覆盖 |
| `hermes_config/SOUL.md` | `~/.hermes/SOUL.md` | ✅ 覆盖 |
| `hermes_config/.hermes.md` | `~/.hermes/.hermes.md` | ✅ 覆盖 |
| `hermes_config/skills/` | `~/.hermes/skills/` | ✅ 覆盖 |

**不要复制个人运行时数据。** `.env`、数据库、logs、sessions 等由各设备自己管理。

---

## 6. 可选：切换官方 Kimi Provider

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

## 7. 编码统一规则

同步后所有设备默认遵循：

1. 意图判定优先
2. T0-T3 任务定级
3. 7 节点强制流程日志
4. engineer → 双重 checker（正向 + 反向）→ fixer → reviewer 三视角 闭环
5. SCOPE_CREEP 反向核对
6. 验收必附映射表
7. 一次性完成判定：双重 checker PASS + reviewer 无 blocker + 无 fixer 轮次

---

## 8. 团队协作要点

| 场景 | 操作 |
|------|------|
| 新成员加入 | clone → 设置 key → 运行 install-hermes 脚本 |
| 个人改通用配置 | 改 `hermes_config/` 后提交 |
| 添加新 skill | 放到 `hermes_config/skills/` 后提交 |
| 更新个人数据 | 各设备本地用 `memory` / `fact_store` 工具维护，不回传仓库 |

---

*最后更新：2026-07-07*
