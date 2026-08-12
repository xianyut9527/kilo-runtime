// stage-i18n.mjs
// 中文 i18n 单一真相源：节点/tier/status/intent/verdict 枚举 → 中文标签+描述。
//
// 约束：
//   - 枚举字面量不可改（与 transition-check / flow-audit 校验同源）
//   - 零依赖（仅 Node 内置）
//   - 未命中键：format* 走 passthrough + stderr 一次警告（warnOnce 去重）
//   - 每条 value 形如 'label|desc'，labelOf 取前段，descOf 取后段

export const STAGE_ZH = {
  START:     '任务入口',
  INIT:      '初始化|意图判定+定级',
  PLANNING:  '设计门|方案设计+DAG+验收点',
  EXECUTING: '编码实现|按方案写代码',
  QUALITY:   '质量保障|验证+修复+审查循环',
  DELIVERING:'交付收尾|输出闭环',
  DONE:      '已完成',
};

export const TIER_ZH = {
  T0: '极速通道|3 节点无设计门',
  T1: '标准闭环|5 阶段 fast',
  T2: '全视角|5 阶段 full + 反向审计',
};

export const STATUS_ZH = {
  initialized: '已初始化',
  running:     '执行中|任务正在运行',
  timeout:     '超时|执行超时',
  cleared:     '已清|超时已清理',
  RUNNING:     '运行中',
  PAUSED:      '已挂起',
  DEGRADED:    '已降级',
  DONE:        '已完成',
  FAILED:      '已失败',
  PENDING:     '待处理|等待分配或外部依赖',
  PASS:        '已通过|验收通过',
  FAIL:        '未通过|验收未通过',
};

export const INTENT_ZH = {
  INQUIRY:   '咨询类',
  EXECUTION: '执行类',
};

export const VERDICT_ZH = {
  PASS:            '通过',
  CIRCUIT_BREAKER: '熔断',
};

const _warnedKeys = new Set();
function warnOnce(key, msg) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  process.stderr.write('[I18N_MISS] ' + msg + '\n');
}

function splitLabelDesc(value) {
  if (typeof value !== 'string') return { label: '', desc: '' };
  const idx = value.indexOf('|');
  if (idx === -1) return { label: value, desc: '' };
  return { label: value.slice(0, idx), desc: value.slice(idx + 1) };
}

export function labelOf(map, key) {
  const v = map?.[key];
  if (v == null) return '';
  return splitLabelDesc(String(v)).label;
}

export function descOf(map, key) {
  const v = map?.[key];
  if (v == null) return '';
  return splitLabelDesc(String(v)).desc;
}

function _format(map, key, kind) {
  if (key == null) return '';
  const v = map[key];
  if (v == null) {
    warnOnce(kind + ':' + key, kind + ': no mapping for "' + key + '", passthrough raw key');
    return String(key);
  }
  const sp = splitLabelDesc(String(v));
  return sp.label ? sp.label + ' (' + key + ')' : String(key);
}

export function formatStage(s)    { return _format(STAGE_ZH, s,    'stage-i18n'); }
export function formatTier(t)     { return _format(TIER_ZH, t,     'stage-i18n'); }
export function formatStatus(s)   { return _format(STATUS_ZH, s,   'stage-i18n'); }
export function formatIntent(i)   { return _format(INTENT_ZH, i,   'stage-i18n'); }
export function formatVerdict(v)  { return _format(VERDICT_ZH, v,  'stage-i18n'); }

export function formatTriple(o) {
  o = o || {};
  const lines = [];
  if (o.tier   !== undefined) lines.push('[TIER: '   + formatTier(o.tier)   + ']');
  if (o.stage  !== undefined) lines.push('[STAGE: '  + formatStage(o.stage)  + ']');
  if (o.status !== undefined) lines.push('[STATUS: ' + formatStatus(o.status) + ']');
  if (o.intent !== undefined) lines.push('[INTENT: ' + formatIntent(o.intent) + ']');
  return lines.join('\n');
}