// index.mjs — Kilo runtime unified entry (U5)
// Aggregates 4 submodules (capability-registry / capability-detector /
// model-selector / early-exit) and exposes two orchestration functions:
//   select(snapshot)        → 完整聚合：detect caps → select model → early-exit
//   selectForDispatch(d,i,f,o) → 简化版：默认 costPriority='balanced'，从 kilo.json 读 smallModel
// Pure aggregation layer; no business logic of its own. Used by conductor
// to make one-shot model-selection decisions before dispatching EXECUTING units.
// Typical: const r = selectForDispatch(cfg.model, intentRaw, attachedFiles, options);
// Zero third-party deps. ESM static imports — submodules MUST exist (DAG guarantee).
//
// v2 (Fix #2/#4): 模块初始化时一次性从 lifecycle/config.yaml 读取
// `runtime.early_exit_signals` 并 setSignals 覆盖（regex 解析，避免引入
// yaml 库；空数组跳过 → 保留默认）；selectForDispatch 改为顶部只读 1 次
// kilo.json（同时拿 smallModel 和预解析 models 透传给 select/selectModel），
// 消除 readSmallModelFromKiloJson 与 selectModel 内部 loadModels 的重复 read。
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cachedDerive } from '../../scripts/lib/derived-cache.mjs';
import { detectCapabilities } from './capability-detector.mjs';
import { selectModel } from './model-selector.mjs';
import { detectEarlyExit, setSignals, getSignals } from './early-exit.mjs';
import { loadModelsFromCfg, getCapabilities, getCapabilitiesFromMap } from './capability-registry.mjs';

// Re-export all submodule surface for downstream consumers that prefer
// a single import root. (e.g. `import { getCapabilities } from './runtime/index.mjs'`)
export { getCapabilities, listVisionModels, listAllModels, getProviderPrefixForModelId } from './capability-registry.mjs';
export { detectCapabilities } from './capability-detector.mjs';
export { selectModel } from './model-selector.mjs';
export { detectEarlyExit, setSignals, getSignals, addSignals } from './early-exit.mjs';

const _REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // lifecycle/runtime/ -> repo root
const KILO_JSON_PATH = resolve(_REPO_ROOT, 'kilo.json');
const CONFIG_YAML_PATH = resolve(_REPO_ROOT, 'lifecycle', 'config.yaml');

// ——— Fix #2: lifecycle/config.yaml `runtime.early_exit_signals` 落地 ———
// 简化解：纯正则匹配 `early_exit_signals: [a, b, c]`，不引入 yaml 解析库；
// 空数组 / 缺失 / 解析失败 → 静默回退 early-exit.mjs 内置默认。
function loadEarlyExitSignalsFromConfig() {
  try {
    const raw = readFileSync(CONFIG_YAML_PATH, 'utf8');
    const m = raw.match(/early_exit_signals:\s*\[([^\]]*)\]/);
    if (!m) return null;
    const inner = m[1].trim();
    if (!inner) return null; // 空数组 = 用默认
    const items = inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : null;
  } catch (err) {
    // 配置缺失/损坏 → 静默回退默认；不向上抛
    console.warn(`[index.mjs] failed to load early_exit_signals: ${err?.message ?? err}`);
    return null;
  }
}

// 模块初始化时一次性 setSignals（避免每次 selectForDispatch 都读 config）
const _configSignals = loadEarlyExitSignalsFromConfig();
if (_configSignals && _configSignals.length > 0) {
  setSignals(_configSignals);
}

// ——— Fix D1: lifecycle/config.yaml `runtime.capability_strict` 落地 ———
// 简化解：纯正则匹配 `capability_strict: true/false`，不引入 yaml 解析库；
// 缺失 / 解析失败 / 未声明 → 默认 false（向后兼容现有调用方）。
let _capabilityStrict = false;
function loadCapabilityStrictFromConfig() {
  try {
    const raw = readFileSync(CONFIG_YAML_PATH, 'utf8');
    const m = raw.match(/capability_strict:\s*(true|false)/);
    if (!m) return false;
    return m[1] === 'true';
  } catch (err) {
    console.warn(`[index.mjs] failed to load capability_strict: ${err?.message ?? err}`);
    return false;
  }
}
export function getCapabilityStrict() { return _capabilityStrict; }
_capabilityStrict = loadCapabilityStrictFromConfig();

