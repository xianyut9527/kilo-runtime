---
name: report-analyzer
description: 项目成员工作报告统计分析 skill。通过 AdsPower + Playwright 抓取仓颉系统日报,按项目/成员维度统计工时占比与完成情况,输出可交互 HTML 周报(9 大 Section + v2.0 项目交付总览/状态分桶/人力盘点)。
keywords: [日报, 工时, AdsPower, 仓颉, 项目报告, 项目成员工作报告, HTML 周报, 成员工时统计, 报告分析]
version: "2.0"
---

# report-analyzer — 项目成员工作报告统计分析

## 1. 触发条件

### 1.1 何时激活本 skill

用户出现以下任一诉求时激活本 skill：

- **统计项目成员的工作报告**（日报/周报）——"统计下 7 月以来大家的日报"、"项目成员工作报告分析"
- **按项目维度看工时占比**——"每个项目花了多少时间"、"项目工时占比统计"
- **生成 HTML 周报**——"输出一个 HTML 报告"、"HTML 周报",报告要求可交互(饼图 hover 显示明细)
- **成员工时统计 / 人员投入分析**——"成员工时统计"、"谁投入哪个项目多少时间"
- **项目交付情况总览 / 状态分桶 / 人力盘点**（v2.0+）——"项目是谁负责的"、"哪些项目已完成/在运维"、"交付中心缺不缺人"

### 1.2 关键要素（每次执行必须询问用户）

1. **成员名单**：默认 14 人（邓佳辉;郭浩成;贺明阳;黄彬洋;胡阳;蒋番;刘成锐;罗贵川;秦琪森;任志勇;谭飞;田于;王海关;姚东甫），可用"全员"或逗号/分号分隔的名单
2. **日期范围**：--start-date / --end-date（如 2026-07-01 ~ 2026-07-17）
3. **输出形式**：默认终端摘要；需要时加 --html 输出可交互 HTML 周报

### 1.3 不适用场景

- 不需要仓颉实时数据、仅基于已有 JSON 重算 → 用 `rerender.py`
- 需要代码资产侧的项目进度（非工时侧）→ 用 `project-intelligence-report` skill

## 2. 快速开始

```powershell
cd .kilo/skills/report-analyzer

# 基础用法（自动检测 AdsPower 浏览器 + 成员/日期交互确认）
python report-analyzer.py --members "田于,郭浩成" --start-date 2026-07-01 --end-date 2026-07-17

# 生成可交互 HTML 周报
python report-analyzer.py --members "全员" --start-date 2026-07-01 --end-date 2026-07-17 --html report-2026-07.html

# v2.0 数据源接入（项目交付总览/状态分桶/人力盘点）
python report-analyzer.py --members "全员" --start-date 2026-07-01 --end-date 2026-07-31 --html report.html --project-metadata project-metadata.json --monthly-snapshot-dir monthly-snapshots --headcount-target headcount-target.json

# 仅对已有 JSON 回算（不重新抓取）
python rerender.py --json report-2026-07.json --start-date 2026-07-01 --end-date 2026-07-17 --html report-2026-07.html
```

## 3. 前置要求

| 依赖 | 说明 |
|------|------|
| Python 3.10+ | 脚本运行环境（Playwright 用 Python 版） |
| Playwright (Python) | `pip install playwright`，需安装 chromium |
| AdsPower 客户端 | 本地 API `http://127.0.0.1:50325`，须已登录并打开目标页面 |
| 目标页面 | `https://cangjie.icinfo.cn/target-manage/work/report`（仓颉系统日报页） |
| 登录态 | 确保 AdsPower 浏览器已登录仓颉系统（脚本有 ensure_logged_in 前置检查） |

### 3.1 AdsPower 自动发现

脚本通过本地 API 自动发现活跃浏览器环境，无需手动查找 CDP 端口：

```http
GET http://127.0.0.1:50325/api/v1/browser/local-active
```

返回活跃环境的 `ws` 端点后，Playwright 通过 CDP 连接该浏览器，复用已打开的页面。多环境时可用 `--adspower-user-id` 指定。

### 3.2 页面结构（Element UI + 自定义单选树）

- 筛选器为自定义组件 `.my-tree-select`（**单选树**，非多选）——脚本通过**逐个切换成员**实现多成员统计
- 数据按日期分组卡片展示：`2026年07月17日(周五)` 头 + 计划内容/完成内容描述/当前耗时/总耗时/负责人
- 项目名取自"计划内容"列完整原始值（默认**完整保留**，`--simplify-project` 才截断）
- 页面切换成员后有异步加载（el-loading-mask），脚本检测 loading 消失后再提取，避免数据串成员

## 4. CLI 参数说明

### 4.1 report-analyzer.py

| 参数 | 说明 | 默认 |
|------|------|------|
| `--members` | 成员名单，逗号/分号分隔；`全员` = 默认 14 人 | 每次询问 |
| `--start-date` | 开始日期 YYYY-MM-DD | 每次询问 |
| `--end-date` | 结束日期 YYYY-MM-DD | 每次询问 |
| `--html` | 输出 HTML 周报路径（可交互 ECharts） | 无 |
| `--output` | 输出结构化 JSON 数据路径 | 无 |
| `--config` | 配置文件（members/adspowerUserId） | 无 |
| `--adspower-user-id` | 指定 AdsPower 环境（多环境时） | 自动发现 |
| `--force-reload` | 每次切换成员前强制刷新整页（~3s/人，100% 成功率） | False |
| `--simplify-project` | 项目名截断为前两段（旧行为） | False（完整保留） |
| `--project-metadata` | project-metadata.json 路径（v2.0） | 同目录 |
| `--monthly-snapshot-dir` | 月度快照目录（v2.0） | ./monthly-snapshots/ |
| `--headcount-target` | headcount-target.json 路径（v2.0） | 同目录 |### 4.2 rerender.py

