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
//   node scripts/task-context.mjs delete <task_id> [--force]
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

import { readContext, writeContext, appendTransitionLog, contextPath, buildInitialContext,
         VALID_STATUSES, VERIFICATION_FIELDS, QUALITY_ROUND_FIELD, CURRENT_STAGE_FIELD,
         TOTAL_ROUNDS_FIELD, readHooksFromConfig, readConvergenceFromConfig, readTierDefaults,
         readTierEscalation,
         readSizeCheckThreshold, readDispatchPromptThreshold, readMaxFilesPerTask,
         assertValidTaskId, getByPath, setByPath, pathAllowedBy, pathPrefix, parseValue,
         extractFrontmatter, die } from './task-context-runtime.mjs';
import { discoverPostPreConstantMountsByAgent, discoverPostPreTieredMounts } from './lib/post-pre-mounts.mjs';
import { getStageRequiredRoles } from './lib/stage-roles.mjs';
import { cachedDerive, listMdFiles } from './lib/derived-cache.mjs';

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

// 静态派生（agent/*.md frontmatter 运行期不变）走 mtime 缓存，避免每次脚本启动全量扫描
const WRITE_MATRIX = cachedDerive('writeMatrix', listMdFiles(AGENT_DIR), deriveWriteMatrix);

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
    '  node scripts/task-context.mjs apply-escalation <task_id> --agent conductor',
    '  node scripts/task-context.mjs validate <task_id>',
    '  node scripts/task-context.mjs assert <task_id> <type> [args...]',
    '  node scripts/task-context.mjs size-check <task_id>',
    '  node scripts/task-context.mjs dispatch-prompt-check <task_id>',
    '  node scripts/task-context.mjs pre-dispatch <task_id> --prompt-chars <N> [--file-count <F>]',
    "  node scripts/task-context.mjs log-dispatch <task_id> --agent <name> --mode <task|agent_manager> --stage <STAGE>",
    "  node scripts/task-context.mjs delete <task_id> [--force]",
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
    '  apply-escalation Scan intent.raw + sizing.key_files against config.yaml tier_escalation; auto-upgrade to T2 if matched (INIT helper).',
    '  validate    Check required top-level fields, quality integers, and convergence mm_fusion integers.',
    '  size-check  Print task_context file character count (pre-dispatch safety gate vs config.size_check_threshold; exit=2 if exceeded).',
    "  dispatch-prompt-check Read dispatch_pending.prompt_chars/file_count written by conductor pre-dispatch; exit=1 if pending info missing, exit=2 if prompt_chars>dispatch_prompt_threshold or file_count>max_files_per_task. PASS otherwise.",
    "  pre-dispatch    Combined gate: writes dispatch_pending then runs dispatch-prompt-check + size-check in one process. Replaces the 3-call `set` + `dispatch-prompt-check` + `size-check` sequence. exit=0 pass / 1 audit fail / 2 over-limit (same semantics).",
    "  log-dispatch Append {agent, mode, stage, timestamp} to dispatch_log[] (provenance gate). --agent must be in write-matrix agent set; --stage must be a graph.yaml node. Whitelist-enforced.",
    "  delete       Remove task_context_<task_id>.json. Default: only DONE/FAILED statuses may be deleted; --force skips the status check.",
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
  // F3 修复：path 以 status 结尾的写入做类型守卫——仅允许 string，
  // 其余类型（含 object/array/number/boolean）直接 reject exit 1，
  // 避免 [object Object] 字符串化事故污染 task_context。
  if (dotPath === 'status' || dotPath.endsWith('.status')) {
    if (typeof value !== 'string') {
      return {
        allowed: false,
        code: 1,
        message: `Error: status must be a string, got ${value === null ? 'null' : typeof value}`,
      };
    }
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
  // 同步写 sizing.tier（消除 INIT 后 transition-check 报 "tier undefined" 的根因）
  // 幂等：当前 tier 与目标 tier 一致则不写多余字段
  ctx.sizing = ctx.sizing || {};
  if (ctx.sizing.tier !== tier) {
    ctx.sizing.tier = tier;
  }
  writeContext(taskId, ctx);

  process.stdout.write(
    `ok: apply-tier ${tier} → config.agents=${JSON.stringify(agentsValue)} review_mode=${reviewMode} sizing.tier=${tier}\n`
  );
  process.exit(0);
}

