#!/usr/bin/env node
// delivery-audit.mjs
// 交付前合规审计器（A 层第一门，机械断言，模型无关）——DELIVERING 阶段 pre_gate
// 必跑项。读 task_context（$TEMP/kilo/task_context_<id>.json），按 8 个检查项
// 机械判定定级/意图/流程/派发/验收完备性，输出结果 JSON + 退出码硬门。
//
// 定位：与 acceptance-check.mjs / diff-boundary-check.mjs 同一层（机械门），
// 由 lifecycle/stages/delivering.md pre_gate 在 DELIVERING 阶段入口自动调用。
// 仅使用 Node 内置模块（node:fs / node:path / node:os / node:url）。
//
// 用法（CLI）：
//   node scripts/delivery-audit.mjs <task_id> [--fix]
//   --fix  自动修复可机械修复的 FAIL 项（INTENT_FIELD_CONSISTENCY），修复后重跑检测
// 退出码：
//   0 = 全部 PASS（允许 WARN/INFO）
//   1 = 至少一项 FAIL
//   2 = 参数错误
//
// 也可被 import（quality-gate 等聚合器复用）：
//   import { checkDeliveryAudit } from './delivery-audit.mjs';
//   const r = checkDeliveryAudit(taskId); // {results, exitCode}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ============================================================
// 常量
// ============================================================

// 逻辑指示词：T0 任务应只处理机械/单文件改动；命中以下词 → 暗示业务逻辑，疑应升 T1
const LOGIC_INDICATORS_ZH = [
  '如果', '当', '条件', '回显', '联动', '判断', '逻辑', '处理', '计算',
  '匹配', '校验', '验证', '转换', '映射', '调用', '请求', '接口', '方法', '函数',
];
const LOGIC_INDICATORS_EN = [
  'change', 'handler', 'method', 'function', 'if', 'when', 'condition',
  'compute', 'filter', 'match', 'validate', 'transform', 'request',
];

// 各 tier 必经派发角色（T0=极速，T1=fast，T2=full；取自 lifecycle/config.yaml 默认组合）
const REQUIRED_DISPATCH_ROLES = {
  T0: ['coder'],
  T1: ['planner', 'coder', 'verifier'],
  T2: ['planner', 'coder', 'verifier', 'reviewer'],
};

const POST_INIT_STAGES = ['EXECUTING', 'QUALITY', 'DELIVERING', 'DONE'];

// ============================================================
// 工具
// ============================================================

function contextPath(taskId) {
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function readCtx(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) die(2, `delivery-audit: task_context 不存在 task_id=${taskId}`);
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(2, `delivery-audit: task_context 解析失败 task_id=${taskId}: ${e.message}`);
  }
  return ctx;
}

function pickIntentType(ctx) {
  return { type: ctx.intent?.type, intent_type: ctx.intent?.intent_type };
}

function effectiveIntentType(ctx) {
  const it = pickIntentType(ctx);
  // 兼容两种字段名：type / intent_type
  if (typeof it.type === 'string' && it.type.trim()) return it.type.trim();
  if (typeof it.intent_type === 'string' && it.intent_type.trim()) return it.intent_type.trim();
  return null;
}

// ============================================================
// 8 个检测函数
// ============================================================

// 1. T0_ELIGIBILITY（WARN）：T0 任务意图是否暗示业务逻辑
// 导出供 transition-check.mjs 复用（INIT 出口 T0 定级合理性校验）
export function checkT0Eligibility(ctx) {
  const tier = ctx.sizing?.tier;
  if (tier !== 'T0') {
    return { check: 'T0_ELIGIBILITY', status: 'PASS', detail: `tier=${tier || '(空)'}，跳过`, remediation: '(无)' };
  }
  const raw = typeof ctx.intent?.raw === 'string' ? ctx.intent.raw : '';
  if (!raw) {
    return { check: 'T0_ELIGIBILITY', status: 'PASS', detail: 'intent.raw 为空，跳过', remediation: '(无)' };
  }
  const rawLower = raw.toLowerCase();
  const hits = [];
  for (const w of LOGIC_INDICATORS_ZH) {
    if (raw.includes(w)) hits.push(w);
  }
  for (const w of LOGIC_INDICATORS_EN) {
    if (rawLower.includes(w)) hits.push(w);
  }
  if (hits.length >= 1) {
    return {
      check: 'T0_ELIGIBILITY',
      status: 'WARN',
      detail: `intent.raw 命中逻辑指示词: [${hits.join(', ')}]`,
      remediation: '建议升 T1 或显式声明 custom_overrides.tier=T0 覆盖',
    };
  }
  return { check: 'T0_ELIGIBILITY', status: 'PASS', detail: 'intent.raw 未命中逻辑指示词', remediation: '(无)' };
}

