# Hermes Agent 配置同步指南

统一团队/多设备编码体验，一键同步当前 Hermes 配置资产。

---

## 1. 目录结构

```text
repo/
├── hermes_config/        ← Hermes 配置资产（同步这个目录）
│   ├── config.yaml
│   ├── SOUL.md
│   ├── .hermes.md
│   ├── memories/
│   │   ├── MEMORY.md
│   │   └── USER.md
│   └── skills/
├── HERMES-GUIDE.md       ← 本文件
├── install-hermes.sh     ← Linux/macOS 同步脚本
└── install-hermes.ps1  ← Windows 同步脚本
```

---

## 2. 新设备安装

### 2.1 安装 Hermes

```bash
# Linux / macOS / WSL2
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# Windows (Python pip)
pip install hermes-agent
```

### 2.2 设置 API Key

```bash
# Linux / macOS / WSL2
export NAT100_API_KEY="your-key"

# Windows PowerShell
$env:NAT100_API_KEY="your-key"
```

### 2.3 同步配置

```bash
# Linux / macOS / WSL2
./install-hermes.sh

# Windows
.\install-hermes.ps1
```

配置会被复制到：

- Linux/macOS：`~/.hermes/`
- Windows：`%LOCALAPPDATA%\hermes\`

### 2.4 验证

```bash
hermes config check
hermes skills list
hermes
```

---

## 3. 手动同步清单

不想用脚本时，复制这些文件到 `~/.hermes/`（Windows 是 `%LOCALAPPDATA%\hermes\`）：

| 文件/目录 | 目标 |
|-----------|------|
| `hermes_config/config.yaml` | `~/.hermes/config.yaml` |
| `hermes_config/SOUL.md` | `~/.hermes/SOUL.md` |
| `hermes_config/.hermes.md` | `~/.hermes/.hermes.md` |
| `hermes_config/memories/` | `~/.hermes/memories/` |
| `hermes_config/skills/` | `~/.hermes/skills/` |

---

## 4. 可选：切换官方 Kimi Provider

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

## 5. 编码统一规则

同步后所有设备默认遵循：

1. 意图判定优先
2. T0-T3 任务定级
3. 7 节点流程日志
4. engineer → checker → fixer 闭环
5. reviewer 总体验收
6. SCOPE_CREEP 反向核对
7. 验收必附映射表

---

## 6. 团队协作要点

| 场景 | 操作 |
|------|------|
| 新成员加入 | clone → 设置 key → 运行 install-hermes 脚本 |
| 个人改配置 | 改完后复制回 `hermes_config/` 并提交 |
| 添加新 skill | 放到 `hermes_config/skills/` 并提交 |
| 更新记忆约束 | 改 `hermes_config/memories/MEMORY.md` 并提交 |

---

*最后更新：2026-07-07*
