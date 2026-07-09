---
name: ui-color
description: >
  色彩系统与高级配色 skill。参考 jakubkrehel/oklch-skill 和 color.review，
  提供 perceptually uniform 的配色方案、对比度检查、色盲模拟。
  每次定义色彩系统、选择品牌色、处理暗色模式时激活。
  若项目已有色彩规范，严格遵循。
---

# UI Color Skill — 感知均匀色彩系统

> **适用场景**：定义品牌色、创建暗色模式、处理渐变、确保无障碍色彩。

## 1. 为什么不用 Hex/HSL？

传统配色的问题：
- **Hex**：人脑无法直观判断 `#3B82F6` 和 `#60A5FA` 的亮度差异
- **HSL**：色相相同但明度感知不同（黄色比蓝色亮得多）
- **RGB**：与感知无关，调色困难

**OKLCH 解决方案**：
- **L** (Lightness)：感知明度，0-100%，线性均匀
- **C** (Chroma)：色度（饱和度），人眼感知一致
- **H** (Hue)：色相，0-360°

## 2. OKLCH 基础用法

### 选择品牌色
```css
/* 在 oklch.com 上选择 */
:root {
  --color-primary: oklch(55% 0.2 250);   /* 蓝色 */
  --color-success: oklch(65% 0.22 145);  /* 绿色 */
  --color-warning: oklch(75% 0.18 85);   /* 黄色 */
  --color-danger: oklch(55% 0.22 25);    /* 红色 */
}
```

### 生成色阶（保持色相一致）
```css
/* 同色系色阶：只改变 L，保持 C 和 H */
--primary-50:  oklch(97% 0.02 250);
--primary-100: oklch(93% 0.05 250);
--primary-200: oklch(87% 0.10 250);
--primary-300: oklch(80% 0.15 250);
--primary-400: oklch(72% 0.18 250);
--primary-500: oklch(55% 0.20 250);  /* 主色 */
--primary-600: oklch(48% 0.18 250);
--primary-700: oklch(42% 0.15 250);
--primary-800: oklch(35% 0.12 250);
--primary-900: oklch(28% 0.08 250);
```

### 暗色模式（自动推导）
```css
.dark {
  /* 暗色模式：提高 L，降低 C（屏幕发光，高饱和刺眼） */
  --color-primary: oklch(70% 0.15 250);
  --color-success: oklch(75% 0.18 145);
  --color-surface: oklch(20% 0.02 250);
  --color-text: oklch(95% 0.02 250);
}
```

## 3. 对比度检查

### 公式
对比度 = (L1 + 0.05) / (L2 + 0.05)，其中 L 是 OKLCH 的 Lightness 值

### 标准
| 场景 | 最小对比度 | 建议 |
|------|-----------|------|
| 正文（< 18px） | 4.5:1 | >= 7:1（AAA） |
| 大文字（>= 18px bold） | 3:1 | >= 4.5:1 |
| 图标/图形 | 3:1 | >= 4.5:1 |

### 快速检查
```css
/* OKLCH L 值差 >= 60% 通常满足 4.5:1 */
.bg-surface { background: oklch(20% 0.02 250); }
.text-primary { color: oklch(80% 0.15 250); }
/* L 差 = 60%，安全 */
```

## 4. 色盲模拟

常见色盲类型：
- **Deuteranopia**（绿色盲）：红绿难辨
- **Protanopia**（红色盲）：红色变暗
- **Tritanopia**（蓝色盲）：蓝黄难辨
- **Achromatopsia**（全色盲）：只看亮度

### 设计原则
- 不要仅用红/绿区分状态（加图标、文字、形状）
- 数据可视化使用 pattern + 颜色双重编码
- 用 color.review 或 Chrome DevTools 色盲模拟器测试

## 5. 渐变与混合

### OKLCH 渐变（感知均匀）
```css
.gradient {
  background: linear-gradient(
    in oklch,
    oklch(60% 0.2 250),   /* 蓝色 */
    oklch(70% 0.18 300)   /* 紫色 */
  );
}
```

### 避免
```css
/* ❌ Hex 渐变：中间会出现灰色死区 */
background: linear-gradient(#3B82F6, #EC4899);

/* ✅ OKLCH 渐变：色相平滑过渡 */
background: linear-gradient(in oklch, oklch(55% 0.2 250), oklch(65% 0.2 340));
```

## 6. 工具

| 工具 | 用途 |
|------|------|
| oklch.com | 交互式 OKLCH 调色板生成 |
| color.review | 对比度检查 + 色盲模拟 |
| oklch-picker.vercel.app | OKLCH 颜色选择器 |
| culori.js | JS 库：OKLCH ↔ Hex/HSL 转换 |

## 7. Agent 执行检查清单

定义色彩时确认：

- [ ] 是否使用了 OKLCH 而非 Hex/HSL？
- [ ] 色阶是否保持色相一致（只改 L）？
- [ ] 对比度是否满足 WCAG 标准？
- [ ] 是否测试了色盲模拟？
- [ ] 暗色模式是否降低了 C（色度）？
- [ ] 是否避免了纯黑/纯白（用极深蓝灰/暖灰）？
