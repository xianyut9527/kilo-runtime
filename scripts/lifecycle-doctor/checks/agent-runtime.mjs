/**
 * agent-runtime.mjs — lifecycle-doctor check (U7)
 *
 * 校验 lifecycle/runtime/ (U1-U5) 的 7 项关键契约, 防止 U1-U5 重构回退:
 *   1. runtime_dir_exists    目录存在且 5 个 .mjs
 *   2. vision_models_match   listVisionModels() ↔ kilo.json provider.hx.models 视觉模型一致(无漂移)
 *   3. index_select_exported select 是 function
 *   4. index_selectForDispatch_exported selectForDispatch 是 function
 *   5. capability_detector_handles_empty detectCapabilities('',[]) 不抛错且返回 {vision:false,code:false,reasoning:true,long_context:false}
 *   6. model_selector_passthrough selectModel(unknown, caps) 返回 {selected_model: 'unknown', override_reason: 'unknown-model: passthrough', upgraded:false, downgraded:false}
 *   7. early_exit_boundary   detectEarlyExit('好不好？') 返回 {early_exit:false, signal_matched:null} (关键边界: '好' 不可误命中)
 *
 * 任一 fail → 整体 check FAIL, 但不抛异常(用 try/catch 包裹每个子检查).
 *
 * 同步调度: Node 14 不支持同步 require ESM，改用 execFileSync 子进程 dynamic import
 * 预取运行时行为（固定参数），保持 run(ctx) 同步契约。详见 loadRuntime()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_DIR = path.join(ROOT, 'lifecycle', 'runtime');
const KILO_JSON_PATH = path.join(ROOT, 'kilo.json');
const RUNTIME_INDEX_PATH = path.join(RUNTIME_DIR, 'index.mjs');

const CHECK_NAME = 'agent-runtime';

function safe(fn) {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

// Node 14 不支持同步 require() 加载 ESM(.mjs)；改用 execFileSync 启子进程
// dynamic import runtime，预取 check 2-7 所需的全部固定参数运行时行为，
// 构造伪模块对象回填——保持 run(ctx) 同步契约，2-7 调用代码不变。
// runtime 装配后静态，单次探测 <50ms；失败回退 safe() 的 ok:false 分支。
const _PROBE_EARLY_CASES = ['好不好？', '对不起', '好看', '对比', '好'];
function loadRuntime() {
  return safe(function () {
    const url = JSON.stringify(pathToFileURL(RUNTIME_INDEX_PATH).href);
    const script = [
      'import * as mod from ' + url + ';',
      'const out = {};',
      'out.selectFn = typeof mod.select;',
      'out.selectForDispatchFn = typeof mod.selectForDispatch;',
      'try { out.listVision = mod.listVisionModels(); } catch(e){ out.visionErr = e.message; }',
      'try { out.detectCapsEmpty = mod.detectCapabilities("", []); } catch(e){ out.detectCapsEmptyErr = e.message; }',
      'try { out.selectModelPass = mod.selectModel("unknown-xyz", {vision:false,code:false,reasoning:true,long_context:false}); } catch(e){ out.selectModelPassErr = e.message; }',
      'try { out.earlyExit = ' + JSON.stringify(_PROBE_EARLY_CASES) + '.map(function(c){ return mod.detectEarlyExit(c); }); } catch(e){ out.earlyExitErr = e.message; }',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT });
    const data = JSON.parse(raw);
    return {
      listVisionModels: function () {
        if (data.visionErr) throw new Error(data.visionErr);
        return data.listVision;
      },
      select: data.selectFn === 'function' ? function () {} : undefined,
      selectForDispatch: data.selectForDispatchFn === 'function' ? function () {} : undefined,
      detectCapabilities: function () {
        if (data.detectCapsEmptyErr) throw new Error(data.detectCapsEmptyErr);
        return data.detectCapsEmpty;
      },
      selectModel: function () {
        if (data.selectModelPassErr) throw new Error(data.selectModelPassErr);
        return data.selectModelPass;
      },
      detectEarlyExit: function (input) {
        if (data.earlyExitErr) throw new Error(data.earlyExitErr);
        const idx = _PROBE_EARLY_CASES.indexOf(input);
        if (idx === -1) return { early_exit: false, signal_matched: null };
        return data.earlyExit[idx];
      },
    };
  });
}

function readKilo() {
  return safe(function () { return JSON.parse(fs.readFileSync(KILO_JSON_PATH, 'utf8')); });
}

export function run(ctx) {
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || ROOT;
  const runtimeDir = (ctx && ctx.RUNTIME_DIR) || RUNTIME_DIR;
  const kiloPath = (ctx && ctx.KILO_JSON_PATH) || KILO_JSON_PATH;
  const results = [];

  // ---- 1. runtime_dir_exists ----
  {
    const id = CHECK_NAME + '.runtime_dir_exists';
    let files = [];
    let dirExists = false;
    try {
      dirExists = fs.existsSync(runtimeDir) && fs.statSync(runtimeDir).isDirectory();
      if (dirExists) {
        files = fs.readdirSync(runtimeDir).filter(function (f) { return f.endsWith('.mjs'); });
      }
    } catch (e) { void e; }
    const ok = dirExists && files.length === 5;
    const detail = 'dir=' + (dirExists ? 'yes' : 'no') + ', .mjs files=' + files.length + '/5';
    if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
    else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
  }

  // ---- 2. vision_models_match ----
  {
    const id = CHECK_NAME + '.vision_models_match';
    const r1 = loadRuntime();
    const r2 = readKilo();
    if (!r1.ok) { const detail = 'require runtime failed: ' + r1.error; if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
    else if (!r2.ok) { const detail = 'read kilo.json failed: ' + r2.error; if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
    else {
      const listVision = r1.value.listVisionModels;
      const fromKilo = (function () {
        const hx = r2.value && r2.value.provider && r2.value.provider.hx;
        const models = (hx && hx.models) || {};
        return Object.keys(models).filter(function (m) {
          const input = models[m] && models[m].modalities && models[m].modalities.input;
          return Array.isArray(input) && input.indexOf('image') !== -1;
        });
      })();
      let fromRuntime = [];
      let err = null;
      try { fromRuntime = listVision(); } catch (e) { err = e && e.message ? e.message : String(e); }
      if (err) { const detail = 'listVisionModels() threw: ' + err; if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
      else {
        const a = fromKilo.slice().sort().join(',');
        const b = fromRuntime.slice().sort().join(',');
        const ok = a === b;
        const detail = 'kilo.json=[' + a + '] runtime=[' + b + ']';
        if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
        else { if (cf) cf.fail(id, 'drift: ' + detail); results.push({ id: id, ok: false, detail: detail }); }
      }
    }
  }

  // ---- 3-7. require runtime module ----
  const runtimeMod = loadRuntime();
  if (!runtimeMod.ok) {
    const subs = ['index_select_exported', 'index_selectForDispatch_exported', 'capability_detector_handles_empty', 'model_selector_passthrough', 'early_exit_boundary'];
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const id2 = CHECK_NAME + '.' + sub;
      const detail2 = 'runtime require failed: ' + runtimeMod.error;
      if (cf) cf.fail(id2, detail2);
      results.push({ id: id2, ok: false, detail: detail2 });
    }
  } else {
    const mod = runtimeMod.value;

    // 3. index_select_exported
    {
      const id = CHECK_NAME + '.index_select_exported';
      const ok = typeof mod.select === 'function';
      const detail = 'typeof select=' + typeof mod.select;
      if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
      else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
    }

    // 4. index_selectForDispatch_exported
    {
      const id = CHECK_NAME + '.index_selectForDispatch_exported';
      const ok = typeof mod.selectForDispatch === 'function';
      const detail = 'typeof selectForDispatch=' + typeof mod.selectForDispatch;
      if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
      else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
    }

    // 5. capability_detector_handles_empty
    {
      const id = CHECK_NAME + '.capability_detector_handles_empty';
      const r = safe(function () { return mod.detectCapabilities('', []); });
      if (!r.ok) { const detail = 'threw: ' + r.error; if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
      else {
        const v = r.value;
        const ok = v && v.vision === false && v.code === false && v.reasoning === true && v.long_context === false;
        const detail = 'got=' + JSON.stringify(v);
        if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
        else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
      }
    }

    // 6. model_selector_passthrough
    {
      const id = CHECK_NAME + '.model_selector_passthrough';
      const caps = { vision: false, code: false, reasoning: true, long_context: false };
      const r = safe(function () { return mod.selectModel('unknown-xyz', caps); });
      if (!r.ok) { const detail = 'threw: ' + r.error; if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
      else {
        const v = r.value;
        const ok = v && v.selected_model === 'unknown-xyz' && v.override_reason === 'unknown-model: passthrough' && v.upgraded === false && v.downgraded === false;
        const detail = 'got=' + JSON.stringify(v);
        if (ok) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
        else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
      }
    }

    // 7. early_exit_boundary (Fix #6: 扩展为 5 sub-case 全 PASS)
    {
      const id = CHECK_NAME + '.early_exit_boundary';
      const cases = [
        { input: '好不好？', want: false, desc: '好+不 否定' },
        { input: '对不起', want: false, desc: '对+起 复合词' },
        { input: '好看', want: false, desc: '好+看 复合词' },
        { input: '对比', want: false, desc: '对+比 复合词' },
        { input: '好', want: true, desc: '好 精确匹配（正例）' },
      ];
      const subResults = [];
      let allOk = true;
      for (const cc of cases) {
        const r = safe(function () { return mod.detectEarlyExit(cc.input); });
        if (!r.ok) {
          subResults.push({ input: cc.input, desc: cc.desc, want: cc.want, got: 'threw:' + r.error, ok: false });
          allOk = false;
          continue;
        }
        const got = r.value.early_exit;
        const ok = got === cc.want;
        if (!ok) allOk = false;
        subResults.push({ input: cc.input, desc: cc.desc, want: cc.want, got: got, ok: ok });
      }
      const detail = JSON.stringify(subResults);
      if (allOk) { if (cf) cf.pass(id, detail); results.push({ id: id, ok: true, detail: detail }); }
      else { if (cf) cf.fail(id, detail); results.push({ id: id, ok: false, detail: detail }); }
    }
  }

  const nPass = results.filter(function (r) { return r.ok; }).length;
  const nFail = results.length - nPass;
  const status = nFail === 0 ? 'PASS' : 'FAIL';
  return { name: CHECK_NAME, status: status, detail: nPass + ' pass / ' + nFail + ' fail (out of ' + results.length + ')', subResults: results };
}
