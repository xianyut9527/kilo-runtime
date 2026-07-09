---
name: ui-vocabulary
description: >
  设计词汇与动画术语 skill。参考 emilkowalski/animation-vocabulary 和 pbakaus/impeccable，
  为 agent 提供描述 UI 设计问题的精确词汇，让设计沟通从"好看一点"变成专业术语。
  每次描述设计问题、评审 UI、写设计文档时激活。
---

# UI Vocabulary Skill — 设计词汇与术语引擎

> **适用场景**：描述设计问题、写 design feedback、与设计师/PM 沟通、写 DESIGN.md。
> **目标**：让"好看一点"变成"提升信息层级对比度和垂直节奏"。

## 1. 空间与布局（Space & Layout）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Whitespace** | 元素间的空白区域 | 元素拥挤，呼吸感不足 | 使用 8px 阶梯留白 |
| **Negative space** | 刻意留出的空区域 | 填满每个角落 | 用空白引导视线 |
| **Grid system** | 栅格对齐系统 | 元素随意摆放 | 12列栅格，严格对齐 |
| **Alignment** | 元素的对齐关系 | 左中右混排 | 统一对齐线 |
| **Proximity** | 相关元素靠近 | 不相关的也挤在一起 | 相关元素间距 < 不相关 |
| **Visual hierarchy** | 视觉重要性层级 | 所有元素一样大 | 大小/颜色/留白区分主次 |
| **Focal point** | 视觉焦点 | 没有重点，眼睛无处安放 | CTA 最突出 |
| **Balance** | 视觉平衡 | 左重右轻或头重脚轻 | 对称或不对称平衡 |
| **Rhythm** | 重复的间距模式 | 间距忽大忽小 | 一致的间距阶梯 |
| **Density** | 信息密度 | 太稀疏（浪费空间）或太密（压迫感） | 根据场景调整 |

## 2. 排版（Typography）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Type scale** | 字号阶梯 | 只有两种字号 | Display/H1/H2/H3/Body/Small |
| **Leading** | 行高 | 行高 = 1（拥挤） | 正文 >= 1.5，标题 1.2-1.3 |
| **Tracking** | 字间距 | 默认字间距 | 大标题收紧，正文正常 |
| **Measure** | 行宽（每行字数） | 一行 100+ 字符 | 45-75 字符最佳 |
| **Rag** | 文本右边缘不齐 | 强制两端对齐（ Rivers 问题） | 左对齐，允许 rag |
| **Widow** | 段落最后一行只有一个词 | 视觉断裂 | 手动调整或 CSS 避免 |
| **Orphan** | 段落第一行在页尾 | 阅读中断 | 分页控制 |
| **Hierarchy** | 层级通过字重区分 | 只用大小不用字重 | H1=700, H2=600, Body=400 |
| **Legibility** | 易读性（单个字符） | 字体模糊、过小 | 14px+，高对比 |
| **Readability** | 可读性（整段文本） | 行太长、行高太小 | 45-75 字符，1.5 行高 |

## 3. 色彩（Color）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Hue** | 色相 | 颜色过多 | <= 3 种主色 |
| **Saturation/Chroma** | 饱和度 | 过饱和刺眼 | 主色适中，点缀色可鲜艳 |
| **Value/Lightness** | 明度 | 明度跳跃过大 | 平滑色阶 |
| **Contrast** | 对比度 | 文字看不清 | 正文 >= 4.5:1 |
| **Temperature** | 色温（冷暖） | 冷暖混用无体系 | 统一色温或有意对比 |
| **Tint** | 加白 | 直接调亮 | 用统一色阶 |
| **Shade** | 加黑 | 直接调暗 | 用统一色阶 |
| **Tone** | 加灰 | 颜色发脏 | 用 OKLCH 控制 |
| **Semantic color** | 语义色 | 红色也代表成功 | 绿=成功，红=错误，黄=警告 |
| **Accent color** | 点缀色 | 点缀色面积过大 | <= 10% 面积 |

