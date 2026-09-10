// task-context-runtime.mjs
// 纯运行时层，零副作用——import 时不读盘、不扫描 agent 目录、不派生矩阵、不做 invariant 断言。
// 只有函数定义和纯常量（Object.freeze 的字面量）。
// 供 transition-check / lifecycle-doctor / e2e-smoke import。
// WRITE_MATRIX 派生在 task-context.mjs（编译期）。
//
// 仅使用 Node 内置模块：node:fs / node:path / node:os / node:process / node:url
// 跨平台：Windows PowerShell + Linux bash 兼容

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cachedDerive } from './lib/derived-cache.mjs';
import { parseTierDefaults, parseTimeouts, parseTierEscalation } from './lib/config-parser.mjs';
import { contextPath, readContextOptional } from './lib/task-context-io.mjs';

// 脚本所在目录（ESM 无 __dirname）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 阈值权威来源：lifecycle/config.yaml（v2 quality.max_total_cycles 来自 hooks.quality）
const CONVERGENCE_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');

// ============================================================
// 纯常量（零副作用字面量）
// ============================================================

// 硬门 1：execution.verification 与 verification.forward 仅 verifier 可写
// 其他 agent 写入 → [TRUST_TRANSFER] + exit 1
// verification.review 由 WRITE_MATRIX 按 reviewer 放行，不在此处硬门触发。
// execution.verification 与 verification.forward 是 verifier 独占产出，
// 合并为 "verification 硬门"。
const VERIFICATION_FIELDS = Object.freeze([
  // 硬门 1：仅 verifier 可写。execution.verification 与 verification.forward
  // 属于 verifier 独占产物，其他 agent 写入触发 [TRUST_TRANSFER]。
  // verification.review 由 WRITE_MATRIX 按 reviewer 放行，
  // 不再纳入此处硬门。
  'execution.verification',
  'verification.forward',
]);

// 硬门 2：quality.round / current_stage 仅 conductor 可写
// 其他 agent 写入 → [PROCESS_VIOLATION] + exit 1
const QUALITY_ROUND_FIELD = 'quality.round';
const CURRENT_STAGE_FIELD = 'current_stage';

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

// ============================================================
// 工具函数
// ============================================================

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// 从 agent .md 全文提取 frontmatter 块（首个 --- ... --- 之间）
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// 白名单校验 taskId：仅允许字母数字下划线连字符，长度 1-64
function assertValidTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    die(1, `Error: invalid task_id "${taskId}". Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-). Max length 64.`);
  }
}

// 从 lifecycle/config.yaml 读取响应式 Hooks 阈值（v2：hooks.quality.max_total_cycles）
// 失败降级到 7
function readConfigText() {
  return cachedDerive('configText', [CONVERGENCE_SOURCE], () => {
    try { return fs.readFileSync(CONVERGENCE_SOURCE, 'utf8'); }
    catch { return null; }
  });
}

function readHooksFromConfig() {
  const text = readConfigText();
  if (!text) return { max_total_cycles: 7 };
  const mtc = text.match(/max_total_cycles:\s*(\d+)/);
  return { max_total_cycles: mtc ? parseInt(mtc[1], 10) : 7 };
}

// 从 lifecycle/config.yaml 读取子图融合阈值（保留 convergence.mm_fusion_max_rounds）
function readConvergenceFromConfig() {
  const text = readConfigText();
  if (!text) return { mm_fusion_max_rounds: 3 };
  const mm = text.match(/mm_fusion_max_rounds:\s*(\d+)/);
  return { mm_fusion_max_rounds: mm ? parseInt(mm[1], 10) : 3 };
}

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_defaults（实现见 scripts/lib/config-parser.mjs）
// ============================================================
function readTierDefaults() {
  return cachedDerive('tierDefaults', [CONVERGENCE_SOURCE], () => {
    const text = readConfigText();
    if (!text) return { execution: {} };
    return parseTierDefaults(text);
  });
}

