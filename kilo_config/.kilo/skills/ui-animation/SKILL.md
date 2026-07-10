---
name: ui-animation
description: >
  动画与动效规范 skill。参考迪士尼12动画原则 + Motion spring 物理动画，
  为 UI 提供有目的、高性能、符合物理直觉的动画决策框架。
  每次涉及 transition、animation、微交互时激活。
  若项目已有动画规范，严格遵循。
keywords: animation, motion, transition, 动画, 动效, micro-interaction, spring
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: ui
---

# UI Animation Skill — 动效决策引擎

> **适用场景**：需要为组件添加过渡动画、页面切换、微交互、加载动效。
> **核心原则**：动画服务于理解，不是为了炫技。若项目已有动画规范（如 motion tokens、transition durations），**严格遵循**。

## 1. 迪士尼12动画原则（UI 精简版）

将经典动画原则映射到 UI 场景：

| 原则 | UI 映射 | 典型场景 |
|------|---------|---------|
| **挤压与拉伸** (Squash & Stretch) | 按钮按下时轻微缩放 (scale 0.97) | 按钮点击反馈 |
| **预备动作** (Anticipation) | 下拉刷新前的回弹提示 | 刷新、加载 |
| **演出布局** (Staging) | 新元素进入时旧元素让位 | 列表插入/删除 |
| **连续动作** (Straight Ahead) | 滚动惯性、拖拽跟随 | 滚动、拖拽 |
| **跟随动作** (Follow Through) | 通知滑出后弹性回弹 | Toast、通知 |
| **缓入缓出** (Slow In & Out) | 所有过渡使用 ease-out/ease-in-out | 所有动画 |
| **弧线运动** (Arc) | 底部弹窗从下方弧线滑入 | Modal、Drawer |
| **附属动作** (Secondary Action) | 主按钮 hover 时图标微移 | 按钮、链接 |
| **时间节奏** (Timing) | 微交互 150ms / 状态切换 300ms | 全局 |
| **夸张** (Exaggeration) | 空状态插图轻微漂浮 | 空状态、引导 |
| **素描技巧** (Solid Drawing) | 3D 翻转卡片、层叠视差 | 高级交互 |
| **吸引力** (Appeal) | 加载动画品牌感设计 | 加载、Skeleton |

## 2. 动画决策矩阵

根据操作类型选择动画模式：

### 页面/路由切换
```
进入：opacity 0→1 + translateY(12px→0)   时长：200ms  缓动：ease-out
离开：opacity 1→0 + scale(1→0.98)       时长：150ms  缓动：ease-in
```
- 使用 `position: absolute` 或 View Transition API 避免布局跳动

### 列表项增删
```
插入：height 0→auto + opacity 0→1 + translateX(-8px→0)  时长：250ms
删除：opacity 1→0 + scale(1→0.95) + height auto→0        时长：200ms
```
- 使用 FLIP 技术或 layout animations 库（如 Framer Motion layout prop）
- 批量 stagger：每项延迟 30-50ms

### 弹窗/抽屉
```
Backdrop：opacity 0→1  时长：200ms
Panel：    translateY(100%→0) 或 translateX(100%→0)  时长：300ms  缓动：cubic-bezier(0.16, 1, 0.3, 1)
关闭：比进入快 20%
```
- 点击 backdrop 或按 Esc 关闭
- 打开时背景禁止滚动（`overflow: hidden` 或 `inert`）

### 按钮/卡片 Hover
```
Hover 进入：brightness(1.05) 或 translateY(-2px) + shadow 升级  时长：150ms
Hover 离开：恢复原状                                        时长：200ms（稍慢于进入，更自然）
按下：     scale(0.97)                                     时长：100ms
```

### Toast/通知
```
进入：translateX(100%→0) + opacity 0→1  时长：300ms  缓动：spring( stiffness: 300, damping: 25 )
停留：4000ms（自动消失）
离开：translateX(0→100%) + opacity 1→0  时长：200ms
进度条：width 100%→0%  时长：4000ms  linear
```

### 骨架屏加载
```
Shimmer：background-position 动画  时长：1500ms  缓动：linear  无限循环
内容替换：opacity 0→1  时长：200ms  缓动：ease-out
```

### 数字/计数变化
```
Count up：translateY(100%→0) + opacity 0→1  时长：400ms  缓动：spring
```

## 3. Spring 物理动画参数

参考 Motion 的 spring 系统，提供常用 spring 配置：

| 场景 | stiffness | damping | mass | 质感 |
|------|-----------|---------|------|------|
| 快速反馈（按钮） | 400 | 30 | 1 | 干脆利落 |
| 自然滑动（列表） | 300 | 25 | 1 | 舒适自然 |
| 弹性通知（Toast） | 300 | 20 | 1 | 轻微回弹 |
| 沉稳页面（Modal） | 200 | 25 | 1 | 沉稳专业 |
| 弹性加载（Spinner） | 150 | 15 | 1 | 活泼俏皮 |

### CSS spring 近似（使用 cubic-bezier）
- 快速：`cubic-bezier(0.25, 1, 0.5, 1)`
- 弹性：`cubic-bezier(0.34, 1.56, 0.64, 1)`
- 沉稳：`cubic-bezier(0.16, 1, 0.3, 1)`

## 4. 性能铁律

- ✅ **只动画** `transform` 和 `opacity`
- ✅ **使用** `will-change: transform`（动画前添加，结束后移除）
- ✅ **批量动画**使用 `requestAnimationFrame` 或交给动画库
- ❌ **禁止动画** `width/height/top/left/margin/padding`（触发重排）
- ❌ **禁止**在滚动事件中直接操作样式（使用 IntersectionObserver + CSS）
- ❌ **禁止**无限循环动画不做性能优化（CPU 占满）

## 5. 可访问性

- 支持 `prefers-reduced-motion`：
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
- 必要动画（如加载状态）即使在 reduced-motion 下也需保留，但去掉过渡效果
- 闪光/频闪效果绝对禁止（光敏性癫痫风险）

## 6. 反模式

| 反模式 | 正确做法 |
|--------|---------|
| 所有元素同时动画（视觉混乱） | 按信息优先级 stagger 进入 |
| 动画时长 > 500ms（感觉卡顿） | 微交互 100-150ms，状态切换 200-300ms |
| 线性缓动（机械感） | 使用 ease-out 进入，ease-in 离开 |
| 页面加载完所有元素一起 pop in | 按阅读顺序 stagger 50-100ms |
| 滚动劫持（scrolljacking） | 尊重原生滚动，用 IntersectionObserver 触发 |
| 无限旋转 loading 无品牌感 | 使用品牌色的 pulse 或骨架屏 |

## 7. Agent 执行检查清单

添加动画前确认：

- [ ] 动画是否有明确目的（引导注意力、反馈状态、平滑过渡）？
- [ ] 是否只使用了 transform/opacity？
- [ ] 时长是否在合理范围（< 300ms 微交互 / < 500ms 大过渡）？
- [ ] 是否使用了合适的缓动（非线性）？
- [ ] 是否支持 prefers-reduced-motion？
- [ ] 移动端低性能设备是否流畅？
- [ ] 是否有动画叠加导致的视觉混乱？
