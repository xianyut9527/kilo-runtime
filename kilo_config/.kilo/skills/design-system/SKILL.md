---
name: design-system
description: >
  针对新开发/缺乏设计规范的系统，强制建立设计系统与UI规范。
  涵盖视觉设计、组件规范、前端实现、交互体验、动画与无障碍。
  每次涉及 UI/前端实现时自动激活，确保输出不业余、不丑、不反模式。
---

# Design System Skill — 新系统 UI 规范引擎

> **适用场景**：新项目、MVP、内部系统、AI 生成的原型页面，或任何"没有设计规范"的系统。
> **目标**：让 AI 生成的 UI 达到一线 SaaS 产品水准，而非 demo 级拼凑。
> **黄金法则**：如果项目**已有成熟的设计规范**（DESIGN.md、组件库、Figma、CSS variables、Tailwind theme 等），**严格遵循现有规范，不得擅自偏离**；本 skill 仅作为补充和兜底，用于填补规范未覆盖的盲区。只有在系统**完全没有设计规范**时，才使用本 skill 提供的模板作为起点。

## 1. 设计系统优先原则

**在任何 UI/前端任务开始前，必须先确认或创建设计规范。**

- 如果项目已有 `DESIGN.md` 或设计系统，**严格遵循**，不得偏离。
- 如果项目**没有**设计规范，**必须先起草一份最小设计系统**（见下方模板），再继续编码。
- **禁止**在没有规范的情况下直接开始写 CSS/组件样式。

### 最小设计系统模板（DESIGN.md）

