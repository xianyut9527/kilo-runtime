# Memory Strategy（默认：标签按需注入）

> 本文件定义 `.kilo/memory/` 目录下记忆文件的注入策略。
> **可插拔**：在 `AGENTS.md` 第8条中通过 `strategy: "memory-strategy.md"` 引用；更换文件名即可切换策略。
> 不引用本文件时，记忆系统不生效（等效全量关闭）。

## 策略标识

- **名称**：`tag-based-selective-injection`
- **版本**：`1.0`
- **适用文件**：`MEMORY.md`、`USER.md`（支持扩展更多记忆文件）

## 注入规则

### 1. 标签匹配（Tag Matching）

- 仅注入与当前任务语义相关的记忆条目。
- 记忆条目或章节需标注 `[tag:xxx]`，如 `[tag:config]` `[tag:workflow]` `[tag:security]`。
- 未命中任何标签的条目不注入，不报错。

### 2. 优先级排序（Priority Ranking）

命中后的条目按以下优先级排序注入：

1. **精确匹配**：任务关键词与标签完全一致（如任务涉及 `kilo.json` 修改，命中 `[tag:config]`）。
2. **模糊匹配**：任务语义与标签属于同一领域（如任务涉及 API 设计，命中 `[tag:workflow]`）。
3. **通用标签**：`[tag:general]` 作为兜底，优先级最低。

### 3. 上限控制（Token Budget）

- 单次会话注入总量 **≤ 1500 tokens**（约 6000 字符）。
- 超出时按优先级截断，低优先条目不注入。
- 记忆文件自身声明的 `char_limit`（如 MEMORY.md ≤2200、USER.md ≤1375）不参与此上限计算，仅作为文件维护约束。

### 4. 回溯放宽（Backtrace Relaxation）

- 方法层 / 需求层失败时触发跨会话根因回溯（`kilo_local_recall` + `gitnexus`）。
- 此时放宽标签限制，允许注入更多上下文（放宽后上限翻倍至 3000 tokens）。

## 文件发现机制

1. **扫描目录**：`.kilo/memory/`
2. **有效文件**：包含 YAML frontmatter 且 `metadata.category == "memory"` 的 `.md` 文件
3. **加载顺序**：`USER.md` → `MEMORY.md`（用户偏好先于 agent 笔记）

## 扩展方式

如需新增记忆文件（如 `TEAM.md`、`PROJECT.md`）：
1. 在 `.kilo/memory/` 下创建文件
2. 在 frontmatter 中声明 `metadata.category: memory`
3. 在章节或条目标注 `[tag:xxx]`
4. 自动纳入本策略管理

## 切换策略

在 `AGENTS.md` 第8条中修改 `strategy` 字段指向新文件：

```
strategy: "memory-strategy-semantic.md"   # 语义向量检索
strategy: "memory-strategy-keyword.md"    # 关键词匹配
strategy: "memory-strategy-full.md"      # 全量注入（回退）
```

不声明 `strategy` 字段时，记忆系统不加载。
