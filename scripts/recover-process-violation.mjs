#!/usr/bin/env node
// recover-process-violation.mjs
// PROCESS_VIOLATION 机械恢复器 — 诊断 stage-mismatch / provenance-missing / illegal-transition 三类违规，
// 返回 recovery_options[] + recommended，conductor 据此选恢复策略。
//
// 定位：
//   - 由 conductor 在检测到 [PROCESS_VIOLATION] 时调用（先于人工决策）
//   - 不修改 task_context（只读 ctx + 输出 JSON 建议）
//   - 仅 Node 内置模块；跨平台 Windows PowerShell + Linux bash
//
// 用法：
//   node scripts/recover-process-violation.mjs <task_id> --violation-type <stage-mismatch|provenance-missing|illegal-transition> [--from <NODE>] [--expected <NODE>]
//   node scripts/recover-process-violation.mjs --help
//
// 退出码：
//   0 = recoverable（建议 retry-transition / re-dispatch 之一）
//   1 = needs-pause（结构损坏，必须挂起人工决策）
//   2 = usage error
//   3 = circuit-breaker（quality.round >= max_total_cycles）
//
// 输出（JSON）：
//   task_id / violation_type / current_stage / expected_stage
//   legal_out_edges[] / provenance_missing[] / recovery_options[] / recommended
//   circuit_breaker / timestamp

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readContext, readHooksFromConfig } from "./task-context-runtime.mjs";
import { verifyField, verifyFields } from "./lib/byte-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_PATH = path.resolve(__dirname, "..", "lifecycle", "graph.yaml");

const VIOLATION_TYPES = new Set(["stage-mismatch", "provenance-missing", "illegal-transition"]);

// ============================================================
// graph.yaml 迷你解析器（与 transition-check.mjs 同源思路，脚本自包含）
// ============================================================

function stripComment(line) {
  const idx = line.search(/\s#/);
  if (idx >= 0) return line.slice(0, idx);
  if (/^\s*#/.test(line)) return "";
  return line;
}

function parseGraph(text) {
  const nodes = new Map();
  const edges = [];
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
        if (key === "nodes") { section = "nodes"; curNode = null; continue; }
        if (key === "edges") { section = "edges"; curEdge = null; continue; }
      }
      continue;
    }
    if (section === "nodes") {
      const idm = line.match(/^\s*-\s*id\s*:\s*(\S+)\s*$/);
      if (idm) { curNode = { id: idm[1] }; nodes.set(curNode.id, curNode); continue; }
      continue;
    }
    if (section === "edges") {
      const inline = line.match(/^\s*-\s*\{(.+)\}\s*$/);
      if (inline) {
        const e = {};
        for (const part of inline[1].split(",")) {
          const kv = part.match(/([a-z_]+)\s*:\s*(.+)$/);
          if (kv) e[kv[1].trim()] = kv[2].trim().replace(/^["'"'"']|["'"'"']$/g, "");
        }
        edges.push(e);
        curEdge = null;
        continue;
      }
      const fromM = line.match(/^\s*-\s*from\s*:\s*(\S+)\s*$/);
      if (fromM) { curEdge = { from: fromM[1] }; edges.push(curEdge); continue; }
      const fm = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (fm && curEdge) {
        const [, key, val] = fm;
        curEdge[key] = val.trim().replace(/^["'"'"']|["'"'"']$/g, "");
      }
    }
  }
  return { nodes, edges };
}

function loadGraph() {
  let text;
  try { text = fs.readFileSync(GRAPH_PATH, "utf8"); }
  catch (e) { return { error: `cannot read graph.yaml: ${e.message}` }; }
  return parseGraph(text);
}

// ============================================================
// stage -> provenance 字段映射（按 fromNode 阶段定义必经产物）
// ============================================================

const STAGE_PROVENANCE = {
  EXECUTING:  ["execution.diffs", "execution.changes", "execution.acceptance_map"],
  QUALITY:    ["verification.forward", "quality.verdict"],
  DELIVERING: ["execution.diffs", "verification.forward"],
  PLANNING:   ["plan.task_dag"],
  INIT:       ["intent.intent_type", "sizing.tier"],
};

// ============================================================
// dispatch_log 必经 agent 推断（顶层字段名 → 智能体角色）
// ============================================================

const PROVENANCE_TO_AGENT = {
  execution: "coder",
  verification: "verifier",
  plan: "planner",
};

// ============================================================
// 恢复策略构造器
// ============================================================

function buildRecoveryOptions({ fromNode, expectedNode, legalOutEdges, provenanceMissing, circuitBroken }) {
  const opts = [];

  if (circuitBroken) {
    opts.push({
      id: "circuit-breaker-pause",
      risk: "high",
      desc: "quality.round >= max_total_cycles → 强制挂起，等人工决策或升级 tier",
      action: "pause",
    });
    return opts;
  }

  if (legalOutEdges.length > 0 && expectedNode && legalOutEdges.includes(expectedNode)) {
    opts.push({
      id: "retry-transition",
      risk: "low",
      desc: `从 ${fromNode} 合法流转到 ${expectedNode}（满足图边条件）`,
      action: "transition",
      to: expectedNode,
    });
  }

  if (legalOutEdges.length > 0) {
    opts.push({
      id: "follow-any-legal-edge",
      risk: "medium",
      desc: `放弃期望目标，从 ${fromNode} 走任一合法出边: ${legalOutEdges.join(", ")}`,
      action: "transition",
      candidates: legalOutEdges,
    });
  }

  if (provenanceMissing.length > 0) {
    opts.push({
      id: "re-dispatch-missing-agents",
      risk: "medium",
      desc: "补派缺失 provenance 的必经智能体（按 fromNode 阶段）",
      action: "re-dispatch",
      missing_fields: provenanceMissing,
    });
  }

  opts.push({
    id: "rollback-to-previous-stage",
    risk: "high",
    desc: "无法自动恢复 → 回退到上一合法阶段或挂起等人工决策",
    action: "pause",
  });

  return opts;
}

