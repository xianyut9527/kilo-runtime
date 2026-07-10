---
name: ui-shadcn
description: >
  shadcn/ui 和 DaisyUI 组件库使用规范 skill。
  提供 shadcn/ui 组件选择、主题定制、组合模式的最佳实践。
  每次使用 shadcn/ui、Radix UI、Tailwind CSS 组件时激活。
  若项目已配置 shadcn/ui，严格遵循现有 theme 和组件约定。
keywords: shadcn, daisyui, radix, tailwind, components, 组件库
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: ui
---

# UI Shadcn Skill — shadcn/ui 与组件库规范

> **适用场景**：使用 shadcn/ui、DaisyUI、Radix UI、Headless UI 等组件库的项目。
> **核心目标**：正确选择组件、一致地定制主题、避免组件库反模式。
> **黄金法则**：若项目**已配置 shadcn/ui 或 DaisyUI**，严格遵循现有 `globals.css`、`tailwind.config.ts`、`components.json` 配置。

## 1. shadcn/ui 项目初始化

### 安装命令
```bash
npx shadcn@latest init
# 或
npx shadcn-ui@latest init
```

### 关键配置文件
| 文件 | 用途 |
|------|------|
| `components.json` | 项目配置（路径、别名、baseColor） |
| `tailwind.config.ts` | 主题扩展、自定义 token |
| `src/app/globals.css` | CSS 变量（主题色、圆角、间距） |
| `src/lib/utils.ts` | cn() 工具函数（clsx + tailwind-merge） |

### baseColor 选择
| 选项 | 风格 | 适合 |
|------|------|------|
| `neutral` | 中性灰，最通用 | 大多数项目 |
| `slate` | 偏蓝灰，现代感 | SaaS、技术产品 |
| `zinc` | 偏暖灰，柔和 | 内容、阅读类 |
| `stone` | 偏黄灰，温暖 | 生活方式、创意 |
| `gray` | 纯灰 | 极简、黑白主题 |

## 2. 组件安装与使用

### 安装单个组件
```bash
npx shadcn add button
npx shadcn add dialog
npx shadcn add dropdown-menu
```

### 推荐核心组件套装
```bash
# 基础交互
npx shadcn add button input label textarea select checkbox radio-group switch

# 导航
npx shadcn add tabs navigation-menu breadcrumb pagination

# 反馈
npx shadcn add dialog alert-dialog toast skeleton

# 数据展示
npx shadcn add table card badge avatar tooltip

# 高级
npx shadcn add command carousel drawer resizable
```

### 使用模式
```tsx
// ✅ 组合使用：表单
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function LoginForm() {
  return (
    <form>
      <div className="grid gap-2">
        <Label htmlFor="email">邮箱</Label>
        <Input id="email" type="email" placeholder="name@example.com" />
      </div>
      <Button type="submit">登录</Button>
    </form>
  )
}
```

## 3. 主题定制

### CSS Variables（globals.css）
```css
@layer base {
  :root {
    /* 核心色板 */
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    /* ... 暗色模式变量 ... */
  }
}
```

### 定制原则
- 不要直接修改组件源码（`node_modules` 里的），用 CSS 变量覆盖
- 使用 `cn()` 工具合并 Tailwind 类：
  ```tsx
  import { cn } from "@/lib/utils"
  
  <div className={cn("base-class", className)} />
  ```
- 主题色用 HSL 格式，便于透明度计算

## 4. DaisyUI（替代方案）

### 适用场景
- 需要快速原型，不想逐个安装组件
- 偏好 class-based 组件（如 `btn btn-primary`）
- 与 Tailwind CSS 深度集成

### 安装
```bash
npm install daisyui@latest
# tailwind.config.ts
plugins: [require("daisyui")],
```

### 主题配置
```typescript
// tailwind.config.ts
export default {
  plugins: [require("daisyui")],
  daisyui: {
    themes: ["light", "dark", "corporate", "business"],
    darkTheme: "dark",
    base: true,
    styled: true,
    utils: true,
  },
}
```

### DaisyUI vs shadcn/ui
| | shadcn/ui | DaisyUI |
|---|-----------|---------|
| **哲学** | 可复制组件，完全可控 | class-based，快速搭建 |
| **定制** | 源码级，CSS 变量 | 主题配置，有限覆盖 |
| **学习成本** | 中（需理解 Radix） | 低（class 名直观） |
| **适合** | 长期维护的生产项目 | MVP、内部工具、原型 |

## 5. 组件库反模式

| 反模式 | 正确做法 |
|--------|---------|
| 修改 `node_modules` 里的组件源码 | 复制到项目本地修改，或覆盖 CSS 变量 |
| 混合使用多个 UI 库（MUI + shadcn） | 统一使用一个组件库 |
| 每个页面引入全部组件样式 | 按需引入，使用 tree-shaking |
| 忽略 dark 模式变量 | 始终配置完整的 light/dark 变量 |
| 用 shadcn 做重度定制（改得面目全非） | 重度定制时考虑自建组件库 |

## 6. Agent 执行检查清单

使用 shadcn/ui 时确认：

- [ ] 项目是否已初始化 shadcn/ui？
- [ ] baseColor 选择是否符合品牌调性？
- [ ] CSS 变量是否完整配置了 light + dark？
- [ ] 组件是否通过 `npx shadcn add` 正确安装？
- [ ] 定制是否通过 CSS 变量而非修改源码实现？
- [ ] 是否使用了 `cn()` 工具合并 Tailwind 类？
- [ ] 是否遵循了组件库的 Props API（不随意扩展）？

---

> **核心思想**：shadcn/ui 是**可复制组件**，不是黑盒依赖。理解它的底层（Radix + Tailwind）才能用好它。
