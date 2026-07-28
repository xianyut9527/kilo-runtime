#!/usr/bin/env node
// transition-check.mjs
// 运行时流转校验器 — graph.yaml DAG 流转的机械裁判 + 收敛计数器机械递增。
//
// 定位：conductor 每次跨节点流转前必须调用本脚本校验合法性。
// "模型提议流转、脚本裁判合法性"——把软约束（提示词）变为硬约束（退出码）。
// 计数器（convergence.total_rounds / round）由本脚本机械递增，是 conductor
// 专属写权限的机械执行臂；coder/fixer/subagents 禁止使用本脚本，
// conductor 也不得绕过本脚本手工 set convergence 计数字段（[PROCESS_VIOLATION]）。
//
// 用法：
//   node scripts/transition-check.mjs <task_id> --from <NODE> --to <NODE>
//   node scripts/transition-check.mjs --help
//
// 退出码：
//   0 = 合法流转（计数已递增并持久化）
//   1 = 非法流转 / gate 未过（[PROCESS_VIOLATION] / [MISSING_MEMORY_WRITE]）
//   2 = 参数错误
//   3 = [CIRCUIT_BREAKER] 熔断（计数已持久化）
//
// when 变量 → task_context 路径映射（按序取首个非 undefined/null）：
//   intent_type     → intent.intent_type ?? intent.transition_context.intent_type
//   tier            → sizing.tier
//   forward_result  → verification.forward.forward_result ?? verification.forward.verdict
//   reverse_result  → verification.reverse.reverse_result ?? verification.reverse.verdict ?? 'N/A'
//   side_result     → verification.side.side_result ?? verification.side.verdict ?? 'N/A'
//   review_result   → verification.review.review_result ?? verification.review.verdict
//   subgraph_status → subgraph_status（顶层）
// 变量为 undefined/null 时 ==/!=/in 比较结果恒为 false（条件不满足，流转拒绝）。
//
// 计数器规则（when/gate 校验通过后执行；触发熔断也先持久化再退出）：
//   to ∈ {CHECKING, REVIEWING}  → total_rounds += 1
//   to ∈ {REVIEWING, DELIVERING} → round = 0（前序失败点已消除）
//   to == FIXING                → round += 1
//   total_rounds >= max_total_rounds → exit 3 [CIRCUIT_BREAKER] global
//   round >= max_rounds              → exit 3 [CIRCUIT_BREAKER] single-point
//
// gate 语义：
//   MEMORY_WRITE_COMPLETE → memory_write_status ∈ {OK, DEGRADED} 或 memory_write_complete === true
//   其他 gate（如 FUSION_SELF_CHECK_10，属子图）→ WARN 放行
//
// 仅使用 Node 内置模块（Node 14 兼容）；graph 解析器为 lifecycle-doctor.mjs
// 本地副本（仓库惯例：脚本自包含）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContext, writeContext } from './task-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_PATH = path.resolve(__dirname, '..', 'lifecycle', 'graph.yaml');
const CONVERGENCE_SOURCE = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');

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
    '  node scripts/transition-check.mjs <task_id> --from <NODE> --to <NODE>',
    '  node scripts/transition-check.mjs --help',
    '',
    'Mechanical DAG transition judge + convergence counter clerk (conductor-only).',
    '',
    'Exit codes:',
    '  0 = legal transition (counters incremented & persisted)',
    '  1 = illegal transition / gate failed ([PROCESS_VIOLATION] / [MISSING_MEMORY_WRITE])',
    '  2 = usage error',
    '  3 = [CIRCUIT_BREAKER] (counters persisted before exit)',
    '',
    'when variables: intent_type tier forward_result reverse_result side_result review_result subgraph_status',
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

