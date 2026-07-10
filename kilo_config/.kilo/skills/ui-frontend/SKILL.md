---
name: ui-frontend
description: >
  前端 UI 工程 skill。参考 addyosmani/frontend-ui-engineering，
  提供组件架构、响应式设计、可维护实现模式的最佳实践。
  每次编写/重构 UI 组件时激活，确保代码可扩展、可测试、易维护。
  若项目已有工程规范（如 React/Vue/Angular 团队规范），严格遵循。
keywords: frontend, component, responsive, architecture, 前端, 组件, 响应式
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: ui
---

# UI Frontend Skill — 前端工程最佳实践

> **适用场景**：组件开发、代码重构、技术选型、架构决策。
> **核心目标**：写出可维护、可测试、可扩展的前端代码。
> **黄金法则**：若项目**已有组件库规范或框架最佳实践**，严格遵循；本 skill 提供通用工程基线。

## 1. 组件架构原则

### 单一职责
- 每个组件只做**一件事**
- 复杂页面拆分为：Layout → Section → Block → Element
- 组件行数控制在 150 行以内，超过则拆分

### Props 设计
```typescript
// ✅ 好的 props 设计
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';  // 语义化 variant
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}

// ❌ 差的 props 设计
interface ButtonProps {
  color?: string;        // 太开放，破坏设计系统
  fontSize?: number;     // 应该通过 size 控制
  isRed?: boolean;       // 布尔爆炸，用 variant
  handleClick?: () => void;  // 命名不统一，用 onClick
}
```

### 组件分类
| 类型 | 职责 | 示例 | 依赖 |
|------|------|------|------|
| **Primitives** | 无业务逻辑，纯样式 | Button, Input, Card | 仅设计系统 |
| **Compositions** | 组合 Primitives | FormField, SearchBar | Primitives |
| **Features** | 包含业务逻辑 | UserProfile, OrderList | Compositions + API |
| **Pages** | 页面级组装 | DashboardPage, SettingsPage | Features + Layout |

### 样式策略
- **优先使用设计 token**（颜色/间距/字体变量）
- **CSS Modules / CSS-in-JS / Tailwind**：团队统一即可
- **避免**：行内样式、!important、魔法数字
- **响应式**：移动优先（`min-width`）或桌面优先（`max-width`），团队统一

## 2. 响应式设计工程

### 断点系统（使用设计 token）
```css
/* 推荐：移动优先 */
.component {
  /* 移动端默认 */
  padding: 16px;
}

@media (min-width: 640px) {
  .component {
    padding: 24px;
  }
}

@media (min-width: 1024px) {
  .component {
    padding: 32px;
  }
}
```

### 容器查询（现代方案）
```css
.card-container {
  container-type: inline-size;
}

@container (min-width: 400px) {
  .card {
    display: flex;
    gap: 16px;
  }
}
```

### 图片响应式
```html
<picture>
  <source media="(min-width: 1024px)" srcset="hero-large.webp" />
  <source media="(min-width: 640px)" srcset="hero-medium.webp" />
  <img src="hero-small.webp" alt="..." />
</picture>
```

## 3. 状态管理模式

### 本地状态 vs 全局状态
| 状态类型 | 使用场景 | 工具 |
|---------|---------|------|
| **Local UI State** | 组件内部开关、表单临时值 | useState / ref |
| **Shared UI State** | 跨组件的 UI 状态（modal、toast）| Context / Zustand |
| **Server State** | API 数据、缓存、同步 | TanStack Query / SWR |
| **Global App State** | 用户认证、主题、语言 | Redux / Zustand / Pinia |

### 状态提升原则
- 状态放在**最低公共祖先**
- 不要为每个输入框创建全局状态
- 表单数据优先用受控组件 + 本地状态，提交时统一处理

## 4. 性能模式

### 渲染优化
```typescript
// ✅ 使用 React.memo 避免不必要的重渲染
const ExpensiveList = React.memo(({ items }) => {
  return <ul>{items.map(...)}</ul>;
});

// ✅ 使用 useMemo 缓存计算
const sortedItems = useMemo(() => 
  items.sort((a, b) => b.date - a.date),
  [items]
);

// ✅ 使用 useCallback 缓存事件处理
const handleClick = useCallback(() => {
  onSelect(id);
}, [id, onSelect]);
```

### 代码分割
```typescript
// ✅ 路由级懒加载
const Dashboard = lazy(() => import('./pages/Dashboard'));

// ✅ 组件级懒加载（大组件）
const Chart = lazy(() => import('./components/Chart'));
```

### 列表虚拟化
- 列表超过 50 项时考虑虚拟滚动
- 推荐：react-window, @tanstack/react-virtual

## 5. 可访问性工程

### 键盘导航
- 所有交互元素必须可通过 Tab 到达
- 自定义组件必须处理键盘事件（Enter, Space, Esc, 方向键）
- 焦点管理：模态框 trapping，关闭后返回触发元素

### ARIA 工程
```typescript
// ✅ 复合组件：Tabs
const TabsContext = createContext();

function Tabs({ children, defaultValue }) {
  const [activeTab, setActiveTab] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div role="tablist">{children}</div>
    </TabsContext.Provider>
  );
}

function Tab({ value, children }) {
  const { activeTab, setActiveTab } = useContext(TabsContext);
  return (
    <button
      role="tab"
      aria-selected={activeTab === value}
      aria-controls={`panel-${value}`}
      onClick={() => setActiveTab(value)}
    >
      {children}
    </button>
  );
}
```

## 6. 测试策略

### 测试金字塔
| 类型 | 比例 | 工具 | 关注点 |
|------|------|------|--------|
| **单元测试** | 70% | Vitest/Jest | 纯函数、工具类 |
| **组件测试** | 20% | Testing Library | 渲染、交互、可访问性 |
| **E2E 测试** | 10% | Playwright | 关键用户流程 |

### 组件测试示例
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

test('button calls onClick when clicked', () => {
  const handleClick = vi.fn();
  render(<Button onClick={handleClick}>Click me</Button>);
  
  fireEvent.click(screen.getByRole('button', { name: /click me/i }));
  expect(handleClick).toHaveBeenCalledTimes(1);
});

test('disabled button is not clickable', () => {
  const handleClick = vi.fn();
  render(<Button disabled onClick={handleClick}>Click me</Button>);
  
  expect(screen.getByRole('button')).toBeDisabled();
});
```

## 7. 代码质量

### Lint 规则（必备）
- ESLint + TypeScript strict mode
- 禁止使用 `any`
- 强制使用设计 token（自定义规则）
- 禁止直接操作 DOM（`document.querySelector`）

### 文件组织
```
components/
  Button/
    index.ts          # 公共导出
    Button.tsx        # 组件实现
    Button.test.tsx   # 测试
    Button.stories.tsx # Storybook（如有）
    types.ts          # 类型定义
    constants.ts      # 组件常量
```

## 8. Agent 执行检查清单

编写组件时确认：

- [ ] 组件是否遵循单一职责？
- [ ] Props 是否语义化且类型安全？
- [ ] 是否使用了设计 token 而非硬编码值？
- [ ] 响应式是否考虑了移动端？
- [ ] 状态管理是否放在了正确的层级？
- [ ] 是否处理了 loading/error/empty 状态？
- [ ] 键盘导航和焦点管理是否完整？
- [ ] 是否有对应的单元/组件测试？
- [ ] 性能关键路径是否做了优化（memo/lazy/virtualize）？

---

> **核心思想**：好的 UI 不只是看起来好，代码也要**写得漂亮**。可维护的代码才能支撑长期迭代。
