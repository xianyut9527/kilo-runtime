---
name: ui-accessibility
description: >
  无障碍（a11y）检查与修复 skill。参考 fixing-accessibility 与 WCAG 2.1 AA 标准，
  为 UI 提供系统化的无障碍审计和修复指南。
  每次生成/修改 UI 代码时激活，确保产品可被所有人使用。
  若项目已有 a11y 规范，严格遵循。
keywords: [a11y, accessibility, wcag, 无障碍, aria, contrast, 对比度]
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: ui
---

# UI Accessibility Skill — 无障碍审计引擎

> **适用场景**：所有 UI/前端实现任务。无障碍不是可选项，是底线。
> **参考标准**：WCAG 2.1 Level AA
> **黄金法则**：若项目已有无障碍规范（如 a11y lint rules、组件库 accessibility guide），**严格遵循**。

## 1. 色彩与视觉（Perceivable）

### 对比度检查
| 场景 | 最小对比度 | 工具 |
|------|-----------|------|
| 正文（< 18px 或 < 14px bold） | 4.5:1 | WebAIM Contrast Checker |
| 大文字（>= 18px 或 >= 14px bold） | 3:1 | WebAIM Contrast Checker |
| 图标/图形 | 3:1 | Chrome DevTools > Contrast |
| 禁用状态文字 | 无需达标，但建议 >= 3:1 | — |

### 不要仅依赖颜色传递信息
- 错误状态：红色文字 + 错误图标 + 文字说明
- 成功状态：绿色 + 对勾图标 + 文字
- 图表：颜色 + 纹理/图案/标签

### 文本缩放
- 页面在 200% 缩放时不应出现内容截断或重叠
- 使用相对单位（rem/em/%），避免 px 定义字体
- 容器应支持文本换行（不要固定高度截断内容）

## 2. 键盘导航（Operable）

### Tab 顺序
- 所有交互元素必须可通过 Tab 键到达
- Tab 顺序符合视觉阅读顺序（左上→右下）
- 避免 tabindex > 0（会打乱自然顺序）

### 焦点可见（Focus Visible）
- 所有可聚焦元素必须有清晰的焦点指示器
- 推荐样式：`outline: 2px solid var(--color-primary)` 或 `box-shadow: 0 0 0 2px ...`
- 不要完全移除 outline（`:focus { outline: none }` 必须有替代方案）
- `:focus-visible` 优于 `:focus`（鼠标点击不显示焦点环，键盘导航才显示）

### 快捷键与操作
- 支持 Enter/Space 激活按钮
- 支持 Esc 关闭弹窗/下拉/抽屉
- 支持方向键在列表/选项间导航
- 支持 Home/End 跳转到列表首尾
- 模态框打开时，焦点应 trapping 在模态内
- 模态框关闭时，焦点应返回到触发元素

## 3. 屏幕阅读器（Understandable & Robust）

### 语义化 HTML
- 使用正确的 HTML 标签（button 不是 div，nav 不是 div）
- 标题层级连续（h1 → h2 → h3，不要跳级）
- 页面只有一个 h1
- 列表使用 ul/ol/li，不要用 div 模拟
- 表格使用 table/thead/tbody/th/td

### ARIA 使用指南
- **优先使用原生 HTML**，ARIA 是补充不是替代
- 常见 ARIA 属性：
  - `role="button"` — 当元素不是 button 但必须可点击时
  - `aria-label="描述"` — 当文字不足以说明时（如图标按钮）
  - `aria-expanded="true/false"` — 可展开/收起的内容
  - `aria-hidden="true"` — 纯装饰元素（图标、分割线）
  - `aria-live="polite/assertive"` — 动态更新内容（toast、通知）
  - `aria-describedby="id"` — 为输入框关联错误提示
- ARIA 常见错误：
  - ❌ `role="button"` 但没有 `tabindex="0"` 和键盘事件
  - ❌ `aria-hidden="true"` 包裹了可聚焦元素
  - ❌ `aria-label` 和可见文字不一致
  - ❌ 动态内容没有 `aria-live` 导致屏幕阅读器不播报

