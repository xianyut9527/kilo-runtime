#!/usr/bin/env node
// delivery-audit.mjs
// 交付合规审计器（事后自查，机械断言，模型无关）。读 task_context
// （$TEMP/kilo/task_context_<id>.json），按 8 个检查项机械判定定级/意图/流程/派发/验收完备性。
//
// 定位（2026-09 校准）：**不在流转链路上**。transition-check.mjs 已在各跳机械强制了
// 本审计器的大部分不变量——EXECUTING 出口产物非空（MISSING_EXECUTION_PRODUCT）、
// QUALITY→DELIVERING verification.forward 非空（MISSING_VERIFICATION_PRODUCT）、
// INIT 出口 T0/T1 强度合格、DELIVERING→DONE KB 回执。所以本脚本是**人工事后自查 / 排障
// 入口**（怀疑 task_context 被手工改过、或跳步走完想看全貌），不是交付前置门。
// 往流转链路里再接一次 = 重复审计已门控的不变量 + 每任务多一个白耗回合，不要接。
// `lifecycle/stages/delivering.md` 的 pre_gate 段是声明式清单（由 conductor 在入口按清单
// 手工执行，框架不会在工具调用层自动插门），其中不含本脚本。
// 被流转链路复用的只有 checkT0Eligibility / checkT1StrengthEligibility（transition-check import）。
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
// 也可被 import：
//   import { checkDeliveryAudit } from './delivery-audit.mjs';
//   const r = checkDeliveryAudit(taskId); // {results, exitCode}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { contextPath } from './lib/task-context-io.mjs';
import { parseT1StrengthSignals } from './lib/config-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 常量
// ============================================================

// 逻辑指示词：T0 任务应只处理机械/单文件改动；命中以下词 → 暗示业务逻辑，疑应升 T1
// 只收录「不会作为无关词子串出现」的词：裸 includes() 匹配下，单字条目会顺手误命中
// （旧表里的 '当' 命中 当前/自动/当然/恰当，'if' 命中 config），等于任何技术提问都必命中。
export const LOGIC_INDICATORS_ZH = [
  '如果', '假如', '否则', '若是', '条件', '回显', '联动', '判断', '逻辑', '处理', '计算',
  '匹配', '校验', '验证', '转换', '映射', '调用', '请求', '接口', '方法', '函数',
  '修改', '改', '增加', '删除', '新增', '实现', '重构', '优化', '修复', '调整',
  '替换', '重写', '迁移', '对接', '接入', '配置', '参数', '状态', '流程', '规则',
  '算法', '排序', '分页', '缓存', '路由', '事件', '监听', '触发', '异步', '事务',
  '回滚', '异常', '错误', '分支', '循环', '递归', '遍历', '解析', '渲染', '提交',
  '保存', '更新', '查询', '搜索', '过滤', '分组', '聚合', '统计', '导出', '导入',
  '上传', '下载', '登录', '授权', '认证', '加密', '解密', '签名', '回调', '通知',
  '推送', '消息', '队列', '调度', '定时', '任务', '限流', '重试', '幂等', '降级',
  '熔断', '开关', '补丁', '热更新', '灰度',
];
// 英文词表只用于词边界匹配（见 EN_WORD_RE），因此保留 if / add 等短词不会误命中
// config / address；但 'routes' 这类复数不再命中 'route'，属可接受的精度优先取舍。
export const LOGIC_INDICATORS_EN = [
  'change', 'handler', 'method', 'function', 'if', 'when', 'condition',
  'compute', 'filter', 'match', 'validate', 'transform', 'request',
  'modify', 'add', 'delete', 'create', 'implement', 'refactor', 'optimize', 'fix',
  'adjust', 'replace', 'rewrite', 'migrate', 'integrate', 'config', 'param', 'state',
  'flow', 'rule', 'algorithm', 'sort', 'paginate', 'cache', 'route', 'event',
  'listen', 'trigger', 'async', 'await', 'transaction', 'rollback', 'exception', 'error',
  'branch', 'loop', 'recursion', 'parse', 'render', 'submit', 'save', 'update',
  'query', 'search', 'group', 'aggregate', 'auth', 'encrypt', 'decrypt', 'sign',
  'callback', 'notify', 'push', 'queue', 'schedule', 'timer', 'task', 'retry',
  'idempotent', 'degrade', 'circuit', 'switch',
];
// key_files 路径启发：命中以下路径模式 → 暗示业务逻辑层，疑应升 T1
export const LOGIC_PATH_GLOBS = [
  '**/service/**', '**/controller/**', '**/handler/**', '**/logic/**', '**/biz/**',
  '**/domain/**', '**/mapper/**', '**/dao/**', '**/repository/**', '**/middleware/**',
  '**/interceptor/**', '**/filter/**', '**/listener/**', '**/scheduler/**', '**/job/**',
  '**/task/**', '**/hook/**',
];


