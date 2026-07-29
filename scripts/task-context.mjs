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

// 脚本所在目录（ESM 无 __dirname）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 阈值权威来源：lifecycle/config.yaml（v2 quality.max_total_cycles 来自 hooks.quality）
const CONVERGENCE_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');

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

// 从 agent .md 全文提取 frontmatter 块（首个 --- ... --- 之间）
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

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

// F2 invariant：WRITE_MATRIX.conductor 必须包含 memory_injection（单数）
// 派生失败（agent/conductor.md frontmatter 被破坏/缺失）→ 启动即报错，fail-closed
if (!Array.isArray(WRITE_MATRIX.conductor) || !WRITE_MATRIX.conductor.includes('memory_injection')) {
  throw new Error('invariant: WRITE_MATRIX.conductor must include "memory_injection" (derived from agent/conductor.md frontmatter task_context.write)');
}

// 硬门 1：execution.verification 与 verification.forward 仅 verifier 可写
// 其他 agent 写入 → [TRUST_TRANSFER] + exit 1
// verification.reverse/side/review 由 WRITE_MATRIX 按 agent 单独放行，
// 不在此处硬门触发。
// execution.verification 与 verification.forward 是 verifier 独占产出，
// 合并为 "verification 硬门"。
const VERIFICATION_FIELDS = Object.freeze([
  // 硬门 1：仅 verifier 可写。execution.verification 与 verification.forward
  // 属于 verifier 独占产物，其他 agent 写入触发 [TRUST_TRANSFER]。
  // verification.reverse/side/review 由 WRITE_MATRIX 按 agent 放行，
  // 不再纳入此处硬门。
  'execution.verification',
  'verification.forward',
]);

// 硬门 2：quality.round 仅 conductor 可写
// 其他 agent 写入 → [PROCESS_VIOLATION] + exit 1
const QUALITY_ROUND_FIELD = 'quality.round';

// 向后兼容别名：旧 assert convergence 仍接受，但内部检查已迁移到 quality/mm_fusion
const TOTAL_ROUNDS_FIELD = 'convergence.total_rounds';

// task_context.status 合法取值（保留小写初始值 initialized，流转后由 conductor 写入大写）
const VALID_STATUSES = Object.freeze([
  'initialized',
  'RUNNING',
  'PAUSED',
  'DEGRADED',
  'DONE',
  'FAILED',
]);

// 文件位置：$env:TEMP/kilo/task_context_<task_id>.json（Windows）
//          /tmp/kilo/task_context_<task_id>.json（Unix）
function contextPath(taskId) {
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

// 白名单校验 taskId：仅允许字母数字下划线连字符，长度 1-64
function assertValidTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    die(1, `Error: invalid task_id "${taskId}". Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-). Max length 64.`);
  }
}

// 从 lifecycle/config.yaml 读取响应式 Hooks 阈值（v2：hooks.quality.max_total_cycles）
// 失败降级到 7
function readHooksFromConfig() {
  try {
    const text = fs.readFileSync(CONVERGENCE_SOURCE, 'utf8');
    const mtc = text.match(/max_total_cycles:\s*(\d+)/);
    return {
      max_total_cycles: mtc ? parseInt(mtc[1], 10) : 7,
    };
  } catch {
    return { max_total_cycles: 7 };
  }
}

// 从 lifecycle/config.yaml 读取子图融合阈值（保留 convergence.mm_fusion_max_rounds）
function readConvergenceFromConfig() {
  try {
    const text = fs.readFileSync(CONVERGENCE_SOURCE, 'utf8');
    const mm = text.match(/mm_fusion_max_rounds:\s*(\d+)/);
    return {
      mm_fusion_max_rounds: mm ? parseInt(mm[1], 10) : 3,
    };
  } catch {
    return { mm_fusion_max_rounds: 3 };
  }
}

