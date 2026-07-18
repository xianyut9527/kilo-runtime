---
name: ui-polish
description: >
  UI 审计、润色与重设计 skill。参考 Impeccable 与 Taste Skill，
  为已有页面提供系统化的视觉审计、润色建议和重设计流程。
  每次对现有 UI 进行优化、review 或 redesign 时激活。
  若项目已有成熟规范，严格遵循，只做规范内的微调。
keywords: [polish, audit, review, redesign, 润色, 审计, 优化]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: ui
---

# UI Polish Skill — 视觉审计与润色引擎

> **适用场景**：已有页面/组件需要优化、review、redesign、提升质感。
> **黄金法则**：若项目**已有成熟设计规范**，审计结果必须在规范框架内输出；若规范缺失，则按本 skill 的通用标准执行。

## 1. 审计命令（Audit）

对目标页面/组件执行以下 5 维审计，输出问题清单 + 严重等级。

### 维度 A：视觉层级（Visual Hierarchy）
- [ ] 最重要的信息是否最大/最显眼？
- [ ] 次要信息是否被正确弱化（颜色/字号/粗细）？
- [ ] 是否存在"所有文字一样大"的扁平问题？
- [ ] CTA（行动按钮）是否是页面上最突出的可交互元素？

### 维度 B：色彩与对比（Color & Contrast）
- [ ] 主色使用是否超过页面 10% 面积？（不应过度饱和）
- [ ] 背景与正文对比度 >= 4.5:1？
- [ ] 色彩是否有语义一致性（成功=绿、错误=红、警告=黄）？
- [ ] 是否存在"彩虹页面"（颜色过多且无体系）？

### 维度 C：排版与可读性（Typography）
- [ ] 正文字号 >= 14px（桌面）/ >= 16px（移动端）？
- [ ] 行高 >= 1.5（正文）/ >= 1.2（标题）？
- [ ] 段落宽度是否控制在 45-75 字符（最佳阅读长度）？
- [ ] 字体种类 <= 2 种（标题体 + 正文体）？

### 维度 D：间距与呼吸感（Spacing & Rhythm）
- [ ] 相关元素间距 < 不相关元素间距？
- [ ] 是否存在元素贴边（padding < 12px）？
- [ ] 页面边缘留白是否足够（>= 16px 移动端 / >= 24px 桌面）？
- [ ] 同类模块间距是否一致（遵循 4px/8px 阶梯）？

### 维度 E：交互状态（Interaction States）
- [ ] 所有按钮是否有 hover/active/disabled 态？
- [ ] 链接是否有 hover 下划线或颜色变化？
- [ ] 表单输入是否有 focus 环？
- [ ] 加载/空状态/错误状态是否完整？

## 2. 润色命令（Polish）

针对审计发现的问题，按优先级执行润色：

### P0 — 结构性问题（不改则无法使用）
- 修复对比度不足（颜色替换）
- 修复触控目标过小（< 44x44px）
- 修复缺少焦点环（键盘无法导航）

### P1 — 体验性问题（显著影响感知质量）
- 统一间距阶梯（消除随意值）
- 统一圆角（同类型元素一致）
- 统一阴影层级（最多 2 层）
- 添加空状态/加载状态

### P2 — 精致度问题（提升高级感）
- 微调字重阶梯（标题 600-700，正文 400）
- 增加微交互（hover 亮度/缩放 1.02）
- 优化过渡时长（150ms 微交互 / 200-300ms 状态切换）
- 用留白替代分割线区分模块

### P3 — 品牌感问题（区分平庸与出色）
- 添加品牌色点缀（不超过 10% 面积）
- 引入高质量插图/图标（统一风格）
- 调整排版节奏（标题-正文-注释的层次）

## 3. 提炼命令（Distill）

从现有混乱的样式中提取出**可复用的设计 token**，产出 DESIGN.md 片段：

```markdown
## Extracted Tokens from [页面名]

### Colors
| Token | Value | Source |
|-------|-------|--------|
| --color-primary | #3B82F6 | 按钮/链接主导色 |
| --color-surface | #F8FAFC | 卡片背景 |

### Typography
| Token | Value | Source |
|-------|-------|--------|
| --font-heading | Inter, sans-serif | H1-H3 |
| --font-body | Inter, sans-serif | 正文 |

### Spacing
| Token | Value | Source |
|-------|-------|--------|
| --space-md | 16px | 卡片内边距 |

### Shadows
| Token | Value | Source |
|-------|-------|--------|
| --shadow-card | 0 4px 6px rgba(0,0,0,0.05) | 卡片悬浮 |
```

## 4. 重设计命令（Redesign）

当用户要求"改得好看一点"/"redesign"时，执行以下流程：

### Step 1：理解上下文
- 这是什么类型的产品？（SaaS / 电商 / 内容 / 工具）
- 目标用户是谁？（开发者 / 普通消费者 / 企业客户）
- 参考哪个成熟产品？（Linear / Stripe / Notion / Apple）

### Step 2：选择参考风格
从 awesome-design-md 中选择最接近的 DESIGN.md 作为参考：
- **SaaS / 工具** → Linear、Vercel、Stripe
- **内容 / 阅读** → Notion、Medium
- **电商 / 零售** → Shopify、Airbnb
- **创意 / 品牌** → Apple、Figma
- **企业 / B端** → IBM Carbon、Salesforce

### Step 3：执行重设计
- 保留原有信息架构（不要改导航结构除非必要）
- 应用参考风格的色彩/字体/间距体系
- 强化视觉层级（大小、颜色、留白的对比）
- 添加微交互和过渡动画
- 确保所有状态完整

### Step 4：输出变更说明
- 改了什么（具体 token 变化）
- 为什么改（设计意图）
- 如何验证（检查清单）

## 5. Soft Skill — 让东西看起来昂贵

参考 Taste Skill 的 soft-skill，以下细节决定高级感：

### 字体
- 使用高品质字体（Inter、Geist、SF Pro、Manrope）
- 标题字母间距略紧（tracking-tight），正文正常
- 大标题使用 display font-weight（700-800）

### 留白
- 模块之间用大量留白区分，而非分割线
- 页面边距 generous（桌面 48px+，移动端 24px+）
- 卡片内边距充足（24-32px）

### 层叠
- 卡片轻微悬浮（translateY -2px + shadow 升级 on hover）
- 使用微妙的背景色差异区分层级（surface / background）
- 圆角按层级递减：大模块 16px → 卡片 12px → 按钮 8px

### 动画
- 使用弹簧物理动画（spring）而非线性过渡
- 页面元素按序进入（stagger 50-100ms）
- hover 反馈即时（< 150ms）

### 导航
- 顶部导航简洁，非当前页面使用 muted 颜色
- 当前页面有清晰指示（下划线/背景高亮）
- 滚动时导航可轻微收缩或添加模糊背景（backdrop-blur）

## 6. Agent 执行检查清单

执行 polish/redesign 后确认：

- [ ] 是否优先遵循了项目已有设计规范？
- [ ] 视觉层级是否清晰（一眼能找到重点）？
- [ ] 色彩是否克制且有语义？
- [ ] 排版是否易读且层级分明？
- [ ] 间距是否遵循阶梯且呼吸感充足？
- [ ] 所有交互状态是否完整？
- [ ] 移动端是否正常？
- [ ] 动画是否克制且有目的？
- [ ] 是否输出了变更说明？