| 参数 | 说明 | 默认 |
|------|------|------|
| `--json` | 已有统计 JSON 路径 | 必填 |
| `--start-date` / `--end-date` | 与 report-analyzer 同口径 | 询问 |
| `--html` | 重渲 HTML 周报 | 无 |
| `--write-json` | 回算后写回 JSON | False |
| `--no-backfill-v2` | 跳过 v2.0 字段回算（project-metadata/快照/编制） | False |
| `--project-metadata` / `--monthly-snapshot-dir` / `--headcount-target` | v2.0 数据源（同 4.1） | 默认路径 |

## 5. 执行流程（5 步）

```
① AdsPower 发现 → ② Playwright 抓取 → ③ 工时统计 → ④ HTML 报告 → ⑤ rerender 回算
```

### 5.1 AdsPower 发现（~1s）

1. `GET /api/v1/browser/local-active` 探测活跃浏览器
2. 未发现时重试 2 次 + 异常分类提示（未启动/未登录/API 不可达）
3. 取 `ws` 端点，Playwright `connect_over_cdp`

### 5.2 Playwright 抓取（~1.7s/人）

1. 校验登录态 + 目标页已打开（ensure_logged_in）
2. 打开 `.my-tree-select` 下拉 → 4 策略查找成员节点（text= 精确 / .el-tree-node__content / 展开"技术中心"遍历 / 模糊匹配）
3. 点击成员 → 点"确定"（5 个 selector 候选）→ 条件轮询等待筛选器文本变更 + `el-loading-mask` 消失
4. 提取该成员整月日报记录（TreeWalker 局部扫描，~0.2s）
5. 内存中按日期范围过滤
6. 切换失败自动重试 1 次；仍失败记录到失败清单，不中断整体（`--force-reload` 兜底）

### 5.3 工时统计

- 每条日报取"总耗时"列（`currentHour`）
- 项目归并：默认取计划内容**完整原始值**（normalize 引号/全角后保留全名）；`--simplify-project` 取前两段
- 按项目累加 totalHours / 参与人数 / 成员名单

### 5.4 HTML 报告

生成独立 HTML（ECharts 5.5 CDN + Indigo/Violet 主题），包含 9 大 Section（见 §7）。

### 5.5 rerender 回算（可选）

已有 JSON 需补算 contributionPct / roleBreakdown / v2.0 字段时运行 rerender.py（见 §8）。

## 6. 数据模型与口径

### 6.1 工时三字段（v2.0）

| 指标 | 算法 | 阈值 |
|------|------|------|
| 总时长 totalHours | 该项目所有日报 currentHour 之和 | 无 |
| 工作时间 workHours | 按天 `min(dailyTotal, OVERTIME_DAILY_THRESHOLD)` 累加 | 8.0h/天 |
| 加班时间 overtimeHours | 按天 `max(0, dailyTotal - 8.0)` 累加 | 8.0h/天 |

**⚠️ OVERTIME_DAILY_THRESHOLD=8.0 与 STANDARD_DAILY_HOURS=7.5 解耦**：
- `STANDARD_DAILY_HOURS = 7.5`：公司预期工时，用于 overPct（超载/欠量判断）
- `OVERTIME_DAILY_THRESHOLD = 8.0`：劳动法 8h 工作制，用于加班风险告警

边界值：日工时 3h → work=3/over=0；8h → work=8/over=0；10h → work=8/over=2。

### 6.2 风险评分（4 因子加权，v2.0）

```
riskScore = Σ(factor_i × weight_i)   # 缺因子时权重重分配
```

| 因子 | 权重 | 公式 | 缺数据降级 |
|------|------|------|-----------|
| 进度偏差 schedule | 0.35 | `(completionThisMonth - forecastCompletion)/forecastCompletion×100` | 因子=0，权重分配 |
| 加班强度 overtime | 0.30 | `overtimeHours / workHours × 100` | 因子=0 |
| 人员缺口 headcount | 0.20 | `(target - actual)/target × 100`（按 dominant role） | 因子=0 |
| 紧迫度 urgency | 0.15 | `remaining% × (60 - daysToEnd)/60` | 因子=0 |

风险分级：`<-30` 🔴 高风险 / `-30~-10` 🟡 中风险 / `>-10` 🟢 正常 / 全缺数据 ⚪ 待评估(unknown)。

## 7. HTML 周报 9 大 Section 结构

| # | Section | 内容 | 来源 |
|---|---------|------|------|
| 1 | 📊 项目维度总览 | ECharts 环形图（hover 显示项目完整名/工时/占比/参与人数/成员标签云）+ 项目卡片（工时、占比 badge、成员、进度条、双向联动高亮） | 抓取统计 |
| 2 | 📁 项目明细 | 每项目总工时/工作·加班拆分/参与人数/工作日 | 统计 |
| 3 | 👥 成员维度总览 | memberBar + 成员卡片（项目贡献%、attendedDays、角色） | 统计 |
| 4 | 🔗 成员-项目贡献矩阵 | 矩阵表 + contributionPct（可复制到 Excel） | 统计 |
| 5 | 🎯 项目岗位占比 | 各项目 5 角色（交付/产品/测试/开发/实施）工时占比 | ROLES |
| 6 | ⏱️ 工时矩阵 | 成员×项目 hours 矩阵，非零单元格高亮 | 统计 |
| 7 | 🏗️ 项目交付情况总览 | 14 列大表（交付经理/方案/产品经理/销售/项目类型/完成%/风险 vs 正常/时长三字段） | project-metadata + 快照 |
| 8 | 📦 项目状态分桶 | 3 卡片（已完成/正在进行/运维） | metadata.statusMapping |
| 9 | 👔 交付中心人力资源情况 | 4 stat-card + 1 缺口表（在编 vs 目标） | headcount-target + target_members |