// ============================================================
// 极简 glob -> RegExp 转换器（零依赖，支持 ** / * / ? 通配符）
// 语义对齐 minimatch：
//   ** -> 任意字符（含 /）  * -> 任意非 / 字符  ? -> 单个非 / 字符
// 其他字符按 RegExp 元字符转义。仅供 apply-escalation 内部使用。
// ============================================================
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') { re += '[^/]*'; }
    else if (c === '?') { re += '[^/]'; }
    else if ('.+^$()|{}[]\\'.indexOf(c) !== -1) { re += '\\' + c; }
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// ============================================================
// apply-escalation: INIT 阶段扫描 intent.raw + sizing.key_files，
// 命中 config.yaml tier_escalation 规则时自动覆盖 sizing.tier=T2。
// 优先级：custom_overrides.tier 存在时跳过升级（用户明示偏好）。
// 幂等：sizing.escalation_reasons 已非空则直接 return。
// ============================================================
function cmdApplyEscalation(taskId, agent, opts) {
  assertValidTaskId(taskId);
  if (agent !== 'conductor') {
    die(1, `[PROCESS_VIOLATION] apply-escalation is conductor-only (got --agent "${agent}")`);
  }
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) {
    die(1, `Error: task_context not found for task_id=${taskId}`);
  }
  const { ctx } = readContext(taskId);
  ctx.sizing = ctx.sizing || {};
  // 幂等：已应用过则直接返回
  if (Array.isArray(ctx.sizing.escalation_reasons) && ctx.sizing.escalation_reasons.length > 0) {
    process.stdout.write(`ok: apply-escalation already applied; reasons=${JSON.stringify(ctx.sizing.escalation_reasons)}\n`);
    process.exit(0);
  }
  const keyFiles = Array.isArray(ctx.sizing.key_files) ? ctx.sizing.key_files : [];
  const esc = readTierEscalation();
  const reasons = [];
  const matchedGroups = new Set();
  const matchedGlobs = new Set();

  // 1) 扫描 intent.raw（支持 string 或 {raw: string}；大小写不敏感）
  let rawIntent = '';
  if (typeof ctx.intent === 'string') {
    rawIntent = ctx.intent;
  } else if (ctx.intent && typeof ctx.intent === 'object' && typeof ctx.intent.raw === 'string') {
    rawIntent = ctx.intent.raw;
  }
  const lowerIntent = rawIntent.toLowerCase();
  for (const [group, kws] of Object.entries(esc.keyword_groups || {})) {
    for (const kw of kws) {
      if (lowerIntent.includes(String(kw).toLowerCase())) {
        matchedGroups.add(group);
        reasons.push(`keyword:${group}:${kw}`);
        break;
      }
    }
  }

  // 2) 扫描 key_files（按 sensitive_path_globs glob 匹配；Windows 路径反斜杠规范化）
  for (const glob of esc.sensitive_path_globs || []) {
    let re;
    try { re = globToRegex(glob); } catch { continue; }
    for (const f of keyFiles) {
      const fNorm = String(f).replace(/\\/g, '/');
      if (re.test(fNorm)) {
        matchedGlobs.add(glob);
        reasons.push(`path:${glob}:${f}`);
        break;
      }
    }
  }

  // 3) 判定升级：mode=any 任一命中；mode=all 全部 keyword_groups 命中 + 任一 glob 命中
  const mode = String(esc.mode || 'any').toLowerCase();
  let shouldUpgrade = false;
  if (mode === 'all') {
    const groups = Object.keys(esc.keyword_groups || {});
    const allGroupsHit = groups.length > 0 && groups.every(g => matchedGroups.has(g));
    shouldUpgrade = allGroupsHit && matchedGlobs.size > 0;
  } else {
    shouldUpgrade = matchedGroups.size > 0 || matchedGlobs.size > 0;
  }

  // 4) 用户覆盖优先
  const customTier = ctx.config && ctx.config.custom_overrides && ctx.config.custom_overrides.tier;

  if (shouldUpgrade) {
    if (customTier) {
      ctx.sizing.escalation_reasons = [`skipped: custom_overrides.tier=${customTier} present`];
    } else {
      ctx.sizing.tier = 'T2';
      ctx.sizing.escalation_reasons = reasons;
    }
  } else {
    ctx.sizing.escalation_reasons = [];
  }

  writeContext(taskId, ctx);
  process.stdout.write(`ok: apply-escalation tier=${ctx.sizing.tier || '(unchanged)'} reasons=${JSON.stringify(ctx.sizing.escalation_reasons)}\n`);
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