### 表单无障碍
- 每个输入框必须有关联的 label：
  ```html
  <!-- 正确 -->
  <label for="email">邮箱</label>
  <input id="email" type="email" />

  <!-- 或 -->
  <label>
    邮箱
    <input type="email" />
  </label>

  <!-- 或（图标按钮时） -->
  <input aria-label="搜索" placeholder="搜索..." />
  ```
- 错误提示关联：
  ```html
  <input aria-describedby="email-error" aria-invalid="true" />
  <p id="email-error" role="alert">请输入有效邮箱</p>
  ```
- 必填字段：使用 `required` 属性 + 视觉标识（如 *）+ `aria-required="true"`
- 字段分组：使用 `fieldset` + `legend`

### 图片与媒体
- 所有图片必须有 `alt` 属性：
  - 信息性图片：`alt="描述图片内容"`
  - 装饰性图片：`alt=""`（空字符串，不是不写）
  - 复杂图表：附近提供文字说明，`alt="描述摘要"`
- 图标按钮：`aria-label="操作描述"`
- 视频：提供字幕（captions）和转录文本（transcript）
- 自动播放音频/视频：提供暂停控制，且音量可控

## 4. 动效可访问性

- 支持 `prefers-reduced-motion`（见 ui-animation skill）
- 不要自动播放可能触发前庭功能障碍的动画（如大幅视差滚动）
- 闪烁频率 < 3Hz（避免光敏性癫痫）

## 5. 移动端无障碍

- 触控目标最小 44x44px（iOS HIG）/ 48x48dp（Material Design）
- 支持双指缩放（不要禁用 `user-scalable=no`）
- 支持屏幕旋转（不要锁定方向除非必要）
- 手势操作有替代方式（如滑动删除 + 按钮删除）

## 6. 检查清单（每次发布前必查）

### 自动化检查（用工具跑）
- [ ] axe-core / Lighthouse Accessibility >= 90
- [ ] 无对比度失败（Critical/serious）
- [ ] 无缺失 alt 文本
- [ ] 无无效 ARIA 属性
- [ ] 无键盘陷阱

### 手动检查（必须人工验证）
- [ ] 全程只用键盘能否完成核心任务？
- [ ] 焦点环是否在所有交互元素上可见？
- [ ] 用屏幕阅读器（NVDA/VoiceOver）能否理解页面结构？
- [ ] 表单错误是否能被屏幕阅读器正确播报？
- [ ] 弹窗/通知是否不会打断屏幕阅读器？
- [ ] 页面在 200% 缩放时是否可用？

## 7. 常用工具

| 工具 | 用途 |
|------|------|
| axe DevTools (Chrome) | 浏览器插件，一键扫描 WCAG 问题 |
| Lighthouse | Chrome 内置，综合评分 |
| WAVE | 网页版，可视化标注问题 |
| NVDA (Windows) / VoiceOver (macOS) | 屏幕阅读器，手动测试 |
| WebAIM Contrast Checker | 对比度计算 |
| color.review | 色盲模拟 + 对比度 |

## 8. Agent 执行检查清单

生成/修改 UI 时逐项确认：

- [ ] 颜色对比度是否达标（正文 >= 4.5:1，大文字 >= 3:1）？
- [ ] 是否没有仅依赖颜色传递信息？
- [ ] 所有交互元素是否可通过 Tab 到达？
- [ ] 焦点环是否可见且清晰？
- [ ] 是否使用了正确的语义化标签？
- [ ] 图片是否有 alt 文本？
- [ ] 表单输入是否有 label 关联？
- [ ] 动态内容是否有 aria-live？
- [ ] 是否支持 prefers-reduced-motion？
- [ ] 触控目标是否 >= 44x44px？

---

> **底线**：无障碍不是"加分项"，是"必须项"。一个无法被键盘和屏幕阅读器访问的产品，对 15%+ 的用户来说等于不存在。