## 8. rerender 回算逻辑

- 重算各项目 `contributionPct`（hours/totalHours×100）+ `roleBreakdown`（5 角色 hours 分布）
- 调 `backfill_member_and_project_fields` 补齐成员/项目缺失字段
- `--no-backfill-v2` 跳过 v2.0 字段（completionSegments/riskScore/headcountAnalysis）
- 优先复用 report-analyzer.py 实现，缺失时内置降级回算

## 9. 角色体系（5 ROLES）

### 9.1 角色定义

v2.0 在 v1.9 4 角色（交付/产品/测试/开发）基础上新增 **实施**，共 5 角色：

| key | 中文角色 | 说明 | 默认人员 |
|-----|---------|------|---------|
| delivery | 交付经理 | 项目交付管理/协调 | 邓佳辉、秦琪森 |
| product | 产品经理 | 需求/产品 | 罗贵川、胡阳 |
| test | 测试 | 测试验证 | 王海关 |
| dev | 研发（研发组长/研发） | 开发实现，默认归集未分配成员 | 其余成员 |
| implement | 实施 | 现场实施/客户培训 | 由用户填入 |

```
ROLES = {
    "delivery":  frozenset({"邓佳辉", "秦琪森"}),  # 交付经理
    "product":   frozenset({"罗贵川", "胡阳"}),    # 产品经理
    "test":      frozenset({"王海关"}),            # 测试
    "implement": frozenset(),                      # 实施 — 由用户填入
    # dev 自动 = 14 人 - 上述
}
ROLE_ORDER = ("delivery", "product", "test", "dev", "implement")
```

### 9.2 角色判定规则

- `get_role(member)`：先查 ROLES 字典；未登记成员自动归 `dev`
- 成员默认名单（14 人）：邓佳辉;郭浩成;贺明阳;黄彬洋;胡阳;蒋番;刘成锐;罗贵川;秦琪森;任志勇;谭飞;田于;王海关;姚东甫
- 项目岗位占比（Section 5）= 各角色在该项目工时 / 项目总工时

### 9.3 为什么实施独立

交付经理偏管理协调；实施偏现场部署/客户培训。混在一起看不到"实施人力投入"独立数据。

### 9.4 新增岗位流程（如未来加"运维"）

1. `ROLES` 加 `"ops": frozenset({...})`
2. `ROLE_LABELS` / `ROLE_COLORS` / `ROLE_ORDER` 同步加
3. HTML 自动遍历（已用字典驱动）

## 10. 反模式清单（12 条）

### 10.1 v1.9 原始 6 条

- `[REPORT_ANTI_PATTERN_TRUNCATE_PROJECT]`：默认截断项目名为前两段，把 `汇信数字化系统-数据上报模块-版本v2.3` 错误合并到 `汇信数字化系统-数据上报模块`，丢失版本号等关键信息（v1.3+ 必修：默认完整保留项目名，`--simplify-project` 才截断）
- `[REPORT_ANTI_PATTERN_NO_PHASE2_MERGE]`：多成员数据抓取后未做项目名归一化合并，同一项目因引号/全角差异被拆成多条统计（v1.3+ 必修：normalize_project_name 统一引号/全角后再归并）
- `[REPORT_ANTI_PATTERN_STAGE_PREFIX_MISSED]`：项目名含"项目开发阶段-""订单跟进阶段-"等前缀时未剥离，同一项目不同阶段显示为不同项目（必修：STAGE_PREFIXES 前缀剥离后归并）
- `[REPORT_ANTI_PATTERN_NO_NAME_MATCH]`：日报项目名与 KNOWN_PROJECTS 无法精确匹配时直接丢弃，导致数据缺失（必修：name-based 匹配 + alias 兜底，匹配不上归入"其他"桶而非丢弃）
- `[REPORT_ANTI_PATTERN_ALIAS_ORDER]`：项目 alias 匹配顺序颠倒，长名先被短名 alias 吞掉（必修：alias 匹配按最长优先，短 alias 不得吞长名）
- `[REPORT_ANTI_PATTERN_HOVER_SCROLL]`：饼图 hover 联动导致页面自动滚动/卡片跳动，管理层查看时体验差（必修：联动高亮 + scrollIntoView 节流，hover 不强制滚动）

### 10.2 v2.0 新增 6 条

