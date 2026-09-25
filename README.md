# Kilo Runtime — KiloCode 全局配置与运行时增强

<div align="center">

**简体中文** | [English](docs/GUIDE-EN.md)

</div>

> **改配置**：编辑 `kilo.json.tmpl` → `.\install.ps1` → 重载 VS Code 窗口。
> **换 API Key**：改 `~/.local/share/kilo/auth.json` 的 `hx.key`（不用 install，即时生效）。

## 架构

```
                    ┌─────────────────────────────────────────────┐
                    │            VS Code + Kilo 扩展              │
                    └────────────────────┬────────────────────────┘
                                         │ 读取
                                         ▼
本仓库（唯一真源） ─install.ps1/sh→ ~/.config/kilo/（运行时副本，别直接改）
│                                          │
├─ kilo.json.tmpl ──渲染──▶ kilo.json      │← 全部配置：模型路由 / 网关 / 权限 / 开关
├─ provider/hx-failover                    │← 模型网关客户端：流式、三级超时、故障自动降级、
│   src/ → build → dist/                   │   排队回执拦截、thinking 双兜底（协议+推理门控）
├─ plugin/（随进程自动加载，改后需重载窗口） │
│   ├─ quality-gate                        │← 三层交付质量门禁：防"声称完成但没做"
│   ├─ dual-review                         │← 双向异源审查：正向查遗漏 × 反向红队 + 裁决
│   ├─ moa                                 │← 多模型交叉分析（高风险决策）
│   ├─ permission-guard                    │← 动态拦截危险命令、密钥路径、锁文件写通道绕过
│   ├─ compaction-anchor                   │← 长会话压缩后保留任务锚点
│   └─ memory-bootstrap                    │← git 项目自动启用原生记忆
├─ agent/verify.md                         │← 异源复核子代理（高风险改动只读复核）
├─ lib/hx-client.ts                        │← moa/dual-review 共享请求层：SSE 流式、三级超时、
│                                          │   过载断路器、失败遥测
├─ INSTRUCTIONS.md                         │← 每会话注入的工程原则
└─ command/evolve.md 等                    │← 全局命令（/evolve 复盘进化）
                                           │
                              ~/.local/share/kilo/（数据目录：会话库 / 记忆 / 凭证 auth.json）
```

数据流：Kilo 会话 → provider（网关客户端）→ 上游模型网关（OpenAI 兼容 API）；
主模型故障时按 `failover.chain.models` 依次自动降级（切换时流首注入 ⚠️ [failover]
可见提示）；moa/dual-review 的分析
调用走 lib/hx-client 独立请求层（网关连续过载时断路器 fail-fast）；交付节点
由 quality-gate 按风险触发 dual-review 自动审查。

## 任务执行流程（发出任务后程序自动做什么）

```
你输入任务
   │
   ▼
① 主模型接手：拆解任务 → todowrite 建任务清单 → 逐步执行
   （读文件/改代码/跑命令；子代理按需扇出，explore 只做粗扫）
   │  期间插件自动工作：
   │   · permission-guard  实时拦截危险命令（rm -rf、改密钥文件等）
   │   · compaction-anchor 长会话压缩时保留任务锚点，上下文不丢
   │   · quality-gate 层1  每标记一个 todo 完成 → 核对真实执行痕迹，
   │                       「声称完成但没做」当场警告
   │   · quality-gate 层2  编辑过代码但没跑测试 → 否决「全部完成」
   │                       （只认末次编辑后 exit 0 的验证命令；改 provider src
   │                        未重建 dist 同样拦；跳过须显式 verify-skipped 登记）
   │   · quality-gate 诊断  编辑 TS/Python 后后台异步跑 tsc/ruff（5s 防抖），
   │                       诊断积压在交付节点冲刷回注
   ▼
② 交付节点（全部 todo 标记完成时）
   │  · 高风险文件（认证/支付/迁移等）命中，或含代码改动且编辑 ≥3 文件（含文档）
   │    → quality-gate 自动发起 dual-review：正向查遗漏 × 反向红队
   │      并行审查 + 第三方模型裁决（2~4 分钟；纯文档会话不烧审查费）
   │  · 裁决「不通过」→ 阻断交付，模型必须修复后重审（最多 2 轮；
   │    接受残余风险须显式 echo "review-accepted" 登记，可审计）
   │  · 通过 → 交付完成；超限放行/显式接受/上游失败等未闭环时，
   │    残余必须修复项沉淀进项目记忆 Open Questions（下次会话自动注入待跟进）
   ▼
③ 你看到结果：改动完成 + 审查裁决记录 + 全部降级/跳过事件账本汇总
```

你全程只需要做两件事：**描述任务**、**确认权限询问**。质量把关由插件自动执行。

## 改模型（都在 kilo.json.tmpl）

| 要改什么 | 位置 |
|---------|------|
| 主模型 | 顶部 `"model": "hx/glm-5.3-flash"` |
| 角色模型 | `agent.code / agent.plan / ...` 的 `model` |
| 网关地址 | `provider.hx.options.baseURL` |
| 降级链 / 审查模型 | `provider.hx.options.failover / moa / dual_review` |

新模型需在 `provider.hx.models` 登记后才能被引用。

## 常用命令

```powershell
.\install.ps1 -DryRun   # 改完模板先校验（不写盘）
.\install.ps1           # 下发（自动备份）
.\install.ps1 -Check    # 漂移体检
```

macOS / Linux：`./install.sh --dry-run` → `./install.sh` → `./install.sh --check`。

改 provider/hx-failover/src 后：`npm run build` → 跑 `test-failover.mjs` / `test-reasoning-gate.mjs` → install → 重载。

## 坑

- 直接改 `~/.config/kilo/kilo.json` 会被 install 覆盖，白改
- 模板注释只写「行首 `//`」；kilo.json 加自定义键整份失效
- `debug config` 通过 ≠ 能跑任务，改完必须真跑一次 `kilo run`

---

维护者进阶（架构演变 / 资产清单 / 性能与维护 / 隐私边界 / 完整约定）：见 [docs/HISTORY.md](docs/HISTORY.md)。