// 期望派发角色按 `lifecycle/stages/init.md` §路由规则 推导。M1 起 intent 与 t1_strength
// 都参与路由，**只按 tier 判会给出假 FAIL**：INQUIRY T1/T2 经 PLANNING 后直通 DELIVERING
// （无 coder/verifier）；EXECUTION T1 low/medium 跳过 PLANNING（无 planner）。
const DISPATCH_REQUIRED = {
  INQUIRY: { T0: [], T1: ['planner'], T2: ['planner'] },
  EXECUTION: {
    T0: ['coder'],
    T1_DIRECT: ['coder', 'verifier'],           // t1_strength ∈ {low, medium}
    T1_FULL: ['planner', 'coder', 'verifier'],  // t1_strength == high
    T2: ['planner', 'coder', 'verifier', 'reviewer'],
  },
};

/** 返回该任务形态应有的派发角色；intent/tier 未定时返回 null（调用方出 WARN）。 */
function requiredDispatchRoles(ctx) {
  const tier = ctx.sizing && ctx.sizing.tier;
  const intent = effectiveIntentType(ctx);
  if (intent === 'INQUIRY') {
    return Object.prototype.hasOwnProperty.call(DISPATCH_REQUIRED.INQUIRY, tier) ? DISPATCH_REQUIRED.INQUIRY[tier] : null;
  }
  if (intent !== 'EXECUTION') return null;
  if (tier === 'T1') {
    const strength = ctx.sizing && ctx.sizing.t1_strength;
    if (strength === 'low' || strength === 'medium') return DISPATCH_REQUIRED.EXECUTION.T1_DIRECT;
    if (strength === 'high') return DISPATCH_REQUIRED.EXECUTION.T1_FULL;
    return null; // T1 未定强度：不在这里报错，交由硬规则 6 的 T1 强度出口门判
  }
  return Object.prototype.hasOwnProperty.call(DISPATCH_REQUIRED.EXECUTION, tier) ? DISPATCH_REQUIRED.EXECUTION[tier] : null;
}

const POST_INIT_STAGES = ['EXECUTING', 'QUALITY', 'DELIVERING', 'DONE'];

// ============================================================
// 工具
// ============================================================

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

// 英文词边界正则（预编译一次）：\b 在非 ASCII 文本旁同样成立，所以中英混排
// （如 "kilo 配置"）不会因缺边界而漏判，也不会因词内子串而误判。
const EN_WORD_RE = new RegExp('\\b(' + LOGIC_INDICATORS_EN.join('|') + ')\\b', 'gi');

// 1. T0_ELIGIBILITY（WARN）：T0 任务意图是否暗示业务逻辑
// 导出供 transition-check.mjs 复用（INIT 出口 T0 定级合理性校验）
export function checkT0Eligibility(ctx) {
  const tier = ctx.sizing?.tier;
  if (tier !== 'T0') {
    return { check: 'T0_ELIGIBILITY', status: 'PASS', ok: true, detail: 'tier=' + (tier || '(空)') + '，跳过', remediation: '(无)' };
  }
  // INQUIRY 不改文件，「逻辑性修改」在定义上不成立；本门只防「执行类被误定为 T0」。
  // 不跳过的后果：含「配置/查询/规则」的普通提问全部被强升 T1，M1 问答极速通道形同关闭。
  if (effectiveIntentType(ctx) === 'INQUIRY') {
    return { check: 'T0_ELIGIBILITY', status: 'PASS', ok: true, detail: 'intent=INQUIRY（不改文件），逻辑指示词门不适用', remediation: '(无)' };
  }
  const raw = typeof ctx.intent?.raw === 'string' ? ctx.intent.raw : '';
  if (!raw) {
    return { check: 'T0_ELIGIBILITY', status: 'WARN', ok: false, detail: 'intent.raw 为空，无法证明无逻辑性修改', remediation: '写入 intent.raw 或直接升 T1' };
  }
  const hits = [];
  for (const w of LOGIC_INDICATORS_ZH) {
    if (raw.includes(w)) hits.push(w);
  }
  EN_WORD_RE.lastIndex = 0;
  let em;
  while ((em = EN_WORD_RE.exec(raw)) !== null) {
    const w = em[1].toLowerCase();
    if (hits.indexOf(w) === -1) hits.push(w);
  }
  // U2: key_files 路径启发——路径反斜杠规范化后测 glob，任一命中即 WARN
  const keyFiles = Array.isArray(ctx.sizing?.key_files) ? ctx.sizing.key_files : [];
  for (const f of keyFiles) {
    if (typeof f !== 'string' || !f) continue;
    const norm = f.replace(/\\/g, '/');
    for (const g of LOGIC_PATH_GLOBS) {
      if (globMatch(norm, g)) {
        hits.push('path:' + g + ':' + f);
      }
    }
  }
  if (hits.length >= 1) {
    return {
      check: 'T0_ELIGIBILITY',
      status: 'WARN',
      ok: false,
      detail: 'intent.raw 命中逻辑指示词: [' + hits.join(', ') + ']',
      remediation: '建议升 T1；确属机械微改则写 config.custom_overrides.tier=T0 覆盖（根级 custom_overrides 不在 WRITE_MATRIX 内，写不进去）',
    };
  }
  return { check: 'T0_ELIGIBILITY', status: 'PASS', ok: true, detail: 'intent.raw 未命中逻辑指示词', remediation: '(无)' };
}

