---
name: component-driven-fixes
description: >
  治理跨页面/组件重复出现的 UI、样式、布局、交互行为问题。
  强制先全量扫描、根因分类，再优先使用共享组件/layout/design token/全局样式统一修复，
  禁止逐页复制粘贴式补丁。
keywords:
  - component-driven
  - 组件化修复
  - 重复模式
  - 全量扫描
  - 共享抽象
  - 局部补丁拦截
  - UI 一致性
  - design-token
  - layout
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: engineering-methodology
---

# Component-Driven Fixes — 重复 UI/样式/行为问题组件化修复

> **触发条件**：任何涉及 UI、样式、布局、交互行为的任务，只要同一症状在 ≥2 个页面/组件出现，或用户已声明「类似问题普遍存在」/「所有页面都有这个问题」，本 skill 强制激活。
> **核心原则**：先扫描、再分类、优先共享抽象、禁止逐页补丁。

## 决策树（编码前必须走一遍）

```
收到 UI/样式/行为修复任务
  ├─ 用 grep/glob 扫描同类症状（样式类名、结构模式、异常行为描述）
  │   ├─ 命中 1 处 → 按单点修复执行，仍需检查是否存在共享 Layout/Token 可兜底
  │   └─ 命中 ≥2 处 → 进入组件化决策
  │         ├─ A. 缺少共享抽象 → 创建/扩展共享 Layout/Component/Token/Mixin/全局 CSS
  │         ├─ B. 已有共享抽象但错/未用 → 修正共享抽象 + 同步消费者
  │         └─ C. 确实独立上下文 → 在验收映射表写明理由，请求用户确认
  └─ 输出：全量扫描清单 + 根因分类 + 修复方案 + 反向验证指标
```

## 六步执行清单

1. **全量扫描**
   - 列出所有出现该症状的文件、行号、出现次数。
   - 对样式问题，同时扫描 `className`/`class`/`style`/`css` 等关键词的重复片段。
   - 对布局问题，检查是否缺少全局 `min-width`/`overflow-x`/`max-width` 等约束。

2. **根因分类**
   - **A. 缺少共享抽象**：项目没有统一的页面布局、容器、或 design token。→ 优先补充共享抽象。
   - **B. 共享抽象已存在但错误/未被使用**：组件库或全局样式已有能力，但页面未接入或接入错误。→ 修复共享抽象并迁移消费者。
   - **C. 独立上下文无法抽象**：各页面语义、数据结构、交互确实不同，抽象成本高于收益。→ 必须记录理由并请求用户确认，否则视为逃避组件化。

3. **组件化优先**
   - 重复 ≥2 处的模式必须提炼为共享组件 / layout / design token / mixin / 全局 CSS。
   - 禁止把同一段样式/结构/逻辑复制到多个页面或组件。
   - 新共享抽象的命名、位置、props/API 必须遵循项目既有 design-system / patterns。

4. **同步依赖**
   - 所有受影响的页面/组件必须同批修改。
   - 修改共享抽象后，必须搜索并更新所有消费者；不得让消费者停留在旧模式。

5. **防复发产物**
   - 至少交付一项防复发机制：design token、共享组件、lint 规则、文档条款、视觉回归测试、Storybook 示例。
   - 若只改了一处而没留防复发机制，验收映射表必须说明原因。

6. **反向验证**
   - 旧模式命中数 = 0（反向 grep）。
   - 新引用命中数 = 预期消费者数（正向 grep）。
   - 数据写入验收映射表。

## 典型场景示例

### 示例 1：页面可以左右拖动（未固定宽度/溢出）

**错误做法（逐页补丁）**：在每个页面文件里加 `style={{ minWidth: '...', overflowX: 'hidden' }}`。

**正确做法**：
- 检查项目是否有根布局组件（如 `RootLayout`/`AppLayout`/`PageContainer`）。
- 在共享布局里统一设置 `min-width: 100vw` / `overflow-x: hidden` / `max-width` 约束。
- 让所有页面接入该布局，或移除页面级冗余样式。
- 反向验证：`grep -R "overflowX.*hidden" src/pages` 命中数应为 0 或仅保留真正需要局部滚动的例外。

### 示例 2：多个页面按钮样式不一致

**错误做法**：逐个页面修改按钮 className。

**正确做法**：
- 扩展 design-system 的 Button 组件/token。
- 统一替换为共享 Button；若用 Tailwind，抽成 `btn-primary` 等 utility/component class。
- 反向验证：旧 className 字符串命中数 = 0。

### 示例 3：多个表单出现相同校验交互

**错误做法**：在每个表单组件里重复写校验逻辑和错误提示样式。

**正确做法**：
- 提炼为 `FormField` / `useValidation` 等共享组件或 hook。
- 统一错误提示样式通过 design token。

## 何时允许单点例外

必须同时满足以下全部条件，否则必须组件化：

1. 该症状仅在 **1 处**出现；或
2. 各出现点处于 **完全不同的业务上下文**，抽象会导致 API 过度复杂；且
3. 已在验收映射表中写明「单点例外」理由；且
4. 已获得用户显式确认或 conductor 授权。

## 与相关规则的衔接

- `core.md`「组件化优先 / 重复模式拦截」：给出通用原则。
- `workflow-core.md`「重复模式修复 / 组件化 SOP」：给出强制流程与失败标记。
- `anti-patterns/SKILL.md` AP-014（fact_store）：记录「逐页补丁式修复」反模式（v2.6 已固化 → skill `component-driven-fixes`）。
- `design-system/SKILL.md`：提供 design token、组件规范、布局原则。

## 失败标记

- `[LOCAL_PATCH]`：重复模式未走组件化/共享抽象，直接逐页修补。
- `[COPY_PASTE_FIX]`：同一段样式/结构/逻辑被复制到多个文件。
- `[MISSING_SCAN]`：未产出全量扫描清单即开始修改。
- `[MISSING_PREVENTION]`：交付缺少防复发产物且无正当理由。