// 2. INTENT_FIELD_CONSISTENCY（FAIL/WARN）：intent.type vs intent.intent_type 字段一致性
function checkIntentFieldConsistency(ctx) {
  const it = pickIntentType(ctx);
  const a = it.type;
  const b = it.intent_type;
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) {
    return {
      check: 'INTENT_FIELD_CONSISTENCY',
      status: 'PASS',
      detail: '两字段均为空（由 INTENT_TYPE_NONEMPTY 处理）',
      remediation: '(无)',
    };
  }
  if (aEmpty && !bEmpty) {
    return {
      check: 'INTENT_FIELD_CONSISTENCY',
      status: 'FAIL',
      detail: `仅 intent.intent_type=${b}，intent.type 为空（transition-check 读 intent.intent_type，缺则阻断流转）`,
      remediation: `执行 set <id> intent.type ${b} --agent conductor`,
    };
  }
  if (!aEmpty && bEmpty) {
    return {
      check: 'INTENT_FIELD_CONSISTENCY',
      status: 'FAIL',
      detail: `仅 intent.type=${a}，intent.intent_type 为空（transition-check 读 intent.intent_type，缺则阻断流转）`,
      remediation: `执行 set <id> intent.intent_type ${a} --agent conductor`,
    };
  }
  // 都有值
  if (a === b) {
    return {
      check: 'INTENT_FIELD_CONSISTENCY',
      status: 'PASS',
      detail: `intent.type=intent.intent_type=${a}，一致`,
      remediation: '(无)',
    };
  }
  return {
    check: 'INTENT_FIELD_CONSISTENCY',
    status: 'FAIL',
    detail: `intent.type=${a} 但 intent.intent_type=${b}，字段名不一致`,
    remediation: `执行 set <id> intent.intent_type ${a} --agent conductor`,
  };
}

// 3. INTENT_TYPE_NONEMPTY（FAIL）：意图字段不能都为空
function checkIntentTypeNonempty(ctx) {
  const eff = effectiveIntentType(ctx);
  if (eff) {
    return {
      check: 'INTENT_TYPE_NONEMPTY',
      status: 'PASS',
      detail: `intent 意图=${eff}`,
      remediation: '(无)',
    };
  }
  return {
    check: 'INTENT_TYPE_NONEMPTY',
    status: 'FAIL',
    detail: 'intent 意图为空',
    remediation: '执行 set <id> intent.intent_type EXECUTION|INQUIRY --agent conductor',
  };
}

// 4. TRANSITION_LOG_INIT_EXIT（FAIL）：进入 EXECUTING 之后必须有 INIT 出口
function checkTransitionLogInit(ctx) {
  const stage = ctx.current_stage;
  if (!POST_INIT_STAGES.includes(stage)) {
    return {
      check: 'TRANSITION_LOG_INIT_EXIT',
      status: 'PASS',
      detail: `current_stage=${stage || '(空)'}，未到 EXECUTING 之后，跳过`,
      remediation: '(无)',
    };
  }
  const log = Array.isArray(ctx.transition_log) ? ctx.transition_log : [];
  const hasInit = log.some((e) => e && e.from === 'INIT');
  if (hasInit) {
    return {
      check: 'TRANSITION_LOG_INIT_EXIT',
      status: 'PASS',
      detail: `transition_log 含 INIT 出口（current_stage=${stage}）`,
      remediation: '(无)',
    };
  }
  return {
    check: 'TRANSITION_LOG_INIT_EXIT',
    status: 'FAIL',
    detail: `transition_log 缺 INIT 出口记录（current_stage=${stage}）`,
    remediation: '补执行 transition-check --from INIT --to <next>',
  };
}

// 5. TRANSITION_LOG_ORDER（INFO）：占位，全量审计交给 flow-audit.mjs
function checkTransitionLogOrder(_ctx) {
  return {
    check: 'TRANSITION_LOG_ORDER',
    status: 'INFO',
    detail: '详见 flow-audit.mjs 输出（事后全量审计）',
    remediation: '(无)',
  };
}

