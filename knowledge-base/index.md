# knowledge-base — 跨项目故障-根因-修复经验库

> **库属性**：本目录是**跨项目**知识库，非项目级。路径以全局配置根目录 `~/.config/kilo/` 为解析基准——任何项目的 `findUp` 都会读到**同一份** `knowledge-base`（全局根 `~/.config/kilo/knowledge-base/`）。项目内有同名目录时按 Overlay 语义用项目级，但默认不建。

## 用途

沉淀跨会话、跨项目反复出现的「故障 → 根因 → 修复」经验，让 fixer/reviewer 不再重复踩坑。检索入口见 `reflection.md`「强制跨会话根因回溯」；命中打 `[KB_HIT]`，未命中打 `[KB_MISS]`。

## 症状 → FX 索引表

| 症状（诱因词） | FX ID | 类别 | 说明 |
|----------------|-------|------|------|
| reviewer abort,tool execution aborted 等 | [FX-001.md](fixes/FX-001.md) | 编排 | reviewer/task 子代理 tool execution aborted 中断处理 |
| GBK mojibake,U+FFFD 等 | [FX-002.md](fixes/FX-002.md) | 执行 | PS5.1 写中文文件默认编码导致 GBK mojibake |
| PS51_REGEX_RISK,Where-Object -match 等 | [FX-003.md](fixes/FX-003.md) | 执行 | PS5.1 -match 正则元字符 ArgumentException 反复重投 |
| doc.drift,硬编码智能体名 等 | [FX-004.md](fixes/FX-004.md) | 编排 | 阶段正文硬编码智能体名触发 doc.drift 阻断 |
| 重复task调用,重复派发,同单元并行,并发写冲突,task_context丢失 等 | [FX-005.md](fixes/FX-005.md) | 编排 | 禁止对同一单元重复派发task——并行仅限不同单元 |

<details>
<summary>如何新增一条经验</summary>

1. 跑 `node scripts/kb.mjs add --symptoms "<诱因词>" --name "<一句话>" --category <编排|方法|执行|需求>`（自动生成 FX 文件 + 自动重建索引表）。
2. 提交后同步到全局根 `~/.config/kilo/knowledge-base/`。
</details>

## FX 文件模板

```yaml
---
id: FX-0NN
name: 一句话经验名
symptoms: [触发诱因词, ...]
category: 编排/方法/执行/需求
hit_count: 0
confidence: high|medium|low
last_used: YYYY-MM-DD
---
```

四段结构：`## 症状` `## 根因` `## 修复` `## 复验`。