- `[REPORT_ANTI_PATTERN_NO_PROJECT_METADATA]`：运行 v2.0 功能但未维护 `project-metadata.json`，导致"项目交付情况总览"全显示"—"，管理层看不到交付经理/完成%/风险（v2.0+ 必修：首次使用前必须创建 project-metadata.json，至少填写 deliveryManager / projectType / status）
- `[REPORT_ANTI_PATTERN_MISSING_IMPLEMENT_ROLE]`：v2.0 升级后未将"实施"人员从 `dev` 改到 `implement`，导致实施人员工时被混入开发，看不到真实实施投入（v2.0+ 必修：必须在 ROLES["implement"] 中登记所有实施人员；ROLE_ORDER 已自动扩展为 5 角色）
- `[REPORT_ANTI_PATTERN_NO_MONTHLY_SNAPSHOT]`：需要"本月增量"但上月快照文件缺失，导致 completionDelta 显示为"—"（v2.0+ 必修：每月运行脚本后手动或自动保存月度快照到 monthly-snapshots/YYYY-MM.json）
- `[REPORT_ANTI_PATTERN_COMPLETION_OUT_OF_RANGE]`：project-metadata.json 中 completion% 超出 0-100 范围，导致进度条溢出（v2.0+ 必修：load_project_metadata 必须校验数值范围，超限截断并报 warning）
- `[REPORT_ANTI_PATTERN_OVERTIME_THRESHOLD_CONFUSION]`：把 `OVERTIME_DAILY_THRESHOLD = 8.0` 和 `STANDARD_DAILY_HOURS = 7.5` 混为一谈，试图改为同一值（v2.0+ 必修：两者语义不同，加班阈值是劳动法口径 8h，标准工时是公司预期 7.5h，不要混用）
- `[REPORT_ANTI_PATTERN_HARDCODED_STATUS_BUCKET]`：在 HTML 模板中硬编码"已完成/进行中/运维"三个分桶卡片，不读 `statusMapping`（v2.0+ 必修：必须用 metadata.statusMapping 驱动分桶标签，新增状态只改 JSON 不改代码）

## 11. 常见问题（FAQ）

| 问题 | 解决 |
|------|------|
| 抓取时某成员数据为 0 | 切换后页面异步未刷新？脚本已检测 el-loading-mask；仍失败加 `--force-reload` |
| 同一项目被拆成多条 | 引号/全角差异 → normalize_project_name 未生效？检查是否走了旧 JSON 而非重抓 |
| 成员名带生僻字（如"甫"）找不到节点 | 4 策略节点查找（text= 精确/class 精确/展开遍历/模糊匹配），仍失败用 `--force-reload` |
| 项目名被截断 | 默认已完整保留；若仍截断说明版本未升级到 v1.3+ |
| HTML 饼图不交互 | 确认 HTML 由 v1.3+ 脚本生成（ECharts 5.5 环形图 + hover tooltip + 双向联动） |
| 想看交付经理/方案/产品经理/销售/项目类型 | v2.0+ Section 7「项目交付情况总览」+ project-metadata.json |
| 想看本月完成增量 / 预计完成 / 风险 | v2.0+ completionSegments + riskScore（4 因子加权） |
| 想看哪些项目已完成 / 在运维 | v2.0+ Section 8「项目状态分桶」 |
| 想看交付中心各岗位在编 vs 目标 / 缺口 | v2.0+ Section 9 + headcount-target.json |
| 想把"实施"从开发分出来 | v2.0+ ROLES["implement"] 已预留；填成员名即可 |

## 12. 数据源维护（v2.0）

### 12.1 project-metadata.json（项目元数据）

**位置**：与 report-analyzer.py 同目录，或 `--project-metadata` 指定

```json
{
  "version": "2.0",
  "lastUpdated": "2026-07-21",
  "projects": {
    "重庆市司法局执法+监督集成数字应用项目": {
      "deliveryManager": "秦琪森",
      "solutionManager": "邓佳辉",
      "productManager": "罗贵川",
      "sales": "某销售",
      "projectType": "开发类",
      "status": "ongoing",
      "startDate": "2025-01-01",
      "plannedEndDate": "2026-12-31",
      "completionLastMonth": 47,
      "completionThisMonth": 67,
      "forecastCompletion": 85
    }
  },
  "statusMapping": {
    "ongoing": "正在进行",
    "completed": "已完成",
    "maintenance": "运维"
  }
}
```

**字段必填性**：
- 必填：`deliveryManager` / `projectType` / `status`（缺则显示"—"或默认"ongoing"）
- 可选：`solutionManager` / `productManager` / `sales` / 完成% / 日期

**维护流程**：
1. 首次使用：用户从外部系统导出项目清单 → 按 schema 整理 → 保存到默认路径
2. 新增项目：在 `projects` 字典加新条目
3. CLI：`--project-metadata project-metadata.json`
4. 缺文件时：**降级** —— Section 7 所有元数据字段显示"—"，不报错

### 12.2 monthly-snapshots/YYYY-MM.json（月度快照）

**位置**：`./monthly-snapshots/` 或 `--monthly-snapshot-dir` 指定

```json
{
  "month": "2026-06",
  "generatedAt": "2026-07-01T00:00:00",
  "source": "manual",
  "completions": {
    "重庆市司法局执法+监督集成数字应用项目": 47,
    "成都市\"一码检查\"": 82
  }
}
```

**累计逻辑**：
- `completionLastMonth` = 上月快照 `completions[project]`，缺省 None
- `completionThisMonth` = project-metadata 优先 → 当前月快照 → None
- `completionDelta` = `completionThisMonth - completionLastMonth`，任一为 None 时显示"—"

**维护**：每月运行脚本后手动保存到 `monthly-snapshots/{YYYY-MM}.json`

### 12.3 headcount-target.json（岗位目标编制）

**位置**：与脚本同目录或 `--headcount-target` 指定

```json
{
  "version": "2.0",
  "lastUpdated": "2026-07-21",
  "targets": {
    "delivery": 4,
    "product": 3,
    "test": 2,
    "dev": 10,
    "implement": 3
  }
}
```

**缺文件时**：Section 9 显示"（未配置 headcount-target.json）"提示，不报错

### 12.4 gap 公式约定（v2.0）

`gap = actual - target`：
- `gap < 0`：**缺口**（人员不足）→ 红色 badge
- `gap = 0`：**达标** → 绿色 badge
- `gap > 0`：**超编**（人员富余）→ 蓝色 badge

**为什么不写成 `target - actual`**：与 `overPct` / `gapPct` 保持一致（用 actual 减 target，正数=多，负数=少），便于跨表对比。