// 从 lifecycle/config.yaml 读取收敛阈值（task-context.mjs 本地副本；失败降级 5/7）
function readConvergenceFromConfig() {
  try {
    const text = fs.readFileSync(CONVERGENCE_SOURCE, 'utf8');
    const mr = text.match(/^\s*max_rounds:\s*(\d+)/m);
    const mtr = text.match(/^\s*max_total_rounds:\s*(\d+)/m);
    return {
      max_rounds: mr ? parseInt(mr[1], 10) : 5,
      max_total_rounds: mtr ? parseInt(mtr[1], 10) : 7,
    };
  } catch {
    return { max_rounds: 5, max_total_rounds: 7 };
  }
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
  const rev = ver.reverse || {};
  const side = ver.side || {};
  const review = ver.review || {};
  return {
    intent_type: pick(intent.intent_type, intent.transition_context && intent.transition_context.intent_type),
    tier: pick(sizing.tier),
    forward_result: pick(fwd.forward_result, fwd.verdict),
    reverse_result: pick(rev.reverse_result, rev.verdict, 'N/A'),
    side_result: pick(side.side_result, side.verdict, 'N/A'),
    review_result: pick(review.review_result, review.verdict),
    subgraph_status: pick(ctx.subgraph_status),
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

  // 子图节点（MM_* 除 MM_SUBGRAPH 外）不在本脚本范围
  for (const n of [FROM, TO]) {
    if (/^MM_/.test(n) && n !== 'MM_SUBGRAPH') {
      die(1, `[PROCESS_VIOLATION] "${n}" 是子图内部节点，子图流转不在本脚本范围（multiModel 主权）`);
    }
    if (!graph.nodes.has(n)) {
      die(1, `[PROCESS_VIOLATION] unknown node "${n}"（graph.yaml 已声明节点: ${[...graph.nodes.keys()].join(', ')}）`);
    }
  }

  // 查边
  const edge = graph.edges.find((e) => e.from === FROM && e.to === TO);
  if (!edge) {
    const outs = graph.edges.filter((e) => e.from === FROM)
      .map((e) => `${FROM} -> ${e.to}${e.when ? ` (when: ${e.when})` : ''}${e.gate ? ` (gate: ${e.gate})` : ''}`);
    die(1, `[PROCESS_VIOLATION] no edge ${FROM} -> ${TO} in graph.yaml. 合法出边:\n  ${outs.join('\n  ') || '(无出边——终态节点)'}`);
  }

  // 读 task_context
  const { ctx } = readContext(taskId);
  const vars = resolveVars(ctx);

  // when 求值
  if (edge.when) {
    let ok = false;
    try {
      ok = evalAst(parseExpr(tokenize(edge.when), edge.when), vars);
    } catch (e) {
      die(1, `[PROCESS_VIOLATION] when 表达式解析失败: ${e.message}`);
    }
    if (!ok) {
      const dump = Object.keys(vars).map((k) => `${k}=${JSON.stringify(vars[k])}`).join(' ');
      die(1, `[PROCESS_VIOLATION] transition ${FROM} -> ${TO} rejected by when: ${edge.when}\n  current: ${dump}`);
    }
  }

  // gate 校验
  if (edge.gate) {
    if (edge.gate === 'MEMORY_WRITE_COMPLETE') {
      const mws = pick(ctx.memory_write_status, ctx.delivery && ctx.delivery.memory_write_status);
      const gateOk = mws === 'OK' || mws === 'DEGRADED' || ctx.memory_write_complete === true;
      if (!gateOk) {
        die(1, `[MISSING_MEMORY_WRITE] gate MEMORY_WRITE_COMPLETE failed: memory_write_status=${JSON.stringify(mws)} memory_write_complete=${JSON.stringify(ctx.memory_write_complete)}（DELIVERING 须先执行 M4-M8 并写入 memory_write_status）`);
      }
    } else {
      process.stdout.write(`WARN unknown gate "${edge.gate}"（子图 gate 不在主图校验范围），放行\n`);
    }
  }

  // 计数器机械递增（conductor 专属写权限的机械执行臂）
  if (!ctx.convergence || typeof ctx.convergence !== 'object') {
    const conv = readConvergenceFromConfig();
    ctx.convergence = { round: 0, max_rounds: conv.max_rounds, total_rounds: 0, max_total_rounds: conv.max_total_rounds };
  }
  const conv = ctx.convergence;
  if (TO === 'CHECKING' || TO === 'REVIEWING') conv.total_rounds += 1;
  if (TO === 'REVIEWING' || TO === 'DELIVERING') conv.round = 0;
  if (TO === 'FIXING') conv.round += 1;

  // 熔断判定（先持久化再退出）
  const maxR = typeof conv.max_rounds === 'number' ? conv.max_rounds : 5;
  const maxT = typeof conv.max_total_rounds === 'number' ? conv.max_total_rounds : 7;
  if (conv.total_rounds >= maxT) {
    writeContext(taskId, ctx);
    die(3, `[CIRCUIT_BREAKER] global total_rounds=${conv.total_rounds} >= max_total_rounds=${maxT}（停止修复，task_context.status=PAUSED 等用户决策）`);
  }
  if (conv.round >= maxR) {
    writeContext(taskId, ctx);
    die(3, `[CIRCUIT_BREAKER] single-point round=${conv.round} >= max_rounds=${maxR}（同一失败点修复轮次耗尽，task_context.status=PAUSED 等用户决策）`);
  }

  // 写回 task_context：同步 current_stage + 计数器
  ctx.current_stage = TO;
  writeContext(taskId, ctx);
  process.stdout.write(`PASS transition ${FROM} -> ${TO} (when=${edge.when || 'none'}${edge.gate ? ` gate=${edge.gate}` : ''} | total_rounds=${conv.total_rounds} round=${conv.round})\n`);
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
