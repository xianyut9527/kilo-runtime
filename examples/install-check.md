# 全局配置同步验证示例

> 演示如何确认 `kilo_config` 仓库的修改已经正确同步到全局配置目录 `~/.config/kilo/`，避免其他项目加载旧版配置导致编排规则执行不一致。

## 为什么需要验证

`kilo_config` 是 Kilo 的**全局配置骨架**。真实项目启动时，Kilo 从 `~/.config/kilo/` 加载 `kilo.json`、`.kilo/instructions/*.md`、`agent/*.md` 等文件。

如果仓库改了但全局目录没同步：
- 其他项目加载的是旧版 `kilo.json`
- 新版 `workflow-core.md` 中的编排规则不会注入
- 导致 coderAgent 不输出强制流程日志、不执行 pre-checker、不拆分任务单元

## 同步后必须验证的三件事

| # | 检查项 | 通过标准 |
|---|--------|----------|
| 1 | 关键文件存在 | `kilo.json` + `AGENTS.md` + `core.md` + `workflow-core.md` + `reflection.md` 均存在 |
| 2 | 安装脚本输出 `[SYNC] OK` | 运行 `./install.ps1` 或 `./install.sh` 后最后一行是 `[SYNC] OK` |
| 3 | 全局目录与仓库一致 | 对比命令无差异 |

## 各平台验证命令

### Windows (PowerShell)

```powershell
robocopy . "$env:USERPROFILE\.config\kilo" /E /XJ /XD .git node_modules /XF install.ps1 install.sh README.md LICENSE .gitignore package.json package-lock.json pnpm-lock.yaml bun.lock yarn.lock agent-manager.json /L /NS /NC /NP /NDL
```

### macOS / Linux (Bash)

```bash
diff -rq . ~/.config/kilo \
  --exclude=.git --exclude=node_modules \
  --exclude=install.ps1 --exclude=install.sh \
  --exclude=README.md --exclude=LICENSE --exclude=.gitignore \
  --exclude=package.json --exclude=package-lock.json \
  --exclude=pnpm-lock.yaml --exclude=bun.lock --exclude=yarn.lock \
  --exclude=agent-manager.json
```

## 预期输出

安装脚本最后一行格式如下（具体 `files=` / `dirs=` 数字会随仓库内容变化，以实际输出为准）：

```text
[SYNC] OK | files=<N> dirs=<M> | critical=5/5 | target=/Users/<你>/.config/kilo
```

如果看到 `[SYNC] FAIL`，请检查：
- 当前目录是否在 `kilo_config` 仓库根目录
- `~/.config/kilo/` 是否被其他进程占用
- 关键文件是否被意外删除

## 何时必须重新同步

修改以下文件后，必须重新运行 `./install.ps1` 或 `./install.sh` 并验证：

- `kilo.json`
- `.kilo/instructions/*.md`
- `agent/*.md`
- `install.ps1` / `install.sh` 本身

> 详见 `README.md`「维护全局骨架」章节和 `CONFIG_CHANGE_CHECKLIST.md` 的对应检查项。

## 注意事项

- 安装脚本刚执行完毕时，全局目录应**只含仓库中的文件**（被排除项不出现）。Kilo 运行后会重新生成 `.gitignore`、`node_modules`、`package.json`、`package-lock.json`、`agent-manager.json` 等运行时依赖，这不代表同步失败。
- Kilo 运行时可能会向全局 `~/.config/kilo/kilo.json` 追加运行时字段（如 `permission`）。这**不代表同步失败**；只要 `instructions`、`agent.*.prompt`、`default_agent`、`model` 等关键配置与仓库一致即可。
- `robocopy /XF` 和 `diff --exclude` 是**递归**排除，会把所有层级的 `README.md` 都忽略，因此无法用来验证 `.kilo/memory/` 等嵌套目录的 README 是否已同步。这些文件需单独检查：
  ```bash
  ls ~/.config/kilo/.kilo/memory/MEMORY.md
  ```
- 判断同步是否成功，应看**安装脚本输出 `[SYNC] OK` 后立即检查的关键文件存在性**，而不是 Kilo 运行一段时间后的目录状态。