// 6. DISPATCH_LOG_COMPLETENESS（FAIL/WARN）：必配角色是否都派发过
function checkDispatchLog(ctx) {
  const tier = ctx.sizing?.tier;
  if (!REQUIRED_DISPATCH_ROLES[tier]) {
    return {
      check: 'DISPATCH_LOG_COMPLETENESS',
      status: 'WARN',
      detail: `tier 未知（${tier || '(空)'}），跳过 dispatch_log 校验`,
      remediation: '补 sizing.tier 设置',
    };
  }
  const required = REQUIRED_DISPATCH_ROLES[tier];
  const log = Array.isArray(ctx.dispatch_log) ? ctx.dispatch_log : [];
  const dispatched = new Set();
  for (const e of log) {
    if (e && typeof e.agent === 'string' && e.agent.trim()) dispatched.add(e.agent.trim());
  }
  const missing = required.filter((r) => !dispatched.has(r));
  if (missing.length === 0) {
    return {
      check: 'DISPATCH_LOG_COMPLETENESS',
      status: 'PASS',
      detail: `dispatch_log 含 tier=${tier} 必配角色 [${required.join(', ')}]`,
      remediation: '(无)',
    };
  }
  return {
    check: 'DISPATCH_LOG_COMPLETENESS',
    status: 'FAIL',
    detail: `dispatch_log 缺 ${missing.join(', ')}（tier=${tier} 必配）`,
    remediation: `补派发 ${missing.join(', ')}`,
  };
}

// 7. VERIFICATION_FORWARD_NONEMPTY（FAIL）：T1/T2 EXECUTION 必经 verifier forward
function checkVerificationForward(ctx) {
  const tier = ctx.sizing?.tier;
  const intent = effectiveIntentType(ctx);
  if (tier !== 'T1' && tier !== 'T2') {
    return {
      check: 'VERIFICATION_FORWARD_NONEMPTY',
      status: 'PASS',
      detail: `tier=${tier || '(空)'}，跳过`,
      remediation: '(无)',
    };
  }
  if (intent !== 'EXECUTION') {
    return {
      check: 'VERIFICATION_FORWARD_NONEMPTY',
      status: 'PASS',
      detail: `intent=${intent || '(空)'}，非 EXECUTION 跳过`,
      remediation: '(无)',
    };
  }
  const fwd = ctx.verification?.forward;
  const empty = fwd === null || fwd === undefined || (typeof fwd === 'object' && Object.keys(fwd).length === 0);
  if (empty) {
    return {
      check: 'VERIFICATION_FORWARD_NONEMPTY',
      status: 'FAIL',
      detail: 'verification.forward 为空（T1/T2 EXECUTION 必经 verifier forward）',
      remediation: '补 verifier 派发',
    };
  }
  return {
    check: 'VERIFICATION_FORWARD_NONEMPTY',
    status: 'PASS',
    detail: 'verification.forward 非空',
    remediation: '(无)',
  };
}

// 8. ACCEPTANCE_MAP_NONEMPTY（FAIL）：EXECUTION 任务必须有 acceptance_map
function checkAcceptanceMap(ctx) {
  const intent = effectiveIntentType(ctx);
  if (intent !== 'EXECUTION') {
    return {
      check: 'ACCEPTANCE_MAP_NONEMPTY',
      status: 'PASS',
      detail: `intent=${intent || '(空)'}，非 EXECUTION 跳过`,
      remediation: '(无)',
    };
  }
  const am = ctx.execution?.acceptance_map;
  if (Array.isArray(am) && am.length > 0) {
    return {
      check: 'ACCEPTANCE_MAP_NONEMPTY',
      status: 'PASS',
      detail: `acceptance_map 含 ${am.length} 条`,
      remediation: '(无)',
    };
  }
  return {
    check: 'ACCEPTANCE_MAP_NONEMPTY',
    status: 'FAIL',
    detail: 'acceptance_map 为空',
    remediation: '补 acceptance_map[{ac,map}] 或标 [MISSING_ACCEPTANCE_MAP]',
  };
}

// ============================================================
// 可导入核心
// ============================================================

export function checkDeliveryAudit(taskId) {
  const ctx = readCtx(taskId);
  const results = [
    checkT0Eligibility(ctx),
    checkIntentFieldConsistency(ctx),
    checkIntentTypeNonempty(ctx),
    checkTransitionLogInit(ctx),
    checkTransitionLogOrder(ctx),
    checkDispatchLog(ctx),
    checkVerificationForward(ctx),
    checkAcceptanceMap(ctx),
  ];
  const hasFail = results.some((r) => r.status === 'FAIL');
  return { results, exitCode: hasFail ? 1 : 0 };
}

