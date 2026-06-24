---
name: anti-patterns
description: 本 SKILL 存放项目在反复出现的错误模式、踩坑记录、禁止事项方面的长期知识。由 skills-writer 根据验证后的经验写入。
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式

> 本文件存放本项目在反复出现的错误模式、踩坑记录、禁止事项方面的长期知识。
> 由 skills-writer 根据验证后的经验写入，禁止手动编造未经验证的内容。
> 新增条目请参考 `.kilo/instructions/skills-lifecycle.md` 的条目模板。

## 条目列表

### AP-001: Edit 工具 BOM 污染（json/csv/yaml 解析失败）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（kilo.json 修改）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
在 Windows 环境下使用 Edit 工具修改 UTF-8 文本文件（特别是 `kilo.json` / `*.yaml` / `*.csv`）时，工具偶尔会向文件写入 UTF-8 BOM（`EF BB BF`），导致严格的 `JSON.parse` / YAML 解析器报错。

**上下文**:
- 任何用 Edit 工具改 JSON/YAML 配置文件后必须做 BOM 检测
- `JSON.parse(fs.readFileSync(...))` 会因 BOM 失败
- 严格的 YAML 解析器同样会失败

**示例（错的）**:
```javascript
// 直接读取 → 失败
const obj = JSON.parse(fs.readFileSync('kilo.json', 'utf8'));
// SyntaxError: Unexpected token in JSON at position 0
```

**示例（对的）**:
```javascript
// 检测并剥离 BOM
let buf = fs.readFileSync('kilo.json');
if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
  buf = buf.subarray(3);
}
const obj = JSON.parse(buf.toString('utf8'));
```

**验证方式**:
- `node -e "let b=require('fs').readFileSync('p'); console.log(b[0]===0xEF?'BOM':'no-BOM')"`
- 在修改后必须跑 `JSON.parse` 验证

**相关条目**:
- AP-005 编码根因（同一 Windows 编码问题）

---

### AP-002: 软约束 vs 硬门禁（规则存在 ≠ 规则被遵守）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: kilo_config 编码规范治理（多次会话）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
把核心规则（如"Windows 编码"、"安全输入校验"、"禁止自验"）放在 `.kilo/instructions/*.md` 的嵌套子条款里，agent 在复杂任务中读到大量其他指令，核心规则被淹没，**规则存在但不被遵守**。

**上下文**:
- 任何被多次违反的规则几乎都位于嵌套位置
- 同一规则放平级位置 + "违反视为方法层错误" 显著提升遵守率
- agent 不会在每个文件操作前都重读 instruction

**示例（错的）**:
```markdown
## 文件操作规范
### 必需使用 Shell 处理内容时的编码要求
- Windows 需设置 `[Console]::OutputEncoding` ...
```
（嵌套太深，agent 看不到）

**示例（对的）**:
```markdown
## 流程强制基线
1. 禁止跳步
2. 过程可追溯
3. **Windows 编码永久化**（违反视为方法层错误，必须修）
4. 自验无效
5. 交付必审
```
（平级 + 显式违反后果）

**验证方式**:
- 在 coderAgent prompt 顶部嵌入核心规则
- 用 `core.md` 的"流程强制基线"位置作为唯一权威源
- 每违反 1 次 = 1 次反模式反馈

**相关条目**:
- AP-005 编码根因

---

### AP-003: pre-checker FAIL 修正后未再过 pre-checker

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（pre-checker 阶段）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
pre-checker 输出 FAIL 后，coderAgent 修正了单元 DAG，但未再次调用 pre-checker 验证，直接进入 engineer 阶段。这是**跳步违规**，违反 workflow.md 的"pre-checker FAIL → 修正后必须 PASS 才能推进"约束。

**上下文**:
- 任何"修正后未复验"的情况都属于跳步
- 修正内容可能引入新问题
- 流程日志必须显式记录复验节点

**示例（错的）**:
```text
pre-checker | ❌ FAIL | 缺 3 个单元
[直接修正]
[直接进入 engineer，不复验]
```

**示例（对的）**:
```text
pre-checker | ❌ FAIL | 缺 3 个单元
[修正]
pre-checker (复验) | ✅ PASS
engineer 委派 | ✅ 已完成
```

**验证方式**:
- 流程日志中"pre-checker"节点必须出现 2 次（首次 + 复验）
- 第二次必须为 ✅ PASS

**相关条目**:
- AP-004 Reviewer 升级失败

---

### AP-004: 子智能体返回空结果未升级（Reviewer / Architect 任务异常）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: 集成 Hermes 4 层加固（reviewer 阶段）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
当 `task` 工具委派的子智能体（reviewer / architect / checker）连续 2 次返回空 `task_result` 时，coderAgent 直接"内联执行"该子智能体的职责。这违反 workflow.md 的"T3 / 多轮失败 → 升级 ensemble"约束。

**上下文**:
- 子智能体返回空可能是 prompt 过长 / context 超限 / 模型路由问题
- 内联执行等于跳过独立验证环节
- 必须标记 `[SUBAGENT_RETURNED_EMPTY]` 并升级

**示例（错的）**:
```text
reviewer 委派 1 次 → 空结果
reviewer 委派 2 次 → 空结果
[直接做内联检查]
```

**示例（对的）**:
```text
reviewer 委派 1 次 → 空结果，标记 [SUBAGENT_RETURNED_EMPTY]
reviewer 委派 2 次（精简 prompt） → 空结果
[升级到 ensemble 或拆细任务]
```

**验证方式**:
- 子智能体返回空时必须显式记录
- 2 次失败后必须升级，不能直接内联
- 必要时重启子智能体而非合并职责

**相关条目**:
- AP-003 流程跳步

---

### AP-005: PowerShell 5.1 GBK 编码根因（中文乱码源头）

**类型**: 反模式
**添加时间**: 2026-06-24
**来源任务**: kilo_config 编码规范治理（多次会话，2026-06-07 专题）
**验证状态**: 已验证
**最近更新**: 2026-06-24

**描述**:
Windows 中文系统下，PowerShell 5.1（`powershell.exe`）默认输出编码为系统活动代码页 936（GBK/GB2312），而非 UTF-8。所有通过 shell 工具读 / 写的中文内容都会触发乱码或编码错误。

**上下文**:
- 仅影响 Windows + PowerShell 5.1（不含 pwsh 7 / WSL）
- 影响所有 `bash` 工具调用
- install.ps1 已写入 `$PROFILE` 永久修复

**示例（错的）**:
```powershell
# 默认状态下
[Console]::OutputEncoding  # 输出 GB2312
Get-Content .\中文文件.md  # 显示乱码
```

**示例（对的）**:
```powershell
# 永久化（已写入 install.ps1）
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
```

**验证方式**:
- 跑 `[Console]::OutputEncoding.WebName` 应返回 `utf-8`
- install.ps1 第 70-106 行已实施

**相关条目**:
- AP-001 BOM 污染（同源 Windows 编码问题）
- AP-002 软约束（编码规则被淹没）

---

## 回写指引

当本次任务产生值得沉淀的经验时：
1. 确认经验已通过 checker/reviewer 验证。
2. 根据经验主题选择本文件或其他分类文件。
3. 按上方条目模板格式追加到文件末尾。
4. 确保不与其他条目重复；若相关，在"相关条目"中建立链接。
