#!/usr/bin/env node
// task-context.mjs
// task_context.json 读写 CLI — task_context 读写的运行时机械强制。
//
// 写权限矩阵（WRITE_MATRIX）：启动时扫描 agent/*.md frontmatter 的
// task_context.write 自动派生——单一真相在各智能体 frontmatter，
// 新增智能体丢文件即获得自声明写权限，零改本脚本。
// conductor 矩阵表（agent/conductor.md §task_context 共享机制）仅为人类速查，
// drift 由 scripts/lifecycle-doctor.mjs 校验。
//
// 安全硬门保留硬编码（框架级安全不变量，显式、稳定、不随 frontmatter 派生）：
//   硬门 1：verification.forward / execution.verification 仅 verifier 可写
//   硬门 2：quality.round 仅 conductor 可写（v2 响应式 Hooks，替代旧 convergence.total_rounds）
// 即使某智能体自声明 write 包含上述字段，硬门仍会拒绝（fail-closed）。
//
// 用法：
//   node scripts/task-context.mjs init <task_id>
//   node scripts/task-context.mjs get <task_id> <dot.path>
//   node scripts/task-context.mjs set <task_id> <dot.path> <json-value> --agent <name>
//   node scripts/task-context.mjs validate <task_id>
//   node scripts/task-context.mjs assert <task_id> <assertion-type> [args...]
//   node scripts/task-context.mjs size-check <task_id>          pre-dispatch 安全门：task_context 字符数 > 阈值 → exit 2
//   node scripts/task-context.mjs log-dispatch <task_id> --agent <name> --mode <task|agent_manager> --stage <STAGE>
//   node scripts/task-context.mjs --help
//
// assert 子命令（运行时状态断言，供 conductor compaction 恢复后自检）：
//   assert <task_id> current-stage <NODE>     断言 current_stage == <NODE>
//   assert <task_id> tier <T0|T1|T2|T3>       断言 sizing.tier == <TIER>
//   assert <task_id> quality                   断言 quality 计数合法未熔断（v2 主图）
//   assert <task_id> convergence              断言 mm_fusion 计数合法未熔断（子图，向后兼容别名）
//   assert <task_id> gate <GATE_NAME>          断言 gate 条件满足
//   assert <task_id> not-written <dot.path>    断言某字段未被写入（反自验辅助）
//   exit 0=断言成立，1=断言失败（含具体差异），2=参数错误
//
// 文件位置：os.tmpdir()/kilo/task_context_<task_id>.json
//
// 退出码：
//   0 = 成功
//   1 = 业务/权限拒绝（[TRUST_TRANSFER] / [PROCESS_VIOLATION] / 校验失败 / 文件不存在）
//   2 = 参数错误
//
// 仅使用 Node 内置模块：node:fs / node:path / node:os / node:process / node:url
// 跨平台：Windows PowerShell 5.1 + Linux bash 兼容

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readContext, writeContext, appendTransitionLog, contextPath, buildInitialContext,
         VALID_STATUSES, VERIFICATION_FIELDS, QUALITY_ROUND_FIELD, CURRENT_STAGE_FIELD,
         TOTAL_ROUNDS_FIELD, readHooksFromConfig, readConvergenceFromConfig, readTierDefaults,
         readSizeCheckThreshold,
         assertValidTaskId, getByPath, setByPath, pathAllowedBy, pathPrefix, parseValue,
         extractFrontmatter, die } from './task-context-runtime.mjs';

