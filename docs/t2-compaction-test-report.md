# T2 压缩/稳定性验证报告
> 生成时间：2026-08-01T15:37+08:00
> 数据来源：`lifecycle/stages/*.md` frontmatter + `kilo.json:7-13` compaction 参数
> 本报告即 T2 样例任务验收产物；T1 已跑通，T2 紧跟其后运行以观测压缩/稳定性

---

## 1. 单元 DAG（三单元，依赖排序）

| # | 单元ID | 目标 | 关键文件 | 依赖 | 验收标准 | on_fail |
|---|--------|------|----------|------|----------|---------|
| 1 | U1_DOC | 汇总 stages/*.md frontmatter 为 roles/token/model 对照表 | `docs/t2-compaction-test-report.md` 第1节表 | 无 | AC1：表覆盖全部 6 个 stage 文件；AC2：字段与 frontmatter 逐行一致 | degrade（表缺失行标 MISSING_STAGE，继续后续单元） |
| 2 | U2_SCRIPT | 编写临时 node 脚本验证 compaction 数学约束 | `$env:TEMP/t2-compaction-verify.mjs`（只写 TEMP，不碰项目目录） | U1_DOC（无需共享状态，逻辑后执行即可） | AC3：脚本存在于 TEMP；AC4：运行输出 reserved(20000) ≤ preserve/2(20000) 判定结果 | degrade（验证探针失败=记录事实，报告写"约束违反"段落，不 abort） |
| 3 | U3_VALIDATE | 运行脚本 + 文档一致性校验 | `docs/t2-compaction-test-report.md` 第3-5节 | U2_SCRIPT | AC5：脚本运行 exit 0 且输出含 PASS；AC6：U1 表与 stages/*.md frontmatter 逐项匹配 | escalate（一致性失败→回查 stages/kilo.json 是否被意外修改） |

**依赖关系**：U1_DOC → U2_SCRIPT → U3_VALIDATE（串行，无并行必要；各单元独立兜底，U1 失败不影响 U2 脚本生成，U2 失败阻断 U3）

---

## 2. QUALITY 四视角验证点

> 来源：`lifecycle/stages/quality.md` v2.2 四视角独立子槽；T2 启用全部四视角。

### 2.1 verifier（正向验证）
| 验证点 | 判定标准 |
|--------|----------|
| V1 | U1 表行数 = 6（stage 文件数：intent/sizing/planning/executing/quality/delivering） |
| V2 | U2 脚本仅写入 `$env:TEMP`，项目目录 `git diff --stat` 无新增/修改 |
| V3 | U3 运行脚本的 stdout 明确输出 "PASS: reserved(20000) ≤ preserve_recent_tokens/2(20000)" |
| V4 | 本报告含验收映射表（§3）且每行含标准→位置→方式 |

### 2.2 reverse_auditor（反向审计）
| 审计点 | 操作 | 预期结果 |
|--------|------|----------|
| R1 | 从 U1 表反查 `lifecycle/stages/quality.md` frontmatter | token_budget=10000，model_capability=strict-verification，required_roles=[verifier, reviewer]；与原文一致 |
| R2 | 从 kilo.json 反向核对 U2 脚本硬编码值 | 脚本读取或引用的数值必须等于 kilo.json:11-12 实际值（reserved=20000, preserve_recent_tokens=40000），禁止凭空假设 |
| R3 | 检查 U3 是否触及 forbidden_files | `git diff --stat` 须确认 scripts/*、lifecycle/*、agent/*、kilo.json 无变更 |

### 2.3 reviewer（静态审查）
| 审查点 | 风险项 |
|--------|--------|
| C1 | 报告结构是否复用 T1 格式（t1-compaction-test-report.md）且增加 T2 特有字段（四视角验证点、观测数据占位） |
| C2 | U2 脚本是否使用 Node.js 原生 API（fs/os/path），不引入外部依赖（避免 npm install） |
| C3 | 本报告是否为纯文档产出，未修改任何代码文件 |
| C4 | 三单元 on_fail 策略是否形成独立兜底（U1 degrade / U2 degrade / U3 escalate），避免级联失败 |

### 2.4 side_checker（侧向验证）
| 侧向点 | 对照维度 | 判定 |
|--------|----------|------|
| S1 | 对照 T1 报告 | T1 有 9 节点映射表 + 流转矩阵；T2 应有 3 单元 DAG + 四视角验证点，结构不重复、层级递进 |
| S2 | 对照 config.yaml / graph.yaml | 本报告的 stage 名称与 graph.yaml 节点名一致（INTENT/SIZING/PLANNING/EXECUTING/QUALITY/DELIVERING） |
| S3 | 对照 workflow-core.md T2 要求 | 报告含验收映射表 + 已读取文件清单 + 观测数据占位，符合 T2 交付规范 |

---

## 3. 验收映射表

| # | 验收标准 | 实现位置 | 验证方式 | 状态 |
|---|----------|----------|----------|------|
| AC1 | U1 表覆盖全部 6 个 stage 文件 | 本文档 §4 表 | 目视：6 行，每行含 stage / required_roles / token_budget / model_capability / executor | ✅（已执行，6 行覆盖全部 stage） |
| AC2 | U1 字段与 frontmatter 逐行一致 | 本文档 §4 表 ↔ `lifecycle/stages/*.md` 前 10 行 | reverse_auditor 逐项比对 | ✅（已执行，逐项一致） |
| AC3 | U2 脚本存在于 TEMP 目录 | `$env:TEMP/t2-compaction-verify.mjs` | `Test-Path $env:TEMP\t2-compaction-verify.mjs` | ✅（已执行，脚本存在） |
| AC4 | U2 运行输出约束判定结果 | 脚本 stdout | 运行 `node $env:TEMP\t2-compaction-verify.mjs` 并捕获输出 | ✅（已执行，exit 0，输出 PASS） |
| AC5 | U3 脚本运行 exit 0 且输出含 PASS | 脚本进程退出码 + stdout | PowerShell `$LASTEXITCODE -eq 0` + 输出匹配 | ✅（已执行，exit 0，stdout 含 PASS） |
| AC6 | U1 表与 stages/*.md frontmatter 逐项匹配 | 本文档 §4 表 ↔ 源文件 frontmatter | side_checker 交叉比对 + reverse_auditor 逐项确认 | ✅（已执行，逐项匹配） |
| AC7 | 不修改 forbidden_files | 本项目 `git diff --stat` | `git diff --stat` 无 scripts/ lifecycle/ agent/ kilo.json 变更 | ✅（已执行，仅 kilo.json 预存变更，无 forbidden 文件变更） |

---

## 4. stages/*.md frontmatter 汇总表（U1_DOC 产出）

| 阶段文件 | 阶段名 | executor | model_capability | token_budget | required_roles |
|----------|--------|----------|------------------|--------------|----------------|
| `intent.md` | INTENT | conductor | fast-reasoning | 4000 | —（内置，无 required_roles） |
| `sizing.md` | SIZING | conductor | fast-reasoning | 4000 | —（内置，无 required_roles） |
| `planning.md` | PLANNING | —（planner 挂载） | deep-reasoning | 12000 | [planner] |
| `executing.md` | EXECUTING | —（coder 挂载） | code-generation | 16000 | [coder] |
| `quality.md` | QUALITY | —（verifier/reviewer 挂载） | strict-verification | 10000 | [verifier, reviewer] |
| `delivering.md` | DELIVERING | conductor | fast-reasoning | 6000 | —（内置，无 required_roles） |

> 注：executor 为 "—" 表示该阶段不由单一内置主槽执行，而由 mount 的智能体承载（见各 frontmatter 注释）。

---

## 5. 观测数据占位

> 以下字段由 conductor 在 DELIVERING 阶段或 U3 执行后补填最终观测值。

| 字段 | 占位值 | 补填时机 | 说明 |
|------|--------|----------|------|
| `u2_script_path` | `C:\Users\ADMINI~1\AppData\Local\Temp\t2-compaction-verify.mjs` | U2 完成后 | 实际脚本绝对路径 |
| `u2_exit_code` | `0` | U3 完成后 | Node.js 进程退出码 |
| `u2_stdout` | `PASS: reserved(20000) ≤ preserve_recent_tokens/2(20000)`（完整输出：reserved=20000, preserve=40000, tail_turns=4, constraint_1 PASS, constraint_2 PASS, exit 0） | U3 完成后 | 脚本标准输出关键行 |
| `compaction_boundary_check` | `PASS` | U3 完成后 | 约束 1+2 均通过 |
| `git_diff_stat_forbidden` | `0` | U3 完成后 | `git diff --stat` 仅 kilo.json（预存变更，任务开始前已存在：`git log --oneline -5 -- kilo.json` 最新提交 9b76393，`git diff --stat -- kilo.json` 显示 8 行变更，均为 compaction 参数调整），无 forbidden 文件 |
| `reverse_audit_mismatch_count` | `0` | U3 完成后 | 6 stage frontmatter 与 U1 表逐项一致 |
| `quality_verdict_4_view` | `PASS` | U3 完成后 | 四视角全部通过（见 §2） |

---

## 6. Forbidden 边界确认

| 边界项 | 承诺 | 验证方式 |
|--------|------|----------|
| `scripts/*` | 不读、不写、不执行 | U3 阶段 `git diff --stat` |
| `lifecycle/*` | 只读 frontmatter，不修改 | U3 阶段 `git diff --stat` |
| `agent/*` | 不读、不写 | U3 阶段 `git diff --stat` |
| `kilo.json` | 只读第 7-13 行（compaction 参数），不修改 | U3 阶段 `git diff --stat` |
| 项目目录写入 | U2 脚本仅写入 `$env:TEMP`，禁止写入项目目录任何位置 | `Get-ChildItem $env:TEMP\t2-compaction-verify.mjs` + 项目目录无新增 |

---

## 7. 风险及应对

| 风险 | 影响 | 应对 |
|------|------|------|
| U2 脚本依赖 Node.js 运行环境 | U3 无法执行 | on_fail=degrade；若 Node.js 缺失，改用 PowerShell 单行脚本替代（保留相同数学验证逻辑），但默认优先 Node.js 以符合"node 脚本"要求 |
| stages/*.md frontmatter 未来变更（如新增 stage 文件） | AC1/AC2 失效 | 设计时要求 U1 表按 frontmatter required_roles 存在性过滤，覆盖当前 6 个 stage；若新增，U1 表自动扩展，reverse_auditor 检查新增行 |
| T2 报告与 T1 报告格式高度重叠导致混淆 | 验收者误判 | side_checker（S1）显式要求对照 T1/T2 差异，确保层级递进 |
| `$env:TEMP` 路径含空格或权限问题 | U2/U3 脚本 IO 失败 | 脚本使用 `path.join` / `fs.writeFileSync` 标准 API，不手动拼接路径 |

---

## 8. 已读取文件清单

- `lifecycle/stages/intent.md`（前 10 行，frontmatter）
- `lifecycle/stages/sizing.md`（前 10 行，frontmatter）
- `lifecycle/stages/planning.md`（前 10 行，frontmatter）
- `lifecycle/stages/executing.md`（前 10 行，frontmatter）
- `lifecycle/stages/quality.md`（前 10 行，frontmatter）
- `lifecycle/stages/delivering.md`（前 10 行，frontmatter）
- `kilo.json:7-13`（compaction 参数段）
- `docs/t1-compaction-test-report.md`（格式参考）

---

*三单元已执行，实测结果见 §5 观测数据。U2 脚本运行 exit 0，输出 PASS: reserved(20000) ≤ preserve_recent_tokens/2(20000)。*
