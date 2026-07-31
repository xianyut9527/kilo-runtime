# 响应模式与示例

## 六步响应模板

```
接收代码评审反馈时：

1. READ: 完整阅读反馈，不做反应
2. UNDERSTAND: 用自己的话重述要求（或提问）
3. VERIFY: 对照代码库现实检查
4. EVALUATE: 对当前代码库技术上是否合理？
5. RESPOND: 技术确认或有理有据的反驳
6. IMPLEMENT: 一次一项，每项测试
```

## 真实示例

**表演式认同（坏）：**
```
Reviewer: "Remove legacy code"
❌ "You're absolutely right! Let me remove that..."
```

**技术验证（好）：**
```
Reviewer: "Remove legacy code"
✅ "检查中... build target 为 10.15+，此 API 需 13+。需要 legacy 保持向后兼容。当前实现 bundle ID 错误——修复它或放弃 pre-13 支持？"
```

**YAGNI（好）：**
```
Reviewer: "Implement proper metrics tracking with database, date filters, CSV export"
✅ "Grep 代码库——没有调用此端点。移除（YAGNI）？或是我遗漏了使用场景？"
```

## 模糊反馈示例

```
human partner: "Fix items 1-6"
你理解 1,2,3,6。4,5 不明确。

✅ "理解了 1,2,3,6。需要先澄清 4 和 5 再实施。"
```

## YAGNI 示例

```
Reviewer: "Implement proper metrics tracking with database, date filters, CSV export"

[在代码库中 grep]
→ 无调用方

✅ "Grep 代码库——没有调用此端点。移除（YAGNI）？或是我遗漏了使用场景？"
```

## GitHub 线程回复

在 GitHub 回复内联评审评论时，在评论线程中回复（`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`），而非作为顶层 PR 评论。