// 脚本所在目录（ESM 无 __dirname）
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 写权限矩阵（v6.2 派生化：启动时扫描 agent/*.md frontmatter
// task_context.write 自动聚合——单一真相在各智能体 frontmatter，
// 新增智能体丢文件即获得自声明写权限，零改本脚本）
//
// 路径匹配规则：dot path = pattern 时允许；dot path 以 pattern + "." 或
// pattern + "[" 开头时也允许（如 execution.diffs[current_unit] 匹配
// execution.diffs）。这覆盖了 matrix 中声明的字段及其子字段。
// ============================================================

const AGENT_DIR = path.resolve(__dirname, '..', 'agent');

// 在 frontmatter 块内提取 task_context.write 列表。
// 支持行内数组（write: [a, b]）与多行列表（write:\n  - a\n  - b）两种 YAML 子集。
// task_context 段结束于下一个顶层键（无缩进的非注释行）或块尾。
function extractTaskContextWrite(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  let inTaskContext = false;
  let inWrite = false;
  const items = [];
  for (const line of lines) {
    // 顶层键（无缩进、非空、非注释）：task_context: 开始，或其他顶层键（段结束）
    if (/^[^\s#]/.test(line)) {
      if (inTaskContext) break;
      inTaskContext = /^task_context\s*:/.test(line);
      continue;
    }
    if (!inTaskContext) continue;
    // write 字段（缩进）：行内数组形式
    const inline = line.match(/^\s+write\s*:\s*\[(.*)\]\s*(?:#.*)?$/);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const v = part.trim();
        if (v) items.push(v);
      }
      inWrite = false;
      continue;
    }
    // write 字段：多行列表形式起始
    if (/^\s+write\s*:\s*$/.test(line)) {
      inWrite = true;
      continue;
    }
    if (inWrite) {
      const li = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
      if (li) {
        items.push(li[1]);
        continue;
      }
      inWrite = false; // write 列表结束（task_context 段内其他键）
    }
  }
  return items;
}

function deriveWriteMatrix() {
  const matrix = {};
  let files;
  try {
    files = fs.readdirSync(AGENT_DIR);
  } catch {
    // 降级：agent 目录不存在 → 空矩阵（fail-closed，全部拒写）
    return Object.freeze(matrix);
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -'.md'.length);
    let text;
    try {
      text = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
    } catch {
      continue;
    }
    const fm = extractFrontmatter(text);
    if (!fm) continue;
    const writes = extractTaskContextWrite(fm);
    if (writes.length > 0) matrix[name] = writes;
  }
  return Object.freeze(matrix);
}

const WRITE_MATRIX = deriveWriteMatrix();

// 编译期校验：派生矩阵中 conductor 必须包含关键字段；如 frontmatter 被破坏则启动即报错，fail-closed
const REQUIRED_CONDUCTOR_FIELDS = [
  'current_stage',
  'intent',
  'sizing',
  'status',
];
if (!Array.isArray(WRITE_MATRIX.conductor)) {
  throw new Error('invariant: WRITE_MATRIX.conductor must be an array (derived from agent/conductor.md frontmatter task_context.write)');
}
for (const f of REQUIRED_CONDUCTOR_FIELDS) {
  if (!WRITE_MATRIX.conductor.includes(f)) {
    throw new Error(`invariant: WRITE_MATRIX.conductor must include "${f}" (derived from agent/conductor.md frontmatter task_context.write)`);
  }
}

// ============================================================
// 工具
// ============================================================

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/task-context.mjs init <task_id>',
    '  node scripts/task-context.mjs get <task_id> <dot.path>',
    "  node scripts/task-context.mjs set <task_id> <dot.path> <json-value> --agent <name>",
    "  node scripts/task-context.mjs set <task_id> --batch '<json-object>' --agent <name>",
    '  node scripts/task-context.mjs apply-tier <task_id> <T0|T1|T2> --agent conductor',
    '  node scripts/task-context.mjs validate <task_id>',
    '  node scripts/task-context.mjs assert <task_id> <type> [args...]',
    '  node scripts/task-context.mjs size-check <task_id>',
    "  node scripts/task-context.mjs log-dispatch <task_id> --agent <name> --mode <task|agent_manager> --stage <STAGE>",
    '',
    'Assert types:',
    '  current-stage <NODE>   Assert current_stage == NODE',
    "  tier <T0|T1|T2>     Assert sizing.tier == TIER",
    '  quality                Assert quality counters valid & not tripped',
    '  convergence            Assert mm_fusion counters valid & not tripped (alias/backward compat)',
    '  gate <GATE_NAME>       Assert gate condition met',
    '  not-written <dot.path> Assert field is unset (anti-self-verify aid)',
    '  node scripts/task-context.mjs --help',
    '',
    'Subcommands:',
    '  init        Create task_context_<task_id>.json under os.tmpdir()/kilo/.',
    '  get         Print value at dot.path (JSON).',
    '  set         Write JSON value to dot.path. Enforces write matrix.',
    '  apply-tier  Apply config.yaml tier_defaults to config.agents + review_mode (INIT helper).',
    '  validate    Check required top-level fields, quality integers, and convergence mm_fusion integers.',
    '  size-check  Print task_context file character count (pre-dispatch safety gate vs config.size_check_threshold; exit=2 if exceeded).',
    "  log-dispatch Append {agent, mode, stage, timestamp} to dispatch_log[] (provenance gate). --agent must be in write-matrix agent set; --stage must be a graph.yaml node. Whitelist-enforced.",
    '',
    'Agents in write matrix: ' + Object.keys(WRITE_MATRIX).join(', '),
    '',
    'Exit codes: 0=ok, 1=rejected/fail, 2=usage error',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

// 解析 --agent 参数（可能在任意位置）
function parseAgent(args) {
  const idx = args.indexOf('--agent');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// ============================================================
// 子命令
// ============================================================

function cmdInit(taskId) {
  assertValidTaskId(taskId);
  const p = contextPath(taskId);
  const tmpdir = path.resolve(os.tmpdir(), 'kilo');
  let files = [];
  try {
    files = fs.readdirSync(tmpdir);
  } catch {
    files = [];
  }

  // GC 策略：
  //   initialized 状态超过 24h → 清理（遗留的空壳）
  //   DONE / FAILED 状态超过 7 天 → 清理（已完成的历史任务）
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const GC_EXPIRY = {
    initialized: ONE_DAY_MS,
    DONE: SEVEN_DAYS_MS,
    FAILED: SEVEN_DAYS_MS,
  };
  for (const file of files) {
    if (!file.startsWith('task_context_') || !file.endsWith('.json')) continue;
    const filePath = path.join(tmpdir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const otherCtx = JSON.parse(raw);
      const status = otherCtx.status;
      const expiry = GC_EXPIRY[status];
      if (expiry === undefined) continue; // RUNNING / PAUSED / DEGRADED 不清理
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > expiry) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // 删除失败不阻塞
        }
      }
    } catch {
      // 解析失败或异常：跳过，不阻塞
    }
  }

  if (fs.existsSync(p)) {
    process.stdout.write(`already exists: task_id=${taskId}\n`);
    process.exit(0);
  }
  const ctx = buildInitialContext(taskId);
  writeContext(taskId, ctx);
  process.stdout.write(`created: task_id=${taskId}\n`);
  process.exit(0);
}

function cmdGet(taskId, dotPath) {
  assertValidTaskId(taskId);
  const { ctx } = readContext(taskId);
  const v = getByPath(ctx, dotPath);
  if (v === undefined) {
    process.stdout.write('null\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(v) + '\n');
  process.exit(0);
}

function validateSingleWrite(agent, dotPath, value) {
  // 硬门 3：--agent 必须存在且在矩阵名单
  if (!agent) {
    return { allowed: false, code: 2, message: 'Error: --agent <name> is required for set' };
  }
  if (!Object.prototype.hasOwnProperty.call(WRITE_MATRIX, agent)) {
    return {
      allowed: false,
      code: 1,
      message: `Error: agent "${agent}" is not in the write matrix. Allowed: ${Object.keys(WRITE_MATRIX).join(', ')}`,
    };
  }

  // 硬门 1：verification 硬门 — 非 verifier 一律拒绝
  if (VERIFICATION_FIELDS.some((f) => pathAllowedBy(dotPath, f))) {
    if (agent !== 'verifier') {
      return {
        allowed: false,
        code: 1,
        message: `[TRUST_TRANSFER] agent "${agent}" is not allowed to write "${dotPath}". verification.forward and execution.verification are reserved for verifier only.`,
      };
    }
  }

  // 硬门 2：quality.round / current_stage 仅 conductor 可写
  if (pathAllowedBy(dotPath, QUALITY_ROUND_FIELD) || pathAllowedBy(dotPath, CURRENT_STAGE_FIELD)) {
    if (agent !== 'conductor') {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] agent "${agent}" is not allowed to write "${dotPath}". quality.round and current_stage are reserved for conductor only.`,
      };
    }
  }

  // 枚举硬门：sizing.tier 必须合法，intent.intent_type 必须合法，current_stage 必须非空字符串
  if (dotPath === 'sizing.tier') {
    const validTiers = ['T0', 'T1', 'T2'];
    if (!validTiers.includes(value)) {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] invalid tier "${value}". tier must be one of: ${validTiers.join(', ')}`,
      };
    }
  }
  if (dotPath === 'intent.intent_type') {
    const validIntents = ['INQUIRY', 'EXECUTION'];
    if (!validIntents.includes(value)) {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] invalid intent_type "${value}". intent_type must be one of: ${validIntents.join(', ')}`,
      };
    }
  }
  if (dotPath === 'current_stage') {
    if (typeof value !== 'string' || value.length === 0) {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] invalid current_stage "${value}". current_stage must be a non-empty string`,
      };
    }
  }

  // status schema 校验：仅 conductor 可写，且值必须在合法集合中
  if (dotPath === 'status') {
    if (!VALID_STATUSES.includes(value)) {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] invalid status "${value}". status must be one of: ${VALID_STATUSES.join(', ')}`,
      };
    }
  }

  // config.agents 值类型校验：整体写入时所有值必须为布尔；单键写入时值必须为布尔
  if (dotPath === 'config.agents') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] config.agents must be an object of boolean switches, got ${Array.isArray(value) ? 'array' : typeof value}`,
      };
    }
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'boolean') {
        return {
          allowed: false,
          code: 1,
          message: `[PROCESS_VIOLATION] config.agents.${k} must be boolean, got ${typeof v} ("${v}")`,
        };
      }
    }
  }
  if (dotPath.startsWith('config.agents.') && !dotPath.includes('[', 14)) {
    // 单键写入 config.agents.<key>：值必须为布尔
    if (typeof value !== 'boolean') {
      return {
        allowed: false,
        code: 1,
        message: `[PROCESS_VIOLATION] ${dotPath} must be boolean, got ${typeof value} ("${value}")`,
      };
    }
  }

  // 矩阵字段匹配
  const allowedPatterns = WRITE_MATRIX[agent];
  const allowed = allowedPatterns.some((p) => pathAllowedBy(dotPath, p));
  if (!allowed) {
    return {
      allowed: false,
      code: 1,
      message: `Error: agent "${agent}" cannot write "${dotPath}". Allowed paths: ${allowedPatterns.join(', ')}`,
    };
  }

  return { allowed: true, code: 0, message: '' };
}

function cmdSet(taskId, dotPath, rawValue, agent) {
  assertValidTaskId(taskId);
  const value = parseValue(rawValue);
  const result = validateSingleWrite(agent, dotPath, value);
  if (!result.allowed) {
    die(result.code, result.message);
  }
  const { ctx } = readContext(taskId);
  setByPath(ctx, dotPath, value);
  writeContext(taskId, ctx);
  process.stdout.write(`ok: set ${dotPath}\n`);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (e) => reject(e));
  });
}

function cmdSetBatch(taskId, batchInput, agent) {
  assertValidTaskId(taskId);

  let rawBatch;
  if (batchInput === '-') {
    rawBatch = fs.readFileSync(0, 'utf8');
  } else {
    rawBatch = batchInput;
  }

  let batch;
  try {
    batch = JSON.parse(rawBatch);
  } catch (e) {
    die(2, `Error: --batch value is not valid JSON: ${e.message}`);
  }
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    die(2, 'Error: --batch JSON must be an object mapping dot paths to values');
  }

  const entries = Object.entries(batch);

  // 第一阶段：预校验所有路径，任一失败则整体拒绝（fail-closed，无部分写入）
  for (const [dotPath, value] of entries) {
    const result = validateSingleWrite(agent, dotPath, value);
    if (!result.allowed) {
      die(result.code, `Batch rejected at "${dotPath}": ${result.message}`);
    }
  }

  // 第二阶段：单次读取，全部写入内存，原子写回
  const { ctx } = readContext(taskId);
  for (const [dotPath, value] of entries) {
    setByPath(ctx, dotPath, value);
  }
  writeContext(taskId, ctx);
  process.stdout.write(`ok: batch set ${entries.length} path(s)\n`);
  process.exit(0);
}

// ============================================================
// apply-tier: INIT 阶段机械应用 config.yaml tier_defaults
// 消除"conductor 手工 set config.agents 容易漏写/写错"的根因。
// 读 config.yaml tier_defaults[tier]（或 inquiry_tier_defaults[tier]），
// 原子写入 config.agents + config.review_mode。
// 覆盖 config.agents 整体（非增量），保证与 config.yaml 单一真相一致。
// ============================================================
function cmdApplyTier(taskId, tier, agent, opts) {
  assertValidTaskId(taskId);
  if (tier === 'T3') {
    die(1, `[PROCESS_VIOLATION] T3 已移除，仅支持 T0/T1/T2。apply-tier 接收到了 tier="${tier}"`);
  }
  if (!['T0', 'T1', 'T2'].includes(tier)) {
    die(2, `Error: apply-tier requires <T0|T1|T2>, got "${tier}"`);
  }
  if (agent !== 'conductor') {
    die(1, `[PROCESS_VIOLATION] apply-tier is conductor-only (got --agent "${agent}")`);
  }

  const allTiers = readTierDefaults();
  const tierMap = allTiers.execution;
  if (!tierMap || !tierMap[tier]) {
    die(1, `Error: config.yaml tier_defaults missing tier "${tier}"`);
  }

  const entry = tierMap[tier];
  const agentsValue = entry.agents || {};
  const reviewMode = entry.review_mode || 'none';

  // 复用 validateSingleWrite 做硬门校验（config.agents 布尔 + conductor 有权写 config）
  const agentsCheck = validateSingleWrite(agent, 'config.agents', agentsValue);
  if (!agentsCheck.allowed) {
    die(agentsCheck.code, `apply-tier: ${agentsCheck.message}`);
  }
  const rmCheck = validateSingleWrite(agent, 'config.review_mode', reviewMode);
  if (!rmCheck.allowed) {
    die(rmCheck.code, `apply-tier: ${rmCheck.message}`);
  }

  // 原子写入：读 → 改 → 写
  const { ctx } = readContext(taskId);
  // config.agents 整体覆盖（保证与 config.yaml 一致，清除残留的脏开关）
  ctx.config = ctx.config || {};
  ctx.config.agents = agentsValue;
  ctx.config.review_mode = reviewMode;
  writeContext(taskId, ctx);

  process.stdout.write(
    `ok: apply-tier ${tier} → config.agents=${JSON.stringify(agentsValue)} review_mode=${reviewMode}\n`
  );
  process.exit(0);
}

function cmdValidate(taskId) {
  assertValidTaskId(taskId);
  const { ctx, path: p } = readContext(taskId);
  const checks = [];
  const required = [
    'task_id',
    'intent',
    'sizing',
    'config',
    'plan',
    'plan_review',
    'execution',
    'verification',
    'quality',
    'fixing_history',
    'status',
    'convergence',
  ];
  for (const k of required) {
    checks.push({
      name: `top-level.${k}`,
      pass: Object.prototype.hasOwnProperty.call(ctx, k),
      detail: Object.prototype.hasOwnProperty.call(ctx, k)
        ? ''
        : `missing top-level field "${k}"`,
    });
  }
  // quality 数值字段非负整数
  const q = ctx.quality || {};
  for (const f of ['round', 'max_rounds']) {
    const v = q[f];
    const ok = typeof v === 'number' && Number.isInteger(v) && v >= 0;
    checks.push({
      name: `quality.${f}`,
      pass: ok,
      detail: ok ? '' : `expected non-negative integer, got ${JSON.stringify(v)}`,
    });
  }
  // critical 字段：intent_type / tier / current_stage 必须已写入且合法
  const intentType = ctx.intent && ctx.intent.intent_type;
  const tier = ctx.sizing && ctx.sizing.tier;
  const currentStage = ctx.current_stage;
  checks.push({
    name: 'critical.intent_type',
    pass: intentType === 'INQUIRY' || intentType === 'EXECUTION',
    detail: `intent.intent_type=${JSON.stringify(intentType)}`,
  });
  checks.push({
    name: 'critical.tier',
    pass: ['T0', 'T1', 'T2'].includes(tier),
    detail: `sizing.tier=${JSON.stringify(tier)}`,
  });
  checks.push({
    name: 'critical.current_stage',
    pass: typeof currentStage === 'string' && currentStage.length > 0,
    detail: `current_stage=${JSON.stringify(currentStage)}`,
  });
  // convergence 数值字段非负整数（v2 仅 mm_fusion 计数）
  const conv = ctx.convergence || {};
  for (const f of ['mm_fusion_rounds', 'mm_fusion_max_rounds']) {
    const v = conv[f];
    const ok = typeof v === 'number' && Number.isInteger(v) && v >= 0;
    checks.push({
      name: `convergence.${f}`,
      pass: ok,
      detail: ok ? '' : `expected non-negative integer, got ${JSON.stringify(v)}`,
    });
  }
  let hasFail = false;
  for (const c of checks) {
    process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}\n`);
    if (!c.pass) hasFail = true;
  }
  if (hasFail) {
    process.stderr.write(`validation failed: task_id=${taskId}\n`);
    process.exit(1);
  }
  process.stdout.write(`validation passed: task_id=${taskId}\n`);
  process.exit(0);
}

// ============================================================
// assert 子命令：运行时状态断言（供 conductor compaction 恢复后自检）
// 设计原则：注册式断言函数，新增断言只往 ASSERTIONS push 一项，零改其他代码。
// 每个断言函数签名: (ctx, args) => { pass: boolean, detail: string }
// ============================================================

const ASSERTIONS = {
  // 断言 current_stage == <NODE>
  'current-stage': (ctx, args) => {
    const expected = args[0];
    if (!expected) return { pass: false, detail: 'usage: assert <task_id> current-stage <NODE>' };
    const actual = ctx.current_stage;
    return actual === expected
      ? { pass: true, detail: `current_stage=${actual}` }
      : { pass: false, detail: `current_stage="${actual ?? '(未设置)'}" ≠ expected="${expected}"` };
  },

  // 断言 sizing.tier == <TIER>
  'tier': (ctx, args) => {
    const expected = args[0];
    if (!expected) return { pass: false, detail: 'usage: assert <task_id> tier <T0|T1|T2|T3>' };
    const actual = ctx.sizing && ctx.sizing.tier;
    return actual === expected
      ? { pass: true, detail: `sizing.tier=${actual}` }
      : { pass: false, detail: `sizing.tier="${actual ?? '(未设置)'}" ≠ expected="${expected}"` };
  },

  // 断言 quality 计数合法 + 未熔断；同时保留旧 assert convergence 别名
  // 检查 mm_fusion 子图字段
  'convergence': (ctx) => {
    const c = ctx.convergence || {};
    const { mm_fusion_rounds, mm_fusion_max_rounds } = c;
    if (!Number.isInteger(mm_fusion_rounds) || mm_fusion_rounds < 0) return { pass: false, detail: `mm_fusion_rounds=${mm_fusion_rounds} 非非负整数` };
    if (Number.isInteger(mm_fusion_max_rounds) && mm_fusion_rounds > mm_fusion_max_rounds) {
      return { pass: false, detail: `[CIRCUIT_BREAKER] mm_fusion mm_fusion_rounds=${mm_fusion_rounds} >= max=${mm_fusion_max_rounds}` };
    }
    return { pass: true, detail: `mm_fusion=${mm_fusion_rounds}/${mm_fusion_max_rounds}` };
  },

  // 断言 quality 计数合法 + 未熔断（v2 主图熔断）
  'quality': (ctx) => {
    const q = ctx.quality || {};
    const { round, max_rounds } = q;
    if (!Number.isInteger(round) || round < 0) return { pass: false, detail: `quality.round=${round} 非非负整数` };
    if (Number.isInteger(max_rounds) && round >= max_rounds) {
      return { pass: false, detail: `[CIRCUIT_BREAKER] quality round=${round} >= max=${max_rounds}` };
    }
    return { pass: true, detail: `quality.round=${round}/${max_rounds}` };
  },

  // 断言 gate 条件满足
  'gate': (ctx, args) => {
    const gate = args[0];
    if (!gate) return { pass: false, detail: 'usage: assert <task_id> gate <GATE_NAME>' };
    return { pass: false, detail: `unknown gate "${gate}"` };
  },

  // 断言某字段未被写入（反自验辅助，检测 conductor 漂移）
  'not-written': (ctx, args) => {
    const dotPath = args[0];
    if (!dotPath) return { pass: false, detail: 'usage: assert <task_id> not-written <dot.path>' };
    const v = getByPath(ctx, dotPath);
    if (v === undefined || v === null) {
      return { pass: true, detail: `${dotPath} 未写入` };
    }
    return { pass: false, detail: `${dotPath} 已被写入（值=${JSON.stringify(v).slice(0, 80)}）——可能违反写入边界` };
  },
};

function cmdAssert(taskId, assertionType, args) {
  assertValidTaskId(taskId);
  const fn = ASSERTIONS[assertionType];
  if (!fn) {
    die(2, `Error: unknown assertion "${assertionType}". Available: ${Object.keys(ASSERTIONS).join(', ')}`);
  }
  const { ctx } = readContext(taskId);
  let result;
  try {
    result = fn(ctx, args);
  } catch (e) {
    die(1, `Error: assertion "${assertionType}" threw: ${e.message}`);
  }
  if (result.pass) {
    process.stdout.write(`PASS assert ${assertionType} — ${result.detail}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`FAIL assert ${assertionType} — ${result.detail}\n`);
    process.exit(1);
  }
}

// ============================================================
// size-check 子命令：返回 task_context 文件字符数
// conductor pre-dispatch 硬门：超 config.size_check_threshold（缺省 120000）时 exit 2
// 强制切 agent_manager，禁止 task dispatch（防主会话 context 撑爆 abort）
// ============================================================

function cmdSizeCheck(taskId) {
  assertValidTaskId(taskId);
  const p = contextPath(taskId);
  const threshold = readSizeCheckThreshold();
  if (!fs.existsSync(p)) {
    process.stdout.write(`0 threshold=${threshold}\n`);
    process.exit(0);
  }
  try {
    const text = fs.readFileSync(p, 'utf8');
    const len = text.length;
    process.stdout.write(`${len} threshold=${threshold}\n`);
    if (len > threshold) process.exit(2);
    process.exit(0);
  } catch (e) {
    die(1, `Error: cannot read task_context for task_id=${taskId}: ${e.message}`);
  }
}

// ============================================================
// log-dispatch 子命令：追加 dispatch_log[] 条目
// conductor 每次 dispatch 前调用，记录 agent/mode/stage（provenance gate 依据）
// 白名单（防任意伪造）：
//   --agent ∈ 注册智能体名（WRITE_MATRIX 键，含 conductor）
//   --stage ∈ graph.yaml 节点集合（主图节点）
// ============================================================

const GRAPH_PATH = path.resolve(__dirname, '..', 'lifecycle', 'graph.yaml');

function readGraphNodeIds() {
  const ids = [];
  let text;
  try {
    text = fs.readFileSync(GRAPH_PATH, 'utf8');
  } catch {
    return ids; // graph.yaml 缺失 → 空集合（fail-closed：所有 --stage 被拒）
  }
  let inNodes = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line) continue;
    if (line === 'nodes:') { inNodes = true; continue; }
    if (line === 'edges:') { inNodes = false; continue; }
    if (inNodes) {
      const m = line.match(/^-\s*id\s*:\s*(\S+)\s*$/);
      if (m) ids.push(m[1]);
    }
  }
  return ids;
}

function cmdLogDispatch(taskId, agent, mode, stage) {
  assertValidTaskId(taskId);
  if (!agent) die(2, 'Error: log-dispatch requires --agent <name>');
  if (!mode) die(2, 'Error: log-dispatch requires --mode <task|agent_manager>');
  if (!stage) die(2, 'Error: log-dispatch requires --stage <STAGE>');
  const validModes = ['task', 'agent_manager'];
  if (!validModes.includes(mode)) {
    die(2, `Error: --mode must be one of: ${validModes.join(', ')}`);
  }
  // --agent 白名单：注册智能体名（含 conductor）
  if (!WRITE_MATRIX[agent] && agent !== 'conductor') {
    die(2, `[PROCESS_VIOLATION] --agent "${agent}" 不在 dispatch 白名单（${[...Object.keys(WRITE_MATRIX), 'conductor'].sort().join(', ')}）。防任意伪造 dispatch 记录。`);
  }
  // --stage 白名单：graph.yaml 节点集合
  const nodeIds = readGraphNodeIds();
  if (!nodeIds.includes(stage)) {
    die(2, `[PROCESS_VIOLATION] --stage "${stage}" 不在 graph.yaml 节点集合（${nodeIds.join(', ')}）。`);
  }
  const { ctx } = readContext(taskId);
  if (!Array.isArray(ctx.dispatch_log)) {
    ctx.dispatch_log = [];
  }
  ctx.dispatch_log.push({
    agent: agent.replace(/-/g, '_'),
    mode,
    stage,
    timestamp: Date.now(),
  });
  writeContext(taskId, ctx);
  process.stdout.write(`ok: dispatch_log appended (agent=${agent} mode=${mode} stage=${stage})\n`);
  process.exit(0);
}

// ============================================================
// 入口
// ============================================================

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
  }
  const sub = args[0];
  if (sub === 'init') {
    if (args.length !== 2) die(2, 'Error: init requires exactly <task_id>');
    cmdInit(args[1]);
  }
  if (sub === 'get') {
    if (args.length !== 3) die(2, 'Error: get requires <task_id> <dot.path>');
    cmdGet(args[1], args[2]);
  }
  if (sub === 'set') {
    // set <task_id> <dot.path> <json-value> --agent <name>
    // set <task_id> --batch '<json-object>' --agent <name>
    // --agent 可出现在任意位置，此处鲁棒解析
    const agentIdx = args.indexOf('--agent');
    if (agentIdx === -1 || agentIdx + 1 >= args.length) {
      die(2, 'Error: set requires --agent <name>');
    }
    const agent = args[agentIdx + 1];
    const positional = args.slice(1, agentIdx).concat(args.slice(agentIdx + 2));
    const batchIdx = positional.indexOf('--batch');
    if (batchIdx !== -1) {
      if (positional.length !== 3) {
        die(2, 'Error: batch set requires <task_id> --batch <json-object-or-minus>');
      }
      cmdSetBatch(positional[0], positional[batchIdx + 1], agent);
    } else {
      if (positional.length !== 3) {
        die(
          2,
          'Error: set requires <task_id> <dot.path> <json-value> --agent <name>'
        );
      }
      cmdSet(positional[0], positional[1], positional[2], agent);
    }
  }
  if (sub === 'validate') {
    if (args.length !== 2) die(2, 'Error: validate requires exactly <task_id>');
    cmdValidate(args[1]);
  }
  if (sub === 'apply-tier') {
    // apply-tier <task_id> <TIER> --agent conductor
    const agentIdx = args.indexOf('--agent');
    if (agentIdx === -1 || agentIdx + 1 >= args.length) {
      die(2, 'Error: apply-tier requires --agent <name>');
    }
    const agent = args[agentIdx + 1];
    const positional = args.slice(1, agentIdx).concat(args.slice(agentIdx + 2));
    if (positional.length !== 2) {
      die(2, 'Error: apply-tier requires <task_id> <T0|T1|T2> --agent conductor');
    }
    cmdApplyTier(positional[0], positional[1], agent, {});
  }
  if (sub === 'assert') {
    // assert <task_id> <assertion-type> [args...]
    if (args.length < 3) {
      die(2, `Error: assert requires <task_id> <assertion-type> [args...]. Available: ${Object.keys(ASSERTIONS).join(', ')}`);
    }
    cmdAssert(args[1], args[2], args.slice(3));
  }
  if (sub === 'size-check') {
    if (args.length !== 2) die(2, 'Error: size-check requires exactly <task_id>');
    cmdSizeCheck(args[1]);
  }
  if (sub === 'log-dispatch') {
    // log-dispatch <task_id> --agent <name> --mode <task|agent_manager> --stage <STAGE>
    const agentIdx = args.indexOf('--agent');
    const modeIdx = args.indexOf('--mode');
    const stageIdx = args.indexOf('--stage');
    if (agentIdx === -1 || agentIdx + 1 >= args.length) die(2, 'Error: log-dispatch requires --agent <name>');
    if (modeIdx === -1 || modeIdx + 1 >= args.length) die(2, 'Error: log-dispatch requires --mode <task|agent_manager>');
    if (stageIdx === -1 || stageIdx + 1 >= args.length) die(2, 'Error: log-dispatch requires --stage <STAGE>');
    cmdLogDispatch(args[1], args[agentIdx + 1], args[modeIdx + 1], args[stageIdx + 1]);
  }
  die(2, `Error: unknown subcommand "${sub}". Use --help.`);
}

// ============================================================
// 模块导出（供 Node 程序 dynamic import）
// ============================================================

export {
  WRITE_MATRIX,
  VERIFICATION_FIELDS,
  TOTAL_ROUNDS_FIELD,
  QUALITY_ROUND_FIELD,
  VALID_STATUSES,
  contextPath,
  buildInitialContext,
  readContext,
  writeContext,
  appendTransitionLog,
  getByPath,
  setByPath,
  pathAllowedBy,
  pathPrefix,
  readHooksFromConfig,
};

// ============================================================
// 脚本入口：仅当通过 `node task-context.mjs` 直接运行时执行 main()
// 被 import 时不执行 main()，避免副作用
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
