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
//   1 = 非法流转 / gate 未过（[PROCESS_VIOLATION] / [MISSING_MEMORY_WRITE]）
//   2 = 参数错误
//   3 = [CIRCUIT_BREAKER] 熔断（计数已持久化）
//
// when 变量 → task_context 路径映射（按序取首个非 undefined/null）：
//   intent_type     → intent.intent_type ?? intent.transition_context.intent_type
//   tier            → sizing.tier
//   quality_verdict → quality.verdict
//   forward_result  → verification.forward.forward_result ?? verification.forward.verdict
//   reverse_result  → verification.reverse.reverse_result ?? verification.reverse.verdict ?? 'N/A'
//   side_result     → verification.side.side_result ?? verification.side.verdict ?? 'N/A'
//   review_result   → verification.review.review_result ?? verification.review.verdict
// 变量为 undefined/null 时 ==/!=/in 比较结果恒为 false（条件不满足，流转拒绝）。
//
// 计数器规则（v2 响应式 Hooks：CHECKING+REVIEWING+FIXING 合并为 QUALITY）：
//   进入 QUALITY  → quality.round += 1
//   quality.round >= quality.max_rounds → exit 3 [CIRCUIT_BREAKER] global
//   quality.max_rounds 来源：config.yaml hooks.quality.max_total_cycles
//
// gate 语义：
//   MEMORY_WRITE_COMPLETE → memory_write_status ∈ {OK, DEGRADED} 或 memory_write_complete === true
//   旧子图 gate 已废弃，若 graph.yaml 中仍声明则 WARN 放行
//
// 仅使用 Node 内置模块（Node 14 兼容）；graph 解析器为 lifecycle-doctor.mjs
// 本地副本（仓库惯例：脚本自包含）。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContext, writeContext, appendTransitionLog, readHooksFromConfig as tcReadHooks, readConvergenceFromConfig } from './task-context-runtime.mjs';

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