// 内部 helper：strict 模式下，selected_model 不满足必需能力时抛 [RUNTIME_STRICT]。
// 注意：当前实现将检测放在 select 聚合层而非 selectModel 内部，原因是
// selectModel 不知道 strict 开关（避免改动 selectModel 公共签名）。
// _assertCapabilitySatisfiable 接受已计算好的 modelResult + required_caps + 预解析 models。
function _assertCapabilitySatisfiable(modelResult, required_caps, models, strictFlag) {
  const strict = strictFlag !== undefined ? strictFlag : _capabilityStrict;
  if (!strict) return;
  const missing = [];
  if (required_caps && required_caps.vision === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.vision !== true) missing.push('vision');
  }
  if (required_caps && required_caps.code === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.code !== true) missing.push('code');
  }
  if (required_caps && required_caps.long_context === true) {
    const caps = models ? getCapabilitiesFromMap(modelResult.selected_model, models) : getCapabilities(modelResult.selected_model);
    if (caps.long_context !== true) missing.push('long_context');
  }
  if (missing.length > 0) {
    throw new Error(
      `[RUNTIME_STRICT] capability gap not satisfiable: ${missing.join('/')}=required but no matching model available (selected=${modelResult.selected_model})`
    );
  }
}

/**
 * Full model-selection pipeline: detect capabilities → select model → early-exit.
 * @param {{
 *   intentRaw: string,
 *   attachedFiles?: string[],
 *   defaultModel: string,
 *   userMessage?: string,
 *   costPriority?: 'balanced'|'quality'|'economy',
 *   smallModel?: string,
 *   models?: object,        // Fix #4 预解析 merged map（capability-registry 内部 key 格式）
 * }} snapshot
 * @returns {{
 *   selected_model: string,
 *   override_reason: string,
 *   upgraded: boolean,
 *   downgraded: boolean,
 *   early_exit: boolean,
 *   signal_matched: string | null,
 *   required_caps: { vision: boolean, code: boolean, reasoning: boolean, long_context: boolean },
 * }}
 */
export function select(snapshot) {
  const {
    intentRaw = '',
    attachedFiles = [],
    defaultModel,
    userMessage = '',
    costPriority = 'balanced',
    smallModel,
    models,
    capabilityStrict, // Fix D1: snapshot override; default = getCapabilityStrict()
  } = snapshot ?? {};

  // 1) detect required capabilities from intent + attachments
  const required_caps = detectCapabilities(intentRaw, attachedFiles);

  // Fix D1: 先计算 strict flag（snapshot > config），后续 selectModel + post-check 共用
  const _strict = capabilityStrict !== undefined ? capabilityStrict : getCapabilityStrict();

  // 2) select model honoring capability gaps + cost priority
  //    Fix #4 透传预解析 models（避免 selectModel 内部再 loadModels → 再读 kilo.json）
  const modelResult = selectModel(defaultModel, required_caps, { costPriority, smallModel, models, capabilityStrict: _strict });

  // 2.5) Fix D1: strict 模式下，若升级后 selected_model 仍不满足必需能力 → 抛 [RUNTIME_STRICT]
  _assertCapabilitySatisfiable(modelResult, required_caps, models, _strict);

  // 3) detect early-exit signal from user message (independent of model choice)
  const earlyExitResult = detectEarlyExit(userMessage);

  // 4) aggregate into a single decision object
  return {
    selected_model: modelResult.selected_model,
    override_reason: modelResult.override_reason,
    upgraded: modelResult.upgraded,
    downgraded: modelResult.downgraded,
    early_exit: earlyExitResult.early_exit,
    signal_matched: earlyExitResult.signal_matched,
    required_caps,
  };
}

