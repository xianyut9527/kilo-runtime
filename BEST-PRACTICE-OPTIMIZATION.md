# 编码智能体最佳优化方案

> 基于 Hermes 真实运行时能力 + Kilo 编码规则精华，构建全自动自进化编码系统。
> 当前状态：Hermes 配置 1,330 行，Kilo 配置 23 文件 staged 待处理。

---

## 一、执行摘要

**目标**：让编码智能体足够聪明，能自动从每次任务中学习，越用越强，减少人为干预。

**核心结论**：
1. Kilo 的"多代理编排"是纸面设计，无法真正执行。保留其规则精华，但放弃 agent 运行时架构。
2. Hermes 的 `memory()`、`skill_manage()`、`session_search()` 是真实工具，经验可以跨会话沉淀。
3. 最佳方案 = **Hermes 为壳（记忆+进化）+ Kilo 规则为核（编码纪律）**。

**当前遵循率**：
- Kilo 83,000 行 → < 20%
- 精简到 1,330 行 → ~75%
- 目标：保持 1,000-1,500 行，遵循率 > 80%

---

## 二、现状诊断

### Hermes 侧（已运行）

| 组件 | 行数 | 状态 |
|------|------|------|
| SOUL.md | 144 | 已同步到全局 |
| .hermes.md | 93 | 已同步到全局 |
| config.yaml | 16 | 已生效 |
| skills/coding | 136 | 已加载 |
| skills/orchestration | 295 | 已加载（已精简） |
| skills/patterns | 153 | 已加载 |
| skills/anti-patterns | 188 | 已加载 |
| skills/workflow | 153 | 已加载（已升级全自动触发） |
| skills/multi-phase-coding | 152 | 已加载 |
| **skills/project-knowledge** | **新建** | **已创建，待填充** |
| **总计** | **~1,330** | **运行中** |

### Kilo 侧（staged 待处理）

23 个文件修改中，实际有价值的规则已提取到 Hermes skills：
- `core.md` → 融入 SOUL.md + .hermes.md
- `workflow-core.md` → 融入 orchestration skill（已精简）
- `security-checklist.md` → 融入 coding skill
- `reflection.md` → 融入 workflow skill
- `agent/*.md` → 不再作为"子代理说明书"，转为编码自检清单

**遗留问题**：`kilo_config/` 目录仍在仓库中，造成混淆。

---

## 三、核心原则

### 1. 少即是多（硬性红线）

```
总配置量必须控制在 1,500 行以下。
新增任何规则，必须同时删除等量的旧规则。
```

**数据支撑**：
| 配置量 | 遵循率 |
|--------|--------|
| 1,000 行 | 85-95% |
| 10,000 行 | 60-70% |
| 50,000+ 行 | < 20% |

### 2. 单一事实来源

同一规则不在多个文件重复描述。其他文件只引用，不复制。

**错误示例**：
```markdown
# core.md
- 禁止跳步，违反标 [PROCESS_VIOLATION]

# workflow-core.md
- 禁止跳步，违反标 [PROCESS_VIOLATION]

# AGENTS.md
- 禁止跳步，违反标 [PROCESS_VIOLATION]
```

**正确示例**：
```markdown
# SOUL.md（唯一来源）
- 禁止跳步 → [PROCESS_VIOLATION]

# 其他文件
- 见 SOUL.md「流程强制基线」
```

### 3. 上层覆盖下层

经验加载时，上层记忆覆盖下层规则，不盲目服从旧规则：

```
用户记忆(memory user) > 项目技能(project-knowledge) > 通用经验(patterns) > 规则基线(coding/orchestration)
```

### 4. 全自动，零询问

经验回写、周期审计、规则冲突标记，全部自动执行，不打扰用户。

---

