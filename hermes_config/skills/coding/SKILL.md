---
name: coding
description: 编码专用策略与高效实现规范。参考 Claude Code / Aider / Cursor 顶级编码 Agent 的实践，优化文件读写、搜索、上下文管理和验证门禁，提升编码输出质量与效率。
keywords:
  - coding
  - code-quality
  - file-ops
  - search
  - lint
  - test
  - git-diff
  - context-management
  - ripgrep
license: MIT
compatibility:
  - hermes-agent >= 2026
metadata:
  version: "2.0"
  category: coding
---

# 编码专用策略

## 1. 文件操作规范

### 批量读取
- **优先用 `execute_code`**：需要读取多个文件时，用 Python 脚本批量 `read_file`，减少往返
- **避免逐行 cat**：不要用 terminal cat/head/tail 读文件，用 `read_file` 工具

### Patch 失败处理
- 同一 patch 失败 **2 次** → 停止尝试，改用 `write_file` 重写整个文件
- patch 前先 `read_file` 确认当前内容，不要用记忆中的旧文本

## 2. 搜索策略

| 场景 | 工具 | 原因 |
|------|------|------|
| 找符号定义/引用 | `search_files(target='content')` | ripgrep-backed，比 grep 快 10x |
| 找文件路径 | `search_files(target='files')` | 自动排序，支持 glob |
| 需要理解调用链 | `gitnexus_context` | 代码图谱，比文本搜索精准 |
| 确认修改影响面 | `gitnexus_impact` | upstream/downstream 分析 |

**禁止**：用 `grep -r` 在 terminal 中搜索，应直接用 `search_files`。

## 3. 修改前必做：代码地图

T2+ 任务或修改不熟悉的模块前，先生成代码地图：

```python
# 用 execute_code 执行
from hermes_tools import search_files, read_file

# 1. 获取模块结构
search_files(target='files', pattern='*.py', path='src/')

# 2. 读取关键入口文件
read_file('src/main.py', limit=50)

# 3. 搜索目标符号的定义和引用
search_files(target='content', pattern='def target_function', path='src/')
```

## 4. 修改后必做：验证门禁

每次文件修改后，立即执行相关验证：

| 验证类型 | 命令 | 失败处理 |
|----------|------|----------|
| 语法检查 | `python -m py_compile <file>` 或对应 linter | 立即修复 |
| 测试覆盖 | `pytest <相关测试文件> -x` | 失败不提交 |
| 类型检查 | `mypy <file>` 或 `pyright <file>` | 优先修复 |
| 安全扫描 | `bandit -r <dir>` |  blocker |
| 调用方确认 | `search_files` 搜索修改符号的全部引用 | 同步调整 |
| diff 范围确认 | `git diff -- <file>` | 防止 SCOPE_CREEP |

**规则**：未通过验证门禁的修改不得标记为完成。

**优先自动化验证，子代理审查仅作兜底**：
- T1 及以下任务：优先跑 `execute_code` 批量验证脚本，不创建 checker 子代理
- 子代理返回空结果或明显 truncation → 直接内联执行其职责

## 5. 上下文管理

### 大文件处理
- 单次 `read_file` 上限 ~100K 字符，超过用 offset/limit 分页
- 需要理解大文件时，先读开头（定义/导入），再跳到关键函数

### 长任务防丢失
- 每完成一个子单元，用 `todo` 标记进度
- 上下文压缩触发 `[RECOVERED_FROM_INSTRUCTIONS]` 时，按 SOUL.md 模板输出恢复摘要

## 6. Git 工作流

### 修改跟踪
- T1+ 任务：用 `git diff` 或 `git status --short` 确认实际改动范围
- 多单元并行时：每单元独立 diff，避免全量误判 SCOPE_CREEP

### 提交规范
- commit message 包含：修改摘要 + 关联的反模式/模式 ID（如 `fix(AP-001): 修复 BOM 污染`）
- 大重构拆分为多个小 commit，每个 commit 对应一个验证单元

## 7. 工具链建议

| 工具 | 安装命令 | 提升 |
|------|----------|------|
| ripgrep | `choco install ripgrep` / `apt install ripgrep` | 搜索速度 10x |
| agent-browser | `npm install -g @anthropic-ai/agent-browser` | 浏览器自动化 |
| mypy | `pip install mypy` | 静态类型检查 |
| bandit | `pip install bandit` | 安全漏洞扫描 |
| pytest-xdist | `pip install pytest-xdist` | 并行测试 |

> 未安装时 Hermes 回退到 grep/browser fallback，体验降级但可用。