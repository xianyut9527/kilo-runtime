// checks/i18n-coverage.mjs
// i18n 渲染器纳管校验：
//   - stage-i18n.mjs / i18n-render.mjs 存在
//   - stage-i18n.mjs 导出 5 个映射表（STAGE/TIER/STATUS/INTENT/VERDICT_ZH）
//   - stage-i18n.mjs 导出 8 个函数（labelOf/descOf + 5 format* + formatTriple）
//   - i18n-render.mjs 5 个 --<kind> CLI 分支全部输出含 (KEY) 的中文标签
//
// 零依赖；通过 import() 动态加载 .mjs 验证导出。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STAGE_I18N = path.join(ROOT, 'scripts', 'lib', 'stage-i18n.mjs');
const I18N_RENDER = path.join(ROOT, 'scripts', 'i18n-render.mjs');

const EXPECTED_MAPS = ['STAGE_ZH', 'TIER_ZH', 'STATUS_ZH', 'INTENT_ZH', 'VERDICT_ZH', 'STRENGTH_ZH'];
const EXPECTED_FUNCS = [
  'labelOf', 'descOf',
  'formatStage', 'formatTier', 'formatStatus', 'formatIntent', 'formatVerdict',
  'formatTriple', 'formatStrength',
];
const CLI_KINDS = [
  { flag: '--stage', key: 'PLANNING' },
  { flag: '--tier', key: 'T1' },
  { flag: '--status', key: 'PENDING' },
  { flag: '--intent', key: 'EXECUTION' },
  { flag: '--verdict', key: 'PASS' },
];

function safeImport(p) {
  return import(pathToFileURL(p).href);
}

export async function run(ctx) {
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || ROOT;

  const stageI18nPath = path.join(root, 'scripts', 'lib', 'stage-i18n.mjs');
  const renderPath = path.join(root, 'scripts', 'i18n-render.mjs');

  // 1. 两个文件必须存在
  const stageExists = fs.existsSync(stageI18nPath);
  const renderExists = fs.existsSync(renderPath);
  if (stageExists && renderExists) {
    cf.pass('i18n.files_exist', `stage-i18n.mjs + i18n-render.mjs 均存在`);
  } else {
    const missing = [];
    if (!stageExists) missing.push('scripts/lib/stage-i18n.mjs');
    if (!renderExists) missing.push('scripts/i18n-render.mjs');
    cf.fail('i18n.files_exist', `i18n 核心文件缺失: ${missing.join(', ')}`);
    return;
  }

  // 2. 5 个映射表导出
  let mod;
  try {
    mod = await safeImport(stageI18nPath);
  } catch (e) {
    cf.fail('i18n.maps_exported', `stage-i18n.mjs 动态 import 失败: ${e.message}`);
    return;
  }
  const missingMaps = EXPECTED_MAPS.filter((k) => mod[k] == null || typeof mod[k] !== 'object');
  if (missingMaps.length === 0) {
    const sizes = EXPECTED_MAPS.map((k) => `${k}=${Object.keys(mod[k]).length}`).join(',');
    cf.pass('i18n.maps_exported', `6 个映射表全部导出（${sizes}）`);
  } else {
    cf.fail('i18n.maps_exported', `缺映射表: ${missingMaps.join(', ')}`);
  }

  // 3. 8 个函数导出
  const missingFuncs = EXPECTED_FUNCS.filter((k) => typeof mod[k] !== 'function');
  if (missingFuncs.length === 0) {
    cf.pass('i18n.functions_exported', `9 个函数全部导出（${EXPECTED_FUNCS.join(', ')}）`);
  } else {
    cf.fail('i18n.functions_exported', `缺函数: ${missingFuncs.join(', ')}`);
  }

  // 4. 5 个 CLI 分支烟测
  let cliPass = 0;
  const cliFailures = [];
  for (const { flag, key } of CLI_KINDS) {
    const res = spawnSync('node', [renderPath, flag, key], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (res.status !== 0) {
      cliFailures.push(`${flag} ${key} exit=${res.status} stderr=${(res.stderr || '').trim()}`);
      continue;
    }
    const out = (res.stdout || '').trim();
    if (!out.includes('(' + key + ')')) {
      cliFailures.push(`${flag} ${key} 缺 "(${key})" 段（stdout=${out.slice(0, 60)}）`);
      continue;
    }
    cliPass++;
  }
  // 额外：--triple 强度烟测（T1 + strength 输出含强度标签）
  const strRes = spawnSync('node', [renderPath, '--triple', 'T1', 'EXECUTING', 'low'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const strOut = (strRes.stdout || '').trim();
  if (strRes.status !== 0 || !strOut.includes('强度')) { cliFailures.push('--triple T1 EXECUTING low 缺强度标签 (exit=' + strRes.status + ' stderr=' + (strRes.stderr||'').trim() + ')'); }

  if (cliFailures.length === 0) {
    cf.pass('i18n.cli_smoke', `5 个 --<kind> 分支烟测全绿（${cliPass}/5）`);
  } else {
    cf.fail('i18n.cli_smoke', `${cliFailures.length} 个 CLI 分支失败: ${cliFailures.slice(0, 3).join(' | ')}`);
  }
}