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
| 重复task调用,重复派发 等 | [FX-005.md](fixes/FX-005.md) | 编排 | 禁止对同一单元重复派发task——并行仅限不同单元 |
| batch-set 覆盖,task_context 数据丢失 等 | [FX-010.md](fixes/FX-010.md) | 执行 | subagent batch-set 覆盖事故致 task_context 字段丢失与数组双编码 |
| 终检 grep 禁词=1 却报 PASS,文案自含禁词 等 | [FX-011.md](fixes/FX-011.md) | 执行 | doc-forbidden-word-self-embedding |
| reviewer 判 SCOPE_CREEP 但引用旧任务 plan,diff 行数远超 plan 声明 等 | [FX-012.md](fixes/FX-012.md) | 编排 | reviewer-stale-plan-misjudge |
| FILE_CONFLICT unit=(unknown),timeout_guard 残留 running 等 | [FX-013.md](fixes/FX-013.md) | 编排 | reviewer-post-dispatch-role-gate-deadlock |
| 清理空目录误删,已跟踪文件被删 等 | [FX-014.md](fixes/FX-014.md) | 执行 | 清理垃圾目录前未查 git 跟踪状态，误删历史产物 |
| install排除清单不同步,RootOnly目录项假MISSING 等 | [FX-015.md](fixes/FX-015.md) | 执行 | 回落镜像清单会同时漂数据与漂豁免规则，须让常态路径不命中它 |
| prompt-sync 派生漂移 ASSEMBLY_FAIL verifier prompt 5元组 8元组 等 | [FX-018.md](fixes/FX-018.md) | 执行 | 改 agent/*.md frontmatter description 后必须跑 sync-agent-prompt.mjs 同步 kilo.json agent.prompt，否则 lifecycle-doctor prompt-sync ASSEMBLY_FAIL |
| task 派发中止,Tool execution aborted 等 | [FX-020.md](fixes/FX-020.md) | 编排 | task 派发被中止后先勘定文件系统落盘再决定补派范围：产物已验证有效时按证据降级补派而非全量重跑 |
| coder 批量注释订正中单处编辑遗漏,acceptance_map 全 PASS 掩盖未改文件 等 | [FX-022.md](fixes/FX-022.md) | 执行 | 多编辑单元必须逐文件 SHA256 前后对比验收,单条 grep 命中数校验防局部遗漏 |
| i18n字典key数量超plan上限,U4文件清单误列 等 | [FX-023.md](fixes/FX-023.md) | 编排 | i18n字典key计数应基于实际.vue文件扫描而非估量;planner任务清单文件需 Glob 验证存在性(本任务 ChatPanel→ApiUsage 误判) |
| verifier FAIL: context_anchor 行号代码不在工作区; fixer 声明 PASS 但磁盘无修复代码 等 | [FX-026.md](fixes/FX-026.md) | 编排 | staged-worktree-dual-version-baseline-reset |

> **ID 跳号说明**：FX-006 ~ FX-009 从未入库。它们是运行时在部署副本侧重复生成的草稿（同一条经验被反复 add，且正文因含引号/`##` 被段落解析器切错），已作为垃圾丢弃；FX-010 ~ FX-013 是从部署副本回收并重排四段结构后的正式条目。保留跳号以保持事故溯源，不补号。
>
> **部署副本 `knowledge-base/fixes/archive/`**：`kb.mjs add` 重写同 ID 时自动把旧版本归档到此目录，属**运行时残留**（多为 TODO 未填的坏草稿），仓库不拥有、`deploy-drift-check.mjs` 不比对；有价值内容一律按下方 step 4 回收成正式条目，不整目录入库。

<details>
<summary>如何新增一条经验</summary>

1. 跑 `node scripts/kb.mjs add --symptoms "<诱因词>" --name "<一句话>" --category <编排|方法|执行|需求>`（自动生成 FX 文件 + 自动重建索引表）。
2. 内容参数禁含 `##` 与未配对引号——会被四段模板的段落解析器切错（FX-008/FX-009 就是这么坏的）。
3. 新增前先 `kb.mjs query` 查重：同一 `name` 已存在则补充原条，禁止开新 ID（FX-006→FX-008→FX-011 就是一条经验被建了三次）。
4. **禁写内容**：不写项目特定代码（具体变量名 / 业务逻辑）、不写敏感信息（API Key / 密码 / 内部域名）、不虚构未验证的经验——本库是全局共享库，只有可迁移的「故障-根因-修复」才有价值。
5. **回收进仓库**：运行时 `kb.mjs add` 写的是部署副本 `~/.config/kilo/knowledge-base/`，必须把新增 FX 文件 + index.md 行拷回本仓库并提交，否则经验只活在本机（install 会保护它们不被 purge，但不入版本库 = 换机器就丢）。
6. 提交后重跑 install 同步到全局根。
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
