---
name: using-git-worktrees
description: 需要与主工作区隔离的新功能开发/执行实现计划前加载。优先平台原生 worktree 工具，回退 git。含 4 步流程、目录优先级、清理。
keywords: [worktree, isolation, git, parallel, 隔离]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/using-git-worktrees/SKILL.md
  rewrite_ratio: 0.6
---

# 使用 Git Worktrees 隔离工作

## 何时触发

- 启动需要与主分支隔离的新功能
- 执行实现计划前
- 并行开发多分支
- 避免污染当前工作区
- 已有平台原生 worktree 工具时优先使用

## 4 步流程

### Step 0：检测已有隔离

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**判断**：
- `GIT_DIR != GIT_COMMON` 且**非子模块** → 已在 linked worktree，**跳过 Step 1**
- 子模块：检查 `git rev-parse --show-superproject-working-tree`，有路径则视为普通仓库
- 询问用户：是否创建 worktree？得到同意前不要操作

### Step 1a：原生工具（优先）

若平台有 `EnterWorktree` / `WorktreeCreate` / `/worktree` / `--worktree` 等工具，**必须用原生**。原生工具处理目录放置/分支创建/清理，git worktree 会产生 harness 看不到的幻影状态。

### Step 1b：git worktree 回退

仅在无原生工具时使用。

**目录优先级**：
1. 指令文件中显式声明的目录
2. 已有项目目录：`.worktrees`（优）>`worktrees`（备）
3. 默认 `.worktrees/`（项目根）

**忽略验证**（项目本地目录必做）：

```bash
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

未忽略 → 写入 .gitignore，提交后再创建。

**创建命令**：

```bash
path="$LOCATION/$BRANCH_NAME"
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

**沙箱回退**：`git worktree add` 权限错误 → 告知用户沙箱阻止，在当前目录工作并跑 setup + baseline。

### Step 2：项目 setup（自动检测）

```bash
[ -f package.json ] && npm install
[ -f Cargo.toml ] && cargo build
[ -f requirements.txt ] && pip install -r requirements.txt
[ -f pyproject.toml ] && poetry install
[ -f go.mod ] && go mod download
```

### Step 3：验证 clean baseline

跑项目测试命令（npm test / cargo test / pytest / go test ./...）。

- 通过：报告 `Worktree ready at <path> | Tests passing (<N> tests, 0 failures)`
- 失败：报告失败，询问是继续还是先调查

## 快速参考

| 情况 | 动作 |
|------|------|
| 已在 linked worktree | 跳过创建（Step 0） |
| 子模块 | 当普通仓库处理 |
| 有原生工具 | 用 Step 1a |
| 无原生工具 | git worktree（Step 1b） |
| `.worktrees/` 存在 | 用它（先验证 ignore） |
| 两者都存在 | 用 `.worktrees/` |
| 都不存在 | 检查指令文件 → 默认 `.worktrees/` |
| 目录未 ignore | 加 .gitignore + 提交 |
| 权限错误 | 沙箱回退，原地工作 |
| baseline 测试失败 | 报告 + 询问 |

## 红旗（Never）

- Step 0 已检测到隔离却再创建 worktree
- 有原生工具却用 `git worktree add`（#1 错误）
- 跳过 Step 1a 直接走 git 命令
- 创建项目本地 worktree 未验证 ignore
- 跳过 baseline 测试验证
- baseline 失败仍继续（不询问）
- 假设目录位置（违反优先级）

## 反模式

- **与 harness 对抗**：有原生工具却用 git 命令
- **跳过检测**：在已有 worktree 内嵌套
- **跳过 ignore 验证**：worktree 内容被 git 跟踪，污染状态
- **假设目录**：不按优先级走，造成不一致
- **失败基线继续**：无法区分新 bug 与已有问题
- **创建后未验证**：跳 baseline 等于埋雷

## 清理

任务完成后按 worktree 类型清理：

- 原生 worktree → 用平台清理命令
- git worktree → `git worktree remove <path>` + `git branch -d <branch>`

## 详细参考

- 原文：github.com/obra/superpowers/tree/main/skills/using-git-worktrees
- 关联：conductor 分支收尾