## 13. ⚠️ v2.0 新增三大模块（项目交付总览 + 状态分桶 + 人力盘点）

**问题（v1.9 仍存在真实痛点）**：

v1.9 能看到"项目有多少工时 / 哪个岗位投入多少 / 谁的贡献高"，但回答不了管理层真正关心的"管理面"问题：

1. **项目是谁负责的？** —— 交付经理/方案/产品经理/销售是谁？项目类型是什么？
2. **项目进度如何？** —— 完成度多少？本月增量？预计何时完成？是风险还是正常？
3. **团队加班多不多？** —— 这个项目的工作时间 vs 加班时间占比？
4. **哪些项目已完成 / 在进行 / 在运维？** —— 当前周期内项目状态分桶？
5. **团队缺不缺人？** —— 交付中心各岗位在编 vs 目标 = 缺口？

**修复**（v2.0）三大模块 + 三个新数据源 + 一个新角色。

### 13.1 模块一：项目交付情况总览（Section 7）

每项目标注人员（交付经理/方案/产品经理/销售）、5 类职能占比（交付/产品/测试/开发/实施）、项目类型、完成百分比（截止上月/本月/增量/forecast）、风险 vs 正常判定、时长三字段（总时长/工作时间/加班时间）。

14 列大表字段：项目名称 / 交付经理 / 方案 / 产品经理 / 销售 / 项目类型 / 完成%（上月/本月/增量/forecast）/ 风险状态 / 总时长 / 工作时间 / 加班时间 / 参与人数 / 成员明细。

- 完成百分比：`completionLastMonth`（截止上月）/ `completionThisMonth`（截止本月）/ `completionDelta`（本月增量）/ `forecastCompletion`（预计完成）
- 风险 vs 正常：riskScore 4 因子加权（见 §6.2），`< -30` 高风险 / `-30 ~ -10` 中风险 / `> -10` 正常 / 缺数据 ⚪ 待评估
- 时长三字段：totalHours / workHours / overtimeHours（见 §6.1）

### 13.2 模块二：项目状态分桶（Section 8）

按 `project-metadata.statusMapping` 将项目分为三类卡片：

| 状态 key | 中文标签 | 判定 |
|---------|---------|------|
| ongoing | 正在进行 | metadata.status=ongoing |
| completed | 已完成 | metadata.status=completed |
| maintenance | 运维 | metadata.status=maintenance |

**硬约束**：分桶标签必须读 `statusMapping` 驱动，禁止在 HTML 模板硬编码三个卡片（见反模式 HARDCODED_STATUS_BUCKET）。新增状态只改 JSON 不改代码。

### 13.3 模块三：交付中心人力资源情况（Section 9）

- 数据来源：`headcount-target.json` targets + `ROLES` 实际在编
- 4 stat-card：总人数 / 各岗位人数（交付经理/产品经理/测试/开发/实施）
- 1 缺口表：岗位 / 目标 target / 在编 actual / 缺口 gap（gap = actual - target）
- 缺口判定：`gap < 0` 缺口（红）/ `gap = 0` 达标（绿）/ `gap > 0` 超编（蓝）
- 缺文件时：显示"（未配置 headcount-target.json）"提示，不报错

## 14. v2.0 数据源维护流程

### 14.1 首次使用

```bash
# 1. 创建 project-metadata.json（按 §12.1 schema）
# 2. 创建 monthly-snapshots/ 目录（可选，缺则完成% 三段显示—）
mkdir monthly-snapshots
# 3. 创建 headcount-target.json（可选，缺则 Section 9 不显示缺口列）
# 4. 跑脚本
python report-analyzer.py --members "全员" --start-date 2026-07-01 --end-date 2026-07-17 --html report.html --project-metadata project-metadata.json --monthly-snapshot-dir monthly-snapshots --headcount-target headcount-target.json
```

### 14.2 每月维护

1. 更新 `project-metadata.json` 的 `completionThisMonth` / `forecastCompletion` 字段
2. 把上月完成度快照保存为 `monthly-snapshots/{YYYY-MM}.json`
3. 跑脚本生成新 HTML

### 14.3 人员变动

- **新增成员**：默认归 `dev`；如需改岗，编辑 `ROLES` 字典
- **岗位变动**：编辑 `ROLES` + `ALL_V19_MEMBERS`（如人员离开）
- **新增岗位类别**：编辑 `ROLES` + `ROLE_LABELS` + `ROLE_COLORS` + `ROLE_ORDER`（HTML 自动适配）

### 14.4 schema 升级

当 `project-metadata.json` schema 变化时，保留 `version` 字段。`load_project_metadata` 可按 version 分支处理。

## 15. v2.0 常见问题扩展（FAQ v2.0）

| 问题 | 解决 |
|------|------|
| **HTML 没看到 Section 7/8/9** | 检查是否传了 `--project-metadata` / `--headcount-target`；缺数据时 Section 9 显示"（未配置）"提示；Section 7/8 仍渲染但内容为"—" |
| **交付经理/方案显示"—"** | project-metadata.json 没维护对应字段 |
| **本月增量显示"—"** | monthly-snapshots/{上月}.json 缺失或该项目无 lastMonth |
| **风险状态全是 ⚪ 待评估** | forecastCompletion 缺失，算法降级为 unknown |
| **Section 9 缺口列空白** | headcount-target.json 缺失或 target=0 |
| **想把某人从 dev 改到 test** | 编辑 `ROLES["test"]` 加成员名，HTML 自动反映 |
| **新增"运维"岗位** | 4 处常量同步（ROLES / ROLE_LABELS / ROLE_COLORS / ROLE_ORDER） |
| **rerender 看不到 Section 7/8/9** | rerender 也需传 `--project-metadata` 等参数 |
| **老 JSON rerender 怎么补 v2.0 字段** | rerender.py 默认会回算（`--no-backfill-v2` 可关闭） |
| **gap 正负号约定** | gap = actual - target；负数=缺口，正数=超编（详见 §12.4） |