// ============================================================
// eval 辅助：纯判定函数，返回 { exitCode, line }（不副作用 exit）
// 供合并子命令 cmdPreDispatch 使用，一次进程原子完成 dispatch 前
// prompt 审计 + size 审计。语义与 cmdDispatchPromptCheck / cmdSizeCheck 一致，
// 改动阈值判定逻辑需同步两处（共用 readDispatchPromptThreshold/readSizeCheckThreshold）。
// ============================================================

function evalSizeCheck(taskId) {
  const p = contextPath(taskId);
  const threshold = readSizeCheckThreshold();
  if (!fs.existsSync(p)) {
    return { exitCode: 0, line: `0 threshold=${threshold}` };
  }
  try {
    const text = fs.readFileSync(p, 'utf8');
    const len = text.length;
    return { exitCode: len > threshold ? 2 : 0, line: `${len} threshold=${threshold}` };
  } catch (e) {
    return { exitCode: 1, line: `Error: cannot read task_context for task_id=${taskId}: ${e.message}` };
  }
}

function evalDispatchPrompt(ctx) {
  const dp = (ctx && ctx.dispatch_pending) || {};
  const promptChars = dp.prompt_chars;
  const fileCount = dp.file_count;
  const promptThreshold = readDispatchPromptThreshold();
  const maxFiles = readMaxFilesPerTask();

  if (typeof promptChars !== 'number' || !Number.isInteger(promptChars) || promptChars < 0) {
    return { exitCode: 1, line: 'FAIL dispatch-prompt-check - dispatch_pending.prompt_chars 未设置或非法（conductor 未写入 dispatch 前 pending 信息），阻断 dispatch' };
  }
  if (promptChars > promptThreshold) {
    return { exitCode: 2, line: `FAIL dispatch-prompt-check (prompt_chars=${promptChars} threshold=${promptThreshold}) - prompt 超限，阻断 dispatch` };
  }
  if (fileCount !== undefined && fileCount !== null) {
    if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) {
      return { exitCode: 1, line: 'FAIL dispatch-prompt-check - dispatch_pending.file_count 非法（' + JSON.stringify(fileCount) + '），阻断 dispatch' };
    }
    if (maxFiles !== null && fileCount > maxFiles) {
      return { exitCode: 2, line: `FAIL dispatch-prompt-check (file_count=${fileCount} max_files=${maxFiles}) - 文件数超限，阻断 dispatch` };
    }
  }
  const fc = typeof fileCount === 'number' ? fileCount : 'null';
  return { exitCode: 0, line: `PASS dispatch-prompt-check (prompt_chars=${promptChars} threshold=${promptThreshold} file_count=${fc} max_files=${maxFiles === null ? 'unset' : maxFiles})` };
}

