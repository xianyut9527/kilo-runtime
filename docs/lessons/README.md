# 能力沉淀教训库（docs/lessons/）

> 把编码能力长在程序里，随使用越来越强，跟模型解耦。
> LLM 判定的门禁随模型智商缩放，机械断言的门禁不缩放--这里沉淀的是后者 + 程序规则，不依赖任何模型。

## 三层沉淀

| 层 | 沉淀什么 | 载体 | 增长方式 |
|---|---|---|---|
| **A 验证** | "证明对" | 脚本硬门（exit code 说了算） | 机械类教训复发 -> 人工建脚本门（范本 `scripts/scan-encoding.mjs`） |
| **B 程序** | "怎么做" | agent 指令 + 注入规则 | 程序类教训复发 -> 自动追加规则到 `<category>.md`，dispatch 注入 |
| **C 学习** | "越来越强" | `registry.jsonl` + `<category>.md` | 每次失败 record -> audit 检测复发 -> 晋级 -> 注入 |

`scripts/scan-encoding.mjs` 就是一条**手动**沉淀的机械教训（有人踩了编码 bug，把检查固化成脚本）。本目录把这件事**系统化**：让每一次失败自动变成一条 scan-encoding.mjs（机械门）或一条程序规则（注入），而不是靠人偶尔加一个。

## 闭环

```
捕获（自动）              存储（跨任务持久）          晋级（半自动）                  注入（自动）
acceptance-check FAIL  ─>  registry.jsonl         ─>  程序类复发≥阈值：             ─>  每次 dispatch
reverse-auditor issues      （一行一条教训）            自动追加 <category>.md 规则        注入 task_context.lessons
fixer root-cause                                       机械类复发≥阈值：                 （agent frontmatter read）
QUALITY FAIL / fixer 轮                                仅输出提案，人工建脚本门           = agent 背着全部历史教训开干
```

跑 100 个任务后，agent 背 100 个任务沉淀的教训。**普通模型 + 100 条教训 > 强模型 + 0 条教训。**

## 分类（= reverse-auditor `issues[].tag` + `ACCEPTANCE_FAIL`）

| 分类 | 含义 | 主要来源 |
|---|---|---|
| `SCOPE_CREEP` | 改动超出 plan DAG 单元范围 | reverse-auditor |
| `LOCAL_PATCH` | 逐处复制粘贴而非组件化 | reverse-auditor |
| `COPY_PASTE_FIX` | 复制粘贴式修复 | reverse-auditor |
| `FAKE_CONTEXT` | 自验声明与 diff 实际不匹配 | reverse-auditor |
| `FORBIDDEN_TOUCH` | 触及 forbidden_files | reverse-auditor |
| `DEBUG_LEFTOVER` | console.log/debugger/TODO 残留 | reverse-auditor |
| `UNCOVERED_CHANGE` | diff 改动无法映射到验收标准 | reverse-auditor |
| `PROCESS_VIOLATION` | 流程跳步 | reverse-auditor / conductor |
| `TRUST_TRANSFER` | 信任传递（"coder 说的对"） | reverse-auditor |
| `ACCEPTANCE_FAIL` | 验收命令 exit code 非零 | acceptance-check.mjs |

## 晋级安全

- **捕获 / 注入 / 复发检测**：全自动（使用中生长，不依赖人）。
- **程序类晋级**（追加规则到 `<category>.md`）：复发≥阈值时 conductor 自动追加；用户经 config 仓库 `git diff` 审阅，bad 规则 `git checkout` 即回退。
- **机械类晋级**（新脚本门）：**始终人工**--高风险，脚本门一旦写错会误杀正常代码。范本 `scripts/scan-encoding.mjs`。

## 文件

- `registry.jsonl` - 原始捕获日志，一行一条教训（JSON）。跨任务持久增长。
- `<category>.md` - 该分类下**已晋级**的程序类规则。每次 dispatch 按角色注入对应分类。

## CLI（`scripts/lessons.mjs`）

```
record --category <tag> --symptom <t> --root-cause <t> --prevention <t> --type mechanical|procedural --source-task <id>
get --role <role>                  # 返回该角色已晋级规则文本（conductor 注入用）
audit [--promote-threshold 3]      # 复发检测 + 自动晋级程序类 + 机械类提案
promote <id>                       # 显式晋级一条程序类教训
list [--category <tag>]            # 列教训
```

## 角色 -> 注入分类（避免噪音，只注入相关）

| 角色 | 注入分类 |
|---|---|
| coder | SCOPE_CREEP, LOCAL_PATCH, COPY_PASTE_FIX, DEBUG_LEFTOVER, UNCOVERED_CHANGE, ACCEPTANCE_FAIL |
| verifier | FAKE_CONTEXT, ACCEPTANCE_FAIL, UNCOVERED_CHANGE |
| reviewer | SCOPE_CREEP, LOCAL_PATCH, COPY_PASTE_FIX, FORBIDDEN_TOUCH |
| reverse-auditor | SCOPE_CREEP, LOCAL_PATCH, COPY_PASTE_FIX, FAKE_CONTEXT, FORBIDDEN_TOUCH, DEBUG_LEFTOVER, UNCOVERED_CHANGE |
| fixer | ACCEPTANCE_FAIL, LOCAL_PATCH, DEBUG_LEFTOVER |
| conductor | 全部分类 |

## 起点

首次使用时 `registry.jsonl` 为空、`<category>.md` 不存在--`lessons.mjs get` 返回"暂无已晋级教训"。随着任务跑起来、失败被 record、复发被 audit 晋级，本目录逐步填充，agent 能力随之增长。