## 16. v2.0 输出与验收

### 16.1 输出文件清单

| 文件 | 说明 |
|------|------|
| `report-{start}_to_{end}.json` | 结构化统计（--output） |
| `report-{start}_to_{end}.html` | 可交互 HTML 周报（--html，9 Section） |
| `monthly-snapshots/{YYYY-MM}.json` | 月度快照（每月维护生成） |
| `project-metadata.json` | 项目元数据（手工维护） |
| `headcount-target.json` | 岗位目标编制（手工维护） |

### 16.2 验收标准

| # | 验收点 | 验证方式 |
|---|--------|---------|
| 1 | 抓取成功 | 每成员记录数 > 0（无 0 数据成员） |
| 2 | 项目归并正确 | 同一项目未因引号/全角被拆分 |
| 3 | HTML 生成 | 文件存在且含 ECharts 容器 + 9 个 Section 锚点 |
| 4 | 5 角色判定 | 每个成员归属 delivery/product/test/dev/implement 之一 |
| 5 | 工时三字段 | totalHours = workHours + overtimeHours（按天口径） |
| 6 | 完成% 三段 | completionLastMonth/ThisMonth/Delta 均来自元数据+快照 |
| 7 | 风险分级 | riskScore 输出 红/黄/绿/待评估 之一 |
| 8 | 状态分桶 | 所有项目均落入 statusMapping 的 3 类 |
| 9 | 缺口表 | gap = actual - target，正负号符合 §12.4 约定 |
| 10 | rerender 回算 | 老 JSON 补算后 contributionPct/roleBreakdown 一致 |

### 16.3 已知边界与限制

- AdsPower 未启动 / 未登录 → 前置检查报错并提示，不静默
- 页面 UI 升级导致 selector 失效 → 需更新脚本选择器（页面为 Element UI + .my-tree-select 单选树）
- 跨月抓取：默认按开始日期所在月份整月抓取后内存过滤；跨月需多次切换月份（或分批执行）
- 系统"总耗时"列缺失时按 8h/条估算（兜底）
- v2.0 数据源缺失时不阻断：Section 7 显示"—"、Section 9 显示"未配置"提示

## 17. 项目识别与归并规则

### 17.1 normalize_project_name（引号/全角归一）

```python
def normalize_project_name(name: str) -> str:
    # 统一引号：中文引号/单引号 → 双引号；全角空格 → 半角
    # 去首尾空白；连续空白折叠
```

同一项目因引号/全角差异被拆分是历史高频问题（反模式 NO_PHASE2_MERGE），归一化必须在归并前完成。

### 17.2 STAGE_PREFIXES（阶段前缀剥离）

```python
STAGE_PREFIXES = ("项目开发阶段-", "订单跟进阶段-", "项目运维阶段-", "项目售前阶段-")
```

- 日报计划内容常见格式：`项目开发阶段-成都市"一码检查"` / `项目开发阶段-重庆市司法局执法+监督集成数字应用项目`
- 归并前剥离阶段前缀，避免同一项目因阶段不同显示为不同项目（反模式 STAGE_PREFIX_MISSED）
- 剥离后匹配 `KNOWN_PROJECTS` / aliases；仍未匹配归入"其他"桶（不丢弃，反模式 NO_NAME_MATCH）

### 17.3 KNOWN_PROJECTS / PROJECT_ALIASES

```python
KNOWN_PROJECTS = {
    "重庆市司法局执法+监督集成数字应用项目",
    "成都市\"一码检查\"",
    "重庆市电子证照库建设项目（二期）",
    "北碚区涉刑移送案件执法监管一件事",
    ...
}
PROJECT_ALIASES = {"司法局": "重庆市司法局执法+监督集成数字应用项目", ...}
```

- alias 匹配**最长优先**，短 alias 不得吞长名（反模式 ALIAS_ORDER）
- 匹配链：精确 → alias → name-based（子串/包含）→ 其他桶

### 17.4 非项目聚合桶（"其他"桶）

```python
NON_PROJECT_BUCKET = "其他"
NON_PROJECT_MIN_MEMBERS = 3
```

- 无法归入任何已知项目的日报聚合到"其他"桶
- 桶内按 subItems 复合键（项目-子项目-子项）合并，成员去重、hours 累加
- member_stats.projects 同步合并（pop 原 key → 累加到桶）

### 17.5 成员统计字段

| 字段 | 说明 |
|------|------|
| expectedHours | 预期工时 = attendedDays × 7.5 |
| overPct | 超载率 = (totalHours - expectedHours)/expectedHours × 100 |
| avgDailyHours | 日均工时 = totalHours / attendedDays |
| attendedDays | 出席天数 = distinct 日期数 |
| role | 5 角色之一（§9） |
| contributionPct | 该成员在某项目工时 / 该成员总工时 × 100 |

## 18. HTML 报告交互与样式

### 18.1 布局

- **sidebar 目录 + main-content**（App 布局，非胶囊 TOC），7 主 Section 顶部导航
- Indigo/Violet 渐变主色调、卡片圆角 + 细边框、现代数据展示风格
- 响应式：窄屏卡片堆叠、表格横向滚动

### 18.2 饼图交互（ECharts 5.5 环形图）