## 4. 组件与状态（Components & States）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Default state** | 默认状态 | 只考虑正常态 | 定义完整的交互状态 |
| **Hover state** | 悬停态 | 无反馈 | 亮度变化/缩放/阴影 |
| **Active/Pressed** | 按下态 | 点击无反馈 | scale(0.97) 或颜色变深 |
| **Focus state** | 焦点态 | outline 被移除 | 可见的焦点环 |
| **Disabled state** | 禁用态 | 看起来像可用 | opacity 0.5 + cursor not-allowed |
| **Loading state** | 加载态 | 无反馈导致重复点击 | spinner + 禁用 |
| **Error state** | 错误态 | 只有红色边框 | 红色边框 + 错误文案 + 恢复建议 |
| **Success state** | 成功态 | 静默成功 | toast/对勾动画 |
| **Empty state** | 空状态 | 空白页 | 引导插图 + 文案 + 操作 |
| **Skeleton** | 骨架屏 | spinner 代替 | 内容轮廓的占位动画 |

## 5. 动画（Animation）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Easing** | 缓动曲线 | linear（机械感） | ease-out 进入，ease-in 离开 |
| **Duration** | 时长 | 太长（> 500ms） | 微交互 150ms，状态 300ms |
| **Stagger** | 错开进入 | 所有元素同时动画 | 50-100ms 间隔 |
| **Spring physics** | 弹簧物理 | 线性过渡 | 有弹性、自然的运动 |
| **Transform-only** | 只动画 transform | 动画 width/height | 只动 translate/scale/rotate |
| **Reduced motion** | 减少动画 | 忽略无障碍 | 支持 prefers-reduced-motion |

## 6. 设计模式（Patterns）

| 术语 | 含义 | 反模式 | 正确做法 |
|------|------|--------|---------|
| **Progressive disclosure** | 渐进式展示 | 一次性展示所有信息 | 先展示概要，再展开详情 |
| **Affordance** |  affordance（可感知性） | 按钮不像按钮 | 按钮看起来像可点击 |
| **Feedback loop** | 反馈循环 | 操作后无响应 | 立即视觉反馈 |
| **Mental model** | 心智模型 | 与用户预期不符 | 遵循平台惯例 |
| **Wayfinding** | 寻路 | 用户不知道自己在哪里 | 面包屑、高亮当前导航 |
| **Information scent** | 信息线索 | 链接文案模糊 | 链接文案说明目的地 |
| **Cognitive load** | 认知负荷 | 一次要求用户做太多 | 分步骤，减少选择 |
| **Dark pattern** | 黑暗模式 | 误导用户操作 | 诚实、透明的设计 |

## 7. 反馈模板

用专业词汇描述设计问题：

### ❌ 模糊的反馈
"这个按钮不太好看。"

### ✅ 精确的反馈
"这个按钮的 **visual hierarchy** 不够突出。建议：
1. 增加 **contrast**（当前明度差只有 30%，建议达到 50%+）
2. 给 **hover state** 添加亮度变化（brightness 1.05）
3. 增加 **whitespace**，上下 padding 从 8px 提升到 12px"

### 评审报告模板
```markdown
## Design Review: [页面名]

### 1. Visual Hierarchy
- **问题**: CTA 按钮被旁边的大标题压制
- **建议**: 缩小标题字号（32px → 28px）或增大按钮（40px → 48px）
- **术语**: focal point, dominance

### 2. Typography
- **问题**: 正文行高 1.3，阅读疲劳
- **建议**: 提升到 1.5-1.6
- **术语**: leading, readability

### 3. Color
- **问题**: 成功提示用蓝色，与信息提示混淆
- **建议**: 改用语义绿色
- **术语**: semantic color, affordance
```

## 8. Agent 执行检查清单

描述设计问题时确认：

- [ ] 是否使用了精确的设计术语（而非"好看""丑"）？
- [ ] 是否指明了具体的问题维度（层级/排版/色彩/间距）？
- [ ] 是否提供了可量化的建议（px、%、时长）？
- [ ] 是否引用了设计原则（ proximity, contrast, rhythm 等）？
- [ ] 反馈是否可执行（对方知道怎么改）？

---

> **核心思想**：精确的词汇 = 精确的意图 = 精确的实现。模糊的反馈产生模糊的结果。
