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

// 脚本所在目录（ESM 无 __dirname）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 阈值权威来源：lifecycle/config.yaml（v2 quality.max_total_cycles 来自 hooks.quality）
const CONVERGENCE_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');

// ============================================================
// 纯常量（零副作用字面量）
// ============================================================

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

// ============================================================
// 从 lifecycle/config.yaml 解析 tier_defaults
// 返回 { execution: { T0: {agents, review_mode, provider?}, ... } }
// conductor 在 INIT 阶段调用 readTierDefaults().execution[tier] 取默认组合，
// 消除"手工 set config.agents 容易漏写/写错"的根因（mm-eval-20260731 全 false bug）。
// 复用 lifecycle-doctor.mjs 的 yaml 子集解析器（脚本自包含）。
// ============================================================
function parseTierDefaults(text) {
  const result = { execution: {} };
  const lines = text.split(/\r?\n/);
  let section = null;      // 'execution' | null
  let curTier = null;
  let inAgents = false;
  let curAgents = null;
  let curReviewMode = null;
  let curProvider = null;

  function flush() {
    if (curTier && section) {
      const entry = { agents: curAgents || {}, review_mode: curReviewMode || 'none' };
      if (curProvider) entry.provider = curProvider;
      result[section][curTier] = entry;
    }
    curAgents = null;
    curReviewMode = null;
    curProvider = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // strip inline comment (preserve # inside quotes — none expected here)
    const hashIdx = raw.search(/\s#/);
    const line = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (!line.trim()) continue;

    // top-level keys we care about
    if (/^tier_defaults\s*:/.test(line)) { flush(); section = 'execution'; curTier = null; inAgents = false; continue; }
    if (/^(overrides|convergence|hooks|timeouts|inquiry_tier_defaults)\s*:/.test(line)) { flush(); section = null; curTier = null; inAgents = false; continue; }

    if (!section) continue;

    // tier key: "  T0:" / "  T1:" (2-space indent under tier_defaults)
    const tierM = line.match(/^  (T[0-3])\s*:\s*$/);
    if (tierM) {
      flush();
      curTier = tierM[1];
      inAgents = false;
      continue;
    }

    if (!curTier) continue;

    // agents: (key under tier, 4-space indent)
    const agentsStart = line.match(/^    agents\s*:\s*$/);
    if (agentsStart) {
      inAgents = true;
      curAgents = {};
      continue;
    }
    const agentsInline = line.match(/^    agents\s*:\s*\{(.*)\}\s*$/);
    if (agentsInline) {
      inAgents = false;
      curAgents = {};
      // inline empty {} → keep empty; inline {} with content not expected in this file
      continue;
    }

    if (inAgents) {
      // agent entry: "      key: true" (6-space indent)
      const agentM = line.match(/^      ([a-z_]+)\s*:\s*(true|false)\s*$/);
      if (agentM) {
        curAgents[agentM[1]] = agentM[2] === 'true';
        continue;
      }
      // leaving agents block (indent < 6)
      if (!/^ {6,}/.test(line) && line.trim()) {
        inAgents = false;
      }
    }

    // review_mode (4-space indent, sibling of agents)
    const rmM = line.match(/^    review_mode\s*:\s*(\w+)\s*$/);
    if (rmM) {
      inAgents = false;
      curReviewMode = rmM[1];
      continue;
    }

    // provider (T3 only, 4-space indent)
    const provM = line.match(/^    provider\s*:\s*(\w+)\s*$/);
    if (provM) {
      curProvider = provM[1];
      continue;
    }
  }
  flush();
  return result;
}

function readTierDefaults() {
  try {
    const text = fs.readFileSync(CONVERGENCE_SOURCE, 'utf8');
    return parseTierDefaults(text);
  } catch {
    return { execution: {} };
  }
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
      review_mode: 'none',
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
  buildInitialContext,
  die,
  readContext,
  writeContext,
  appendTransitionLog,
  getByPath,
  setByPath,
  pathAllowedBy,
  pathPrefix,
  parseValue,
  extractFrontmatter,
};
