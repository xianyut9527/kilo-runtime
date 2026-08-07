# Tier 0/1/2 对比测试报告 (tier-bench-20260807)

> 测试日期：2026-08-07  
> 任务 ID：tier-bench-20260807  
> 工作流：完整 5 阶段 INIT→PLANNING→EXECUTING→QUALITY→DELIVERING  
> 状态：status=DONE, quality.verdict=PASS, flow-audit: ALL PASS  
> 9 个独立 git worktree：.kilo/worktrees/bench-t{n}-{i}/

## 一、9 任务 commit 元数据表

| Tier | ID | commit | author | date | files | +lines | -lines | elapsed_s | score |
|------|-----|--------|--------|------|-------|--------|--------|-----------|-------|
| T0 | T0-1 | e1097c6 | bench<bench@local> | 2026-08-07 14:31:35 | 1 (README.md) | 1 | 0 | 28 | 4 |
| T0 | T0-2 | 893f48b | tianyu | 2026-08-07 13:54:22 | 1 (.gitignore) | 4 | 0 | 12 | 4 |
| T0 | T0-3 | 21cbf4f | tianyu | 2026-08-07 13:48:28 | 1 (CHANGELOG.md) | 5 | 0 | 42 | 5 |
| T1 | T1-1 | aabaaca | tianyu | 2026-08-07 14:05:16 | 3 (path-safe+2 接入) | 186 | 1 | 1260 | 4 |
| T1 | T1-2 | 3d87c66 | tianyu | 2026-08-07 13:51:59 | 2 (frontmatter.mjs+task-context.mjs) | 53 | 2 | 303 | 5 |
| T1 | T1-3 | 98b18f3 | bench<bench@local> | 2026-08-07 13:48:40 | 3 (review.md+graph.yaml+README.md) | 51 | 1 | 95 | 5 |
| T2 | T2-1 | 076f594 | tianyu | 2026-08-07 13:52:03 | 4 (path-safe+task-context+runtime+config) | 94 | 0 | 180 | 5 |
| T2 | T2-2 | 0c909d6 | tianyu | 2026-08-07 13:49:51 | 4 (config+runtime+planning+conductor) | 22 | 3 | 334 | 5 |
| T2 | T2-3 | 14192e5 | tianyu | 2026-08-07 14:21:35 | 6 (4 agent+validator+executing.md) | 223 | 0 | 360 | 5 |

## 二、5 维对比

| 维度 | T0 | T1 | T2 |
|------|----|----|----|
| 平均耗时 (s) | 27.3 | 552.7 (中位 199) | 291.3 |
| 单位文件开销 (s/file) | 27.3 | 207 | 62.4 |
| 平均文件数 | 1.0 | 2.67 | 4.67 |
| abort 率 | 0/3 | 0/3 | 0/3 |
| PASS 率 | 3/3 | 3/3 | 3/3 |
| 输出质量均值 (1-5) | 4.33 | 4.67 | 5.00 |
| 流程阶段 | EXEC | PLANNING+EXEC+QUALITY | +plan-reviewer+reverse-auditor |

## 三、确认的缺点（含证据）

### P0 数据错误
1. **T0-3 重复 [Unreleased] 段**：commit 21cbf4f 在 L5 插入新 [Unreleased] + ### Changed + 1 bullet，但 L4 已存在 [Unreleased] 段；L9 又重复 [Unreleased] 标题。subagent 自检漏报 0 错。修复：FIX-1 amend commit 去重。

### P0 文档死引用
2. **`node scripts/lifecycle-doctor.mjs` 全仓死引用**：commit 0a119e5 删单文件后重组为 scripts/lifecycle-doctor/ 目录（index.mjs 入口已验证 57 PASS / 1 FAIL，1 FAIL 为 decouple-audit 独立检查与本次重构无关）。FIX2-A/B/C 完成后实测死引用分布：docs/tier-bench-report.md(1，本报告自指历史描述) = 1 文件 1 处（FIX2-B 已清 configuration-guide.md 等 8 文件 26 处，剩余仅本报告自指）。修复：FIX-2..5。

### P1 内容质量
3. **T1-1 derived-cache.mjs +110 行超范围**：原任务仅要求"找 1 个 path.join 接入"，subagent 实际添加 110 行（含 20 行注释 + fail-safe 原则 + 进程内 memo + 原子落盘）。属 bench-t1-1 worktree 产物不合并。
4. **T2-3 author 错配**：多个 commit author=`<bench@local>`（agent_manager session 默认）而非项目 `tianyu`。属 git config 层面。
5. **subagent 报告 elapsed_s 与实际 commit 时间不一致**：T0-1 报告 28s 但 commit 时间为 14:31（其他任务 13:48-14:05 之间），agent_manager session 在 task 委派之后又跑一次。

### P2 健壮性
6. **缺 PowerShell 转义 helper**：T1-1 1260s outlier 根因（subagent 自述 PS 转义失败 20+ 次）。修复：FIX-7 新增 scripts/lib/powershell-escape.mjs。

## 四、修复方案引用

详见 tier-bench-fix-20260807 task_context 7 unit：
- FIX-1: bench-t0-3 CHANGELOG amend
- FIX-2..5: 1 文件 1 处死引用 → /index.mjs (FIX2-A/B/C 已清 9 文件 32 处，剩本报告 1 处自指)
- FIX-6: 本报告文档
- FIX-7: scripts/lib/powershell-escape.mjs helper

## 五、关键经验

1. **tier 流程差异真实可观测**：T0 27s 极速 / T1 中位 199s / T2 334s；流程阶段数严格对应（EXEC / +PLANNING+QUALITY / +plan-reviewer+reverse-auditor）
2. **输出质量随 tier 提升**：T2 多视角自检稳定 5/5，T0/T1 受限于单次 LLM 输出
3. **subagent 工具栈开销是 tier 流程的混淆变量**：T1-1 21 分钟 outlier 暴露 PowerShell 转义问题，需独立 helper
4. **process vs result 双层验证必要**：subagent 返回的 elapsed_s 报告不可信（与 git commit 时间不符），需独立 git log -1 时间戳二次验证

## 六、worktree 分支去向

9 个分支 `bench-t0-1` ... `bench-t2-3` 未推送/未合并。Agent Manager UI 可查看/合并/清理。
