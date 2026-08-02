---
name: finishing-a-development-branch
description: 在实现完成、测试通过后必须加载本 skill。4 选项决策树（merge/PR/keep/discard）+ 环境探测 + worktree 清理协议。完成 T1+ 任务的最后一步。
keywords: [finishing, branch, merge, pr, cleanup, worktree, 完成, 合并, 收尾]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: workflow
  source: obra/superpowers@main
  derived_from: https://github.com/obra/superpowers/tree/main/skills/finishing-a-development-branch/SKILL.md
  rewrite_ratio: 0.4
---

# 完成开发分支

## 何时触发

- T1+ 任务所有单元已通过 verifier，测试套件本轮 fresh 通过
- 准备合回基分支 / 开 PR / 或决定放弃

**不触发**：T0 直接合并即可。

## 铁律

```
测试未通过 = 不得进入收尾流程
```

## 6 步流程

### Step 1：验证测试

`npm test` / `pytest -x` / `cargo test` / `go test ./...`。失败 → 停止，不进 Step 2。

### Step 2：探测环境

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

| `GIT_DIR == GIT_COMMON` | 4 选项，无 worktree |
| 不等 + named branch | 4 选项，按 provenance 清理 |
| 不等 + detached HEAD | **3 选项**（无 merge） |

### Step 3：确定基分支

```bash
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

或问用户。

### Step 4：呈现选项

**普通 / 命名 worktree**（4 选项）：
```
实现完成。你想怎么处理？
1. 合并回 <base-branch>（本地）
2. 推送并创建 Pull Request
3. 保持分支现状（稍后处理）
4. 放弃此工作
```

**Detached HEAD**（3 选项，去掉本地合并）：
```
实现完成。你在 detached HEAD（外部托管工作区）上。
1. 推送为新分支并创建 PR
2. 保持现状
3. 放弃此工作
```

**禁止追加解释**。

### Step 5：执行选择

| 选项 | 关键命令 | 清理 |
|------|----------|------|
| 1. 本地合并 | `cd <main-root>; git checkout <base>; git pull; git merge <feature>; <test>` | 成功后 `git branch -d <feature>` |
| 2. 推送 PR | `git push -u origin <feature>` | **不清理 worktree**（PR 迭代需要） |
| 3. 保持现状 | 报告路径 | **不清理 worktree** |
| 4. 放弃 | **要求输入 `discard` 确认** | `cd <main-root>; git branch -D <feature>` |

### Step 6：清理 worktree（仅选项 1 和 4）

```bash
WORKTREE_PATH=$(git rev-parse --show-toplevel)
if [[ "$WORKTREE_PATH" == */.worktrees/* ]] || [[ "$WORKTREE_PATH" == */worktrees/* ]]; then
  MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
  cd "$MAIN_ROOT"
  git worktree remove "$WORKTREE_PATH"
  git worktree prune
fi
# 否则：harness/host 拥有此 worktree，留给平台清理
```

## 红旗（Never）

- 测试失败仍推进 / merge 后未跑测试 / 未确认就删除 / 未经请求 force-push
- merge 成功前移除 worktree / 清理未由本会话创建的 worktree
- 在 worktree 内执行 `git worktree remove`（CWD 锁定，命令静默失败）
- 选项 2/3 清理 worktree（用户失去 PR 迭代能力）

## 关联

- 上游：`using-git-worktrees`（worktree 创建）
- `verification-before-completion`（测试证据）
- `agent/conductor.md`「分支收尾协议」
- 原文：https://github.com/obra/superpowers/tree/main/skills/finishing-a-development-branch/SKILL.md