- **hover tooltip**：项目完整名 + 工时 + 占比 + 参与人数（大字号突出）+ 参与成员标签云
- **双向联动高亮**：
  - 饼图 hover → 对应项目卡片 + 表格行高亮，并滚动到视口（节流，不抖动）
  - 卡片/表格 hover → 饼图对应扇区高亮并弹出 tooltip
- 图例右侧滚动式，避免项目多时被挤占

### 18.3 项目卡片

每项目一张卡：总工时 / 工作·加班拆分 / 参与人数 / 工作日 / 交付经理·方案·产品经理 / 进度条（完成%）/ 悬停上浮阴影。

### 18.4 表格

- 项目名称下方显示完整路径（sub 样式）
- 成员标签可换行
- 矩阵非零单元格高亮
- 表头不换行、矩阵 sticky 首列（便于横向滚动对比）

### 18.5 Section 7 弹窗（成员明细聚合）

- 卡片点击弹出 L2/L3 成员明细：每项目成员明细（name/role/hours/days/pct）+ 每日工时趋势（date/hours/members）
- 数据来自 `_calc_time_breakdown_for_project` 的 membersDetail + dailyTrend
- JS 弹窗数据缓存须作用域隔离，避免跨 Modal 污染（`_dailyRows` 全局缓存问题已修复）

## 19. 性能与稳定性指标

### 19.1 目标性能（实测基准）

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 2 人统计 | ~25-30s | ~4.5s |
| 8 人统计 | ~120s | ~13.5s |
| 人均耗时 | ~10-15s | ~1.7s |

### 19.2 关键优化手段

1. **条件轮询替代固定 sleep**：等待筛选器文本变更 + el-loading-mask 消失即继续（切换 ~1.5s）
2. **DOM 提取局部化**：TreeWalker 仅遍历文本节点 + 局部表格容器（~0.2s）
3. **成员切换失败自动重试 1 次**；仍失败记录失败清单不中断
4. **AdsPower API 2 次重试 + 异常分类**（未启动/未登录/不可达）
5. **ensure_logged_in() 前置检查**（未登录/会话过期拦截）
6. **--force-reload 兜底**：切换失败时强制整页刷新（~3s/人，100% 成功）

### 19.3 稳定性保障

- 单成员异常隔离：try/except 包裹，失败成员跳过并汇总 `⚠️ 以下成员处理失败`
- 切换后数据一致性校验：检测到 el-loading-mask 消失后再提取，防止数据串成员
- 提取结果校验：每成员记录数 > 0 才视为成功

## 20. 版本演进记录

| 版本 | 变更 |
|------|------|
| v1.0 (7/17) | 创建：AdsPower + Playwright 抓取仓颉日报，成员/项目维度工时统计 |
| v1.1 | 输出 HTML 报告（项目维度汇总） |
| v1.2 | 效率稳定性优化：条件轮询、DOM 局部提取、重试机制（人均 ~1.7s） |
| v1.3 | 报告改版：移除成员明细板块、ECharts 交互饼图、双向联动高亮；项目名完整保留 + --simplify-project；--force-reload；4 策略节点查找 |
| v1.4-v1.8 | 4 岗位映射（交付/产品/测试/开发）、成员卡片项目贡献%、贡献矩阵、岗位占比汇总、attendedDays、overPct 7.5h 口径、滚动 bug 修复 |
| v1.9 | 项目卡片岗位分布、风险/正常判定雏形、数据源加载入口 |
| v2.0 (7/21) | 新增三大模块（项目交付总览 Section 7 / 状态分桶 Section 8 / 人力盘点 Section 9）+ 实施角色 + project-metadata/月度快照/headcount-target 三数据源 + 时长三字段 + 4 因子风险评分 |
| v2.1-v2.7 | 布局改版（sidebar + main-content）、Section 7 卡片+弹窗、Section 8/9 重建、其他桶聚合、修复审查 6 项（type badge 转义、缓存隔离、_tc 字典补产品类、死代码清理） |

## 21. 与相邻 skill 的关系

| skill | 定位 | 数据源 |
|-------|------|--------|
| report-analyzer | 项目成员工作报告（工时侧：谁投入多少时间） | 仓颉日报 + AdsPower/Playwright |
| project-intelligence-report | 项目进度报告（代码资产侧：功能/API/变更） | gitnexus 知识图谱 |

两者互补：report-analyzer 回答"投入"，project-intelligence-report 回答"进度"。管理层看板可同时消费两个 skill 的输出。

## 22. 完整命令示例

### 22.1 单成员单月

```powershell
cd .kilo/skills/report-analyzer
python report-analyzer.py --members "田于" --start-date 2026-07-01 --end-date 2026-07-31 --html report-tianyu-2026-07.html
```

### 22.2 全员 + 导出 JSON + HTML

```powershell
python report-analyzer.py --members "全员" --start-date 2026-07-01 --end-date 2026-07-31 --output report-2026-07.json --html report-2026-07.html
```

### 22.3 跨月统计（7/15 ~ 8/15）

```powershell
# 跨月需分两段执行后合并，或使用 config 指定月份切换策略
python report-analyzer.py --members "田于,郭浩成" --start-date 2026-07-15 --end-date 2026-07-31 --output july-part.json
python report-analyzer.py --members "田于,郭浩成" --start-date 2026-08-01 --end-date 2026-08-15 --output aug-part.json
# 用 rerender.py 合并回算
python rerender.py --json july-part.json --start-date 2026-07-15 --end-date 2026-07-31 --write-json
```

### 22.4 失败成员兜底

```powershell
python report-analyzer.py --members "田于,郭浩成,姚东甫" --start-date 2026-07-01 --end-date 2026-07-17 --force-reload
```

