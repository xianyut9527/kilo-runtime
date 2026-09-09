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
  PLAN_REVIEW_CB: {
    code: 'PLAN_REVIEW_CB',
    msg: '熔断：plan_review.round >= max_rounds 仍 FAIL（方案审查熔断，应 ESCALATE 而非回流）',
    see: 'agent/plan-reviewer.md §熔断约定',
  },

  // === recovery 引擎错误码（U6 新增，T20260811-001-recovery-engineering）===
  CONTEXT_UNSAFE: {
    code: 'CONTEXT_UNSAFE',
    msg: '主会话 context 超过 size_check_threshold，强制切 worktree',
    see: 'lifecycle/config.yaml §size_check_threshold',
  },
  WRITE_MISSING: {
    code: 'WRITE_MISSING',
    msg: 'agent 返回时未落盘 task_context 产物（execution.diffs/changes/acceptance_map 或 verification.forward 等，按角色 write 契约）',
    see: 'agent/coder.md §完工即写硬门',
  },
  RECOVERY_RETRY_EXHAUSTED: {
    code: 'RECOVERY_RETRY_EXHAUSTED',
    msg: 'recovery 重试配额耗尽（max_write_retry 内仍失败），升级 conductor escalate',
    see: 'lifecycle/config.yaml §recovery',
  },

  // === LLM 判定标记（agent/AGENTS 声明，非机械门，U10 三合一审计 SSOT 注册）===
  // 这些标记由 conductor/reviewer/verifier/planner/fixer 等 LLM 角色在返回消息中判定，
  // 无独立脚本执行者（非机械门），但需在 error-codes.mjs 单一来源注册，防幽灵门禁/未注册漂移。
  AGENT_UNAVAILABLE: { code: 'AGENT_UNAVAILABLE', msg: 'Tool execution aborted 视为会话断开，按节点 on_fail 派发或降级 conductor 内建处理', see: 'agent/conductor.md 铁律 #9' },
  COPY_PASTE_FIX: { code: 'COPY_PASTE_FIX', msg: '重复实现/复制粘贴式补丁（同类实现 ≥2 处未走共享抽象）', see: 'agent/reviewer.md §组件化合规' },
  DEBUG_LEFTOVER: { code: 'DEBUG_LEFTOVER', msg: '调试残留（console.log/debugger/print/TODO/注释代码）', see: 'agent/reverse-auditor.md §3' },
  DEGRADED: { code: 'DEGRADED', msg: '脚本不存在降级手工编排（DEGRADED 不豁免 permission）', see: 'agent/conductor.md 铁律 #8' },
  ENCODING_DRIFT: { code: 'ENCODING_DRIFT', msg: '编码健康度漂移（BOM/U+FFFD/GBK 残留），scan-encoding 命中阻断', see: 'agent/verifier.md §scan-encoding' },
  ESCALATE: { code: 'ESCALATE', msg: 'timeout 且计数 > agent_timeout_max_retries，按节点 on_fail:escalate', see: 'agent/conductor.md 铁律 #9' },
  FAKE_CONTEXT: { code: 'FAKE_CONTEXT', msg: '自验声明与 diff 实际改动不匹配（声称验证但无对应改动/测试）', see: 'AGENTS.md 锚点 5 / agent/reverse-auditor.md §5' },
  FORBIDDEN_TOUCH: { code: 'FORBIDDEN_TOUCH', msg: 'diff 触及 forbidden_files 列出的文件', see: 'agent/reverse-auditor.md §6' },
  LOCAL_PATCH: { code: 'LOCAL_PATCH', msg: '局部补丁（未走共享抽象/组件化）', see: 'agent/reviewer.md §组件化合规' },
  MISSING_ACCEPTANCE_MAP: { code: 'MISSING_ACCEPTANCE_MAP', msg: '验收必附映射表缺失', see: 'AGENTS.md 锚点 5' },
  MISSING_MINIMAL_GATE: { code: 'MISSING_MINIMAL_GATE', msg: '直通边最小产物缺失（transition-check 直通边校验）', see: 'agent/conductor.md §直通边' },
  MISSING_OLD_PHRASING_SCAN: { code: 'MISSING_OLD_PHRASING_SCAN', msg: '全网旧措辞扫描缺失（涉及规则/判据/语义同步时必填）', see: 'agent/planner.md §硬门' },
  MISSING_PREVENTION: { code: 'MISSING_PREVENTION', msg: '防复发缺失（扫描与防复发机制未建立）', see: 'agent/reviewer.md' },
  MISSING_SCAN: { code: 'MISSING_SCAN', msg: '扫描缺失（同类实现/影响面未扫描）', see: 'agent/reviewer.md' },
  MISSING_STAGE_MARKER: { code: 'MISSING_STAGE_MARKER', msg: 'stage 标识缺失或与 task_context 不符', see: 'agent/conductor.md §10.1' },
  NO_CONCLUSION_CLOSE: { code: 'NO_CONCLUSION_CLOSE', msg: 'DELIVERING 输出无末尾 verdict 总结段落', see: 'agent/conductor.md §DELIVERING' },
  PARTIAL_IMPLEMENTATION: { code: 'PARTIAL_IMPLEMENTATION', msg: '部分实现（需回到需求扩散包补齐同类点）', see: 'agent/fixer.md' },
  PATH_NOT_NORMALIZED: { code: 'PATH_NOT_NORMALIZED', msg: '委派包 key_files 路径未 path.resolve/normalize 或磁盘字节不符', see: 'agent/verifier.md §6 路径断言' },
  PLAN_REVIEW_MISS: { code: 'PLAN_REVIEW_MISS', msg: '方案未审查（T1/T2 时 plan_review.verdict ≠ PASS）进入 EXECUTING', see: 'agent/plan-reviewer.md §兜底' },
  PS51_REGEX_RISK: { code: 'PS51_REGEX_RISK', msg: 'bash 命令含 PS5.1 复杂 regex（Where-Object -match 含 ( [ { ?）', see: 'agent/verifier.md §bash-guard' },
  QUALITY_CB: { code: 'QUALITY_CB', msg: '降级交付（quality 熔断后 DELIVERING 降级）', see: 'agent/conductor.md §DELIVERING' },
  RETRY: { code: 'RETRY', msg: 'timeout 且计数 ≤ agent_timeout_max_retries，同 agent 新会话重跑', see: 'agent/conductor.md 铁律 #9' },
  RETURN_OVER_LIMIT: { code: 'RETURN_OVER_LIMIT', msg: 'subagent 返回超角色上限，重派', see: 'AGENTS.md 锚点 16 / output-schema §返回超限约束' },
  ROLLBACK: { code: 'ROLLBACK', msg: '变差时回滚', see: 'agent/fixer.md' },
  SCOPE_CREEP: { code: 'SCOPE_CREEP', msg: 'verification 能力 L2 反向核对 diff 命中越界改动', see: 'AGENTS.md 锚点 6' },
  SEARCH_LADDER_VIOLATION: { code: 'SEARCH_LADDER_VIOLATION', msg: '搜索四层阶梯跳级（绕过 L2 直接全仓 Grep 或已索引仓库首选 Grep）', see: 'AGENTS.md 锚点 15' },
  SLOT_ABORT: { code: 'SLOT_ABORT', msg: '挂载点 on_fail:abort 中止流转（审查者异常/超时非 verdict 返回）', see: 'agent/plan-reviewer.md' },
  UNCOVERED_CHANGE: { code: 'UNCOVERED_CHANGE', msg: 'diff 改动无法映射到任一验收标准/plan.scheme_summary', see: 'agent/reverse-auditor.md §1' },
  UNVERIFIED: { code: 'UNVERIFIED', msg: '任何声明无本轮 fresh 证据', see: 'agent/verifier.md' },
  VERIFY_PENDING: { code: 'VERIFY_PENDING', msg: '无法运行（验证待定）', see: 'agent/verifier.md' },
  VIOLATION: { code: 'VIOLATION', msg: '跳过委派/流程违规（DAG 流转缺失必经智能体）', see: 'agent/conductor.md' },
};

// helper：构造带 [CODE] 前缀的错误消息
export function codeMsg(key, extra) {
  const e = ERROR_CODES[key];
  if (!e) throw new Error(`unknown error code: ${key}`);
  return `[${e.code}] ${extra || e.msg}${e.see ? `（见 ${e.see}）` : ''}`;
}