// 初始 task_context 结构（按 conductor.md §task_context 结构摘要）
function buildInitialContext(taskId) {
  const conv = readConvergenceFromConfig();
  const hooks = readHooksFromConfig();
  return {
    task_id: taskId,
    intent: {},
    sizing: {},
    config: {
      // 仅差异化开关（恒定挂载智能体无 when，不依赖 config.agents，由图拓扑限定）
      // SIZING 按 lifecycle/config.yaml tier_defaults 覆盖写入
      agents: {
        reverse_auditor: false,
        side_checker: false,
        synthesizer_fusion: false,
      },
      review_mode: 'none',
      custom_overrides: {},
    },
    plan: {},
    plan_review: {},
    execution: {},
    verification: {
      forward: null,
      reverse: null,
      side: null,
      review: null,
    },
    quality: {
      round: 0,
      max_rounds: hooks.max_total_cycles,
      status: 'running',
      verify: { forward: {}, reverse: {} },
      review: { result: {}, side: {} },
      fix: { round: 0, issues_fixed: [], issues_remaining: [] },
      verdict: 'PENDING',
    },
    fixing_history: [],
    memory_injection: {},
    status: 'initialized',
    transition_log: [],
    convergence: {
      mm_fusion_rounds: 0,
      mm_fusion_max_rounds: conv.mm_fusion_max_rounds,
    },
  };
}

// ============================================================
// 工具
// ============================================================

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/task-context.mjs init <task_id>',
    '  node scripts/task-context.mjs get <task_id> <dot.path>',
    "  node scripts/task-context.mjs set <task_id> <dot.path> <json-value> --agent <name>",
    '  node scripts/task-context.mjs validate <task_id>',
    '  node scripts/task-context.mjs assert <task_id> <type> [args...]',
    '',
    'Assert types:',
    '  current-stage <NODE>   Assert current_stage == NODE',
    "  tier <T0|T1|T2|T3>     Assert sizing.tier == TIER",
    '  quality                Assert quality counters valid & not tripped',
    '  convergence            Assert mm_fusion counters valid & not tripped (alias/backward compat)',
    '  gate <GATE_NAME>       Assert gate condition met (e.g. MEMORY_WRITE_COMPLETE)',
    '  not-written <dot.path> Assert field is unset (anti-self-verify aid)',
    '  node scripts/task-context.mjs --help',
    '',
    'Subcommands:',
    '  init     Create task_context_<task_id>.json under os.tmpdir()/kilo/.',
    '  get      Print value at dot.path (JSON).',
    '  set      Write JSON value to dot.path. Enforces write matrix.',
    '  validate Check required top-level fields, quality integers, and convergence mm_fusion integers.',
    '',
    'Agents in write matrix: ' + Object.keys(WRITE_MATRIX).join(', '),
    '',
    'Exit codes: 0=ok, 1=rejected/fail, 2=usage error',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

// 解析 dot path 段。支持 execution.diffs[current_unit] → ["execution","diffs[current_unit]"]
// 简化：拆 dot；首段为顶层 key，后续作为该 key 下的子路径。
function pathPrefix(dotPath) {
  // 取第一段作为顶层前缀
  const idx = dotPath.indexOf('.');
  if (idx === -1) return dotPath;
  return dotPath.slice(0, idx);
}

// 判断 dotPath 是否在 matrix 字段的允许范围内。
// 规则：dotPath === pattern，或 dotPath 以 pattern + "." 开头，
// 或 dotPath 以 pattern + "[" 开头（处理 execution.diffs[current_unit]）。
function pathAllowedBy(dotPath, pattern) {
  if (dotPath === pattern) return true;
  if (dotPath.startsWith(pattern + '.')) return true;
  if (dotPath.startsWith(pattern + '[')) return true;
  return false;
}