### 22.5 老 JSON 补 v2.0 字段

```powershell
python rerender.py --json report-2026-07.json --start-date 2026-07-01 --end-date 2026-07-17 --html report-2026-07.html --project-metadata project-metadata.json --monthly-snapshot-dir monthly-snapshots --headcount-target headcount-target.json
```

### 22.6 配置文件方式

```json
{
  "members": ["田于", "郭浩成"],
  "adspowerUserId": "k1dgyja5"
}
```

```powershell
python report-analyzer.py --config report-config.json --start-date 2026-07-01 --end-date 2026-07-17
```

## 23. AdsPower 集成细节

### 23.1 本地 API 端点

| 端点 | 用途 |
|------|------|
| `http://127.0.0.1:50325/status` | 服务健康检查 |
| `http://127.0.0.1:50325/api/v1/browser/local-active` | 活跃浏览器列表（含 ws CDP 端点） |
| `POST .../api/v1/browser/stop` / `start` | 切换失败时重启浏览器环境 |

### 23.2 多环境处理

- `--adspower-user-id` 指定环境；未指定时自动发现活跃环境
- 重启后脚本自动发现新 CDP 端口（`GET /api/v1/browser/local-active` 返回最新 ws）
- 14 人切换偶尔失败时重启 AdsPower 浏览器（沿用已验证方案：POST stop → start → 重新发现）

### 23.3 CDP 连接

```python
from playwright.sync_api import sync_playwright
browser = p.chromium.connect_over_cdp(ws_endpoint)
context = browser.contexts[0]
pages = context.pages
```

## 24. 疑难排查（Troubleshooting）

| 症状 | 可能原因 | 处理 |
|------|---------|------|
| 成员数据为 0 | 切换后异步未刷新 / 节点未找到 | 检查 el-loading-mask 等待；`--force-reload` |
| 项目被拆分 | 引号/全角未归一 | 确认 normalize_project_name 在归并前执行 |
| 同一项目不同阶段 | 阶段前缀未剥离 | 确认 STAGE_PREFIXES 匹配 |
| 项目名被截断 | 旧版本脚本 | 升级到 v1.3+，默认完整保留 |
| 饼图不联动 | HTML 由旧版本生成 | 用 v2.0+ 重新生成 |
| Section 7 全"—" | 未传 --project-metadata | 传参或补建 metadata |
| 风险全 ⚪ 待评估 | forecastCompletion 缺失 | 补元数据字段 |
| 缺口列空白 | headcount-target 缺失 | 补建编制文件 |
| 某成员反复失败 | 节点加载延迟/SPA 状态污染 | `--force-reload`（~3s/人） |
| HTML 弹窗数据串项目 | 弹窗缓存跨 Modal 污染 | 升级到 v2.3+（_dailyRows 缓存隔离修复） |

## 25. 交付产物检查清单

执行完 skill 后按此清单核验交付完整性：

- [ ] 终端摘要输出：总记录数、总工时、每项目占比
- [ ] （如要求）HTML 周报生成且浏览器可打开，9 个 Section 齐全
- [ ] （如要求）JSON 导出成功，字段完整（totalHours/workHours/overtimeHours/contributionPct/roleBreakdown）
- [ ] 无成员 0 数据（或失败清单已向用户说明）
- [ ] 同一项目未被拆分统计
- [ ] v2.0 数据源缺失时已降级提示（非报错）
- [ ] 失败成员已在输出中汇总说明

## 26. 维护与扩展指引

### 26.1 常见修改场景速查

| 场景 | 修改位置 |
|------|---------|
| 新增/调整成员默认名单 | `ALL_V19_MEMBERS` 常量 |
| 调整角色人员分配 | `ROLES` 字典 |
| 新增项目别名 | `PROJECT_ALIASES` |
| 调整加班/标准工时阈值 | `OVERTIME_DAILY_THRESHOLD` / `STANDARD_DAILY_HOURS` |
| 新增状态分桶标签 | `project-metadata.json` 的 `statusMapping`（不改代码） |
| 调整风险因子权重 | `RISK_WEIGHTS` 常量 |
| 页面 UI 升级选择器失效 | 更新 `.my-tree-select` / `.el-*` 选择器 |

### 26.2 修改后必跑验证

```bash
python -m py_compile report-analyzer.py rerender.py
python -m pytest tests/test_v19.py
python report-analyzer.py --help
python rerender.py --help
```

### 26.3 目录结构

```
report-analyzer/
├── SKILL.md                 # 本文档（触发条件/CLI/流程/口径/反模式）
├── report-analyzer.py       # 主脚本（AdsPower + Playwright 抓取 + 统计 + HTML）
├── rerender.py              # 重算脚本（JSON 回算 contributionPct/roleBreakdown/v2.0 字段）
├── project-metadata.json    # v2.0 项目元数据（手工维护）
├── headcount-target.json    # v2.0 岗位目标编制（手工维护）
├── monthly-snapshots/       # v2.0 月度快照（YYYY-MM.json）
├── tests/
│   └── test_v19.py          # 60+ 单测（mock 数据，不依赖 AdsPower/Playwright）
└── .gitignore               # 屏蔽 __pycache__ / monthly-snapshots 临时文件
```

### 26.4 数据流总览

```
仓颉日报(AdsPower+Playwright) → 成员/日期过滤 → 工时统计
    → project-metadata.json ──┐
    → monthly-snapshots/ ─────┼→ v2.0 数据融合 → 9 Section HTML 周报
    → headcount-target.json ──┘
    → rerender.py(可选) → 回算 contributionPct/roleBreakdown → 更新 JSON/HTML
```