// ============================================================
// Auto-fix
// ============================================================

export function applyFixes(taskId, results) {
  const fixesApplied = [];
  const ctx = readCtx(taskId);

  let modified = false;
  for (const r of results) {
    if (r.status !== 'FAIL') continue;
    if (r.check === 'INTENT_FIELD_CONSISTENCY') {
      const it = pickIntentType(ctx);
      const a = it.type;
      const b = it.intent_type;
      const aEmpty = a === null || a === undefined || a === '';
      const bEmpty = b === null || b === undefined || b === '';

      if (!aEmpty && bEmpty) {
        ctx.intent = ctx.intent || {};
        ctx.intent.intent_type = a;
        modified = true;
        fixesApplied.push({ check: r.check, action: `set intent.intent_type=${a}`, success: true });
      } else if (aEmpty && !bEmpty) {
        ctx.intent = ctx.intent || {};
        ctx.intent.type = b;
        modified = true;
        fixesApplied.push({ check: r.check, action: `set intent.type=${b}`, success: true });
      } else if (!aEmpty && !bEmpty && a !== b) {
        ctx.intent = ctx.intent || {};
        ctx.intent.intent_type = a;
        modified = true;
        fixesApplied.push({ check: r.check, action: `set intent.intent_type=${a} (was ${b})`, success: true });
      }
    } else {
      fixesApplied.push({ check: r.check, action: '(需 conductor 手动补齐)', success: false });
    }
  }

  if (modified) {
    fs.writeFileSync(contextPath(taskId), JSON.stringify(ctx, null, 2), 'utf8');
  }

  const recheck = checkDeliveryAudit(taskId);
  return { results: recheck.results, exitCode: recheck.exitCode, fixesApplied };
}

// ============================================================
// CLI
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const hasFix = args.includes('--fix');
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length !== 1 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/delivery-audit.mjs <task_id> [--fix]\n');
    process.stdout.write('  --fix  自动修复可机械修复的 FAIL 项（INTENT_FIELD_CONSISTENCY），重跑检测\n');
    process.stdout.write('Exit: 0=all PASS (allow WARN/INFO), 1=at least one FAIL, 2=args error\n');
    process.exit(positional.length !== 1 ? 2 : 0);
  }

  const taskId = positional[0];
  const r = checkDeliveryAudit(taskId);

  if (hasFix && r.exitCode === 1) {
    process.stdout.write('[delivery-audit] --fix 模式：尝试自动修复 FAIL 项...\n');
    const fixResult = applyFixes(taskId, r.results);
    process.stdout.write(JSON.stringify(fixResult.results, null, 2) + '\n');
    const pass = fixResult.results.filter(x => x.status === 'PASS').length;
    const warn = fixResult.results.filter(x => x.status === 'WARN').length;
    const info = fixResult.results.filter(x => x.status === 'INFO').length;
    const fail = fixResult.results.filter(x => x.status === 'FAIL').length;
    process.stdout.write(`\n[after --fix] Summary: PASS=${pass} WARN=${warn} INFO=${info} FAIL=${fail} -> exit ${fixResult.exitCode}\n`);
    if (fixResult.fixesApplied.length > 0) {
      process.stdout.write(`\nFixes applied:\n`);
      for (const f of fixResult.fixesApplied) {
        process.stdout.write(`  - ${f.check}: ${f.action} -> ${f.success ? 'SUCCESS' : 'FAILED'}\n`);
      }
    }
    process.exit(fixResult.exitCode);
  }

  process.stdout.write(JSON.stringify(r.results, null, 2) + '\n');
  const pass = r.results.filter(x => x.status === 'PASS').length;
  const warn = r.results.filter(x => x.status === 'WARN').length;
  const info = r.results.filter(x => x.status === 'INFO').length;
  const fail = r.results.filter(x => x.status === 'FAIL').length;
  process.stdout.write(`\nSummary: PASS=${pass} WARN=${warn} INFO=${info} FAIL=${fail} -> exit ${r.exitCode}\n`);
  process.exit(r.exitCode);
}

// CLI guard：仅当直接作为入口运行时执行 main()，import 时不触发
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

