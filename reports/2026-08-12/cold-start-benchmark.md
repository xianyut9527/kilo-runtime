# 冷启动基准测试报告

> 日期：2026-08-12 | 任务：T20260812-perf-opt | 优化目标：T2 334s→200-260s, T1 199s→150-170s

## 1. 注入上下文体积对比

| 文件 | 优化前 | 优化后 | 削减 |
|------|--------|--------|------|
| core.md | 12975B | 6998B | 46% |
| workflow-core.md | 11846B | 4695B | 60% |
| reflection.md | 1544B | 1544B | 0%（已精简） |
| **合计** | **26365B** | **13237B** | **50%** |

**结论**：每次 agent 调用注入上下文削减 13128B（50%）。T2 任务 5+ subagent 累计省 ~65KB。

## 2. 脚本冷启动计时

| 脚本 | 耗时 | 说明 |
|------|------|------|
| task-context.mjs --help | 90ms | CLI 冷启动基线 |
| transition-check.mjs --help | 82ms | 阶段门禁冷启动 |
| init-gate.mjs (no args) | 64ms | 合并脚本冷启动 |
| lifecycle-doctor --quiet | 2516ms | 只输出 FAIL 项 |
| lifecycle-doctor full | 2242ms | 全量 678 检查 |

**结论**：脚本层非瓶颈（<100ms/次），lifecycle-doctor ~2.2s 是 INIT 一次性开销。

## 3. init-gate 合并 vs 分离对比

| 方式 | 耗时 | 说明 |
|------|------|------|
| init-gate T2 (doctor+apply-tier 合并) | 2482ms | 单进程 |
| init-gate T1 (doctor+apply-tier 合并) | 2542ms | 单进程 |
| doctor + apply-tier 分离 | 2283ms + 57ms = 2340ms | 两进程 |

**结论**：init-gate 合并与分离耗时相当（~2.5s），但省 1 个 reasoning 回合（conductor 不需在两进程间做判定）。

## 4. 质量门禁

| 门禁 | 结果 |
|------|------|
| lifecycle-doctor | 678 PASS / 0 FAIL / 0 WARN |
| scan-encoding | exit 0（BOM/U+FFFD/GBK 全 pass） |

## 5. 优化项清单

| 优化项 | 预期收益 | 验证状态 |
|--------|----------|----------|
| U1 精简注入上下文 (50% 削减) | T2 省 30-60s, T1 省 20-40s | PASS |
| U2 post-dispatch 合并 | 每次 dispatch 省 2 reasoning 回合 | PASS |
| U3 verifier T1 降级 deepseek-v4-flash | T1 省 8-15s | PASS |
| U4 init-gate 合并 | INIT 省 1 reasoning 回合 | PASS |

## 6. 预期累计收益

| Tier | 基线 | 优化后预估 | 预期节省 |
|------|------|-----------|----------|
| T0 | 27s | ~20-25s | 2-7s |
| T1 | 199s | ~150-170s | 29-49s |
| T2 | 334s | ~200-260s | 74-134s |

> 注：以上为基于注入上下文削减 + 编排合并 + 模型降级的预估，实际收益需端到端任务实测验证。
> 基线数据来源：docs/tier-bench-report.md（T0=27s, T1=199s, T2=334s 中位数）
