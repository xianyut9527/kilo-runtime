// early-exit.mjs — Kilo runtime early-exit signal detector (U4)
// 检测用户早退信号（"好"/"继续"/"OK" 等），用于 EXECUTING/QUALITY 内循环
// 短路建议：检测到 → conductor 跳到 DELIVERING，省一轮完整阶段。
// 边界：去尾标点精确匹配 + 前导匹配（信号后跟 ≥1 字符，排除 "不" 紧跟造成的否定）。
// 不读 config.yaml：信号词列表默认内置，可被 setSignals() 覆盖（YAML 解析留给 index.mjs）。
// 零第三方依赖，纯 ESM。

// 默认早退信号词（plan.task_dag.units[3] 锁定列表）
const DEFAULT_SIGNALS = ['好', '继续', '就这样', '已修', '对', '可以了', '没问题', 'OK', 'ok'];

// NEGATIVE_AFTER：单字信号词后的"否定/复合词前缀"集合
// 避免误命中常见复合词（好看/好喝/好像/对比/对象/对得起 等）。
// 仅对 length===1 的信号生效；多字信号不应用此表。
// 对字复合词补充：得/上/手/方面（对得起/对得上/对不上/对手/对方面 等口语表达）
const NEGATIVE_AFTER = {
  '好': ['看', '喝', '像', '点', '处', '人', '意思', '玩', '用', '吃', '听', '说'],
  '对': ['比', '待', '白', '策', '联', '象', '应', '话', '外', '得', '上', '手', '方', '面'],
};

// 尾标点剥离集合：中文 + ASCII 感叹/问号 + 句号
const TRAILING_PUNCT = /[。！？.!?]+$/;

// 运行时信号词列表（可被 setSignals 覆盖）
let signals = [...DEFAULT_SIGNALS];

// 长信号优先匹配（避免 "好" 抢匹配 "可以了" 的前两位）
function getSortedSignals() {
  return [...signals].sort((a, b) => b.length - a.length);
}

/**
 * 覆盖默认信号词列表。传 null/空数组则重置为默认。
 * @param {string[] | null | undefined} arr
 */
export function setSignals(arr) {
  if (Array.isArray(arr) && arr.length > 0) {
    signals = arr.filter((s) => typeof s === 'string' && s.length > 0);
  } else {
    signals = [...DEFAULT_SIGNALS];
  }
}

/**
 * 追加信号词到当前列表（去重，不影响已有信号）。
 * 与 setSignals 的 REPLACE 语义互补——"默认 + 追加"场景。
 * @param {string[] | null | undefined} arr
 */
export function addSignals(arr) {
  if (Array.isArray(arr)) {
    for (const s of arr) {
      if (typeof s === 'string' && s.length > 0 && !signals.includes(s)) {
        signals.push(s);
      }
    }
  }
}

/**
 * 获取当前生效的信号词列表（浅拷贝）。
 * @returns {string[]}
 */
export function getSignals() {
  return [...signals];
}

/**
 * 去除字符串尾部的标点（连续 . ! ? 。 ！ ？）
 * @param {string} s
 * @returns {string}
 */
function stripTrailingPunct(s) {
  return s.replace(TRAILING_PUNCT, '');
}

/**
 * 检测用户消息是否包含早退信号。
 * 匹配规则（满足任一即命中）：
 *   1) trim + 去尾标点后，**等于**信号词（避免子串误判）
 *   2) trim 后**以**信号词开头 + 至少 1 字符后续（中文/字母/数字/标点均可），
 *      但排除信号词后紧跟 "不" 的否定形（"好不好" / "对不" 等）
 * @param {string} userMessage
 * @returns {{early_exit: boolean, signal_matched: string | null}}
 */
export function detectEarlyExit(userMessage) {
  // 1. 防御：空 / 非字符串 / 仅空白
  if (typeof userMessage !== 'string') {
    return { early_exit: false, signal_matched: null };
  }
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) {
    return { early_exit: false, signal_matched: null };
  }

  const sorted = getSortedSignals();

  // 规则 1：精确匹配（trim + 去尾标点）+ OK 类信号大小写不敏感
  const stripped = stripTrailingPunct(trimmed);
  for (const sig of sorted) {
    const sigLower = sig.toLowerCase();
    if (stripped === sig || (sigLower === 'ok' && stripped.toLowerCase() === 'ok')) {
      return { early_exit: true, signal_matched: sig };
    }
  }

  // 规则 2：前导匹配 + 至少 1 字符后续（更宽松：标点 / 中文 / 字母 / 数字均可）
  // 排除两种否定形：
  //   (a) 信号词后紧跟 "不"（如 "好不好" / "对不"）—— 显式否定
  //   (b) 单字信号词后紧跟常见复合词前缀（好+看/对+比 等）—— 口语复合词
  // 仅对 length===1 的信号应用 (b) NEGATIVE_AFTER 表；多字信号不应用。
  for (const sig of sorted) {
    if (trimmed.startsWith(sig)) {
      const after = trimmed.slice(sig.length);
      if (after.length > 0 && after[0] !== '不') {
        // 单字信号才检查 NEGATIVE_AFTER
        const isSingleChar = sig.length === 1;
        const negChars = isSingleChar ? NEGATIVE_AFTER[sig] : undefined;
        const nextChar = after[0];
        if (!negChars || !negChars.includes(nextChar)) {
          return { early_exit: true, signal_matched: sig };
        }
      }
    }
  }

  return { early_exit: false, signal_matched: null };
}