## 四、三层架构

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  L1 记忆层（自动进化）                                        │
│  ├─ memory(user)          → 用户偏好、纠正                   │
│  ├─ skills/project-knowledge/ → 项目约定（自动提取）         │
│  ├─ skills/patterns/      → 可复用最佳实践                   │
│  └─ skills/anti-patterns/ → 错误模式                         │
├─────────────────────────────────────────────────────────────┤
│  L2 规则层（手动维护，精简）                                   │
│  ├─ SOUL.md               → 核心身份 + T0-T3 + 自进化契约     │
│  ├─ .hermes.md            → 锚点规则 + 检查点 + gitnexus     │
│  ├─ config.yaml           → 模型 + MCP 配置                  │
│  └─ skills/orchestration/ → 编码自检清单（建议而非强制）      │
├─────────────────────────────────────────────────────────────┤
│  L3 编码层（单次任务）                                        │
│  ├─ skills/coding/        → 文件操作、搜索、验证门禁         │
│  ├─ skills/workflow/      → 自进化触发 + 经验回路            │
│  └─ skills/multi-phase-coding/ → 复杂任务 ensemble          │
└─────────────────────────────────────────────────────────────┘
```

### 各层职责

| 层级 | 维护方式 | 更新频率 | 触发写入 |
|------|----------|----------|----------|
| L1 记忆层 | `memory()` + `skill_manage()` | 每次任务后 | 全自动 |
| L2 规则层 | `patch` / `write_file` | 手动，月度审计 | 人工决策 |
| L3 编码层 | `skill_manage()` | 发现新工具/新坑时 | 半自动 |

---

## 五、全自动经验回路（核心机制）

### 触发条件

**无条件触发**：每次编码任务结束后（成功/失败/用户纠正均触发）。

**常规触发**：
1. checker/reviewer FAIL 且为方法层/需求层错误
2. fixer 连续 2 轮同症状
3. 用户反馈"还是有问题/不对/遗漏"
4. Circuit Breaker 触发（连续 3 次无法收敛）

### 经验提取（自动）

```
任务完成 / 失败 / 用户纠正
        ↓
    ┌──────────────────────────┐
    │  1. 关键决策：为什么选 A 而非 B  │
    │  2. 边界教训：参数为 null 会怎样  │
    │  3. 用户纠正：用户说"不要..."    │
    │  4. 验证教训：测试覆盖了 X 没覆盖 Y │
    └──────────────────────────┘
        ↓
    ┌──────────────────────────┐
    │  自动路由（不询问）：       │
    │  用户偏好 → memory(user)   │
    │  项目约定 → project-knowledge│
    │  可复用模式 → patterns      │
    │  应当避免 → anti-patterns   │
    │  规则冲突 → [RULE_CONFLICT] │
    └──────────────────────────┘
```

### 写入前验证（自动）

1. 不可编造未发生的经验
2. 不可与现有规则冲突（冲突时标记 `[RULE_CONFLICT]`，保留新旧规则同时存在）
3. 必须带上下文（什么场景、什么结果）

---

## 六、三个可选路径

### 路径 A：激进精简（推荐）

**动作**：
1. 删除 `kilo_config/` 整个目录（或移入 `.kilo-archive/`）
2. `hermes_config/` 成为唯一活跃配置
3. 提交当前 staged 的 SOUL.md + .hermes.md 修改
4. 清空 staging area 中所有 kilo 文件

**优点**：
- 单一来源，无混淆
- 配置总量可控在 1,330 行
- 维护成本低

**风险**：
- Kilo 历史配置丢失（已备份到 `.kilo-archive/` 可缓解）

### 路径 B：保守并存

**动作**：
1. 保留 `kilo_config/` 作为参考
2. 在 README 中明确标注"Kilo 配置已归档，不再维护"
3. 仅维护 `hermes_config/`

**优点**：
- 历史可追溯
- 可对比两种方案效果

**风险**：
- 仓库混乱
- 新贡献者分不清哪个是"真的"

### 路径 C：混合运行时（不推荐）

**动作**：
- 试图让 Hermes 调用 Kilo 运行时

**风险**：
- 两套系统冲突
- 上下文互相覆盖
- 调试地狱

---

## 七、推荐路径：激进精简 + 执行清单

### Step 1：归档 Kilo 历史（立即）

```bash
cd /e/AI/agent/kilo_config

# 创建归档目录
mkdir -p .kilo-archive

# 移动 kilo 配置（保留历史）
git rm -r kilo_config/
mv kilo_config .kilo-archive/ 2>/dev/null || true

# 如 .kilo-archive/ 已存在备份，直接删除旧目录
rm -rf kilo_config/

# 更新 .gitignore
echo "kilo_config/" >> .gitignore
echo ".kilo-archive/" >> .gitignore
```

### Step 2：提交当前 Hermes 配置（立即）

```bash
# 只保留 Hermes 相关修改
git reset HEAD kilo_config/ 2>/dev/null || true
git checkout -- kilo_config/ 2>/dev/null || true

# 确认 staged 只有 Hermes 文件
git status --short

# 提交
git add hermes_config/
git commit -m "refactor(config): 精简为 Hermes 单配置 + 全自动自进化

- 删除 kilo 纸面编排，保留规则精华到 skills
- SOUL.md 新增自进化契约（全自动经验回路）
- .hermes.md 删除子代理表格，新增无条件触发回写
- workflow skill 升级：每次任务结束自动提取经验
- 新建 project-knowledge skill：项目专属知识容器
- orchestration skill 精简 70%：自检清单替代强制格式
- 配置总量控制：1,330 行"
```

### Step 3：验证全局同步（立即）

```bash
# 确认 Hermes 读取的是最新配置
ls -la "$LOCALAPPDATA/hermes/SOUL.md"
ls -la "$LOCALAPPDATA/hermes/.hermes.md"
ls -la "$LOCALAPPDATA/hermes/config.yaml"
ls -la "$LOCALAPPDATA/hermes/skills/"