// 从 lifecycle/config.yaml 读取 size-check 阈值（conductor pre-dispatch 硬门依据）
// 缺省 150000 字符（约 30K token，主会话 context 安全水位）
function readSizeCheckThreshold() {
  const text = readConfigText();
  if (!text) return 150000;
  const m = text.match(/size_check_threshold:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 150000;
}

// 从 lifecycle/config.yaml 读取 dispatch-prompt-check 阈值（conductor pre-dispatch 硬门依据）
// 缺省 4000 字符：单次 task prompt 字符数上限（小任务上限 ×1.5 安全系数，与 lifecycle/config.yaml 对齐）
function readDispatchPromptThreshold() {
  const text = readConfigText();
  if (!text) return 4000;
  const m = text.match(/dispatch_prompt_threshold:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 4000;
}

// 从 lifecycle/config.yaml 读取单次 task 委派涉及文件数上限（dispatch-prompt-check 依据）
// 缺省 5；配置缺失时返回 null（表示不限制）
function readMaxFilesPerTask() {
  const text = readConfigText();
  if (!text) return null;
  const m = text.match(/max_files_per_task:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 从 lifecycle/config.yaml 读取 recovery 引擎阈值（U6 新增）
// 缺省回退与 config.yaml 中显式值一致；任意字段缺失时该字段回退到缺省
// max_write_retry=1, overload_threshold=3, circuit_breaker_overload=5
function readRecoveryConfig() {
  const defaults = {
    max_write_retry: 1,
    overload_threshold: 3,
    circuit_breaker_overload: 5,
  };
  const text = readConfigText();
  if (!text) return defaults;
  const mw = text.match(/max_write_retry:\s*(\d+)/);
  const ot = text.match(/overload_threshold:\s*(\d+)/);
  const cb = text.match(/circuit_breaker_overload:\s*(\d+)/);
  return {
    max_write_retry: mw ? parseInt(mw[1], 10) : defaults.max_write_retry,
    overload_threshold: ot ? parseInt(ot[1], 10) : defaults.overload_threshold,
    circuit_breaker_overload: cb ? parseInt(cb[1], 10) : defaults.circuit_breaker_overload,
  };
}

// ============================================================
// 从 lifecycle/config.yaml 解析 timeouts（实现见 scripts/lib/config-parser.mjs）
// ============================================================
// 读取 config.yaml timeouts；文件缺失或缺少 timeouts 段 -> null。
// 复用 readConfigText（已 mtime 缓存）+ cachedDerive 跨 start/check/pre-dispatch/post-dispatch 命中缓存。
function readTimeouts() {
  return cachedDerive('timeouts', [CONVERGENCE_SOURCE], () => {
    const text = readConfigText();
    if (!text || !/^\s*timeouts\s*:/m.test(text)) return null;
    return parseTimeouts(text);
  });
}

// 初始 task_context 结构（按 conductor.md §task_context 结构摘要）
function buildInitialContext(taskId) {
  const hooks = readHooksFromConfig();
  return {
    task_id: taskId,
    intent: {},
    sizing: {},
    config: {
      // 仅差异化开关（恒定挂载智能体无 when，不依赖 config.agents，由图拓扑限定）
      // INIT 按 lifecycle/config.yaml tier_defaults 覆盖写入
      agents: {},
      custom_overrides: {},
    },
    plan: {},
    plan_review: {},
    execution: {},
    verification: {
      forward: null,
    },
    quality: {
      round: 0,
      max_rounds: hooks.max_total_cycles,
      status: 'running',
      verify: { forward: {} },
      review: { result: {} },
      fix: { round: 0, issues_fixed: [], issues_remaining: [] },
      verdict: 'PENDING',
    },
    fixing_history: [],
    convergence: {
      mm_fusion_rounds: 0,
      mm_fusion_max_rounds: 3,
    },
    dispatch_log: [],        // 每次 dispatch 记录 {agent, mode, stage, timestamp}（provenance gate 依据）
    overload_count: 0,       // task 返回 >角色上限累计次数（分档见 output-schema §返回超限约束）；>=3 → [CONTEXT_UNSAFE] 强制切 agent_manager
    status: 'initialized',
    current_stage: 'START',
    transition_log: [],
  };
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

function parseValue(rawValue) {
  // 解析 JSON 值（必须在枚举校验前完成）
  // 优先 JSON.parse；失败时将裸字符串视为 JSON 字符串（友好降级）
  // （PowerShell 传递 "PASS" 时外层引号被剥离 → node 收到 PASS → JSON.parse 失败）
  try {
    return JSON.parse(rawValue);
  } catch (e) {
    // 裸字符串降级：将 rawValue 原样作为字符串值
    return rawValue;
  }
}

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_escalation（实现见 scripts/lib/config-parser.mjs）
// ============================================================
function readTierEscalation() {
  return cachedDerive('tierEscalation', [CONVERGENCE_SOURCE], () => {
    const text = readConfigText();
    if (!text) return { mode: 'any', keyword_groups: {}, sensitive_path_globs: [] };
    return parseTierEscalation(text);
  });
}
// 模块导出
// ============================================================

export {
  CONVERGENCE_SOURCE,
  VALID_STATUSES,
  VERIFICATION_FIELDS,
  QUALITY_ROUND_FIELD,
  CURRENT_STAGE_FIELD,
  TOTAL_ROUNDS_FIELD,
  contextPath,
  assertValidTaskId,
  readHooksFromConfig,
  readConvergenceFromConfig,
  readTierDefaults,
  readTierEscalation,
  parseTierEscalation,
  readSizeCheckThreshold,
  readDispatchPromptThreshold,
  readMaxFilesPerTask,
  readRecoveryConfig,
  readTimeouts,
  parseTimeouts,
  buildInitialContext,
  die,
  readContext,
  readContextOptional,
  writeContext,
  appendTransitionLog,
  getByPath,
  setByPath,
  pathAllowedBy,
  pathPrefix,
  parseValue,
  extractFrontmatter,
};
