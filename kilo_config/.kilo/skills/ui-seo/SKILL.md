---
name: ui-seo
description: >
  SEO 元数据与网页质量审计 skill。参考 fixing-metadata 与 addyosmani/web-quality-audit，
  为每个页面提供系统化的 meta 标签、Open Graph、JSON-LD、性能信号检查。
  每次生成/修改页面、路由、组件时激活，确保页面可被搜索引擎正确索引。
  若项目已有 SEO 规范，严格遵循。
---

# UI SEO Skill — 元数据与网页质量引擎

> **适用场景**：所有页面/路由创建、内容发布、营销活动页、文档站点。
> **参考标准**：Google Search Essentials、Lighthouse SEO 评分、Open Graph Protocol
> **黄金法则**：若项目**已有 SEO 规范或营销团队的元数据模板**，严格遵循；本 skill 提供通用基线。

## 1. 每个页面必须有的元数据

### 基础标签（<head> 内）
```html
<!-- 页面标题：唯一、描述性强、<= 60 字符 -->
<title>[页面特定标题] | [品牌名]</title>

<!-- 描述：<= 160 字符，包含关键词，行动导向 -->
<meta name="description" content="[页面内容的精炼描述]" />

<!-- 视口（移动端必需） -->
<meta name="viewport" content="width=device-width, initial-scale=1" />

<!-- 字符编码 -->
<meta charset="utf-8" />

<!-- 规范 URL（防止重复内容） -->
<link rel="canonical" href="https://example.com/page-path" />

<!-- 语言 -->
<html lang="zh-CN"> <!-- 或 en, ja 等 -->
```

### Open Graph（社交分享）
```html
<meta property="og:title" content="[页面标题]" />
<meta property="og:description" content="[页面描述]" />
<meta property="og:type" content="website" /> <!-- 文章用 article -->
<meta property="og:url" content="https://example.com/page-path" />
<meta property="og:image" content="https://example.com/og-image.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="[图片文字描述]" />
<meta property="og:site_name" content="[品牌名]" />
<meta property="og:locale" content="zh_CN" />
```

### Twitter Cards
```html
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@品牌账号" />
<meta name="twitter:creator" content="@作者账号" />
<meta name="twitter:title" content="[页面标题]" />
<meta name="twitter:description" content="[页面描述]" />
<meta name="twitter:image" content="https://example.com/og-image.jpg" />
<meta name="twitter:image:alt" content="[图片文字描述]" />
```

### 结构化数据（JSON-LD）
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "页面标题",
  "description": "页面描述",
  "url": "https://example.com/page-path",
  "publisher": {
    "@type": "Organization",
    "name": "品牌名",
    "logo": {
      "@type": "ImageObject",
      "url": "https://example.com/logo.png"
    }
  }
}
</script>
```

常见 `@type`：
- `WebPage` — 普通页面
- `Article` / `BlogPosting` — 文章/博客
- `Product` — 产品页（含价格、评分）
- `FAQPage` — FAQ 页面
- `HowTo` — 教程/指南
- `SoftwareApplication` — SaaS 产品页

## 2. 路由级元数据策略

### 动态路由（如 `/blog/[slug]`）
```typescript
// 每个动态路由必须导出 generateMetadata
export async function generateMetadata({ params }) {
  const post = await getPost(params.slug);
  return {
    title: `${post.title} | 品牌名`,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      images: [post.coverImage],
      type: 'article',
      publishedTime: post.publishedAt,
      authors: [post.author.name],
    },
    twitter: { /* ... */ },
    alternates: {
      canonical: `/blog/${post.slug}`,
    },
  };
}
```

### 404 页面
- title: "页面未找到 | 品牌名"
- description: "您访问的页面不存在，返回首页探索更多内容。"
- meta robots: noindex

### 登录/注册/后台页面
- meta robots: noindex, nofollow（除非需要被搜索）

## 3. 图片 SEO

### 基础要求
- 所有图片必须有 `alt` 属性（与 a11y 重叠）
- 图片文件名描述性强：`hero-dashboard-dark.jpg` 而非 `IMG_1234.jpg`
- 使用 WebP/AVIF 格式，提供 fallback

### 响应式图片
```html
<picture>
  <source srcset="image.avif" type="image/avif" />
  <source srcset="image.webp" type="image/webp" />
  <img src="image.jpg" alt="描述性文字" loading="lazy" width="800" height="600" />