/**
 * Simplified dispatch helper: defaults costPriority='balanced' and reads
 * smallModel from kilo.json (root: kilo_config/kilo.json).
 * Fix #4: 单次调用只读 1 次 kilo.json，解析出 smallModel + 预加载 models。
 * @param {string} defaultModel
 * @param {string} intentRaw
 * @param {string[]} [attachedFiles]
 * @param {{costPriority?: 'balanced'|'quality'|'economy', userMessage?: string, smallModel?: string, models?: object}} [options]
 */
export function selectForDispatch(defaultModel, intentRaw, attachedFiles = [], options = {}) {
  // kilo.json 读取经 cachedDerive mtime 缓存（装配后静态，跨 dispatch 命中）；
  // 同时拿 smallModel + 预解析 models（用 cfg 复用 loadModelsFromCfg）
  let { smallModel, models } = options;
  if (smallModel === undefined || models === undefined) {
    const cfg = cachedDerive('kiloCfg', [KILO_JSON_PATH], () => {
      const raw = readFileSync(KILO_JSON_PATH, 'utf8');
      return JSON.parse(raw);
    });
    if (smallModel === undefined) smallModel = cfg?.small_model;
    if (models === undefined) models = loadModelsFromCfg(cfg);
  }
  return select({
    defaultModel,
    intentRaw,
    attachedFiles,
    costPriority: options.costPriority ?? 'balanced',
    userMessage: options.userMessage ?? '',
    smallModel,
    models,
  });
}

// ============================================================
// CLI 入口（铁律 #6a 用；被 import 时不执行，零副作用）
// ============================================================
// 历史缺陷：铁律 #6a 曾要求 conductor 写 `import { selectForDispatch } from '../lifecycle/runtime/index.mjs'`
// ——LLM 不能执行 ESM import，本模块也无 CLI，整条规则不可执行 = 死规则（每个 T1/T2
// 任务要么静默跳过、要么编造结果）。现提供 CLI，使 runtime 模型调度变成一条可机械回放的
// bash 命令（与 task-context.mjs / transition-check.mjs 同构，证据可入 evidence[]）。
//
// 用法：
//   node lifecycle/runtime/index.mjs select --agent <name> --task-id <id> [--cost balanced|quality|economy]
//   node lifecycle/runtime/index.mjs select --model <defaultModel> --intent <text> [--files a,b] [--user-message <text>]
//
// 输出：单行 JSON（selected_model / override_reason / upgraded / downgraded / early_exit /
//       signal_matched / required_caps / default_model / model_override / runtime_status）
// 退出码：0=正常决策；1=运行时异常（stdout 仍输出 runtime_status:'degraded' + 原始 model，
//       conductor 按降级继续并记 dispatch_log）；3=参数错误
const COST_PRIORITIES = ['balanced', 'quality', 'economy'];

