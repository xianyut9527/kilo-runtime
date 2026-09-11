#!/usr/bin/env node
// transition-check.mjs
// 运行时流转校验器 — graph.yaml DAG 流转的机械裁判 + quality 轮次机械递增。
//
// 定位：conductor 每次跨节点流转前必须调用本脚本校验合法性。
// "模型提议流转、脚本裁判合法性"——把软约束（提示词）变为硬约束（退出码）。
// quality.round 由本脚本在进入 QUALITY 时机械递增，是 conductor
// 专属写权限的机械执行臂；coder/fixer/subagents 禁止使用本脚本，
// conductor 也不得绕过本脚本手工 set quality.round（[PROCESS_VIOLATION]）。
//
// 用法：
//   node scripts/transition-check.mjs <task_id> --from <NODE> --to <NODE>
//   node scripts/transition-check.mjs --help
//
// 退出码：
//   0 = 合法流转（计数已递增并持久化）
//   1 = 非法流转 / gate 未过（[PROCESS_VIOLATION]）
//   2 = 参数错误
//   3 = [CIRCUIT_BREAKER] 熔断（计数已持久化）
//
// when 变量 → task_context 路径映射（按序取首个非 undefined/null）：
//   intent_type     → intent.intent_type ?? intent.transition_context.intent_type
//   tier            → sizing.tier
//   quality_verdict → quality.verdict
//   forward_result  → verification.forward.forward_result ?? verification.forward.verdict
//   review_result   → verification.review.review_result ?? verification.review.verdict
// 变量为 undefined/null 时 ==/!=/in 比较结果恒为 false（条件不满足，流转拒绝）。
//
// 计数器规则（v2 响应式 Hooks：CHECKING+REVIEWING+FIXING 合并为 QUALITY）：
//   进入 QUALITY  → quality.round += 1
//   quality.round >= quality.max_rounds → exit 3 [CIRCUIT_BREAKER] global
//   quality.max_rounds 来源：config.yaml hooks.quality.max_total_cycles
//
// gate 语义：
//   当前图无 gate；未来新增 gate 在此声明求值规则
//
// 仅使用 Node 内置模块（Node 14 兼容）；graph 解析器为 lifecycle-doctor.mjs
// 本地副本（仓库惯例：脚本自包含）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContext, writeContext, appendTransitionLog, readHooksFromConfig as tcReadHooks, die } from './task-context-runtime.mjs';
import { discoverPostPreConstantMounts, discoverPostPreTieredMounts } from './lib/post-pre-mounts.mjs';
import { getStageRequiredRoles, isConditionalRole, hasRequirementSpread, hasSpreadTrigger, validateRequirementSpread } from './lib/stage-roles.mjs';
import { cachedDerive } from './lib/derived-cache.mjs';
import { verifyField } from './lib/byte-verify.mjs';
import { ERROR_CODES, codeMsg } from './error-codes.mjs';
import { recordThenDie } from './lessons-recorder.mjs';
import { checkT0Eligibility, checkT1StrengthEligibility } from './delivery-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_PATH = path.resolve(__dirname, '..', 'lifecycle', 'graph.yaml');
const CONVERGENCE_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');


// ============================================================
// post:/pre: 恒定挂载 agent 发现（S9 扩展 provenance gate）
//   实现已抽取至 scripts/lib/post-pre-mounts.mjs（共享 helper）。
//   返回 [{ name, stage, kind: 'post'|'pre' }]：扫描 agent/*.md frontmatter
//   mount.at 前缀匹配 post:<STAGE> 或 pre:<STAGE> 且无 when（恒定挂载）。
//   这些 agent 不在 stages/<stage>.md required_roles 主槽契约内，但属于
//   生命周期钩子必经智能体——transition-check provenance gate 必须校验它们
//   已在 dispatch_log（防跳过 plan-reviewer 这类 post:PLANNING 钩子）。
// ============================================================

function usage() {
    const txt = [
      'Usage:',
      '  node scripts/transition-check.mjs <task_id> --from <NODE> --to <NODE>',
      '  node scripts/transition-check.mjs --help',
      '',
      'Mechanical DAG transition judge + quality round clerk (conductor-only).',
      '',
      'Exit codes:',
      '  0 = legal transition (counters incremented & persisted)',
      '  1 = illegal transition / gate failed ([PROCESS_VIOLATION])',
      '  2 = usage error',
      '  3 = [CIRCUIT_BREAKER] (counters persisted before exit)',
      '',
      'when variables: intent_type tier quality_verdict forward_result review_result',
    ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

// ============================================================
// graph.yaml 迷你解析器（lifecycle-doctor.mjs 本地副本，脚本自包含）
// ============================================================

function stripComment(line) {
  const idx = line.search(/\s#/);
  if (idx >= 0) return line.slice(0, idx);
  if (/^\s*#/.test(line)) return '';
  return line;
}

function parseGraphFile(text) {
  const nodes = new Map();
  const edges = [];
  const top = {};
  let section = null;
  let curNode = null;
  let curEdge = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;

    if (/^[^\s-]/.test(line)) {
      const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (key === 'nodes') { section = 'nodes'; curNode = null; continue; }
        if (key === 'edges') { section = 'edges'; curEdge = null; continue; }
        if (val) top[key] = val.trim();
        if (key === 'diversity_rule') section = null;
        continue;
      }
      continue;
    }

    if (section === 'nodes') {
      const idm = line.match(/^\s*-\s*id\s*:\s*(\S+)\s*$/);
      if (idm) {
        curNode = { id: idm[1] };
        nodes.set(curNode.id, curNode);
        continue;
      }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curNode) {
        const [, key, val] = fm;
        curNode[key] = val.trim();
      }
      continue;
    }

    if (section === 'edges') {
      const inline = line.match(/^\s*-\s*\{(.+)\}\s*$/);
      if (inline) {
        const e = {};
        for (const part of inline[1].split(',')) {
          const kv = part.match(/([a-z_]+)\s*:\s*(.+)$/);
          if (kv) e[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
        }
        edges.push(e);
        curEdge = null;
        continue;
      }
      const fromM = line.match(/^\s*-\s*from\s*:\s*(\S+)\s*$/);
      if (fromM) {
        curEdge = { from: fromM[1] };
        edges.push(curEdge);
        continue;
      }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curEdge) {
        const [, key, val] = fm;
        curEdge[key] = val.trim().replace(/^["']|["']$/g, '');
      }
      continue;
    }
  }
  return { nodes, edges, top };
}

// graph.yaml 走 mtime 缓存（静态拓扑运行期不变）。parseGraphFile 返回 Map（不可
// JSON 序列化），缓存层存 plain object，取出后还原 Map，调用方 API 不变。
export function loadGraphCached() {
  const data = cachedDerive('graphFile', [GRAPH_PATH], () => {
    let text;
    try {
      text = fs.readFileSync(GRAPH_PATH, 'utf8');
    } catch (e) {
      die(1, `Error: cannot read graph.yaml: ${e.message}`);
    }
    const { nodes, edges, top } = parseGraphFile(text);
    return { nodes: Object.fromEntries(nodes), edges, top };
  });
  return { nodes: new Map(Object.entries(data.nodes)), edges: data.edges, top: data.top };
}

// ============================================================
// when 表达式求值器（递归下降解析器；禁止 eval/new Function）
// 文法：or := and (or and)* ; and := cmp (and cmp)* ;
//       cmp := '(' or ')' | IDENT ('=='|'!=') STRING | IDENT in '[' STRING (, STRING)* ']'
// ============================================================

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ t: 'LP' }); i++; continue; }
    if (ch === ')') { tokens.push({ t: 'RP' }); i++; continue; }
    if (ch === '[') { tokens.push({ t: 'LB' }); i++; continue; }
    if (ch === ']') { tokens.push({ t: 'RB' }); i++; continue; }
    if (ch === ',') { tokens.push({ t: 'COMMA' }); i++; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) { s += src[j]; j++; }
      if (j >= src.length) throw new Error(`unterminated string in when: ${src}`);
      tokens.push({ t: 'STR', v: s });
      i = j + 1;
      continue;
    }
    if (src.startsWith('==', i)) { tokens.push({ t: 'EQ' }); i += 2; continue; }
    if (src.startsWith('!=', i)) { tokens.push({ t: 'NE' }); i += 2; continue; }
    const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      const w = m[0];
      if (w === 'and') tokens.push({ t: 'AND' });
      else if (w === 'or') tokens.push({ t: 'OR' });
      else if (w === 'in') tokens.push({ t: 'IN' });
      else tokens.push({ t: 'IDENT', v: w });
      i += w.length;
      continue;
    }
    throw new Error(`unexpected char '${ch}' at ${i} in when: ${src}`);
  }
  return tokens;
}