# 确认行数
cd /e/AI/agent/kilo_config
wc -l hermes_config/SOUL.md hermes_config/.hermes.md hermes_config/config.yaml hermes_config/skills/*/SKILL.md
```

### Step 4：首次任务验证（下次编码时）

执行一个 T1 级别任务，观察：
1. 是否自动输出 T0-T3 定级结论
2. 是否自动执行编码前检查点（search_files ×2）
3. 任务结束后是否自动触发经验回写（查看 memory 和 skills 是否有新增）
4. 是否没有 `[PROCESS_VIOLATION]` 或 `[CHECKPOINT_MISSED]`

### Step 5：周期审计（每周一自动）

已创建 cron job `weekly-evolution-audit`，每周一 9:00 自动执行：
- 扫描 `[RULE_CONFLICT]` 标记
- 检查 skills 文件大小
- 标记过时条目

查看审计结果：
```bash
hermes cron list
# 或查看保存的输出
```

---

## 八、长期维护规则

### 8.1 新增规则的红线

| 检查项 | 标准 |
|--------|------|
| 总行数 | < 1,500 |
| 新增规则 | 必须同时删除等量旧规则 |
| 重复规则 | 同一字面句不在 >1 文件出现 |
| 装饰性文本 | 删除 `>` 引用、`---` 分隔线、详细示例 |
| 伪功能规则 | 删除不能被 Hermes 工具执行的规则 |

### 8.2 经验回写规范

| 经验类型 | 写入目标 | 触发条件 |
|----------|----------|----------|
| 用户偏好 | `memory(target='user')` | 用户说"不要..."/"换成..." |
| 项目约定 | `skills/project-knowledge/` | 本项目特有 API/数据/工具链约定 |
| 可复用模式 | `skills/patterns/` | 连续 3 次成功且用户无纠正 |
| 错误模式 | `skills/anti-patterns/` | 导致 bug 或验证失败 |
| 规则冲突 | `[RULE_CONFLICT]` 标记 | 新经验与现有规则矛盾 |

### 8.3 禁止事项

1. **禁止编造未验证的经验**：必须是真实任务中发生过的
2. **禁止把项目规则写入个人运行时数据**：SQLite、logs、sessions 中不应出现项目级规则
3. **禁止在 Hermes 中复现 Kilo 子代理架构**：`coderAgent` → `engineer` → `checker` 的纸面委派不可执行
4. **禁止全量格式化无关文件**：用户要求"按需修改"时，只改必要文件
5. **禁止新增远程 MCP**：如 context7、commit_message 等不可控依赖

---

## 九、验收标准

| 标准 | 验证方式 | 状态 |
|------|----------|------|
| 配置总量 < 1,500 行 | `wc -l hermes_config/**/*` | ✅ 1,330 行 |
| 无重复规则 | `grep -r "禁止跳步" hermes_config/` 只命中 1 处 | 待验证 |
| 全局配置已同步 | `diff hermes_config/SOUL.md "$LOCALAPPDATA/hermes/SOUL.md"` | ✅ 已同步 |
| 经验回写自动触发 | 下次任务结束后检查 memory/skills | 待验证 |
| 周期审计已配置 | `hermes cron list` 显示 weekly-evolution-audit | ✅ 已配置 |
| Kilo 配置已归档 | `ls kilo_config/` 返回不存在 | 待执行 |

---

## 十、附录：文件映射表

| Kilo 原文件 | 活化后归宿 | 处理方式 |
|-------------|-----------|----------|
| `core.md` | SOUL.md + .hermes.md | 规则融入，文件废弃 |
| `workflow-core.md` | skills/orchestration/ | 精简为自检清单 |
| `security-checklist.md` | skills/coding/ | 检测项融入验证章节 |
| `reflection.md` | skills/workflow/ | 三层判定 + 经验回路 |
| `output-schema.md` | skills/orchestration/ | 格式要求改为建议 |
| `skills-lifecycle.md` | skills/workflow/ | 自进化触发规则 |
| `agent/engineer.md` | skills/orchestration/ | 输出格式→自检清单 |
| `agent/checker.md` | skills/orchestration/ | L1-L3 验证→自检清单 |
| `agent/reviewer.md` | skills/orchestration/ | 三视角→自检清单 |
| `agent/architect.md` | skills/orchestration/ | 规划要求→T2 额外检查 |
| `agent/fixer.md` | skills/orchestration/ | 修复规则→自检清单 |
| `agent/pre-checker.md` | skills/orchestration/ | 预审要求→编码前检查点 |
| `agent/ensemble.md` | skills/multi-phase-coding/ | ensemble 逻辑保留 |
| `agent/executor-*.md` | **废弃** | 纸面子代理，无运行时 |
| `agent/synthesizer.md` | **废弃** | 纸面子代理，无运行时 |
| `kilo.json` | **废弃** | 模型配置由 config.yaml 覆盖 |
| `.kilo/memory/` | **废弃** | 改用 `memory()` 工具 |
| `.kilo/skills/*` | skills/patterns/ + skills/anti-patterns/ | 迁移为通用经验 |

---

> 本方案遵循"少即是多"原则。每新增一行规则，必须同时删除一行旧规则。
> 经验的价值不在于记录多少，而在于下次任务时能否自动加载并避免重复踩坑。