function pickRecommended(opts) {
  if (!opts || opts.length === 0) return null;
  const order = ["retry-transition", "re-dispatch-missing-agents", "follow-any-legal-edge", "rollback-to-previous-stage", "circuit-breaker-pause"];
  for (const id of order) {
    const hit = opts.find((o) => o.id === id);
    if (hit) return hit.id;
  }
  return opts[0].id;
}

// ============================================================
// CLI helpers
// ============================================================

function usage() {
  const txt = [
    "Usage:",
    "  node scripts/recover-process-violation.mjs <task_id> --violation-type <stage-mismatch|provenance-missing|illegal-transition> [--from <NODE>] [--expected <NODE>]",
    "  node scripts/recover-process-violation.mjs --help",
    "",
    "Mechanical PROCESS_VIOLATION diagnoser (conductor-only diagnostic).",
    "Output: JSON { task_id, violation_type, current_stage, expected_stage, legal_out_edges, provenance_missing, recovery_options, recommended, circuit_breaker, timestamp }",
    "",
    "Exit codes:",
    "  0 = recoverable (recommended option present)",
    "  1 = needs-pause (structural damage / no legal recovery path)",
    "  2 = usage error",
    "  3 = circuit-breaker (quality.round >= max_total_cycles)",
  ].join("\n");
  process.stdout.write(txt + "\n");
  process.exit(0);
}

function die(code, msg) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = { taskId: null, violationType: null, from: null, expected: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage();
    if (!out.taskId && !a.startsWith("--")) { out.taskId = a; continue; }
    if (a === "--violation-type") { out.violationType = argv[++i]; continue; }
    if (a === "--from") { out.from = argv[++i]; continue; }
    if (a === "--expected") { out.expected = argv[++i]; continue; }
  }
  return out;
}

// ============================================================
// main
// ============================================================

function main() {
  const args = parseArgs(process.argv);
  if (!args.taskId) die(2, "Error: missing <task_id>");
  if (!args.violationType) die(2, "Error: missing --violation-type");
  if (!VIOLATION_TYPES.has(args.violationType)) {
    die(2, `Error: invalid --violation-type "${args.violationType}". Allowed: ${[...VIOLATION_TYPES].join(", ")}`);
  }

  // 读 ctx（不存在时 needs-pause）
  let ctx;
  try {
    const r = readContext(args.taskId);
    ctx = r.ctx;
  } catch (e) {
    die(1, `Error: cannot read task_context for ${args.taskId}: ${e.message}`);
  }

  // 读 graph
  const graph = loadGraph();
  if (graph.error) die(1, `Error: ${graph.error}`);

  const currentStage = ctx.current_stage || "UNKNOWN";
  const fromNode = args.from || currentStage;

  // legal_out_edges: 去重（多 when 子句边共享 to）
  const legalOutEdges = [...new Set(
    graph.edges
      .filter((e) => e.from === fromNode)
      .map((e) => e.to)
      .filter(Boolean)
  )];

  // provenance_missing: 用 U2 byte-verify 校验 fromNode 阶段必经字段
  const requiredFields = STAGE_PROVENANCE[fromNode] || [];
  const fieldResults = verifyFields(ctx, requiredFields);
  const provenanceMissing = fieldResults
    .filter((r) => !r.present)
    .map((r) => r.field);

  // dispatch_log 检查：仅当 violation_type=provenance-missing 时显式校验必经 agent
  if (args.violationType === "provenance-missing" && requiredFields.length > 0) {
    const seenAgents = new Set(
      (Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [])
        .map((e) => e && e.agent)
        .filter(Boolean)
    );
    const requiredAgents = new Set();
    for (const f of requiredFields) {
      const top = f.split(".")[0];
      if (PROVENANCE_TO_AGENT[top]) requiredAgents.add(PROVENANCE_TO_AGENT[top]);
    }
    for (const a of requiredAgents) {
      if (!seenAgents.has(a)) provenanceMissing.push(`dispatch_log.${a}`);
    }
  }

  // circuit-breaker 检测
  const hooks = readHooksFromConfig();
  const round = (ctx.quality && typeof ctx.quality.round === "number") ? ctx.quality.round : 0;
  const circuitBroken = round >= hooks.max_total_cycles;

  // 构造 recovery options
  const recoveryOptions = buildRecoveryOptions({
    fromNode,
    expectedNode: args.expected,
    legalOutEdges,
    provenanceMissing,
    circuitBroken,
  });

  const recommended = pickRecommended(recoveryOptions);

  const result = {
    task_id: args.taskId,
    violation_type: args.violationType,
    current_stage: currentStage,
    expected_stage: args.expected || null,
    legal_out_edges: legalOutEdges,
    provenance_missing: provenanceMissing,
    recovery_options: recoveryOptions,
    recommended,
    circuit_breaker: circuitBroken,
    timestamp: new Date().toISOString(),
  };

  // 退出码决策
  if (circuitBroken) emit(result, 3);
  if (!recommended) emit(result, 1);
  if (recommended === "rollback-to-previous-stage" || recommended === "circuit-breaker-pause") emit(result, 1);
  emit(result, 0);
}

main();
