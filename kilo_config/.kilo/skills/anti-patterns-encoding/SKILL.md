---
name: anti-patterns-encoding
description: 编码类反模式（encoding 主题）。Windows 环境下 UTF-8 / BOM / GBK 编码相关的反复出现错误。
keywords: encoding, bom, utf-8, gbk, powershell-5.1, 编码, 乱码
license: MIT
compatibility:
  - kilo >= 1.0
metadata:
  version: "1.0"
  category: knowledge
---

# 反模式 — encoding 主题

> 覆盖 Windows 编码工具链的反复出现错误：BOM 污染、PowerShell 5.1 GBK 默认输出。
> 来源：原 `anti-patterns/SKILL.md` 拆分；保留全部 AP-001、AP-005 条目。

## 主题条目表

| ID | 标题 |
|----|------|
| AP-001 | Edit 工具 BOM 污染（json/csv/yaml 解析失败） |
| AP-005 | PowerShell 5.1 GBK 编码根因（中文乱码源头） |

---

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

## 条目模板（新增参考）

```markdown
### AP-{NNN}: {条目标题}

**类型**: 反模式
**添加时间**: {YYYY-MM-DD}
**来源任务**: {任务名}
**验证状态**: {已验证 / ⚠️ 单次发生}
**最近更新**: {YYYY-MM-DD}

**描述**:
{一句话说明}

**上下文**:
- {触发场景 1}
- {触发场景 2}

**示例（错的）**:
{code 或 text}

**示例（对的）**:
{code 或 text}

**验证方式**:
- {验证命令或检查项}

**相关条目**:
- {AP-XXX 标题}
```