```markdown
# [项目名] Design System

## 1. 视觉主题与氛围
- 风格定位：[SaaS / 极简 / 企业 / 创意 / 数据仪表盘]
- 整体密度：[紧凑 / 舒适 / 宽松]
- 设计语言：[圆角友好 / 锐利专业 / 有机柔和]

## 2. 色彩系统
| 角色 | 色值 | 用途 |
|------|------|------|
| Primary | #3B82F6 | 主按钮、链接、关键操作 |
| Secondary | #64748B | 次级按钮、辅助信息 |
| Success | #22C55E | 成功状态、正向反馈 |
| Warning | #F59E0B | 警告、需要注意 |
| Danger | #EF4444 | 错误、删除、阻断操作 |
| Background | #FFFFFF / #0F172A | 页面背景（明暗）|
| Surface | #F8FAFC / #1E293B | 卡片、面板背景 |
| Text Primary | #0F172A / #F1F5F9 | 主文本 |
| Text Secondary | #64748B / #94A3B8 | 次级文本 |
| Border | #E2E8F0 / #334155 | 边框、分割线 |

## 3. 字体规范
- 字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- 代码字体：`"SF Mono", "Fira Code", monospace`
- 字号阶梯：
  - Display: 32-48px / font-weight: 700 / line-height: 1.1
  - H1: 24-28px / 600 / 1.2
  - H2: 20px / 600 / 1.3
  - H3: 16px / 600 / 1.4
  - Body: 14px / 400 / 1.5
  - Small: 12px / 400 / 1.5
  - Caption: 11px / 500 / 1.4

## 4. 间距系统（4px 基准）
- xs: 4px | sm: 8px | md: 16px | lg: 24px | xl: 32px | 2xl: 48px | 3xl: 64px
- 组件内边距默认 md(16px)，页面边距默认 lg(24px) 或 xl(32px)

## 5. 圆角规范
- 按钮/输入框: 6-8px
- 卡片/面板: 12-16px
- 标签/徽章: 9999px (全圆角)
- 大模块/弹窗: 16-24px

## 6. 阴影与层级
| 层级 | 阴影值 | 用途 |
|------|--------|------|
| Low | 0 1px 2px rgba(0,0,0,0.05) | 轻微提升 |
| Medium | 0 4px 6px -1px rgba(0,0,0,0.1) | 卡片、下拉 |
| High | 0 10px 15px -3px rgba(0,0,0,0.1) | 弹窗、抽屉 |
| Focus | 0 0 0 2px primary/30% | 焦点环 |

## 7. 组件规范

### Button
- 高度: 32px(sm) / 40px(md) / 48px(lg)
- 内边距: 12px 16px(md)
- 主按钮: Primary bg + white text + 无边框
- 次按钮: Surface bg + Border + Text Primary
- 文字按钮: 无 bg + Primary text + hover 背景淡色
- 禁用: opacity 0.5 + cursor not-allowed
- 加载: spinner + 文字变灰，禁用点击

### Input / Select
- 高度同 Button
- 背景: Surface 或透明
- 边框: 1px solid Border，focus 时 Primary
- 错误: Border Danger + 下方错误文案
- placeholder 颜色: Text Secondary

### Card
- 背景: Surface
- 圆角: 12-16px
- 内边距: 16-24px
- 阴影: Low 或 Medium
- hover 可轻微上浮 (translateY -2px + shadow 升级)

### Table / List
- 表头: 背景略深或加粗文字，无纵向边框
- 行高: 48-56px
- hover: Surface 背景色变化
- 选中: Primary/10% 背景 + 左侧 2px Primary 竖条

### Modal / Drawer
- 遮罩: rgba(0,0,0,0.5)
- 面板: Surface + High 阴影
- 圆角: 16px（Drawer 左侧无圆角）
- 进入动画: 200-300ms ease-out

## 8. 布局原则
- 最大内容宽度: 1200-1440px，居中
- 栅格: 12列，间距 16-24px
- 信息层级: 通过留白而非分割线区分模块
- 对齐: 严格遵循栅格，避免视觉漂移

## 9. 交互与动画
- 过渡时长: 150ms（微交互）/ 200-300ms（组件状态）
- 缓动: ease-out（进入）/ ease-in-out（状态切换）
- 按钮 hover: 亮度变化或轻微缩放(1.02)
- 页面切换: 淡入 200ms
- 加载: Skeleton > Spinner > 内容

## 10. 响应式断点
| 断点 | 宽度 | 调整 |
|------|------|------|
| Mobile | < 640px | 单列，全宽按钮，隐藏次要信息 |
| Tablet | 640-1024px | 双列，侧边栏可折叠 |
| Desktop | > 1024px | 完整布局 |

## 11. 无障碍 (a11y)
- 颜色对比度 >= 4.5:1（正文）/ 3:1（大文字）
- 所有交互元素支持键盘 Tab 导航
- 焦点环必须可见
- 图片必须有 alt 文本
- 表单必须有 label 关联
- 动画支持 prefers-reduced-motion

## 12. Do's and Don'ts
- ✅ 使用一致的间距阶梯
- ✅ 保持足够的留白呼吸感
- ✅ 用色彩传递语义（成功绿、警告黄、错误红）
- ✅ 优先使用幽灵/文字按钮做次要操作
- ❌ 不要在页面上使用超过 3 种主色
- ❌ 不要把正文行高设为 1（必须 >= 1.5）
- ❌ 不要给所有元素都加阴影
- ❌ 不要在大片区域使用纯黑 #000000
- ❌ 按钮文字不要只有图标无 tooltip/aria-label
- ❌ 不要忽略 hover/focus/disabled 状态
```

## 2. 前端实现规范

### CSS / Tailwind / 样式框架
- **统一使用设计 token**，禁止硬编码颜色/间距值。
- 颜色、间距、圆角、阴影必须通过设计系统变量引用。
- 避免 `!important`，避免行内样式（动态计算除外）。
- 响应式必须用设计系统的断点，不要自定义随机值。

### 组件化
- 每个 UI 元素都应该是可复用组件，**不要复制粘贴样式**。
- 组件 props 必须支持 `variant`、`size`、`disabled`、`loading` 等常见状态。
- 复合组件模式（如 Tabs、Modal）保持 API 一致性。

### 状态管理
- 空状态：必须有 Empty State，不能是空白页。
- 加载状态：优先 Skeleton，其次 Spinner，避免布局跳动。
- 错误状态：清晰可读的错误提示，提供恢复操作。
- 边界状态：超长文本截断 + tooltip，图片加载失败 fallback。

## 3. 交互体验 (UX) 规范

### 反馈
- **立即反馈**：用户操作后 100ms 内必须有视觉响应。
- **进度反馈**：超过 1s 的操作需要进度指示。
- **结果反馈**：操作完成后明确告知成功/失败。

