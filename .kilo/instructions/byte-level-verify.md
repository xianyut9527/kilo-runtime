---
description: byte-level 验证 SOP — 反 subagent 虚报(010/010b/011 三次教训)
---

# Byte-Level 验证 SOP

> **强制原则**:byte-level 客观证据 **>** subagent 主观报告。
> subagent 报告"基于自己意图",与磁盘实际状态可分离。
> **必须**用 Get-Content L 行精确索引 + git diff stat + SHA256 对比作硬门禁。

## §1 原则
1. **客观优先**:磁盘实际状态 > LLM 报告
2. **二次读**:每个修改点必 Get-Content L 行(0-indexed 数组索引)
3. **可回放**:byte-level 证据必可机械回放(命令 + exit + 输出)
4. **不可信报告**:subagent 报告 PASS 但无 byte-level 证据 = `[INSUFFICIENT_EVIDENCE]`

## §2 5 必做
1. **Get-Content L 行精确索引**:对每个修改点,`(Get-Content f)[line-1]` 必返回预期内容
2. **git diff stat**:`git diff --stat HEAD -- <files>` 显示实际变更字节
3. **SHA256 对比**:改前/改后 `Get-FileHash` SHA256 必变化
4. **grep 严格匹配**:`grep -n "关键词" <files>` 命中数与预期一致(0 命中/≥n 命中)
5. **二次读确认**:改后再读 L 行,确保实际落盘非缓存

## §3 反模式(禁止)
- ❌ "grep 0 命中 → PASS"
- ❌ "doctor 57 PASS → PASS"
- ❌ "verifier 已确认" 无 byte-level 证据
- ❌ "改 3 文件" 实际未改(010 U1 虚报)
- ❌ "任务清单已覆盖" 漏列间接影响(011 漏 .gitignore)
- ❌ 报告 PASS 时 evidence < 3 条

## §4 输出:8 元组 evidence

```json
{
  "cmd": "实际跑的命令",
  "exit": 0,
  "stdout_key": "命令输出关键摘要",
  "hit_count": 0,
  "file": "文件路径",
  "line": 34,
  "before_sha": "abc12345",
  "after_sha": "def67890",
  "note": "本条 evidence 说明"
}
```

## §5 verifier 委派包必含

- `byte_level_required: true`
- `forbidden_files` 列表
- `verification_command` ≥1 条
- `return_contract.byte_level` schema 必填

## §6 全套 byte-level 验证命令模板

```powershell
# 1. SHA256 before
$before = (Get-FileHash <file>).Hash
# 2. 改文件(用 Set-Content UTF-8 无 BOM)
# 3. SHA256 after
$after = (Get-FileHash <file>).Hash
# 4. Get-Content 关键 L 行
(Get-Content <file>)[<line-1>]
# 5. git diff stat
git diff --stat HEAD -- <file>
# 6. grep 严格匹配
grep -n "<keyword>" <file>
```

## §7 历史教训
- **010 U1**:报告 PASS,kilo.json 未改(SHA256 未变)
- **010 U2/U4/U6**:报告 PASS,5 文件 12 处未改
- **010b U2 verifier**:报告 FAIL,实际 byte-level PASS
- **011 U2 CHANGELOG**:漏列 011 自身决策
- **011 .gitignore 5 处漏**:M1-M3 改 install,kilo.json,但 .gitignore 漏同步
## §8 路径陷阱(Windows 必读,013 U8 新增)

> **反 012 U5 教训**:`path.join('a','b')` 在 Windows = `a\b`(反斜杠),EXCLUDES 必用 `/` + `replace(/\\/g, '/')` 规范化,否则 `full.includes(e)` 永 false → 自豁免静默失效。

### 8.1 三大陷阱

1. **path.join 反斜杠**:`path.join('scripts','decouple-check.mjs')` Windows = `scripts\decouple-check.mjs`(``)
2. **EXCLUDES 正斜杠**:`['scripts/decouple-check.mjs']` Windows = `scripts/decouple-check.mjs`(`/`)
3. **includes 永不匹配**:`'scripts\decouple-check.mjs'.includes('scripts/decouple-check.mjs')` = **false**

### 8.2 解:`full.replace(/\\/g, '/').includes(e)`

```js
// 反模式(012 U5 教训):
if (EXCLUDES.some(e => full.includes(e))) continue;

// 正例(Windows 兼容):
if (EXCLUDES.some(e => full.replace(/\\/g, '/').includes(e))) continue;
```

### 8.3 跨平台规范

- **EXCLUDES 项必用 `/`**(统一正斜杠)
- **扫的文件路径必 `replace(/\\/g, '/')` 规范化**
- **path 断言必 `path.resolve()` 相对项目根**
- **agent/委派包必 `path_normalized: true` 字段**

### 8.4 8 元组 evidence 加 path_normalized

```json
{
  "cmd": "实际跑的命令",
  "exit": 0,
  "stdout_key": "命令输出",
  "hit_count": 0,
  "file": "path.resolve(<file>) 相对项目根",
  "line": L,
  "before_sha": "前 8 字符",
  "after_sha": "前 8 字符",
  "path_normalized": true,
  "note": "本条 evidence"
}
```

### 8.5 委派包必含路径断言

- 委派包必 `forbidden_files` + `key_files` 必用 `path.resolve()` 相对项目根
- verifier 必 `Test-Path <file>` 二次验证(防 012 verifier 路径错)
- 禁止硬编码 `lifecycle-doctor/` 不带 `scripts/` 前缀(012 教训)