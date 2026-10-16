---
description: "为当前项目启用原生记忆（kilo_memory_* 工具族 + 自动注入），并做端到端体检"
agent: code
---

# /memory-setup — 原生记忆显式启用

git 仓库项目通常已被 `plugin/memory-bootstrap.ts` 自动启用（首次 session.created 即落盘 scaffold）。
本命令用于两类残余场景：非 git 目录（插件故意跳过，防污染临时目录）、或自动自举疑似失效时的排查修复。

## 步骤

1. 确定当前工作区根目录（git 仓库取 `git rev-parse --show-toplevel`，否则取会话工作目录）。
2. 执行部署副本脚本（幂等，已有状态不动）：
   `node "$HOME/.config/kilo/scripts/memory-enable.mjs" "<工作区根>"`
   输出 `enabled: ... -> <记忆根>` 即成功；`skip (state exists, enabled=...)` 表示此前已初始化。
3. 体检：`node "$HOME/.config/kilo/scripts/memory-enable.mjs"`（无参列出全部记忆根与 enabled 状态）。
4. 告知用户：**当前会话的工具表是启动时定好的**——若本会话之前 `kilo_memory_*` 工具不可见，
   新开会话即生效（注入 + 工具 + 回调齐全）。不要谎报"本会话已生效"。
5. 若脚本不可用（部署缺失），兜底方案：让用户在 TUI 跑一次 `/memory`，或
   `kilo serve` 后 `POST /memory/enable?directory=<工作区根>`——这是官方通道。

## 边界

- 绝不删除/改写已有记忆目录内容；只允许 create-if-missing 的 scaffold。
- 不改 `state.json` 的其他字段（limits/stats 由 Kilo 自管）。

## 命令模板（自 INSTRUCTIONS.md 外迁，2026-10-16）

跨项目定向同步与 mem_add 兜底的完整命令模板在此维护；INSTRUCTIONS.md 只保留判据与指针。

- **跨项目定向同步**（A 项目会话沉淀了 B 项目专属事实后镜像到 B）：
  `node "$HOME/.config/kilo/scripts/memory-sync.mjs" <B 的项目根> <facts|decisions|constraints|open-questions|corrections|commands|paths|tooling> <key> <text>`
  （同 key 原位更新、幂等、原子写；kind 对应 project.md 四段 + corrections.md 段 + environment.md
  的 Commands/Paths/Tooling 三段——「B 的构建命令/路径/工具链怪癖」走 environment 类 kind；
  B 记忆未启用时报错——先在 B 跑 `/memory-setup`，或免切项目直接
  `node "$HOME/.config/kilo/scripts/memory-enable.mjs" <B 的项目根>` 启用再同步）
- **mem_add 脚本兜底**（mem_add 工具不可用时直写 inbox）：
  `node -e "fs.appendFileSync('C:/Users/Administrator/.local/share/kilo/memory-store/inbox.md', ...)"`
  （路径按本机 DATA_DIR）