// ============================================================
// pre-dispatch 子命令：合并 step 0b（dispatch-prompt-check）+ step 0a（size-check）
// 一次进程原子完成：写 dispatch_pending -> prompt 校验 -> size 校验 -> 单一 verdict。
// 替代旧的 `set dispatch_pending` + `dispatch-prompt-check` + `size-check` 三连串行调用，
// 省 2 次 node 进程启动 + 2 个 conductor reasoning 回合 / 每次 dispatch。
// 语义与三连等价：exit 0=全通过可 dispatch / 1=审计失败（pending 非法）/ 2=超限阻断。
// size-check 超限时本命令仅返回 exit 2（阻断）；摘要压缩 + 切 worktree 仍由 conductor
// 在收到 exit 2 后按铁律 #9 step 0a 流程处理（脚本不做副作用压缩）。
// ============================================================
function cmdPreDispatch(taskId, promptCharsArg, fileCountArg, bashCmd) {
  assertValidTaskId(taskId);
  const promptChars = Number.parseInt(promptCharsArg, 10);
  if (!Number.isInteger(promptChars) || promptChars < 0) {
    die(2, 'Error: pre-dispatch requires --prompt-chars <non-negative integer>');
  }
  let fileCount = null;
  if (fileCountArg !== undefined && fileCountArg !== null) {
    fileCount = Number.parseInt(fileCountArg, 10);
    if (!Number.isInteger(fileCount) || fileCount < 0) {
      die(2, 'Error: --file-count must be a non-negative integer');
    }
  }

  // 1. 写 dispatch_pending（替代 `set <task_id> dispatch_pending.prompt_chars <N> --agent conductor`）
  const { ctx } = readContext(taskId);
  ctx.dispatch_pending = { prompt_chars: promptChars, file_count: fileCount };
  writeContext(taskId, ctx);

  // 2. dispatch-prompt-check（对刚写入的 pending 校验）
  const dpc = evalDispatchPrompt(ctx);
  // 3. size-check（writeContext 后文件已是最新）
  const sc = evalSizeCheck(taskId);

  // 合并：取最严重 exit code（2 > 1 > 0）
  const exitCode = Math.max(dpc.exitCode, sc.exitCode);
  process.stdout.write(`[pre-dispatch] ${dpc.line}\n`);
  process.stdout.write(`[pre-dispatch] ${sc.line}\n`);
  if (exitCode === 0) {
    process.stdout.write('PASS pre-dispatch (combined) - 允许 dispatch\n');
  } else {
    process.stdout.write(`FAIL pre-dispatch (combined) - 阻断 dispatch（见上 ${exitCode === 2 ? '超限' : '审计失败'} 项）\n`);
  }

  // 4. bash-guard 子进程（可选 --bash-cmd；省略时整段跳过，零侵入旧调用方）
  if (bashCmd) {
    const bg = spawnSync('node', [path.resolve(SCRIPT_DIR, 'bash-guard.mjs'), bashCmd], { encoding: 'utf8' });
    const bgExit = bg.status || 0;
    if (bgExit === 2) {
      process.stdout.write(`[pre-dispatch] bash-guard BLOCKED: ${(bg.stdout || '').trim()}\n`);
      process.exit(2);
    } else {
      process.stdout.write(`[pre-dispatch] bash-guard: PASS (exit ${bgExit})\n`);
    }
  }

  process.exit(exitCode);
}

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
// dispatch-prompt-check 子命令：conductor pre-dispatch 的 prompt 审计门
// conductor dispatch 前用 `set <task_id> dispatch_pending.prompt_chars <N> --agent conductor` 写入 pending 信息
// （file_count 可选），随后调用本子命令校验：
//   - dispatch_pending.prompt_chars 未设置/非法 → exit 1（审计失败：conductor 未写入 pending 信息）
//   - prompt_chars > dispatch_prompt_threshold（config.yaml，缺省 3000）→ exit 2（超限，阻断 dispatch）
//   - file_count > max_files_per_task（若设置）→ exit 2（超限）
//   - 全部通过 → exit 0（输出 PASS）
// 输出格式参照 size-check：PASS dispatch-prompt-check (prompt_chars=N threshold=M file_count=F max_files=G)
// ============================================================
function cmdDispatchPromptCheck(taskId) {
  assertValidTaskId(taskId);
  const { ctx } = readContext(taskId);
  const dp = (ctx && ctx.dispatch_pending) || {};
  const promptChars = dp.prompt_chars;
  const fileCount = dp.file_count;
  const promptThreshold = readDispatchPromptThreshold();
  const maxFiles = readMaxFilesPerTask();

  // 审计失败：conductor 未写入 pending 信息（未设置 / 非法 → 阻断 dispatch，fail-closed）
  if (typeof promptChars !== 'number' || !Number.isInteger(promptChars) || promptChars < 0) {
    process.stdout.write('FAIL dispatch-prompt-check — dispatch_pending.prompt_chars 未设置或非法（conductor 未写入 dispatch 前 pending 信息），阻断 dispatch\n');
    process.exit(1);
  }
  // prompt 超限 → 阻断 dispatch
  if (promptChars > promptThreshold) {
    process.stdout.write(`FAIL dispatch-prompt-check (prompt_chars=${promptChars} threshold=${promptThreshold}) — prompt 超限，阻断 dispatch\n`);
    process.exit(2);
  }
  // 文件数超限（若设置了 file_count；设置了但非法 → 审计失败）
  if (fileCount !== undefined && fileCount !== null) {
    if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) {
      process.stdout.write('FAIL dispatch-prompt-check — dispatch_pending.file_count 非法（' + JSON.stringify(fileCount) + '），阻断 dispatch\n');
      process.exit(1);
    }
    if (maxFiles !== null && fileCount > maxFiles) {
      process.stdout.write(`FAIL dispatch-prompt-check (file_count=${fileCount} max_files=${maxFiles}) — 文件数超限，阻断 dispatch\n`);
      process.exit(2);
    }
  }
  // 通过
  const fc = typeof fileCount === 'number' ? fileCount : 'null';
  process.stdout.write(`PASS dispatch-prompt-check (prompt_chars=${promptChars} threshold=${promptThreshold} file_count=${fc} max_files=${maxFiles === null ? 'unset' : maxFiles})\n`);
  process.exit(0);
}

