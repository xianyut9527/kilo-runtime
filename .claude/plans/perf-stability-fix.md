# 修复计划：高性能 + 稳定可靠运行

## 已确认决策
- 模型绑定：保持 deepseek-v4-flash（model-registry.md L94-104 已固化决策理由）
- review_mode：config.yaml T1 改 fast（对齐实际行为）
- runtime 横切层：T1 默认关闭（T0 已跳过，扩展到 T1）

## 举一反三的修正
- A1 config.agents **不删**：lifecycle-doctor/runtime.mjs L110-131 仍校验它存在+一致。从"删死字段"修正为"文档对齐"。
- C2 model-registry.md 已记录锁定，kilo.json 已一致，仅需确保后续不横跳。

---

## 批次 1：热路径接入缓存层（最高收益，零语义变更）

把已有的 `scripts/lib/derived-cache.mjs`（cachedDerive，mtime 失效，进程间缓存）接入 3 个未接入的热路径脚本。对齐 transition-check/task-context 已有模式。

### 1.1 capability-registry.mjs（B1）
- [L51-62](lifecycle/runtime/capability-registry.mjs#L51) `loadModels()` 包 `cachedDerive('kiloModels', [KILO_JSON_PATH], () => {...})`
- 注释自述 "Reads kilo.json on every call (no cache)" → 改为缓存
- import 路径：从 lifecycle/runtime/ 出发 `../../scripts/lib/derived-cache.mjs`
- merged map 是 plain object，JSON 可序列化，符合 cachedDerive 要求

### 1.2 runtime/index.mjs（B2）
- [L176-194](lifecycle/runtime/index.mjs#L176) `selectForDispatch` 的 readFileSync+JSON.parse 包缓存
- 复用 1.1 的 'kiloModels' key + 加 'kiloSmallModel' key（或合并为 'kiloCfg' 缓存 parsed cfg）
- 消除每次 dispatch 的 kilo.json 读取

### 1.3 agent-timeout-guard.mjs（B3）
- [L161-170](scripts/agent-timeout-guard.mjs#L161) `readTimeouts()` 包 `cachedDerive('configTimeouts', [CONFIG_SOURCE], () => {...})`
- import `./lib/derived-cache.mjs`（同 scripts/ 下，与 transition-check 同模式）
- parseTimeouts 返回 plain object，可缓存

**验证**：`node --check` 三个文件 + 手动跑 `node -e "import('lifecycle/runtime/index.mjs')..."` 确认缓存命中

---

## 批次 2：删死配置 + 文档对齐（低风险）

### 2.1 删 session_strategy（A4，0 消费者）
- [config.yaml:153-155](lifecycle/config.yaml#L153) 删 `custom_overrides.session_strategy`（Grep 仅此一处，无脚本读取）

### 2.2 overrides 三空段（A3）
- [config.yaml:135-146](lifecycle/config.yaml#L135) 保留（扩展点），加注释说明"预留，当前空"

### 2.3 review_mode T1 改 fast（C1）
- [config.yaml:59](lifecycle/config.yaml#L59) `review_mode: full` → `review_mode: fast`
- 对齐 workflow-detail.md §C.1（T1=fast）和实际行为（reviewer 靠 tiers:[T2] 不在 T1 加载）

### 2.4 config.agents 文档对齐（A1 修正）
- 保留字段（doctor 校验依赖）
- 清理文档"config.agents 驱动挂载"过时描述（已由 tiers 接管）：
  - [configuration-guide.md:404,438-466](docs/configuration-guide.md#L404) 标注"config.agents 现仅为 doctor 一致性校验对象，挂载由 tiers 决定"
  - [agent-mount-guide.md:157-171](docs/agent-mount-guide.md#L157) 同步

### 2.5 docs 示例模型名（C3）
- [ARCHITECTURE.md:183](docs/ARCHITECTURE.md#L183) 示例 `kimi-k2.6` 标注为示例或对齐实际
- model-registry.md 已一致，无需改

---

## 批次 3：横切层 T1 默认关闭（中风险，需改 conductor 铁律）

### 3.1 conductor.md 6a 调整
- [conductor.md:90-93](agent/conductor.md#L90) 铁律 6a：T0 跳过 runtime → 扩展为 **T0/T1 跳过**
- T1+ 改为 "T2 才调 selectForDispatch"
- early_exit 随横切层关闭，6a 删除"early_exit 仅记日志"段（纯日志无价值）
- description 同步（经 sync-agent-prompt 写入 kilo.json）

### 3.2 风险控制
- T2 保留横切层（未来可激活 quality 模式动态升模型）
- balanced 默认下横切层对 T2 也基本 no-change，但保留检测能力供未来

**验证**：`sync-agent-prompt --check` drift=0

---

## 批次 4：验证重复 + 注入瘦身（中风险，列为后续，本计划不实施）

### 4.1 scan-encoding 增量化（D1）
- scan-encoding.mjs 加 `--since <commit>` 模式
- verifier 只扫 coder 自检后的增量（coder 自检 PASS 的全量结果复用）

### 4.2 output-schema 按角色拆分（E1）
- output-schema.md 384 行，标记检测表只注入给 verifier/reviewer
- coder 只注入返回契约 + 证据契约部分

---

## 全局验证清单
1. `node --check` 所有改过的 .mjs 脚本
2. `node scripts/lifecycle-doctor/index.mjs` 全 PASS（0 FAIL）
3. `node scripts/sync-agent-prompt.mjs --check` drift=0
4. 手动确认 cachedDerive 缓存命中（第二次调用 <10ms）
5. git diff 确认无意外改动

## 风险评估
- 批次 1：零风险（缓存层 fail-safe，异常降级为直接派生）
- 批次 2：低风险（配置/文档对齐，doctor 校验不变）
- 批次 3：中风险（改 conductor 铁律，需确保 sync 一致）
- 不碰：coder 读写权限、模型绑定、task_context schema
