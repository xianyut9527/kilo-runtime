# 经验索引

症状 → 条目 ID。新增条目由 `scripts/kb.mjs add` 自动追加。

| ID | 症状 | 标签 | 文件 |
|----|------|------|------|
| FX-0001 | Kilo 主模型报错时只会重试同一模型、绝不换模型（5 次退避后中断） | failover,provider | [FX-0001](entries/FX-0001.md) |
| FX-0002 | 写 `.kilo/agent/<内置名>.md` 会摧毁内置 agent 提示词 | agent,plugin | [FX-0002](entries/FX-0002.md) |
| FX-0003 | `permission.ask` 不是 plugin hook，挂载后从不触发 | plugin,permission | [FX-0003](entries/FX-0003.md) |
| FX-0004 | `options.failover` / `options.moa` 改了却静默失效 | failover,moa,config | [FX-0004](entries/FX-0004.md) |
| FX-0005 | config 权限规则是「最后一条匹配者生效」，兜底写后面会吞掉例外 | permission,config | [FX-0005](entries/FX-0005.md) |
| FX-0006 | 路径与扩展键三条硬约束：`~` 不展开 / `npm` 需三斜杠 `file:///` / 自定义键导致整份配置失效 | config,provider,install | [FX-0006](entries/FX-0006.md) |