// ============================================================
// log-dispatch 子命令：追加 dispatch_log[] 条目
// conductor 每次 dispatch 前调用，记录 agent/mode/stage（provenance gate 依据）
// 白名单（防任意伪造）：
//   --agent ∈ 注册智能体名（WRITE_MATRIX 键，含 conductor）
//   --stage ∈ graph.yaml 节点集合（主图节点）
//   --agent ∈ stages/<stage>.md frontmatter required_roles（防跨阶段乱派发）
//   conductor 内建阶段（INIT/DELIVERING，executor: conductor）豁免 required_roles 校验
// ============================================================

const GRAPH_PATH = path.resolve(__dirname, '..', 'lifecycle', 'graph.yaml');

function readGraphNodeIds() {
  return cachedDerive('graphNodeIds', [GRAPH_PATH], _readGraphNodeIdsUncached);
}

function _readGraphNodeIdsUncached() {
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

// 读 graph.yaml 节点的 executor 字段（判断是否 conductor 内建阶段）
function readNodeExecutor(stageName) {
  const executors = cachedDerive('graphExecutors', [GRAPH_PATH], () => {
    const map = {};
    let text;
    try {
      text = fs.readFileSync(GRAPH_PATH, 'utf8');
    } catch {
      return map;
    }
    let inNodes = false;
    let curId = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s#.*$/, '').trim();
      if (!line) continue;
      if (line === 'nodes:') { inNodes = true; continue; }
      if (line === 'edges:') break;
      if (inNodes) {
        const idm = line.match(/^-\s*id\s*:\s*(\S+)\s*$/);
        if (idm) { curId = idm[1]; continue; }
        const em = line.match(/^executor\s*:\s*(\S+)\s*$/);
        if (em && curId) map[curId] = em[1];
      }
    }
    return map;
  });
  return executors[stageName] || null;
}

// S9: 发现 post:<STAGE>/pre:<STAGE> 恒定挂载 agent（无 when）
//   实现已抽取至 scripts/lib/post-pre-mounts.mjs（共享 helper）。
//   返回 Map<agentName, Set<stageId>>（agent 在哪些 stage 上有 post:/pre: 恒定挂载）。
//   log-dispatch 扩展：若 --agent 在 --stage 上有 post:/pre: 恒定挂载，即使不在
//   required_roles 也允许记录（plan-reviewer 的 post:PLANNING 钩子 dispatch 不再被拒）。

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
  // agent-stage 匹配校验（防跨阶段乱派发）：
  //   --agent 必须在该 stage 的 required_roles 中，或该 stage 是 conductor 内建阶段（executor: conductor），
  //   或 --agent 在 --stage 上有 post:/pre: 恒定挂载（S9 扩展：生命周期钩子 agent 放行）
  const executor = readNodeExecutor(stage);
  const requiredRoles = getStageRequiredRoles(stage);
  const agentNorm = agent.replace(/-/g, '_');
  let allowed = false;
  if (executor === 'conductor' && agent === 'conductor') {
    allowed = true; // conductor 内建阶段豁免 required_roles
  } else if (requiredRoles && requiredRoles.length > 0) {
    const rolesNorm = requiredRoles.map((r) => r.replace(/-/g, '_'));
    if (rolesNorm.includes(agentNorm)) allowed = true;
  } else {
    // requiredRoles 为 null/空 → fail-open（兼容无 required_roles 声明的 stage）
    allowed = true;
  }
  // S9: post:/pre: 恒定挂载 agent 允许按对应阶段记录（即使不在 required_roles）
  if (!allowed) {
    const postPreMap = discoverPostPreConstantMountsByAgent();
    const stages = postPreMap.get(agent);
    if (stages && stages.has(stage)) {
      allowed = true;
    }
  }
  // S9b: post:/pre: 定级挂载（tiers: [T2]）agent 同样允许按对应阶段记录，
  //      但须按 sizing.tier 过滤：仅当 tier ∈ entry.tiers 才放行（与 transition-check:445 语义一致）
  if (!allowed) {
    const { ctx: ctxForTier } = readContext(taskId);
    const tier = ctxForTier.sizing && ctxForTier.sizing.tier;
    if (tier) {
      const tieredMounts = discoverPostPreTieredMounts();
      const hit = tieredMounts.some(
        (m) => m.name === agent && m.stage === stage && Array.isArray(m.tiers) && m.tiers.includes(tier)
      );
      if (hit) allowed = true;
    }
  }
  if (!allowed) {
    die(2, `[PROCESS_VIOLATION] --agent "${agent}" 不在 stage "${stage}" 的 required_roles（${requiredRoles ? requiredRoles.join(', ') : '(无)'}），亦无 post:${stage}/pre:${stage} 恒定/定级挂载。防跨阶段乱派发。`);
  }
  const { ctx } = readContext(taskId);
  if (!Array.isArray(ctx.dispatch_log)) {
    ctx.dispatch_log = [];
  }
  ctx.dispatch_log.push({
    agent: agentNorm,
    mode,
    stage,
    timestamp: Date.now(),
  });
  writeContext(taskId, ctx);
  process.stdout.write(`ok: dispatch_log appended (agent=${agent} mode=${mode} stage=${stage})\n`);
  process.exit(0);
}

