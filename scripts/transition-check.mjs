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
import { discoverPostPreConstantMounts } from './lib/post-pre-mounts.mjs';
import { getStageRequiredRoles, isConditionalRole } from './lib/stage-roles.mjs';

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

function resolveVars(ctx) {
  const intent = ctx.intent || {};
  const sizing = ctx.sizing || {};
  const ver = ctx.verification || {};
  const fwd = ver.forward || {};
  const review = ver.review || {};
  return {
    intent_type: pick(intent.intent_type, intent.transition_context && intent.transition_context.intent_type),
    tier: pick(sizing.tier),
    quality_verdict: pick(ctx.quality && ctx.quality.verdict),
    forward_result: pick(fwd.forward_result, fwd.verdict),
    review_result: pick(review.review_result, review.verdict),
  };
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

  // 加载 graph.yaml（仅主图）
  let graphText;
  try {
    graphText = fs.readFileSync(GRAPH_PATH, 'utf8');
  } catch (e) {
    die(1, `Error: cannot read graph.yaml: ${e.message}`);
  }
  const graph = parseGraphFile(graphText);

  // 校验节点存在性
  for (const n of [FROM, TO]) {
    if (!graph.nodes.has(n)) {
      die(1, `[PROCESS_VIOLATION] unknown node "${n}"（graph.yaml 已声明节点: ${[...graph.nodes.keys()].join(', ')}）`);
    }
  }

  // 查边：同一 from→to 可能有多条边（不同 when 条件），逐条求值找第一条满足的
  const candidateEdges = graph.edges.filter((e) => e.from === FROM && e.to === TO);
  if (candidateEdges.length === 0) {
    const outs = graph.edges.filter((e) => e.from === FROM)
      .map((e) => `${FROM} -> ${e.to}${e.when ? ` (when: ${e.when})` : ''}${e.gate ? ` (gate: ${e.gate})` : ''}`);
    die(1, `[PROCESS_VIOLATION] no edge ${FROM} -> ${TO} in graph.yaml. 合法出边:\n  ${outs.join('\n  ') || '(无出边——终态节点)'}`);
  }

  // 读 task_context（必须在 init 之后才能流转）
  let ctx;
  try {
    const result = readContext(taskId);
    ctx = result.ctx;
  } catch (e) {
    die(1, `[PROCESS_VIOLATION] task_context not initialized for task_id=${taskId}. Run: node scripts/task-context.mjs init ${taskId}`);
  }
  const vars = resolveVars(ctx);

  // 阶段顺序硬门：FROM 必须等于 task_context.current_stage（已设置时），防止跨阶段跳跃
  const actualCurrentStage = ctx.current_stage;
  if (actualCurrentStage && actualCurrentStage !== 'START' && actualCurrentStage !== FROM) {
    die(1, `[PROCESS_VIOLATION] stage mismatch: transition claims ${FROM} -> ${TO}, but task_context.current_stage="${actualCurrentStage}"。必须先经 transition-check 逐步流转，不得跳跃。`);
  }

  // 关键字段缺失硬门（在求值 when 之前拒绝，给出明确错误）
  if (FROM === 'INIT') {
    if (vars.intent_type !== 'INQUIRY' && vars.intent_type !== 'EXECUTION') {
      die(1, `[PROCESS_VIOLATION] INIT 阶段未写入合法 intent_type（当前=${JSON.stringify(vars.intent_type)}）。必须执行 task-context.mjs set <task_id> intent.intent_type '<INQUIRY|EXECUTION>' --agent conductor`);
    }
    if (!['T0', 'T1', 'T2'].includes(vars.tier)) {
      die(1, `[PROCESS_VIOLATION] INIT 阶段未写入合法 tier（当前=${JSON.stringify(vars.tier)}）。必须执行 task-context.mjs set <task_id> sizing.tier '<T0|T1|T2>' --agent conductor`);
    }
  }
  if (FROM === 'QUALITY') {
    if (vars.quality_verdict !== 'PASS' && vars.quality_verdict !== 'CIRCUIT_BREAKER') {
      die(1, `[MISSING_QUALITY_VERDICT] QUALITY 阶段未写入合法 verdict（当前=${JSON.stringify(vars.quality_verdict)}）。T1/T2/T3 必须经过 QUALITY hooks（verify/review/fix 循环），写入 quality.verdict ∈ {PASS, CIRCUIT_BREAKER} 后才能离开。`);
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
      die(1, `[PROCESS_VIOLATION] when 表达式解析失败: ${err.message}`);
    }
    if (ok) { edge = e; break; }
    lastFailEdge = e;
  }

  if (!edge) {
    const dump = Object.keys(vars).map((k) => `${k}=${JSON.stringify(vars[k])}`).join(' ');
    const allWhens = candidateEdges.map((e) => e.when || '(none)').join(' | ');
    die(1, `[PROCESS_VIOLATION] transition ${FROM} -> ${TO} rejected by all when conditions: ${allWhens}\n  current: ${dump}`);
  }

  // ============================================================
  // provenance gate（edge-conditioned，仅 T1/T2 EXECUTION 边）
  // 校验 dispatch_log 中是否包含对应阶段的必配角色（防跳步绕过委派）
  // 豁免：T0 边、INQUIRY 边、CIRCUIT_BREAKER 出口
  // ============================================================
  const tier = vars.tier;
  const intentType = vars.intent_type;
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const isT1orT2 = tier === 'T1' || tier === 'T2';
  const isExempt = intentType !== 'EXECUTION' || !isT1orT2;
  const isCircuitBreakerExit = FROM === 'QUALITY' && TO === 'DELIVERING' && vars.quality_verdict === 'CIRCUIT_BREAKER';

  if (!isExempt && !isCircuitBreakerExit) {
    const provenanceRequired = [];
    if (FROM === 'PLANNING' && TO === 'EXECUTING') {
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
    // S9 扩展：post:/pre: 恒定挂载 agent 并入 provenance 校验
    //   PLANNING→EXECUTING：post:PLANNING 恒定挂载 agent（如 plan-reviewer）必须已派发
    //   EXECUTING→QUALITY：post:EXECUTING 恒定挂载 agent 必须已派发
    //   QUALITY→DELIVERING：post:QUALITY 恒定挂载 agent 必须已派发
    //   pre:<TO> 同理：pre:EXECUTING / pre:QUALITY / pre:DELIVERING 恒定挂载 agent
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
    if (provenanceRequired.length > 0) {
      // 双方统一归一化（连字符→下划线）：dispatch_log 写入时已归一化，required_roles 角色名可能带连字符
      const dispatchedAgents = new Set(dispatchLog.map((e) => e.agent.replace(/-/g, '_')));
      const requiredNorm = provenanceRequired.map((a) => a.replace(/-/g, '_'));
      const missing = requiredNorm.filter((a) => !dispatchedAgents.has(a));
      if (missing.length > 0) {
        die(1, `[PROCESS_VIOLATION] missing dispatch provenance for ${FROM} -> ${TO}: required agents ${JSON.stringify(provenanceRequired)}, missing ${JSON.stringify(missing)}. dispatch_log agents: ${JSON.stringify([...dispatchedAgents])}`);
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
  process.exit(0);
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
  main();
}