function parseExpr(tokens, src) {
  let pos = 0;
  function peek() { return tokens[pos]; }
  function eat(t) {
    const tk = tokens[pos];
    if (!tk || tk.t !== t) throw new Error(`expected ${t}, got ${tk ? tk.t : 'EOF'} in when: ${src}`);
    pos++;
    return tk;
  }
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'OR') { pos++; left = { op: 'or', l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (peek() && peek().t === 'AND') { pos++; left = { op: 'and', l: left, r: parseCmp() }; }
    return left;
  }
  function parseCmp() {
    if (peek() && peek().t === 'LP') { pos++; const e = parseOr(); eat('RP'); return e; }
    const ident = eat('IDENT').v;
    const nx = peek();
    if (!nx || (nx.t !== 'EQ' && nx.t !== 'NE' && nx.t !== 'IN')) {
      throw new Error(`expected ==/!=/in after identifier '${ident}' in when: ${src}`);
    }
    pos++;
    if (nx.t === 'IN') {
      eat('LB');
      const arr = [];
      if (peek() && peek().t !== 'RB') {
        arr.push(eat('STR').v);
        while (peek() && peek().t === 'COMMA') { pos++; arr.push(eat('STR').v); }
      }
      eat('RB');
      return { op: 'in', name: ident, values: arr };
    }
    const str = eat('STR').v;
    return { op: nx.t === 'EQ' ? '==' : '!=', name: ident, value: str };
  }
  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in when: ${src}`);
  return ast;
}

function evalAst(ast, vars) {
  switch (ast.op) {
    case 'and': return evalAst(ast.l, vars) && evalAst(ast.r, vars);
    case 'or': return evalAst(ast.l, vars) || evalAst(ast.r, vars);
    case '==': {
      const v = vars[ast.name];
      if (v === undefined || v === null) return false;
      return v === ast.value;
    }
    case '!=': {
      const v = vars[ast.name];
      if (v === undefined || v === null) return false;
      return v !== ast.value;
    }
    case 'in': {
      const v = vars[ast.name];
      if (v === undefined || v === null) return false;
      return ast.values.indexOf(v) !== -1;
    }
    default: throw new Error(`unknown op ${ast.op}`);
  }
}

// ============================================================
// when 变量 → task_context 路径映射
// ============================================================

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function resolveVars(ctx) {
  const intent = ctx.intent || {};
  const sizing = ctx.sizing || {};
  const ver = ctx.verification || {};
  const fwd = ver.forward || {};
  const review = ver.review || {};
  return {
    intent_type: pick(intent.intent_type),
    tier: pick(sizing.tier),
    t1_strength: pick(sizing.t1_strength),
    quality_verdict: pick(ctx.quality && ctx.quality.verdict),
    forward_result: pick(fwd.forward_result, fwd.verdict),
    review_result: pick(review.review_result, review.verdict),
  };
}

// ============================================================
// T1 强度校验纯函数（供 INIT 出口门禁 + 自检复用）
// ============================================================

// custom_overrides 读取收口（2026-09 修复覆盖出口不可达）：唯一的可写路径是
// `config.custom_overrides`——buildInitialContext 只创建该嵌套对象，且 WRITE_MATRIX 未放行根级
// `custom_overrides`（实测 `set <id> custom_overrides.tier` 被直接拒绝）。旧代码只读根级，
// 于是门禁一边在 remediation 里让用户「显式声明 custom_overrides.tier 覆盖」、一边没有任何
// 合法写法，照做必然再次 FAIL 死循环。嵌套优先，根级保留为兼容回落（历史快照与本文件自检夹具）。
function readCustomOverride(ctx, key) {
  const nested = ctx.config && ctx.config.custom_overrides ? ctx.config.custom_overrides[key] : undefined;
  if (nested !== undefined) return nested;
  return ctx.custom_overrides ? ctx.custom_overrides[key] : undefined;
}

// T1 强度合法性校验：tier!=='T1' 跳过；T1 时 t1_strength 必填 ∈ {low,medium,high}
// config.custom_overrides.t1_strength 显式声明时作为生效值（覆盖 sizing.t1_strength）
export function validateT1Strength(ctx) {
  const tier = ctx.sizing?.tier;
  if (tier !== 'T1') {
    return { ok: true, effective: undefined, reason: 'tier=' + (tier || '(空)') + '，非 T1 跳过' };
  }
  const strength = ctx.sizing?.t1_strength;
  const override = readCustomOverride(ctx, 't1_strength');
  const effective = ['low', 'medium', 'high'].includes(override) ? override : strength;
  if (!['low', 'medium', 'high'].includes(effective)) {
    return { ok: false, effective, reason: 't1_strength=' + JSON.stringify(strength) + ' 非法/缺失（合法值 low/medium/high）' };
  }
  return { ok: true, effective, reason: 't1_strength=' + effective };
}

// minimal_gate 校验：T1 直通边（INIT→EXECUTING）conductor 必须补齐的最小产物
// goal(string 非0) + acceptance_criteria(array length>=1) + forbidden_files(array)
export function validateMinimalGate(ctx) {
  const mg = ctx.plan?.minimal_gate;
  if (!mg || typeof mg !== 'object') {
    return { ok: false, reason: 'plan.minimal_gate 缺失或非对象' };
  }
  if (typeof mg.goal !== 'string' || mg.goal.trim().length === 0) {
    return { ok: false, reason: 'plan.minimal_gate.goal 缺失或非空字符串' };
  }
  if (typeof mg.context_anchor !== 'string' || mg.context_anchor.trim().length === 0) {
    return { ok: false, reason: 'plan.minimal_gate.context_anchor 缺失或非空字符串（文件:行号 精确指向）' };
  }
  if (!Array.isArray(mg.acceptance_criteria) || mg.acceptance_criteria.length < 1) {
    return { ok: false, reason: 'plan.minimal_gate.acceptance_criteria 缺失或 <1 条' };
  }
  if (!Array.isArray(mg.forbidden_files)) {
    return { ok: false, reason: 'plan.minimal_gate.forbidden_files 缺失或非数组' };
  }
  return { ok: true, reason: 'plan.minimal_gate 完整' };
}


// ============================================================
// recovery_pending hook (U5)
// ============================================================
// ============================================================
// recovery_pending hook (U5, QUALITY->DELIVERING 专用)
//   若 recovery_log 最后一条是 retry+write-missing 且 timestamp 早于当前 transition,
//   用 byte-verify 复查 entry 标记的未补写字段; 任一仍缺失 -> 返回缺失数组.
//   返回 null = 无需检查 (无 log / 非 retry / 时间戳未来 / 无未补写字段).
//   双源 schema: byte_verification[] (U7) + missing_fields[] (U1/U2 兼容).
// ============================================================
function checkRecoveryPending(ctx) {
  const log = Array.isArray(ctx.recovery_log) ? ctx.recovery_log : null;
  if (!log || log.length === 0) return null;
  const last = log[log.length - 1];
  if (!last || typeof last !== 'object') return null;
  if (last.action !== 'retry' || last.type !== 'write-missing') return null;
  const ts = Number(last.timestamp);
  if (!Number.isFinite(ts) || ts >= Date.now()) return null;
  const so = (last.script_output && typeof last.script_output === 'object') ? last.script_output : {};
  const missing = [];
  if (Array.isArray(so.byte_verification)) {
    for (const r of so.byte_verification) {
      if (r && typeof r.field === 'string' && r.present === false && !missing.includes(r.field)) {
        missing.push(r.field);
      }
    }
  }
  if (Array.isArray(so.missing_fields)) {
    for (const f of so.missing_fields) {
      if (typeof f === 'string' && !missing.includes(f)) missing.push(f);
    }
  }
  if (missing.length === 0) return [];
  const stillMissing = missing.filter((f) => !verifyField(ctx, f).present);
  return stillMissing;
}

// ============================================================
// KB 经验沉淀 gate（DELIVERING->DONE 专用，unit-2-delivering-gate）
//   若 fixing_history 非空（存在即代表有 FAIL 转 PASS 的修复轮次），则要求
//   execution.kb_write 存在且为对象含 fx 字段，并校验 knowledge-base/fixes/<fx>.md
//   真实存在。缺字段或文件不存在 -> [MISSING_KB_WRITE] exit 1。
//   fixing_history 为空/不存在 -> 跳过（无 FAIL 无需写经验）。
//   KB 根 = path.resolve(path.dirname(本脚本), ../knowledge-base)；若该目录不存在
//   则降级仅查字段（不校验文件存在）。
// ============================================================
function checkKbWriteGate(ctx) {
  const fixingHistory = ctx.fixing_history;
  const hasFixing = Array.isArray(fixingHistory) ? fixingHistory.length > 0 : !!fixingHistory;
  if (!hasFixing) {
    return { ok: true, skipped: true, reason: "fixing_history 为空/不存在，无 FAIL 转 PASS，跳过 KB 校验" };
  }
  const kbWrite = ctx.execution && ctx.execution.kb_write;
  if (!kbWrite || typeof kbWrite !== "object" || Array.isArray(kbWrite)) {
    return { ok: false, skipped: false, reason: "execution.kb_write 缺失或非对象（存在 fixing_history 的 FAIL 转 PASS 任务必须沉淀经验）" };
  }
  const fx = kbWrite.fx;
  if (typeof fx !== "string" || fx.trim().length === 0) {
    return { ok: false, skipped: false, reason: "execution.kb_write.fx 缺失或非空字符串" };
  }
  const kbRoot = path.resolve(__dirname, "..", "knowledge-base");
  if (fs.existsSync(kbRoot)) {
    const fxFile = path.join(kbRoot, "fixes", fx + ".md");
    if (!fs.existsSync(fxFile)) {
      return { ok: false, skipped: false, reason: "knowledge-base/fixes/" + fx + ".md 不存在（KB 根=" + kbRoot + "）" };
    }
    // 校验正文非 TODO 占位：四段任一仍为 "- TODO:" 即视为未补全
    const fxText = fs.readFileSync(fxFile, "utf8");
    if (fxText.includes("- TODO:")) {
      return { ok: false, skipped: false, reason: "KB 正文仍为 TODO 占位，需用 kb.mjs add --body 补全" };
    }
  }
  return { ok: true, skipped: false, reason: "execution.kb_write.fx=" + fx + " 已沉淀（KB 文件存在且正文非 TODO）" };
}

// ============================================================
// lessons 反馈 gate（DELIVERING->DONE 专用，U5 lessons-反馈）
//   要求：intent.prior_lessons 非空 且 intent_type=EXECUTION 的任务，必须在
//   execution.prior_lessons_used 中逐条回填 lessons 落实证据（每项须含 code + bumped，
//   且覆盖 prior_lessons 全部 code），否则 [MISSING_LESSONS_FEEDBACK] 阻断。
//   三态：
//    ① intent.prior_lessons 缺失/空，或 intent_type != EXECUTION -> {ok:true, skipped:true}
//    ② 非空 + used 为非空数组、每项含 code+bumped 且覆盖 prior_lessons 全部 code -> 通过
//    ③ 非空但 used 缺失/空/覆盖不全 -> 失败（[MISSING_LESSONS_FEEDBACK]）
//   when 语义（intent_type==EXECUTION 且 prior_lessons 非空）在函数内判断，非 when 表达式。
// ============================================================
function checkLessonsFeedback(ctx) {
  const intent = ctx.intent || {};
  const prior = intent.prior_lessons;
  // ① prior_lessons 缺失/空，或非 EXECUTION（INQUIRY 等不适用） -> 跳过，不误伤
  if (intent.intent_type !== 'EXECUTION') {
    return { ok: true, skipped: true, reason: "intent_type != EXECUTION，lessons 反馈不适用" };
  }
  const priorArr = Array.isArray(prior) ? prior : (prior && typeof prior === 'object' ? Object.values(prior) : null);
  const hasPrior = Array.isArray(priorArr) && priorArr.length > 0;
  if (!hasPrior) {
    return { ok: true, skipped: true, reason: "intent.prior_lessons 缺失或为空，无 lessons 需反馈" };
  }
  const expectedCodes = priorArr.map((p) => p && p.code).filter((c) => typeof c === 'string' && c.trim().length > 0);
  const used = ctx.execution && ctx.execution.prior_lessons_used;
  if (!Array.isArray(used) || used.length === 0) {
    return { ok: false, skipped: false, reason: "execution.prior_lessons_used 缺失或为空（prior_lessons 非空任务必须逐条回写落实证据）" };
  }
  const missingFields = used.filter((u) => !u || typeof u.code !== 'string' || u.code.trim().length === 0 || !u.bumped);
  if (missingFields.length > 0) {
    return { ok: false, skipped: false, reason: "execution.prior_lessons_used 存在缺 code 或 bumped 未置真的条目" };
  }
  const usedCodes = new Set(used.map((u) => u.code));
  const uncovered = expectedCodes.filter((c) => !usedCodes.has(c));
  if (uncovered.length > 0) {
    return { ok: false, skipped: false, reason: "execution.prior_lessons_used 未覆盖全部 prior_lessons code（缺失: " + uncovered.join(', ') + "）" };
  }
  return { ok: true, skipped: false, reason: "execution.prior_lessons_used 已回填并覆盖全部 prior_lessons code（" + expectedCodes.length + " 条）" };
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();

  const taskId = args[0];
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  if (fromIdx === -1 || fromIdx + 1 >= args.length) die(2, 'Error: --from <NODE> is required');
  if (toIdx === -1 || toIdx + 1 >= args.length) die(2, 'Error: --to <NODE> is required');
  const FROM = args[fromIdx + 1];
  const TO = args[toIdx + 1];
  // dieMsg: die(1,...) 的失败回写统一出口——先沉淀经验(lessons-recorder)再退出。
  // 失败日志本身是 process 级退出, 经验沉淀副作用在 recorder 内部 try/catch 保护,
  // 任何 IO 错误只 stderr 不阻断退出语义。code 从 msg 提取: [CODE] 前缀;
  // 根因句 = msg 去掉 [CODE] 前缀后的主体。
  function dieMsg(msg, codeOverride) {
    let code = codeOverride;
    let root = msg;
    const m = (msg || "").match(/^\[([A-Z_]+)\]\s*/);
    if (m) {
      if (!code) code = m[1];
      root = msg.slice(m[0].length);
    }
    recordThenDie(1, msg, {
      taskId,
      code: code || "PROCESS_VIOLATION",
      stage: FROM + "->" + TO,
      rootCause: root,
    });
  }

  // 加载 graph.yaml（仅主图）
  // 加载 graph.yaml（仅主图，走 mtime 缓存；读失败由 loadGraphCached 内部 die 处理）
  const graph = loadGraphCached();

  // 校验节点存在性
  for (const n of [FROM, TO]) {
    if (!graph.nodes.has(n)) {
      dieMsg(`[PROCESS_VIOLATION] unknown node "${n}"（graph.yaml 已声明节点: ${[...graph.nodes.keys()].join(', ')}）`);
    }
  }

  // 查边：同一 from→to 可能有多条边（不同 when 条件），逐条求值找第一条满足的
  const candidateEdges = graph.edges.filter((e) => e.from === FROM && e.to === TO);
  if (candidateEdges.length === 0) {
    const outs = graph.edges.filter((e) => e.from === FROM)
      .map((e) => `${FROM} -> ${e.to}${e.when ? ` (when: ${e.when})` : ''}${e.gate ? ` (gate: ${e.gate})` : ''}`);
    dieMsg(`[PROCESS_VIOLATION] no edge ${FROM} -> ${TO} in graph.yaml. 合法出边:\n  ${outs.join('\n  ') || '(无出边——终态节点)'}`);
  }

  // 读 task_context（必须在 init 之后才能流转）
  let ctx;
  try {
    const result = readContext(taskId);
    ctx = result.ctx;
  } catch (e) {
    dieMsg(`[PROCESS_VIOLATION] task_context not initialized for task_id=${taskId}. Run: node scripts/task-context.mjs init ${taskId}`);
  }
  const vars = resolveVars(ctx);

  // 阶段顺序硬门：FROM 必须等于 task_context.current_stage（已设置时），防止跨阶段跳跃
  const actualCurrentStage = ctx.current_stage;
  if (actualCurrentStage && actualCurrentStage !== 'START' && actualCurrentStage !== FROM) {
    dieMsg(`[PROCESS_VIOLATION] stage mismatch: transition claims ${FROM} -> ${TO}, but task_context.current_stage="${actualCurrentStage}"。必须先经 transition-check 逐步流转，不得跳跃。`);
  }

  // INIT 只能从 START 进入：current_stage 已非 START（已流转过）→ 拒绝重复 INIT 空转直通
  if (TO === 'INIT' && actualCurrentStage && actualCurrentStage !== 'START') {
    dieMsg(`[PROCESS_VIOLATION] INIT 只能从 START 进入，但 current_stage="${actualCurrentStage}"（已流转过）。禁止重复 INIT 空转直通。`);
  }

  // 关键字段缺失硬门（在求值 when 之前拒绝，给出明确错误）
  if (FROM === 'INIT') {
    if (vars.intent_type !== 'INQUIRY' && vars.intent_type !== 'EXECUTION') {
      dieMsg(`[PROCESS_VIOLATION] INIT 阶段未写入合法 intent_type（当前=${JSON.stringify(vars.intent_type)}）。必须执行 task-context.mjs set <task_id> intent.intent_type '<INQUIRY|EXECUTION>' --agent conductor`);
    }
    if (!['T0', 'T1', 'T2'].includes(vars.tier)) {
      dieMsg(`[PROCESS_VIOLATION] INIT 阶段未写入合法 tier（当前=${JSON.stringify(vars.tier)}）。必须执行 task-context.mjs set <task_id> sizing.tier '<T0|T1|T2>' --agent conductor`);
    }
  }
  // T0 定级合理性校验：INIT 出口 tier=T0 时，intent.raw 命中逻辑指示词且无 config.custom_overrides.tier 覆盖 → 拒绝 T0 直通
  if (FROM === 'INIT' && vars.tier === 'T0') {
    const t0 = checkT0Eligibility(ctx);
    if (t0.ok === false || t0.status === 'WARN') {
      const override = readCustomOverride(ctx, 'tier');
      if (override !== 'T0') {
        dieMsg(`[PROCESS_VIOLATION] T0 定级不合理：${t0.detail}。建议升 T1；确属机械微改则在同一 batch 内写入 config.custom_overrides.tier=T0 覆盖（该键存在即跳过升级判定）。`);
      }
    }
  }
  // T1 强度合法性校验：INIT 出口 tier=T1 时 t1_strength 必填 ∈ {low, medium, high}
  // config.custom_overrides.t1_strength 显式声明时作为生效值（不阻断）
  if (FROM === 'INIT' && vars.tier === 'T1') {
    const v = validateT1Strength(ctx);
    if (!v.ok) {
      dieMsg('[INVALID_T1_STRENGTH] INIT 阶段 T1 任务未写入合法 t1_strength（' + v.reason + '）。按 init.md §2b 四维度写入 sizing.t1_strength \'<low|medium|high>\'，或 config.custom_overrides.t1_strength 显式覆盖。');
    }
    // T1 low 强度 + 命中升级信号词 → 强制升 high（防该走规划被跳过）
    const t1 = checkT1StrengthEligibility({ ...ctx, sizing: { ...(ctx.sizing || {}), t1_strength: v.effective } });
    if (t1.ok === false || t1.status === 'WARN') {
      if (readCustomOverride(ctx, 't1_strength') !== 'low') {
        dieMsg('[PROCESS_VIOLATION] T1 强度低判: intent.raw 命中升级信号词, t1_strength 强制升 high。' + t1.detail + '。由 conductor 重写 sizing.t1_strength=high 后重新流转。');
      }
    }
  }
  if (FROM === 'QUALITY') {
    if (vars.quality_verdict !== 'PASS' && vars.quality_verdict !== 'CIRCUIT_BREAKER') {
      dieMsg(`[MISSING_QUALITY_VERDICT] QUALITY 阶段未写入合法 verdict（当前=${JSON.stringify(vars.quality_verdict)}）。T1/T2/T3 必须经过 QUALITY hooks（verify/review/fix 循环），写入 quality.verdict ∈ {PASS, CIRCUIT_BREAKER} 后才能离开。`);
    }
  }

  // 多边求值：找第一条 when 满足的边；无 when 的边直接匹配
  let edge = null;
  let lastFailEdge = candidateEdges[0]; // 用于错误信息
  for (const e of candidateEdges) {
    if (!e.when) { edge = e; break; }
    let ok = false;
    try {
      ok = evalAst(parseExpr(tokenize(e.when), e.when), vars);
    } catch (err) {
      dieMsg(`[PROCESS_VIOLATION] when 表达式解析失败: ${err.message}`);
    }
    if (ok) { edge = e; break; }
    lastFailEdge = e;
  }

  if (!edge) {
    const dump = Object.keys(vars).map((k) => `${k}=${JSON.stringify(vars[k])}`).join(' ');
    const allWhens = candidateEdges.map((e) => e.when || '(none)').join(' | ');
    dieMsg(`[PROCESS_VIOLATION] transition ${FROM} -> ${TO} rejected by all when conditions: ${allWhens}\n  current: ${dump}`);
  }

  // ============================================================
  // provenance gate（edge-conditioned，仅 T1/T2 边）
  // 校验 dispatch_log 中是否包含对应阶段的必配角色（防跳步绕过委派）
  // 豁免：T0 边、CIRCUIT_BREAKER 出口；INQUIRY 直通见下方 M1 分支（仅校验 PLANNING roles + post:PLANNING 恒定挂载）
  // ============================================================
  const tier = vars.tier;
  const intentType = vars.intent_type;
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const isT1orT2 = tier === 'T1' || tier === 'T2';
  const isExempt = !isT1orT2;  // T0 边豁免；T1/T2 走 provenance gate；INQUIRY 直通见 M1 分支
  const isCircuitBreakerExit = FROM === 'QUALITY' && TO === 'DELIVERING' && vars.quality_verdict === 'CIRCUIT_BREAKER';
  // T1 直通边（INIT→EXECUTING low/medium）：跳过 PLANNING 设计门，provenance 不要求 PLANNING roles
  // （PLANNING roles 仅在 FROM==='PLANNING' 时加入，天然不命中；此处显式声明豁免语义）
  const isT1DirectEdge = FROM === 'INIT' && TO === 'EXECUTING' && tier === 'T1';

  if (FROM === 'PLANNING' && TO === 'DELIVERING' && intentType === 'INQUIRY') {
    // M1 INQUIRY 直通：仅校验 PLANNING 必配角色 + post:PLANNING 恒定挂载，跳过 EXECUTING/QUALITY roles 与 review tiered mounts
    const provenanceRequired = [...getStageRequiredRoles('PLANNING')];
    const postPreMountsLocal = discoverPostPreConstantMounts();
    for (const m of postPreMountsLocal) {
      if (m.kind === 'post' && m.stage === 'PLANNING') provenanceRequired.push(m.name);
    }
    if (provenanceRequired.length > 0) {
      const dispatchedAgents = new Set(dispatchLog.map((e) => e.agent.replace(/-/g, '_')));
      const requiredNorm = provenanceRequired.map((a) => a.replace(/-/g, '_'));
      const missing = requiredNorm.filter((a) => !dispatchedAgents.has(a));
      if (missing.length > 0) {
        dieMsg(`[PROCESS_VIOLATION] missing dispatch provenance for ${FROM} -> ${TO}: required agents ${JSON.stringify(provenanceRequired)}, missing ${JSON.stringify(missing)}. dispatch_log agents: ${JSON.stringify([...dispatchedAgents])}`);
      }
    }
  } else if (!isExempt && !isCircuitBreakerExit) {
    const provenanceRequired = [];
    if (FROM === 'PLANNING' && TO === 'EXECUTING' && !isT1DirectEdge) {
      provenanceRequired.push(...getStageRequiredRoles('PLANNING'));
    }
    if (FROM === 'EXECUTING' && TO === 'QUALITY') {
      provenanceRequired.push(...getStageRequiredRoles('EXECUTING'));
    }
    if (FROM === 'QUALITY' && TO === 'DELIVERING') {
      // fixer 是 onFail 条件角色（agent/fixer.md mount trigger: onFail）：仅 QUALITY
      // 任一视角 FAIL 时才派发。能走到 QUALITY→DELIVERING 边意味着 quality.verdict ∈
      // {PASS, CIRCUIT_BREAKER}（上文 QUALITY verdict 门禁已保证）；PASS 路径本就无 FAIL
      // → fixer 不派发属正确行为，不得误判 missing provenance 死锁；CIRCUIT_BREAKER 出口
      // 已由 isCircuitBreakerExit 整体豁免。故该边 provenance 校验须过滤条件角色。
      // 其余边（PLANNING→EXECUTING / EXECUTING→QUALITY）的必配角色（planner/coder）无
      // onFail trigger，不受影响，保持全量强制。
      provenanceRequired.push(...getStageRequiredRoles('QUALITY').filter((r) => !isConditionalRole(r)));
    }
    // S9 扩展：post:/pre: 挂载 agent 并入 provenance 校验（tiers 按当前 tier 求值）
    //   PLANNING→EXECUTING：post:PLANNING 定级挂载 agent（如 plan-reviewer）tiers 含当前
    //     sizing.tier 才强制派发——T1 不强制（tiers:[T2] 不含 T1）；T2 命中由 dispatch_log
    //     provenance 校验兜底
    //   EXECUTING→QUALITY：post:EXECUTING 定级挂载 agent tiers 含当前 tier 则必须已派发
    //   QUALITY→DELIVERING：post:QUALITY 定级挂载 agent tiers 含当前 tier 则必须已派发
    //   pre:<TO> 同理：pre:EXECUTING / pre:QUALITY / pre:DELIVERING 定级挂载 agent 按 tiers 求值
    //   防跳过 post:PLANNING 的 plan-reviewer（本次 plan-reviewer 被跳过的根因）
    const postPreMounts = discoverPostPreConstantMounts();
    for (const m of postPreMounts) {
      // post:<FROM> 恒定挂载：FROM 阶段主槽执行后、流转前的钩子
      if (m.kind === 'post' && m.stage === FROM) {
        provenanceRequired.push(m.name);
      }
      // pre:<TO> 恒定挂载：TO 阶段主槽执行前的钩子
      if (m.kind === 'pre' && m.stage === TO) {
        provenanceRequired.push(m.name);
      }
    }
    // 定级挂载（tiers: [T1,T2]）：仅当 sizing.tier ∈ entry.tiers 才纳入 provenance 校验
    const postPreTieredMounts = discoverPostPreTieredMounts();
    for (const m of postPreTieredMounts) {
      if (!Array.isArray(m.tiers) || !m.tiers.includes(tier)) continue;
      if (m.kind === 'post' && m.stage === FROM) {
        provenanceRequired.push(m.name);
      }
      if (m.kind === 'pre' && m.stage === TO) {
        provenanceRequired.push(m.name);
      }
    }
    if (provenanceRequired.length > 0) {
      // 双方统一归一化（连字符→下划线）：dispatch_log 写入时已归一化，required_roles 角色名可能带连字符
      const dispatchedAgents = new Set(dispatchLog.map((e) => e.agent.replace(/-/g, '_')));
      const requiredNorm = provenanceRequired.map((a) => a.replace(/-/g, '_'));
      const missing = requiredNorm.filter((a) => !dispatchedAgents.has(a));
      if (missing.length > 0) {
        dieMsg(`[PROCESS_VIOLATION] missing dispatch provenance for ${FROM} -> ${TO}: required agents ${JSON.stringify(provenanceRequired)}, missing ${JSON.stringify(missing)}. dispatch_log agents: ${JSON.stringify([...dispatchedAgents])}`);
      }
    }
  }

  // 产物非空门禁（防形式 dispatch 但产物空转 / conductor 假写 verdict=PASS）
  // execution 产物校验：所有 EXECUTING 出口（T0->DELIVERING, T1/T2->QUALITY）--diffs/changes/acceptance_map 任一非空
  if (FROM === 'EXECUTING' && (TO === 'QUALITY' || TO === 'DELIVERING')) {
    const exec = ctx.execution || {};
    if (!exec.diffs && !exec.changes && !exec.acceptance_map) {
      dieMsg(codeMsg('MISSING_EXECUTION_PRODUCT', `${FROM} -> ${TO}: execution 产物全空（coder 未产出 diffs/changes/acceptance_map，禁止空转流转）`));
    }
  }
  // INIT→DELIVERING 直通边产物门禁：
  //   INQUIRY 直通豁免——conductor 内建纯问答，分析结论直接输出给用户，不写
  //   execution/plan/verification 产物字段（WRITE_MATRIX 限制 conductor 不能写这些字段）。
  //   防伪造已由上方 T0_ELIGIBILITY 逻辑词检测覆盖（含逻辑词的 intent.raw 被拒），产物门禁多余且有害。
  //   EXECUTION 直通保留产物门禁——T0 极速通道 conductor 会委派 coder 产出 execution 产物，
  //   无产物即空转，必须拒绝。
  if (FROM === 'INIT' && TO === 'DELIVERING' && vars.intent_type === 'EXECUTION') {
    const exec = ctx.execution || {};
    const hasExec = !!(exec.diffs || exec.changes || exec.acceptance_map);
    // 对象有非空 key（排除值为 null/undefined 的 key），数组非空
    const hasNonEmptyKey = (o) => o && typeof o === 'object' && !Array.isArray(o)
      && Object.keys(o).some((k) => o[k] != null);
    const hasPlan = hasNonEmptyKey(ctx.plan);
    // verification 初始为 {"forward":null}，Object.keys().length>0 会误判为有产物；
    // 必须校验 verification.forward 本身非空（对象有非空 key 或数组非空）
    const hasVer = (() => {
      const f = ctx.verification && ctx.verification.forward;
      if (f == null) return false;
      if (Array.isArray(f)) return f.length > 0;
      if (typeof f === 'object') return Object.keys(f).some((k) => f[k] != null);
      return true;
    })();
    if (!hasExec && !hasPlan && !hasVer) {
      dieMsg(codeMsg('MISSING_EXECUTION_PRODUCT', `INIT -> DELIVERING: EXECUTION 直通无可交付产物（execution/plan/verification 全空）。EXECUTION T0 极速通道必须由 coder 产出 execution 产物，禁止空转。`));
    }
  }
  // plan / verification.forward 校验：T1/T2 非 CB 出口
  if (!isExempt && !isCircuitBreakerExit) {
    if (FROM === 'PLANNING' && TO === 'EXECUTING') {
      if (!ctx.plan || typeof ctx.plan !== 'object' || Object.keys(ctx.plan).length === 0) {
        dieMsg(codeMsg('MISSING_PLAN_PRODUCT', `PLANNING -> EXECUTING: plan 为空（planner 未产出方案，禁止空转流转）`));
      }
      // T2 plan_review 熔断：round >= max_rounds 仍 FAIL → 阻断回流，强制 ESCALATE
      const tier = ctx.sizing && ctx.sizing.tier;
      if (tier === 'T2' && ctx.plan_review) {
        const pr = ctx.plan_review;
        const maxR = (typeof pr.max_rounds === 'number') ? pr.max_rounds : 3;
        if (pr.verdict === 'ESCALATE') {
          // ESCALATE = plan-reviewer 判定方案不可修复，允许流转（带降级标记）
        } else if (typeof pr.round === 'number' && pr.round >= maxR && pr.verdict !== 'PASS') {
          dieMsg(codeMsg('PLAN_REVIEW_CB', `PLANNING -> EXECUTING: plan_review.round=${pr.round} >= max_rounds=${maxR} 且 verdict=${pr.verdict}（方案审查熔断，应 ESCALATE 而非回流）`));
        }
      }
    }
    if (FROM === 'QUALITY' && TO === 'DELIVERING') {
      if (!ctx.verification || !ctx.verification.forward) {
        dieMsg(codeMsg('MISSING_VERIFICATION_PRODUCT', `QUALITY -> DELIVERING: verification.forward 为空（verifier 未产出验证结果，禁止 conductor 假写 verdict=PASS）`));
      }
      const evidence = ctx.verification.forward.evidence;
      if (!Array.isArray(evidence) || evidence.length < 1) {
        dieMsg(codeMsg('INSUFFICIENT_EVIDENCE', `QUALITY -> DELIVERING: verification.forward.evidence 数组必填 ≥1 条`));
      }
      for (let i = 0; i < evidence.length; i++) {
        const e = evidence[i];
        if (!e.cmd || typeof e.cmd !== 'string' || e.cmd.trim().length === 0) {
          dieMsg(codeMsg('MISSING_EVIDENCE_FIELD', `evidence[${i}].cmd 缺失或非字符串`));
        }
        if (typeof e.exit !== 'number') {
          dieMsg(codeMsg('MISSING_EVIDENCE_FIELD', `evidence[${i}].exit 缺失或非数字(0/非0)`));
        }
        if (!e.stdout_key || typeof e.stdout_key !== 'string') {
          dieMsg(codeMsg('MISSING_EVIDENCE_FIELD', `evidence[${i}].stdout_key 缺失或非字符串(≤200字关键输出)`));
        }
      }
      // U-W7: verification.forward.byte_level 对象存在性校验（只校验存在性，不校验内部字段）
      const bl = ctx.verification.forward.byte_level;
      if (bl == null || typeof bl !== 'object' || Array.isArray(bl)) {
        dieMsg('[MISSING_BYTE_LEVEL] QUALITY -> DELIVERING: verification.forward.byte_level 缺失或非对象（undefined/null/非对象/数组均不合法）。verifier 必须产出 byte_level 对象（byte-level 验证 SOP 产物），禁止 conductor 假写 verdict=PASS。');
      }
    }
  }
  // INIT→EXECUTING 直通边（T1 low/medium）minimal_gate 门禁：
  // 直通无 plan 产物，conductor 必须补齐 plan.minimal_gate 最小产物（goal + acceptance_criteria≥1 + forbidden_files）
  if (FROM === 'INIT' && TO === 'EXECUTING' && vars.tier === 'T1') {
    const mg = validateMinimalGate(ctx);
    if (!mg.ok) {
      dieMsg('[MISSING_MINIMAL_GATE] INIT -> EXECUTING: T1 直通边缺少 plan.minimal_gate 最小产物（' + mg.reason + '）。conductor 按 T1 直通包规范写入 plan.minimal_gate。');
    }
  }
  // recovery_pending hook (U5): QUALITY->DELIVERING - 上一次 retry 仍未补全 -> 阻断
  // CB 出口豁免 (与 verification.forward 校验同: CB 是用户决策的降级路径)
  if (FROM === 'QUALITY' && TO === 'DELIVERING' && !isCircuitBreakerExit) {
    const stillMissing = checkRecoveryPending(ctx);
    if (Array.isArray(stillMissing) && stillMissing.length > 0) {
      dieMsg(`[RECOVERY_RETRY_EXHAUSTED] QUALITY -> DELIVERING: recovery_log 最后一条 retry (type=write-missing) 标记的字段在 task_context 中仍未补写: ${JSON.stringify(stillMissing)}。请先补写这些字段并重新触发 recovery,否则禁止流转到 DELIVERING。`);
    }
  }

  // KB 经验沉淀 gate（DELIVERING->DONE）：fixing_history 非空（FAIL 转 PASS）必须已写
  // execution.kb_write.fx 且 knowledge-base/fixes/<fx>.md 存在；否则 [MISSING_KB_WRITE] 阻断。
  if (FROM === "DELIVERING" && TO === "DONE") {
    const kb = checkKbWriteGate(ctx);
    if (!kb.ok) {
      dieMsg("[MISSING_KB_WRITE] FAIL转PASS 任务未沉淀经验（跑 node scripts/kb.mjs add 后 set execution.kb_write）。" + kb.reason);
    }
  }

  // lessons 反馈 gate（DELIVERING->DONE）：intent.prior_lessons 非空 + EXECUTION 必须已回写
  // execution.prior_lessons_used（每项含 code+bumped 且覆盖全部 code）；否则 [MISSING_LESSONS_FEEDBACK] 阻断。
  if (FROM === "DELIVERING" && TO === "DONE") {
    const lf = checkLessonsFeedback(ctx);
    if (!lf.ok) {
      dieMsg("[MISSING_LESSONS_FEEDBACK] prior_lessons 非空任务未回写 lessons 落实证据（execution.prior_lessons_used 需含 code+bumped 且覆盖全部 code）。" + lf.reason);
    }
  }

  // premise_audit 必填校验（U1+U2 配套，U3 实现）：T1+ plan 流转 PLANNING->EXECUTING 时
  // 每个 unit 必须带 premise_audit 段（含 existence_cmd + ≥2 alternatives），
  // 拒绝"拍脑袋方案"——planner 必须先 L3 广搜证明假设存在，并列出 ≥2 个备选方案 + 风险评分。
  if (FROM === 'PLANNING' && TO === 'EXECUTING' && !isExempt && !isCircuitBreakerExit) {
    const units = ctx.plan?.task_dag?.units;
    if (Array.isArray(units) && units.length > 0) {
      for (const u of units) {
        const unitId = u.id || u.unit_id || 'unknown';  // 重构:提取 helper
        if (!u.premise_audit) {
          dieMsg(codeMsg('MISSING_PREMISE_AUDIT', `unit=${unitId} — plan.task_dag.units[].premise_audit 必填`));
        }
        if (!u.premise_audit.existence_cmd || typeof u.premise_audit.existence_cmd !== 'string' || u.premise_audit.existence_cmd.trim().length === 0) {
          dieMsg(codeMsg('MISSING_EXISTENCE_CMD', `unit=${unitId} — premise_audit.existence_cmd 必填(L3 广搜命令字面量)`));
        }
        if (!Array.isArray(u.premise_audit.alternatives) || u.premise_audit.alternatives.length < 2) {
          dieMsg(codeMsg('FEW_ALTERNATIVES', `unit=${unitId} — premise_audit.alternatives 必填 ≥ 2 个方案,只有 ${Array.isArray(u.premise_audit.alternatives) ? u.premise_audit.alternatives.length : 0} 个 = 高风险`));
        }
        if (!u.premise_audit.falsifiable_test || typeof u.premise_audit.falsifiable_test !== 'string' || u.premise_audit.falsifiable_test.trim().length === 0) {
          dieMsg(codeMsg('MISSING_FALSIFIABLE_TEST', `unit=${unitId} — premise_audit.falsifiable_test 必填非空(关键前提+验证方法)`));
        }
        if (!Array.isArray(u.premise_audit.user_hints) || u.premise_audit.user_hints.length < 1) {
          dieMsg(codeMsg('MISSING_USER_HINTS', `unit=${unitId} — premise_audit.user_hints 必填 ≥1 数组(用户常识暗示,允许 ["(none)"] 显式声明无)`));
        }
        if (!u.premise_audit.existence_result || typeof u.premise_audit.existence_result !== 'object') {
          dieMsg(codeMsg('MISSING_EXISTENCE_RESULT', `unit=${unitId} — premise_audit.existence_result 必填对象(cmd/stdout_key/hit_count 字段,记录 existence_cmd 实际跑过的结果,杜绝 LLM 写假命令字面量)`));
        }
      }
    }
  }

  // requirement_spread gate（命中扩散触发词时校验扩散包产物）
  if (FROM === 'PLANNING' && TO === 'EXECUTING' && hasSpreadTrigger(ctx.intent?.user_request)) {
    const unitsWithSpread = (ctx.plan?.task_dag || []).filter(u => hasRequirementSpread(u));
    if (unitsWithSpread.length > 0) {
      for (const unit of unitsWithSpread) {
        const errs = validateRequirementSpread(unit);
        if (errs.length > 0) dieMsg(`[PROCESS_VIOLATION] unit ${unit.unit_id} requirement_spread 校验失败: ${errs.join('; ')}`);
      }
    }
  }

  // gate 校验
  if (edge.gate) {
    process.stdout.write(`WARN unknown gate "${edge.gate}"，放行\n`);
  }

  // quality 轮次机械递增（conductor 专属写权限的机械执行臂）
  if (!ctx.quality || typeof ctx.quality !== 'object') {
    const conv = tcReadHooks();
    ctx.quality = {
      round: 0,
      max_rounds: conv.max_total_cycles,
      status: 'running',
      verdict: 'PENDING',
    };
  }
  const quality = ctx.quality;
  if (TO === 'QUALITY') quality.round += 1;

  // 熔断判定（先持久化再退出）
  const maxR = typeof quality.max_rounds === 'number' ? quality.max_rounds : 7;
  if (quality.round >= maxR) {
    quality.status = 'tripped';
    quality.verdict = 'CIRCUIT_BREAKER';
    appendTransitionLog(ctx, FROM, TO);
    ctx.current_stage = TO;
    writeContext(taskId, ctx);
    die(3, `[CIRCUIT_BREAKER] global quality_round=${quality.round} >= max_total_cycles=${maxR}（已写入 quality.verdict=CIRCUIT_BREAKER + current_stage=${TO}，流转到 DELIVERING 带降级标记 [QUALITY_CB]，由用户决策是否继续）`);
  }

  // 写回 task_context：追加 transition_log + current_stage + quality round 原子写入
  appendTransitionLog(ctx, FROM, TO);
  ctx.current_stage = TO;
  writeContext(taskId, ctx);
  process.stdout.write(`PASS transition ${FROM} -> ${TO} (when=${edge.when || 'none'}${edge.gate ? ` gate=${edge.gate}` : ''} | quality_round=${quality.round}/${maxR})\n`);
  // T1 强度显式展示（避免用户疑惑"没走规划"）：INIT 出口时直观标出强度档位与去向
  if (FROM === 'INIT' && vars.tier === 'T1' && (TO === 'EXECUTING' || TO === 'PLANNING')) {
    // effective 复用 validateT1Strength：config.custom_overrides.t1_strength 显式覆盖时显示生效值，不重建逻辑
    const eff = validateT1Strength(ctx).effective || vars.t1_strength;
    if (eff === 'high') {
      process.stdout.write('  T1 强度(t1_strength)=high → 去向: INIT→PLANNING 走完整设计门\n');
    } else {
      process.stdout.write('  T1 强度(t1_strength)=' + (eff || 'low|medium') + ' → 去向: INIT→EXECUTING 直通跳过规划(PLANNING)\n');
    }
  }
  process.exit(0);
}

// ============================================================
// 自检 (U5 AC7: scan-encoding + bash-guard)
// ============================================================
async function runSelfCheck() {
  const eq = (a, b) => { if (a === b) return true; try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
  const assertEq = (label, got, want) => {
    if (!eq(got, want)) {
      console.error('FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
      process.exitCode = 1;
    } else {
      console.log('PASS ' + label);
    }
  };

  assertEq('no recovery_log', checkRecoveryPending({}), null);
  assertEq('empty log', checkRecoveryPending({ recovery_log: [] }), null);
  assertEq('non-retry action', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'noop', timestamp: 1, script_output: {} }] }), null);
  assertEq('non-write-missing type', checkRecoveryPending({ recovery_log: [{ type: 'other', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ field: 'a', present: false }] } }] }), null);
  assertEq('future timestamp', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: Date.now() + 1e9, script_output: { byte_verification: [{ field: 'a', present: false }] } }] }), null);
  assertEq('non-numeric timestamp', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 'xxx', script_output: { byte_verification: [{ field: 'a', present: false }] } }] }), null);
  const r4 = checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ field: 'x', present: false }] } }] });
  assertEq('still missing -> [x]', Array.isArray(r4) && r4.length === 1 && r4[0] === 'x', true);
  assertEq('originally present=true -> []', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ field: 'x', present: true }] } }] }), []);
  assertEq('ctx now populated -> []', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ field: 'a', present: false }] } }], a: 'v' }), []);
  const r7 = checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { missing_fields: ['x'] } }] });
  assertEq('missing_fields compat', Array.isArray(r7) && r7.length === 1 && r7[0] === 'x', true);
  const r8 = checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ field: 'a', present: false }], missing_fields: ['a', 'b'] } }] });
  assertEq('dedup a,b', Array.isArray(r8) && r8.length === 2 && r8.includes('a') && r8.includes('b'), true);
  const r9 = checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: { byte_verification: [{ present: false }, { field: 'z', present: false }] } }] });
  assertEq('skip entry without field', Array.isArray(r9) && r9.length === 1 && r9[0] === 'z', true);
  assertEq('no fields tracked -> []', checkRecoveryPending({ recovery_log: [{ type: 'write-missing', action: 'retry', timestamp: 1, script_output: {} }] }), []);

  // === U3 T1 强度（t1_strength）自检断言 ===
  // ① resolveVars t1_strength 映射
  const rv = resolveVars({ intent: {}, sizing: { tier: 'T1', t1_strength: 'low' } });
  assertEq('resolveVars t1_strength maps sizing.t1_strength', rv.t1_strength, 'low');
  assertEq('resolveVars t1_strength undefined when absent', resolveVars({ intent: {}, sizing: { tier: 'T1' } }).t1_strength, undefined);
  // ② 合法值 low/medium/high 放行
  assertEq('validateT1Strength low ok', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'low' } }).ok, true);
  assertEq('validateT1Strength medium ok', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'medium' } }).ok, true);
  assertEq('validateT1Strength high ok', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'high' } }).ok, true);
  assertEq('validateT1Strength effective returned', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'medium' } }).effective, 'medium');
  // ③ 非法值/缺失阻断
  assertEq('validateT1Strength invalid value blocks', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'super' } }).ok, false);
  assertEq('validateT1Strength missing blocks', validateT1Strength({ sizing: { tier: 'T1' } }).ok, false);
  // ① custom_overrides 显式覆盖生效：**嵌套路径是运行时真实可写路径**（优先断言），根级仅作兼容回落
  assertEq('config.custom_overrides.t1_strength overrides invalid', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'bad' }, config: { custom_overrides: { t1_strength: 'low' } } }).effective, 'low');
  assertEq('custom_overrides.t1_strength (legacy root) still read', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'bad' }, custom_overrides: { t1_strength: 'low' } }).effective, 'low');
  assertEq('nested overrides root (precedence)', validateT1Strength({ sizing: { tier: 'T1', t1_strength: 'bad' }, config: { custom_overrides: { t1_strength: 'high' } }, custom_overrides: { t1_strength: 'low' } }).effective, 'high');
  assertEq('readCustomOverride nested-first', readCustomOverride({ config: { custom_overrides: { tier: 'T0' } } }, 'tier'), 'T0');
  assertEq('readCustomOverride absent', readCustomOverride({ config: {} }, 'tier'), undefined);
  // ④ low + 信号词 → WARN
  const warnR = checkT1StrengthEligibility({ intent: { raw: '需要设计契约与并发机制' }, sizing: { tier: 'T1', t1_strength: 'low' } });
  assertEq('low + escalation word -> WARN', warnR.status === 'WARN' && warnR.ok === false, true);
  // low 无信号词 → PASS；tier!=T1 跳过；strength!=low 跳过
  assertEq('low no signal -> PASS', checkT1StrengthEligibility({ intent: { raw: '简单改一行' }, sizing: { tier: 'T1', t1_strength: 'low' } }).status, 'PASS');
  assertEq('tier=T2 skip', checkT1StrengthEligibility({ intent: { raw: '契约' }, sizing: { tier: 'T2', t1_strength: 'low' } }).status, 'PASS');
  assertEq('strength=high skip', checkT1StrengthEligibility({ intent: { raw: '契约' }, sizing: { tier: 'T1', t1_strength: 'high' } }).status, 'PASS');
  // ⑤ minimal_gate 完整放行 / 缺失阻断
  const goodMg = { plan: { minimal_gate: { goal: 'x', context_anchor: 'a.md:1', acceptance_criteria: ['a'], forbidden_files: [] } } };
  assertEq('minimal_gate ok', validateMinimalGate(goodMg).ok, true);
  assertEq('minimal_gate missing blocks', validateMinimalGate({}).ok, false);
  assertEq('minimal_gate empty goal blocks', validateMinimalGate({ plan: { minimal_gate: { goal: '', context_anchor: 'a.md:1', acceptance_criteria: ['a'], forbidden_files: [] } } }).ok, false);
  assertEq('minimal_gate missing context_anchor blocks', validateMinimalGate({ plan: { minimal_gate: { goal: 'x', acceptance_criteria: ['a'], forbidden_files: [] } } }).ok, false);
  assertEq('minimal_gate empty context_anchor blocks', validateMinimalGate({ plan: { minimal_gate: { goal: 'x', context_anchor: '', acceptance_criteria: ['a'], forbidden_files: [] } } }).ok, false);
  assertEq('minimal_gate empty ac blocks', validateMinimalGate({ plan: { minimal_gate: { goal: 'x', context_anchor: 'a.md:1', acceptance_criteria: [], forbidden_files: [] } } }).ok, false);
  // ⑥ T2 无 strength 不阻断
  assertEq('T2 no strength not blocked', validateT1Strength({ sizing: { tier: 'T2' } }).ok, true);


  // === U5 lessons 反馈 gate 自检断言 ===
  // ① prior_lessons 缺失/空 -> skipped
  assertEq('lessons no prior -> skipped', checkLessonsFeedback({ intent: {} }).ok, true);
  assertEq('lessons empty prior -> skipped', checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [] } }).ok, true);
  assertEq('lessons INQUIRY -> skipped', checkLessonsFeedback({ intent: { intent_type: 'INQUIRY', prior_lessons: [{ code: 'X' }] } }).ok, true);
  // ② 非空 + used 覆盖全部 -> 通过
  const lfOk = checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [{ code: 'X' }] }, execution: { prior_lessons_used: [{ code: 'X', bumped: true, count: 2 }] } });
  assertEq('lessons covered -> ok', lfOk.ok, true);
  assertEq('lessons covered -> not skipped', lfOk.skipped, false);
  // ③ 非空但 used 缺失/空/覆盖不全 -> 失败
  assertEq('lessons used missing -> fail', checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [{ code: 'X' }] }, execution: {} }).ok, false);
  assertEq('lessons used empty -> fail', checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [{ code: 'X' }] }, execution: { prior_lessons_used: [] } }).ok, false);
  assertEq('lessons used no bumped -> fail', checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [{ code: 'X' }] }, execution: { prior_lessons_used: [{ code: 'X', bumped: false }] } }).ok, false);
  assertEq('lessons used partial cover -> fail', checkLessonsFeedback({ intent: { intent_type: 'EXECUTION', prior_lessons: [{ code: 'X' }, { code: 'Y' }] }, execution: { prior_lessons_used: [{ code: 'X', bumped: true }] } }).ok, false);

  const { execSync } = await import('node:child_process');
  const scanOut = execSync('node scripts/scan-encoding.mjs scripts/transition-check.mjs', { encoding: 'utf8' });
  const scanJson = JSON.parse(scanOut);
  const scanFail = scanJson.some((f) => f.checks.some((c) => !c.pass));
  assertEq('scan-encoding self', scanFail, false);

  const guardOut = execSync('node scripts/bash-guard.mjs ""', { encoding: 'utf8' });
  assertEq('bash-guard self', guardOut.includes('PASS'), true);

  console.log(process.exitCode ? 'SELF-CHECK FAILED' : 'ALL SELF-CHECK PASS');
}
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
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
  } else {
    main();
  }
}