function parseCli(argv) {
  const o = {
    cmd: argv[0] || '', agent: null, taskId: null, model: null, intent: null,
    files: [], userMessage: null, cost: 'balanced', help: false,
  };
  // --help 允许出现在子命令位（`index.mjs --help`）与参数位（`index.mjs select --help`）
  if (o.cmd === '--help' || o.cmd === '-h') { o.help = true; o.cmd = ''; }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--task-id') o.taskId = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--intent') o.intent = argv[++i];
    else if (a === '--files') o.files = String(argv[++i] || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    else if (a === '--user-message') o.userMessage = argv[++i];
    else if (a === '--cost') o.cost = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function printUsage() {
  process.stdout.write([
    'usage: node lifecycle/runtime/index.mjs select --agent <name> --task-id <id> [--cost balanced|quality|economy]',
    '       node lifecycle/runtime/index.mjs select --model <defaultModel> --intent <text> [--files a,b] [--user-message <text>]',
    'out  : single-line JSON decision (selected_model / upgraded / downgraded / override_reason / early_exit / runtime_status)',
    'exit : 0=ok  1=degraded (fallback model emitted)  3=bad args',
  ].join('\n') + '\n');
}

async function cliMain() {
  const o = parseCli(process.argv.slice(2));
  if (o.help) { printUsage(); process.exit(0); }
  if (o.cmd !== 'select') { printUsage(); process.exit(3); }
  if (COST_PRIORITIES.indexOf(o.cost) < 0) {
    process.stderr.write(`[RUNTIME_CLI] bad --cost "${o.cost}"; expected one of ${COST_PRIORITIES.join('|')}\n`);
    process.exit(3);
  }

  const cfg = cachedDerive('kiloCfg', [KILO_JSON_PATH], () => JSON.parse(readFileSync(KILO_JSON_PATH, 'utf8')));
  // 优先级：--model 显式传入 > kilo.json agent.<name>.model > kilo.json 顶层 model
  let defaultModel = o.model;
  if (!defaultModel && o.agent) defaultModel = (cfg && cfg.agent && cfg.agent[o.agent] && cfg.agent[o.agent].model) || null;
  if (!defaultModel) defaultModel = (cfg && cfg.model) || null;
  if (!defaultModel) {
    process.stderr.write('[RUNTIME_CLI] cannot resolve default model: pass --model, or --agent with kilo.json agent.<name>.model\n');
    process.exit(3);
  }

  let intentRaw = o.intent || '';
  let attachedFiles = o.files;
  let modelOverride = null;

  // --task-id：从 task_context 取 intent.raw / sizing.key_files / config.model_overrides（经 task-context.mjs
  // 导出接口读，不直接碰 JSON 文件——与铁律 #4 context 必收口保持一致）
  if (o.taskId) {
    try {
      const tc = await import('../../scripts/task-context.mjs');
      // 先自查存在性：readContext 内部 die(1) 会直接终止进程，无法被 catch 归类为参数错
      const ctxFile = tc.contextPath(o.taskId);
      if (!existsSync(ctxFile)) {
        process.stderr.write(`[RUNTIME_CLI] task_context not found: task_id=${o.taskId} (expected ${ctxFile})\n`);
        process.exit(3);
      }
      const { ctx } = tc.readContext(o.taskId);
      if (!intentRaw) intentRaw = tc.getByPath(ctx, 'intent.raw') || '';
      if (attachedFiles.length === 0) {
        const kf = tc.getByPath(ctx, 'sizing.key_files');
        if (Array.isArray(kf)) attachedFiles = kf.map((x) => String(x));
      }
      if (o.agent) {
        const ov = tc.getByPath(ctx, 'config.model_overrides');
        if (ov && typeof ov === 'object' && ov[o.agent]) modelOverride = String(ov[o.agent]);
      }
    } catch (e) {
      process.stderr.write(`[RUNTIME_CLI] task_context read failed (task_id=${o.taskId}): ${e && e.message ? e.message : e}\n`);
      process.exit(3);
    }
  }

  const userMessage = o.userMessage || intentRaw;
  let decision;
  try {
    decision = selectForDispatch(defaultModel, intentRaw, attachedFiles, { costPriority: o.cost, userMessage });
    decision.runtime_status = 'ok';
  } catch (e) {
    // 降级不阻断派发：回退原始 model，conductor 在 dispatch_log 追记 runtime_status:'degraded'
    decision = {
      selected_model: defaultModel, override_reason: 'runtime error', upgraded: false, downgraded: false,
      early_exit: false, signal_matched: null, required_caps: null,
      runtime_status: 'degraded', error: (e && e.message) ? e.message : String(e),
    };
    decision.default_model = defaultModel;
    if (modelOverride) decision.model_override = modelOverride;
    process.stdout.write(JSON.stringify(decision) + '\n');
    process.exit(1);
  }

  decision.default_model = defaultModel;
  // 铁律 #6a1：config.model_overrides.<agent> 优先于 runtime 决策（apply-tier-auto 已机械写入）
  if (modelOverride) decision.model_override = modelOverride;
  process.stdout.write(JSON.stringify(decision) + '\n');
  process.exit(0);
}

const _isMain = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (_isMain) { cliMain(); }