// 从 lifecycle/config.yaml 读取 t1_strength_signals.strength_escalation_words
// 简单 YAML 词表提取（与 tier_escalation 解析同构，脚本自包含，不引入 yaml 库）
// 返回 string[]；段缺失/文件缺失/词表为空 → null（调用方按不阻断处理）
function readStrengthEscalationWords() {
  const cfgPath = path.resolve(__dirname, '..', 'lifecycle', 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return null;
  }
  return parseT1StrengthSignals(text);
}

// T1_STRENGTH_ELIGIBILITY（WARN）：T1 low 强度任务 intent.raw 是否命中强度升级信号词
// 导出供 transition-check.mjs 复用（INIT 出口 T1 直通边强制升 high 判定）
// 语义：tier!=='T1' 或 t1_strength!=='low' → PASS 跳过；low + 命中信号词 → WARN
export function checkT1StrengthEligibility(ctx) {
  const tier = ctx.sizing?.tier;
  const strength = ctx.sizing?.t1_strength;
  if (tier !== 'T1' || strength !== 'low') {
    return { check: 'T1_STRENGTH_ELIGIBILITY', status: 'PASS', ok: true, detail: 'tier=' + (tier || '(空)') + ' strength=' + (strength || '(空)') + '，跳过', remediation: '(无)' };
  }
  const raw = typeof ctx.intent?.raw === 'string' ? ctx.intent.raw : '';
  if (!raw) {
    return { check: 'T1_STRENGTH_ELIGIBILITY', status: 'PASS', ok: true, detail: 'intent.raw 为空，无信号词可命中', remediation: '(无)' };
  }
  const words = readStrengthEscalationWords();
  if (!words || words.length === 0) {
    return { check: 'T1_STRENGTH_ELIGIBILITY', status: 'PASS', ok: true, detail: 'config.yaml t1_strength_signals.strength_escalation_words 段缺失或为空，跳过', remediation: '(无)' };
  }
  const rawLower = raw.toLowerCase();
  const hits = [];
  for (const w of words) {
    if (rawLower.includes(w.toLowerCase())) hits.push(w);
  }
  if (hits.length >= 1) {
    return {
      check: 'T1_STRENGTH_ELIGIBILITY',
      status: 'WARN',
      ok: false,
      detail: '命中强度升级信号词: [' + hits.join(', ') + ']',
      remediation: '强制升 high 或 config.custom_overrides.t1_strength=low 显式覆盖',
    };
  }
  return { check: 'T1_STRENGTH_ELIGIBILITY', status: 'PASS', ok: true, detail: 'intent.raw 未命中强度升级信号词', remediation: '(无)' };
}


// 极简 glob 匹配：支持 ** 跨目录、* 单段、? 单字符；路径已规范化为正斜杠
function globMatch(file, pattern) {
  const f = file.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');
  return matchSegs(f.split('/'), p.split('/'));
}
function matchSegs(fSegs, pSegs) {
  if (pSegs.length === 0) return fSegs.length === 0;
  const head = pSegs[0];
  if (head === '**') {
    for (let i = 0; i <= fSegs.length; i++) {
      if (matchSegs(fSegs.slice(i), pSegs.slice(1))) return true;
    }
    return false;
  }
  if (fSegs.length === 0) return false;
  if (!matchSeg(fSegs[0], head)) return false;
  return matchSegs(fSegs.slice(1), pSegs.slice(1));
}
function matchSeg(seg, pat) {
  let si = 0, pi = 0, star = -1, mark = 0;
  while (si < seg.length) {
    if (pi < pat.length && (pat[pi] === '?' || pat[pi] === seg[si])) {
      si++; pi++;
    } else if (pi < pat.length && pat[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === '*') pi++;
  return pi === pat.length;
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
  const required = requiredDispatchRoles(ctx);
  if (!required) {
    return {
      check: 'DISPATCH_LOG_COMPLETENESS',
      status: 'WARN',
      detail: `intent/tier/t1_strength 未定齐（intent=${effectiveIntentType(ctx) || '(空)'} tier=${tier || '(空)'}），跳过 dispatch_log 校验`,
      remediation: '补 sizing.tier / intent.intent_type（T1 还需 sizing.t1_strength）',
    };
  }
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