// ============================================================
// delete 子命令：清理 task_context JSON（默认仅 DONE/FAILED 状态可删，--force 跳过）
// 用于 5 次 scan-cleanup + V8 模拟测试产生的临时 task_context 清理。
// 路径：os.tmpdir()/kilo/task_context_<task_id>.json（复用 contextPath helper）
// 退出码：0=已删 / 1=业务拒绝（不存在/状态非 DONE|FAILED/解析失败）/ 2=参数错误
// ============================================================
function cmdDelete(taskId, force) {
  assertValidTaskId(taskId);
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) {
    die(1, `Error: task_context not found for task_id=${taskId} (path: ${p})`);
  }
  if (!force) {
    let status;
    try {
      const ctx = JSON.parse(fs.readFileSync(p, 'utf8'));
      status = ctx.status;
    } catch (e) {
      die(1, `Error: failed to read/parse ${p}: ${e.message}`);
    }
    if (status !== 'DONE' && status !== 'FAILED') {
      die(1, `Error: cannot delete task_id=${taskId} with status=${status}（默认仅 DONE/FAILED 可删，加 --force 跳过状态检查）`);
    }
  }
  fs.unlinkSync(p);
  process.stdout.write(`ok: deleted ${p}${force ? ' (--force)' : ''}\n`);
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
  if (sub === 'apply-escalation') {
    // apply-escalation <task_id> --agent conductor
    const agentIdx = args.indexOf('--agent');
    if (agentIdx === -1 || agentIdx + 1 >= args.length) {
      die(2, 'Error: apply-escalation requires --agent <name>');
    }
    const agent = args[agentIdx + 1];
    const positional = args.slice(1, agentIdx).concat(args.slice(agentIdx + 2));
    if (positional.length !== 1) {
      die(2, 'Error: apply-escalation requires <task_id> --agent conductor');
    }
    cmdApplyEscalation(positional[0], agent, {});
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
  if (sub === 'dispatch-prompt-check') {
    if (args.length !== 2) die(2, 'Error: dispatch-prompt-check requires exactly <task_id>');
    cmdDispatchPromptCheck(args[1]);
  }
  if (sub === 'pre-dispatch') {
    // pre-dispatch <task_id> --prompt-chars <N> [--file-count <F>]
    // 合并 set dispatch_pending + dispatch-prompt-check + size-check（一次进程）
    if (args.length < 4) die(2, 'Error: pre-dispatch requires <task_id> --prompt-chars <N>');
    const taskId = args[1];
    const pcIdx = args.indexOf('--prompt-chars');
    const fcIdx = args.indexOf('--file-count');
    if (pcIdx === -1 || pcIdx + 1 >= args.length) {
      die(2, 'Error: pre-dispatch requires --prompt-chars <N>');
    }
    const promptChars = args[pcIdx + 1];
    const fileCount = fcIdx !== -1 && fcIdx + 1 < args.length ? args[fcIdx + 1] : undefined;
    const bgIdx = args.indexOf('--bash-cmd');
    const bashCmd = bgIdx !== -1 && bgIdx + 1 < args.length ? args[bgIdx + 1] : undefined;
    cmdPreDispatch(taskId, promptChars, fileCount, bashCmd);
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
  if (sub === 'delete') {
    // delete <task_id> [--force]  — 清理 task_context JSON（默认仅 DONE/FAILED 可删）
    if (args.length < 2 || args[1].startsWith('--')) {
      die(2, 'Error: delete requires <task_id> [--force]');
    }
    const force = args.includes('--force');
    cmdDelete(args[1], force);
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