// 动态求值阶段必配角色（主槽 required_roles + POST 钩子审查角色）
// 参考 lifecycle-doctor.mjs 的 extractFrontmatter / parseStageFrontmatter / parseAgentFrontmatter
function getStageRequiredRoles(stageName) {
  const stageLower = stageName.toLowerCase();
  const stagesDir = path.resolve(__dirname, '..', 'lifecycle', 'stages');
  const stagePath = path.resolve(stagesDir, `${stageLower}.md`);
  const roles = [];

  // 路径逃逸防护：fail-closed
  if (!stagePath.startsWith(stagesDir + path.sep) && stagePath !== stagesDir) {
    return roles;
  }

  // 1) 读 stage frontmatter required_roles（主槽角色）
  if (fs.existsSync(stagePath)) {
    const stageText = fs.readFileSync(stagePath, 'utf-8');
    const fm = stageText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const rm = fm[1].match(/^required_roles\s*:\s*\[(.*)\]\s*(?:#.*)?$/m);
      if (rm) {
        roles.push(...rm[1].split(',').map(s => s.trim()).filter(Boolean));
      }
    }
  }

  // 2) 扫 agent/*.md frontmatter mount[].at 匹配 stageName 或 post:stageName（POST 钩子审查角色）
  const agentDir = path.resolve(__dirname, '..', 'agent');
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir)) {
      if (!entry.endsWith('.md')) continue;
      const agentPath = path.join(agentDir, entry);
      const agentText = fs.readFileSync(agentPath, 'utf-8');
      const afm = agentText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!afm) continue;
      // 检查 mount 条目 at 是否匹配 stageName 或 post:stageName
      const mountSection = afm[1].match(/mount\s*:\s*([\s\S]*?)(?=\n[a-z_]+\s*:|\n*$)/);
      if (!mountSection) continue;
      const mountLines = mountSection[1].split(/\r?\n/);
      for (const line of mountLines) {
        const atm = line.match(/^\s*-\s*at\s*:\s*(post:)?(\S+)\s*(?:#.*)?$/);
        if (atm) {
          const prefix = atm[1] || '';
          const atVal = atm[2];
          if (prefix + atVal === `post:${stageName}` || (prefix === '' && atVal === stageName)) {
            const agentName = entry.replace(/\.md$/, '');
            if (!roles.includes(agentName)) roles.push(agentName);
          }
        }
      }
    }
  }

  return roles;
}

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
      '  1 = illegal transition / gate failed ([PROCESS_VIOLATION] / [MISSING_MEMORY_WRITE])',
      '  2 = usage error',
      '  3 = [CIRCUIT_BREAKER] (counters persisted before exit)',
      '',
      'when variables: intent_type tier quality_verdict forward_result reverse_result side_result review_result',
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
  const rev = ver.reverse || {};
  const side = ver.side || {};
  const review = ver.review || {};
  return {
    intent_type: pick(intent.intent_type, intent.transition_context && intent.transition_context.intent_type),
    tier: pick(sizing.tier),
    quality_verdict: pick(ctx.quality && ctx.quality.verdict),
    forward_result: pick(fwd.forward_result, fwd.verdict),
    reverse_result: pick(rev.reverse_result, rev.verdict, 'N/A'),
    side_result: pick(side.side_result, side.verdict, 'N/A'),
    review_result: pick(review.review_result, review.verdict),
    memory_write_status: pick(ctx.memory_write_status, ctx.delivery && ctx.delivery.memory_write_status),
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

  // 主图已不存在子图节点；若仍出现 MM_* 节点则视为流程违规
  for (const n of [FROM, TO]) {
    if (/^MM_/.test(n)) {
      die(1, `[PROCESS_VIOLATION] "${n}" 已废弃（T3 改为阶段级多模型并行，主图不再有子图节点）`);
    }
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
  if (FROM === 'INTENT') {
    if (vars.intent_type !== 'INQUIRY' && vars.intent_type !== 'EXECUTION') {
      die(1, `[PROCESS_VIOLATION] INTENT 阶段未写入合法 intent_type（当前=${JSON.stringify(vars.intent_type)}）。必须执行 task-context.mjs set <task_id> intent.intent_type '<INQUIRY|EXECUTION>' --agent conductor`);
    }
  }
  if (FROM === 'SIZING') {
    if (!['T0', 'T1', 'T2', 'T3'].includes(vars.tier)) {
      die(1, `[PROCESS_VIOLATION] SIZING 阶段未写入合法 tier（当前=${JSON.stringify(vars.tier)}）。必须执行 task-context.mjs set <task_id> sizing.tier '<T0|T1|T2|T3>' --agent conductor`);
    }
  }
  if (FROM === 'QUALITY') {
    if (vars.quality_verdict !== 'PASS' && vars.quality_verdict !== 'CIRCUIT_BREAKER') {
      die(1, `[MISSING_QUALITY_VERDICT] QUALITY 阶段未写入合法 verdict（当前=${JSON.stringify(vars.quality_verdict)}）。T1/T2/T3 必须经过 QUALITY hooks（verify/review/fix 循环），写入 quality.verdict ∈ {PASS, CIRCUIT_BREAKER} 后才能离开。`);
    }
    // QUALITY→DELIVERING full 模式：reverse/side 非 PASS/FAIL/CONDITIONAL_PASS 时拒绝流转
    // 判据改为白名单：仅 PASS/FAIL/CONDITIONAL_PASS 为合法值；N/A/PENDING/SKIPPED/''/null/undefined/0/false 均拒绝
    // 修复 I1 U9 逃逸：原 === 'N/A' 严格比较可被 PENDING/SKIPPED/''/0/false 绕过
    if (TO === 'DELIVERING' && vars.quality_verdict === 'PASS') {
      const reviewMode = (ctx.config && ctx.config.review_mode) || 'none';
      if (reviewMode === 'full') {
        const VALID_RESULTS = new Set(['PASS', 'FAIL', 'CONDITIONAL_PASS']);
        const missing = [];
        const normalizeResult = (v) => (v != null ? String(v).trim().toUpperCase() : '');
        if (!VALID_RESULTS.has(normalizeResult(vars.reverse_result))) missing.push('reverse_auditor');
        if (!VALID_RESULTS.has(normalizeResult(vars.side_result))) missing.push('side_checker');
        if (missing.length > 0) {
          die(1, `[DEGRADED] full 模式 QUALITY→DELIVERING 缺少审查视角结果: ${missing.join(', ')} 非 PASS/FAIL/CONDITIONAL_PASS（reverse_result=${JSON.stringify(vars.reverse_result)} side_result=${JSON.stringify(vars.side_result)}）。请确认对应 agent 已执行并写入 verification 结果。`);
        }
      }
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

  // gate 校验
  if (edge.gate) {
    if (edge.gate === 'MEMORY_WRITE_COMPLETE') {
      const mws = pick(ctx.memory_write_status, ctx.delivery && ctx.delivery.memory_write_status);
      const tier = pick(ctx.sizing && ctx.sizing.tier);
      // T0/INQUIRY 按价值信号触发，可能不写 memory → SKIPPED 放行；T1+ 必须 OK/DEGRADED
      const gateOk = (tier === 'T0' && (mws === 'OK' || mws === 'DEGRADED' || mws === 'SKIPPED'))
        || (tier !== 'T0' && (mws === 'OK' || mws === 'DEGRADED'))
        || ctx.memory_write_complete === true;
      if (!gateOk) {
        die(1, `[MISSING_MEMORY_WRITE] gate MEMORY_WRITE_COMPLETE failed: memory_write_status=${JSON.stringify(mws)} memory_write_complete=${JSON.stringify(ctx.memory_write_complete)} tier=${JSON.stringify(tier)}（DELIVERING 须先执行 M4-M8 并写入 memory_write_status；T0 允许 SKIPPED）`);
      }
    } else {
      process.stdout.write(`WARN unknown gate "${edge.gate}"（子图 gate 不在主图校验范围），放行\n`);
    }
  }

  // ============================================================
  // provenance gate（edge-conditioned，仅 T1/T2 EXECUTION 边）
  // 检查 dispatch_log 中是否包含对应阶段的 agent 记录
  // 豁免：T0 边（SIZING→DELIVERING / SIZING→EXECUTING）、INQUIRY 全部边
  // （含 PLANNING→QUALITY / QUALITY→DELIVERING）
  // T3 已无子图，主图正常产生 dispatch 记录；QUALITY→DELIVERING 的 required
  // 集合按 task_context.config.agents 中为 true 的视角动态求值（不静态要求 4 视角）；
  // CIRCUIT_BREAKER 出口豁免本门（熔断逃逸不受缺日志阻塞，CB 路径 hooks 可能未全跑）。
  // ============================================================
  const tier = vars.tier;
  const intentType = vars.intent_type;
  const dispatchLog = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];

  // 门仅对 EXECUTION 意图的 T1/T2/T3 生效；T0/INQUIRY 一律豁免
  const isT1orT2 = tier === 'T1' || tier === 'T2' || tier === 'T3';
  const isExempt = intentType !== 'EXECUTION' || !isT1orT2;
  // CIRCUIT_BREAKER 出口豁免：熔断逃逸不受 provenance 缺记录阻塞
  const isCircuitBreakerExit = FROM === 'QUALITY' && TO === 'DELIVERING' && vars.quality_verdict === 'CIRCUIT_BREAKER';

  if (!isExempt && !isCircuitBreakerExit) {
    const provenanceRequired = [];
    if (FROM === 'PLANNING' && TO === 'EXECUTING') {
      // 动态求值：读 planning.md required_roles + 扫 agent/*.md post:PLANNING 挂载的审查角色
      // 求值结果等价于原硬编码 [planner, plan-reviewer]
      // T3 阶段级多模型并行仍走 PLANNING→EXECUTING，multiModel 替代 planner 主槽但同阶段输出仍由 planning.md required_roles 定义
      const planningRoles = getStageRequiredRoles('PLANNING');
      // 按 config.agents 过滤 when 条件：planner:false 时移除 planner；multiModel:false 时移除 multiModel
      // T3（planner:false+multiModel:true）→ 要求 [multiModel, plan-reviewer]
      // T1/T2（planner:true+multiModel:false）→ 要求 [planner, plan-reviewer]
      const agentsCfgP = (ctx.config && ctx.config.agents && typeof ctx.config.agents === 'object') ? ctx.config.agents : null;
      for (const role of planningRoles) {
        if (role === 'planner' && agentsCfgP && agentsCfgP.planner === false) continue;
        if (role === 'multiModel' && agentsCfgP && agentsCfgP.multiModel === false) continue;
        provenanceRequired.push(role);
      }
    }
    if (FROM === 'EXECUTING' && TO === 'QUALITY') {
      // 动态求值：读 executing.md required_roles
      // 求值结果等价于原硬编码 [coder]
      provenanceRequired.push(...getStageRequiredRoles('EXECUTING'));
      // 额外校验：execution.acceptance_map 存在性 + 每条含 implementation+verification 双字段
      // 迁移宽限：仅当 task_context 存在 execution.changes 或 execution.code 时要求 acceptance_map
      // （旧飞行任务无此字段则跳过校验，避免误伤历史 context；有 changes/code 说明是新执行任务，必须提供）
      const hasExecutionArtifacts = (ctx.execution && (
        (Array.isArray(ctx.execution.changes) ? ctx.execution.changes.length > 0 : !!ctx.execution.changes) ||
        (Array.isArray(ctx.execution.code) ? ctx.execution.code.length > 0 : !!ctx.execution.code)
      ));
      if (hasExecutionArtifacts) {
        const am = ctx.execution && ctx.execution.acceptance_map;
        if (!am || !Array.isArray(am) || am.length === 0) {
          die(1, `[MISSING_ACCEPTANCE_MAP] execution.acceptance_map 缺失或为空（EXECUTING→QUALITY 必须包含验收映射表）`);
        }
        for (let i = 0; i < am.length; i++) {
          const item = am[i];
          if (!item || typeof item !== 'object') {
            die(1, `[MISSING_ACCEPTANCE_MAP] execution.acceptance_map[${i}] 不是有效对象`);
          }
          if (!item.implementation) {
            die(1, `[MISSING_ACCEPTANCE_MAP] execution.acceptance_map[${i}] 缺少 implementation 字段`);
          }
          if (!item.verification) {
            die(1, `[MISSING_ACCEPTANCE_MAP] execution.acceptance_map[${i}] 缺少 verification 字段`);
          }
        }
      }
    }
    if (FROM === 'QUALITY' && TO === 'DELIVERING') {
      // 动态求值（不静态要求 4 视角）：
      //   必配视角（quality.md required_roles，动态读取）→ verifier / reviewer
      //   可选视角（config.agents 中为 true 才要求）→ reverse_auditor / side_checker
      // T1 side_checker=false 时仅要求 reverse_auditor（可选视角），缺 side_checker 不阻塞。
      const MANDATORY = getStageRequiredRoles('QUALITY');
      const OPTIONAL = ['reverse_auditor', 'side_checker'];
      const agentsCfg = (ctx.config && ctx.config.agents && typeof ctx.config.agents === 'object') ? ctx.config.agents : null;
      if (agentsCfg) {
        provenanceRequired.push(...MANDATORY);
        for (const p of OPTIONAL) {
          if (agentsCfg[p] === true) provenanceRequired.push(p);
        }
      } else {
        // config.agents 缺失（异常态/旧上下文）：保守回退静态 4 视角（fail-closed）
        provenanceRequired.push(...MANDATORY, ...OPTIONAL);
      }
    }

    if (provenanceRequired.length > 0) {
      const dispatchedAgents = new Set(dispatchLog.map((e) => e.agent));
      const missing = provenanceRequired.filter((a) => !dispatchedAgents.has(a));
      if (missing.length > 0) {
        die(1, `[PROCESS_VIOLATION] missing dispatch provenance for ${FROM} -> ${TO}: required agents ${JSON.stringify(provenanceRequired)}, missing ${JSON.stringify(missing)}. dispatch_log agents: ${JSON.stringify([...dispatchedAgents])}`);
      }
    }
  }

  // quality 轮次机械递增（conductor 专属写权限的机械执行臂）
  if (!ctx.convergence || typeof ctx.convergence !== 'object') {
    const convCfg = readConvergenceFromConfig();
    ctx.convergence = {
      mm_fusion_rounds: 0,
      mm_fusion_max_rounds: convCfg.mm_fusion_max_rounds,
    };
  }
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
  const maxR = typeof quality.max_rounds === 'number' ? quality.max_rounds : 4;
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
