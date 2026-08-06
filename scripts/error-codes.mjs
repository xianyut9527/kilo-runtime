// 错误码单一来源（transition-check.mjs + 文档 同源）
// 任何新增/修改错误码必须先改本文件，再在 transition-check.mjs 引用

export const ERROR_CODES = {
  // === premise_audit 必填（M1-M6，scan-cleanup-005/006 实施）===
  MISSING_PREMISE_AUDIT: {
    code: 'MISSING_PREMISE_AUDIT',
    msg: 'plan.task_dag.units[].premise_audit 必填',
    see: 'lifecycle/stages/planning.md §premise_audit',
  },
  MISSING_EXISTENCE_CMD: {
    code: 'MISSING_EXISTENCE_CMD',
    msg: 'premise_audit.existence_cmd 必填（L3 广搜命令字面量）',
    see: 'planning.md §premise_audit.existence_cmd',
  },
  MISSING_EXISTENCE_RESULT: {
    code: 'MISSING_EXISTENCE_RESULT',
    msg: 'premise_audit.existence_result 必填对象（cmd/stdout_key/hit_count）',
    see: 'planning.md §premise_audit.existence_result',
  },
  MISSING_FALSIFIABLE_TEST: {
    code: 'MISSING_FALSIFIABLE_TEST',
    msg: 'premise_audit.falsifiable_test 必填非空',
    see: 'planning.md §premise_audit.falsifiable_test',
  },
  MISSING_USER_HINTS: {
    code: 'MISSING_USER_HINTS',
    msg: 'premise_audit.user_hints 必填 ≥1 数组',
    see: 'planning.md §premise_audit.user_hints',
  },
  FEW_ALTERNATIVES: {
    code: 'FEW_ALTERNATIVES',
    msg: 'premise_audit.alternatives 必填 ≥2 数组',
    see: 'planning.md §premise_audit.alternatives',
  },

  // === evidence 必填（B 段，scan-cleanup-005 实施）===
  INSUFFICIENT_EVIDENCE: {
    code: 'INSUFFICIENT_EVIDENCE',
    msg: 'verification.forward.evidence 数组必填 ≥1 条',
    see: '.kilo/instructions/output-schema.md §证据契约',
  },
  MISSING_EVIDENCE_FIELD: {
    code: 'MISSING_EVIDENCE_FIELD',
    msg: 'evidence[i] 缺 cmd/exit/stdout_key',
    see: '.kilo/instructions/output-schema.md §证据契约',
  },

  // === 既有错误码（保留原名，仅 SSOT 化）===
  MISSING_PLAN_PRODUCT: {
    code: 'MISSING_PLAN_PRODUCT',
    msg: 'PLANNING -> EXECUTING: plan 为空（planner 未产出方案）',
    see: 'lifecycle/stages/planning.md',
  },
  MISSING_VERIFICATION_PRODUCT: {
    code: 'MISSING_VERIFICATION_PRODUCT',
    msg: 'QUALITY -> DELIVERING: verification.forward 为空（verifier 未产出验证结果）',
    see: '.kilo/instructions/output-schema.md',
  },
  MISSING_EXECUTION_PRODUCT: {
    code: 'MISSING_EXECUTION_PRODUCT',
    msg: 'EXECUTING 产物全空（coder 未产出 diffs/changes/acceptance_map）',
    see: 'lifecycle/stages/executing.md',
  },
  MISSING_QUALITY_VERDICT: {
    code: 'MISSING_QUALITY_VERDICT',
    msg: 'QUALITY 阶段未写入合法 verdict',
    see: 'lifecycle/stages/quality.md',
  },
  PROCESS_VIOLATION: {
    code: 'PROCESS_VIOLATION',
    msg: '流程违规（详见具体上下文）',
    see: 'AGENTS.md 锚点 8',
  },
  CIRCUIT_BREAKER: {
    code: 'CIRCUIT_BREAKER',
    msg: '熔断：quality.round >= max_total_cycles',
    see: 'lifecycle/config.yaml',
  },
};

// helper：构造带 [CODE] 前缀的错误消息
export function codeMsg(key, extra) {
  const e = ERROR_CODES[key];
  if (!e) throw new Error(`unknown error code: ${key}`);
  return `[${e.code}] ${extra || e.msg}${e.see ? `（见 ${e.see}）` : ''}`;
}