// 解析 --agent 参数（可能在任意位置）
function parseAgent(args) {
  const idx = args.indexOf('--agent');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// ============================================================
// 读 / 写 task_context.json
// ============================================================

function readContext(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) {
    die(1, `Error: task_context not found for task_id=${taskId}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    die(1, `Error: cannot read task_context for task_id=${taskId}: ${e.message}`);
  }
  // 剥离 UTF-8 BOM（外部工具可能以 UTF-8 with BOM 写入）
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  try {
    return { ctx: JSON.parse(raw), path: p };
  } catch (e) {
    die(1, `Error: invalid JSON in task_context for task_id=${taskId}: ${e.message}`);
  }
}

function writeContext(taskId, ctx) {
  const p = contextPath(taskId);
  // F1 二次校验：确保解析后的路径仍在安全前缀内
  const resolved = path.resolve(p);
  const tmpdir = path.resolve(os.tmpdir(), 'kilo');
  if (!resolved.startsWith(tmpdir + path.sep)) {
    die(1, `Error: path traversal detected for task_id=${taskId}`);
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch (e) {
    die(1, `Error: cannot create task_context directory for task_id=${taskId}: ${e.message}`);
  }
  // 原子写：同目录 tmp 文件 + rename，确保同卷且不掉电丢失
  // Windows 兼容：fs.renameSync 在目标文件存在时 EPERM，先尝试 unlink 目标
  const tmpPath = p + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(ctx, null, 2) + '\n', 'utf8');
    // Windows: 先删除目标（若存在），再 rename
    try { fs.unlinkSync(p); } catch { /* 目标不存在则忽略 */ }
    fs.renameSync(tmpPath, p);
  } catch (e) {
    // 兜底：rename 失败时直接复制 tmp 到目标再删 tmp
    try {
      fs.copyFileSync(tmpPath, p);
      fs.unlinkSync(tmpPath);
    } catch (e2) {
      die(1, `Error: cannot write task_context for task_id=${taskId}: ${e.message}`);
    }
  }
}

// 追加一条流转记录（供 transition-check.mjs 等调用）
function appendTransitionLog(ctx, from, to) {
  if (!Array.isArray(ctx.transition_log)) {
    ctx.transition_log = [];
  }
  ctx.transition_log.push({ from, to, timestamp: Date.now() });
}

// 按 dot path 取值（支持 a.b.c 与 a.b[0] 形式）
function getByPath(obj, dotPath) {
  // 拆 a.b[0].c 为段：a, b[0], c
  const segments = [];
  let buf = '';
  for (let i = 0; i < dotPath.length; i++) {
    const ch = dotPath[i];
    if (ch === '.') {
      if (buf.length > 0) {
        segments.push(buf);
        buf = '';
      }
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) segments.push(buf);

  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    // 段中可能含 [N]（仅一个），如 execution.diffs[current_unit]
    const m = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    const key = m[1];
    const idx = m[2];
    if (typeof cur !== 'object' || cur === null) return undefined;
    if (!(key in cur)) return undefined;
    cur = cur[key];
    if (idx !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

// 按 dot path 写入（支持 a.b.c 形式创建中间对象）
function setByPath(obj, dotPath, value) {
  // 拆段（同 getByPath）
  const segments = [];
  let buf = '';
  for (let i = 0; i < dotPath.length; i++) {
    const ch = dotPath[i];
    if (ch === '.') {
      if (buf.length > 0) {
        segments.push(buf);
        buf = '';
      }
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) segments.push(buf);

  let cur = obj;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const m = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!m) {
      die(1, `Error: invalid path segment "${seg}"`);
    }
    const key = m[1];
    const idx = m[2];
    const isLast = i === segments.length - 1;
    if (isLast) {
      if (idx === undefined) {
        cur[key] = value;
      } else {
        if (!Array.isArray(cur[key])) {
          die(
            1,
            `Error: path segment "${seg}" expects an array, got ${typeof cur[key]}`
          );
        }
        cur[key][Number(idx)] = value;
      }
      return;
    }
    // 中间段：若不存在则创建对象
    if (idx === undefined) {
      if (
        !(key in cur) ||
        cur[key] === null ||
        typeof cur[key] !== 'object' ||
        Array.isArray(cur[key])
      ) {
        cur[key] = {};
      }
      cur = cur[key];
    } else {
      if (!Array.isArray(cur[key])) {
        die(
          1,
          `Error: path segment "${seg}" expects an array, got ${typeof cur[key]}`
        );
      }
      cur = cur[key];
    }
  }
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

  // GC：清理 initialized 状态超过 24h 的旧 task_context 残留
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  for (const file of files) {
    if (!file.startsWith('task_context_') || !file.endsWith('.json')) continue;
    const filePath = path.join(tmpdir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const otherCtx = JSON.parse(raw);
      if (otherCtx.status === 'initialized') {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > ONE_DAY_MS) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            // 删除失败不阻塞
          }
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

function cmdSet(taskId, dotPath, rawValue, agent) {
  assertValidTaskId(taskId);
  // 硬门 3：--agent 必须存在且在矩阵名单
  if (!agent) {
    die(2, 'Error: --agent <name> is required for set');
  }
  if (!Object.prototype.hasOwnProperty.call(WRITE_MATRIX, agent)) {
    die(
      1,
      `Error: agent "${agent}" is not in the write matrix. Allowed: ${Object.keys(
        WRITE_MATRIX
      ).join(', ')}`
    );
  }

  // 硬门 1：verification 硬门 — 非 verifier 一律拒绝
  // matrix 中 verifier 独占 verification.forward 与 execution.verification；
  // verification.reverse/side/review 由 WRITE_MATRIX 按 agent 单独放行，
  // 不进入本硬门。
  if (VERIFICATION_FIELDS.some((f) => pathAllowedBy(dotPath, f))) {
    if (agent !== 'verifier') {
      die(
        1,
        `[TRUST_TRANSFER] agent "${agent}" is not allowed to write "${dotPath}". ` +
          'verification.forward and execution.verification are reserved for verifier only.'
      );
    }
  }

  // 硬门 2：quality.round 仅 conductor 可写
  if (pathAllowedBy(dotPath, QUALITY_ROUND_FIELD)) {
    if (agent !== 'conductor') {
      die(
        1,
        `[PROCESS_VIOLATION] agent "${agent}" is not allowed to write "${dotPath}". ` +
          'quality.round is reserved for conductor only.'
      );
    }
  }

  // 矩阵字段匹配
  const allowedPatterns = WRITE_MATRIX[agent];
  const allowed = allowedPatterns.some((p) => pathAllowedBy(dotPath, p));
  if (!allowed) {
    die(
      1,
      `Error: agent "${agent}" cannot write "${dotPath}". ` +
        `Allowed paths: ${allowedPatterns.join(', ')}`
    );
  }

  // 解析 JSON 值
  // 优先 JSON.parse；失败时将裸字符串视为 JSON 字符串（友好降级）
  // （PowerShell 传递 "PASS" 时外层引号被剥离 → node 收到 PASS → JSON.parse 失败）
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch (e) {
    // 裸字符串降级：将 rawValue 原样作为字符串值
    value = rawValue;
  }

  // status schema 校验：仅 conductor 可写，且值必须在合法集合中
  if (dotPath === 'status') {
    if (!VALID_STATUSES.includes(value)) {
      die(
        1,
        `[PROCESS_VIOLATION] invalid status "${value}". ` +
          `status must be one of: ${VALID_STATUSES.join(', ')}`
      );
    }
  }

  const { ctx } = readContext(taskId);
  setByPath(ctx, dotPath, value);
  writeContext(taskId, ctx);
  process.stdout.write(`ok: set ${dotPath}\n`);
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
    'memory_injection',
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
    if (gate === 'MEMORY_WRITE_COMPLETE') {
      const mws = ctx.memory_write_status;
      if (mws === 'OK' || mws === 'DEGRADED' || ctx.memory_write_complete === true) {
        return { pass: true, detail: `memory_write_status=${mws}` };
      }
      return { pass: false, detail: `[MISSING_MEMORY_WRITE] memory_write_status=${mws || '(未设置)'}` };
    }
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
    if (args.length < 6) {
      die(
        2,
        'Error: set requires <task_id> <dot.path> <json-value> --agent <name>'
      );
    }
    const agent = parseAgent(args);
    cmdSet(args[1], args[2], args[3], agent);
  }
  if (sub === 'validate') {
    if (args.length !== 2) die(2, 'Error: validate requires <task_id>');
    cmdValidate(args[1]);
  }
  if (sub === 'assert') {
    // assert <task_id> <assertion-type> [args...]
    if (args.length < 3) {
      die(2, `Error: assert requires <task_id> <assertion-type> [args...]. Available: ${Object.keys(ASSERTIONS).join(', ')}`);
    }
    cmdAssert(args[1], args[2], args.slice(3));
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