</picture>
```

### OG 图片规范
| 平台 | 尺寸 | 格式 |
|------|------|------|
| Facebook/通用 | 1200x630 | JPG/PNG |
| Twitter | 1200x600 | JPG/PNG |
| LinkedIn | 1200x627 | JPG/PNG |
| 微信 | 900x500 | JPG/PNG |

## 4. 性能信号（Core Web Vitals）

Google 搜索排名受性能影响，关键指标：

| 指标 | 目标 | 优化方向 |
|------|------|---------|
| LCP (Largest Contentful Paint) | < 2.5s | 优化首屏图片、字体加载、服务器响应 |
| INP (Interaction to Next Paint) | < 200ms | 减少主线程阻塞、优化事件处理 |
| CLS (Cumulative Layout Shift) | < 0.1 | 图片/iframe 预定义尺寸、避免无尺寸插入内容 |
| TTFB (Time to First Byte) | < 600ms | CDN、边缘渲染、缓存策略 |

### 性能检查清单
- [ ] 关键 CSS 内联，非关键 CSS 异步加载
- [ ] 字体使用 `font-display: swap`
- [ ] 图片使用 `loading="lazy"`（首屏除外）
- [ ] 第三方脚本使用 `async`/`defer`
- [ ] 启用 gzip/brotli 压缩
- [ ] 静态资源长期缓存（hash 文件名）

## 5. 索引与爬虫控制

### robots.txt
```
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /*?*sort=  # 防止参数重复内容
Sitemap: https://example.com/sitemap.xml
```

### Sitemap
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page</loc>
    <lastmod>2026-07-09</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

### 页面级爬虫控制
```html
<!-- 正常索引 -->
<meta name="robots" content="index, follow" />

<!-- 不索引但跟踪链接 -->
<meta name="robots" content="noindex, follow" />

<!-- 完全不索引也不跟踪 -->
<meta name="robots" content="noindex, nofollow" />

<!-- 禁止缓存快照 -->
<meta name="robots" content="noarchive" />
```

## 6. 多语言与国际化

```html
<!-- 当前页面 -->
<link rel="alternate" hreflang="zh-CN" href="https://example.com/zh/page" />
<link rel="alternate" hreflang="en" href="https://example.com/en/page" />
<link rel="alternate" hreflang="x-default" href="https://example.com/page" />
```

- 每种语言必须有独立 URL（不要靠 cookie 切换）
- `hreflang` 标签必须在所有语言版本间互相引用

## 7. 网页质量审计（Lighthouse 风格）

定期运行以下检查：

### 自动化（CI/CD）
- [ ] Lighthouse SEO 评分 >= 90
- [ ] 无无效链接（404 检查）
- [ ] 无重复标题/描述
- [ ] 所有图片有 alt
- [ ] OG 标签完整
- [ ] JSON-LD 语法有效（schema.org 验证）

### 手动检查
- [ ] 搜索品牌名，首页是否为第一个结果？
- [ ] 搜索核心关键词，是否出现在前 3 页？
- [ ] 社交分享时卡片是否正确渲染？
- [ ] 移动端搜索结果是否显示友好？

## 8. Agent 执行检查清单

创建/修改页面时确认：

- [ ] `<title>` 是否唯一且 <= 60 字符？
- [ ] `<meta name="description">` 是否存在且 <= 160 字符？
- [ ] `canonical` 链接是否正确？
- [ ] OG 标签是否完整（title/description/image/type）？
- [ ] Twitter Card 是否配置？
- [ ] 图片是否有 alt 和正确尺寸？
- [ ] 是否使用了响应式图片格式（WebP/AVIF）？
- [ ] JSON-LD 是否语法有效？
- [ ] 动态路由是否导出了 generateMetadata？
- [ ] 不需要索引的页面是否设置了 noindex？
- [ ] 性能指标是否达标（LCP < 2.5s, CLS < 0.1）？

---

> **底线**：再好的设计如果搜索引擎看不到，就等于不存在。SEO 是设计交付的必要一环，不是事后补丁。