### 防错
- 危险操作（删除、退出）必须有二次确认。
- 表单提交前做客户端校验，避免服务端往返。
- 批量操作提供撤销能力（toast + undo）。

### 效率
- 常用操作 2 步内可达。
- 表单支持 Enter 提交、Tab 切换、Esc 关闭。
- 列表支持批量选择、筛选、排序。
- 搜索支持实时建议、高亮匹配。

### 一致性
- 同一操作在不同页面使用相同文案和图标。
- 同一组件在不同场景表现一致。
- 路由切换保持顶部导航、侧边栏状态。

## 4. 动画与动效

### 原则
- **有目的**：动效必须服务于理解，不是为了炫技。
- **克制**：页面同时存在的动画不超过 3 处。
- **快速**：微交互 100-150ms，页面过渡 200-300ms。

### 常见模式
- **进入**：fade + slight translateY(8px → 0)
- **离开**：fade + scale(1 → 0.95)，比进入更快
- **状态**：高度/宽度变化用 CSS transition，不用 JS 动画
- **加载**：骨架屏 shimmer 从左到右扫过
- **通知**：从右侧滑入，停留 4s 后自动滑出

### 性能
- 只动画 `transform` 和 `opacity`，禁止动画 `width/height/top/left`。
- 对频繁动画的元素加 `will-change`，动画结束后移除。
- 支持 `prefers-reduced-motion`。

## 5. 反模式清单（常见新手错误）

| 反模式 | 正确做法 |
|--------|---------|
| 纯黑背景 #000 + 纯白文字 #fff | 使用极深蓝灰/暖灰作为"黑"，降低刺眼感 |
| 没有 hover/focus 状态 | 所有可交互元素必须有 3 态（默认/hover/按下）|
| 12px 正文 | 正文最小 14px，移动端最小 16px（防缩放）|
| 表单没有 label | 每个输入框必须有可见 label 或 placeholder 充当 label |
| 按钮文字颜色与背景对比不足 | 用对比度检查工具确保可读性 |
| 卡片内元素贴边 | 卡片内边距至少 16px，元素间至少 12px |
| 阴影过重/过多 | 最多 2 层阴影，值要小且柔和 |
| 圆角不统一 | 同一页面同类元素圆角必须一致 |
| 图片变形拉伸 | 使用 object-fit: cover/contain |
| 忽略空状态 | 列表/表格为空时展示引导插图+文案+操作 |
| 移动端未适配 | 所有页面必须考虑 375px 宽度 |
| 颜色传递错误语义 | 红色不只代表删除，也代表错误；绿色代表成功 |

## 6. 工具与资源

- ** awesome-design-md**: https://github.com/VoltAgent/awesome-design-md
  - 收录 Apple、Figma、Stripe、Linear、Vercel 等顶级产品的 DESIGN.md
  - 新项目可直接复制参考品牌的 DESIGN.md 作为起点
- **颜色**: oklch.com 或 coolors.co 生成配色
- **字体**: fontsource.org 安装开源字体
- **图标**: Lucide、Heroicons、Phosphor Icons
- **对比度**: webaim.org/resources/contrastchecker/
- **动画**: easings.net 选择缓动曲线

## 7. Agent 执行检查清单

每次生成/修改 UI 代码前，必须逐项确认：

- [ ] 项目是否有 DESIGN.md / 设计系统？若无，先创建最小版本。
- [ ] 是否使用了设计 token 而非硬编码值？
- [ ] 颜色是否符合语义角色（primary/success/warning/danger）？
- [ ] 字号和行高是否满足可读性？
- [ ] 间距是否遵循 4px/8px 阶梯？
- [ ] 所有交互元素是否有 hover/focus/disabled/loading 状态？
- [ ] 是否有空状态、加载状态、错误状态？
- [ ] 是否支持键盘导航和焦点可见？
- [ ] 动画是否只使用 transform/opacity？
- [ ] 移动端布局是否正常？
- [ ] 颜色对比度是否达标？

---

> **底线**：没有规范的系统看起来总是"差一点"。这个 skill 的目标是让"差一点"变成"到位"。
