#!/usr/bin/env node
// deploy-drift-check.mjs
// 部署漂移校验器：逐文件比对「源码仓库」与「已部署的全局配置副本」，任一不一致即阻断。
//
// 存在动机（真实事故）：
//   install.ps1 的 post-sync doctor 跑的是 $Source（仓库），而 lifecycle-doctor 的 ROOT
//   又硬编码为脚本自身位置——两者叠加使部署副本永不被校验。结果运行时长期跑的是拆分前的
//   旧 conductor.md（37.9KB 单体）、缺 conductor-dispatch-sop.md、kilo.json 被压成 1 行且
//   deep-analyzer prompt="|"，而 doctor 一律报全绿。
//   本脚本把「部署副本 == 仓库」变成机械门禁，并取代 install 脚本里手维护的 CriticalFiles
//   硬编码清单（清单会漏项：conductor-dispatch-sop.md 从未被列进去）。
//
// 归一化规则（比对前对部署副本内容做逆变换，消除安装期的合法改写）：
//   1. 占位符：install 把 agent/*.md + .kilo/instructions/*.md + lifecycle/stages/*.md
//      里的 ${KILO_CONFIG_DIR} 替换成目标绝对路径；比对时把目标路径还原回 ${KILO_CONFIG_DIR}。
//   2. BOM：两侧统一去 BOM 后比对（编码安全由 lifecycle-doctor encoding-safety 负责）。
//   3. 行尾：统一 CRLF -> LF 后比对（跨平台安装不应被判定为漂移）。
//
// 用法：
//   node scripts/deploy-drift-check.mjs [--repo <dir>] [--target <dir>] [--json] [--quiet]
//     --repo    源码仓库根，默认脚本所在仓库
//     --target  部署副本根，默认 $KILO_INSTALL_TARGET 或 ~/.config/kilo
//     --json    输出单行 JSON（供 CI/hook 消费）
//     --quiet   只输出 FAIL 明细与 SUMMARY
//
// 退出码：0=无漂移，1=存在 DIFF/MISSING，2=参数或目标目录错误
//
// 仅用 Node 内置模块；Node 14 兼容（无 replaceAll / ??= / structuredClone）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseRuntimeOwn, classifyExtra, buildDriftExcludes, resolveMdSubstDirs,
  isRootOnlyExcluded } from './lib/install-runtime-data.mjs';
import { globalRoot } from './lib/global-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..');

// ---- 排除清单：从 install 脚本**解析**，不重抄 ----
// 事实源 = install.ps1 `$RecursiveExclude` / install.sh `RECURSIVE_EXCLUDE`（同名同时作用于目录与文件，
// 与 install 的 Should-Exclude 判定方式一致）。旧写法在本文件里另声明一份 EXCLUDE_DIRS/EXCLUDE_FILES，
// 注释「与 install.ps1 对齐」靠人工维持——install 侧动一项而这里没动，就是假 MISSING/EXTRA。
// 回落清单与 DRIFT_ONLY_NAMES 均在 lib 里 export，由夹具跟真实清单交叉校验。
//
// 候选根按序首个命中：`--repo`（install 双脚本就是这么调的，事实源一直在手边）→ 脚本所在树。
// 上一版只读 SELF_ROOT，导致从部署副本跑时（那树里按设计没有 install.ps1）必然回落 fallback
// ——把一份只在极端场景才该用的手工镜像当成了常态路径，而它确实已经漂过两次。
let EXCLUDE_NAMES, ROOT_ONLY_EXCLUDE, EXCLUDE_SOURCE, INSTALL_MISMATCH;
let MD_SUBST_DIRS, MD_SUBST_SOURCE;

function initExcludes(candidateRoots) {
  // 排除集的合并（+ DRIFT_ONLY）在 lib 的 buildDriftExcludes 里做（那里有夹具）；本处只负责展示文案。
  const r = buildDriftExcludes(candidateRoots);
  EXCLUDE_NAMES = r.excludeNames;
  ROOT_ONLY_EXCLUDE = r.rootOnly;
  EXCLUDE_SOURCE = r.usingFallback
    ? 'fallback（候选根均无 install 脚本，清单可能与事实源不符）'
    : `${r.via}@${r.root}`;
  INSTALL_MISMATCH = r.mismatch;
  return r;
}

/**
 * 占位符替换目录：同样从 install 解析（旧写法在此硬编码 `^(agent/|\.kilo/instructions/|lifecycle/stages/)`，
 * install 新增替换目录时这里不报错，只是不对该目录还原占位符 → 目标绝对路径被当成内容差异报假 [DIFF]）。
 */
function initMdSubst(candidateRoots) {
  const r = resolveMdSubstDirs(candidateRoots);
  MD_SUBST_DIRS = r.dirs;
  MD_SUBST_SOURCE = r.usingFallback ? 'fallback' : `${r.via}@${r.root}`;
  return r;
}

const EXCLUDE_SUFFIX = ['.bak', '.bak2', '.orig', '.old', '.tmp', '.log', '.diff', '.patch'];
// 路径前缀级排除（不能用裸目录名：'archive' 同时是仓库拥有的 docs/archive/）。
// knowledge-base/fixes/archive/ = kb.mjs add 重写同 ID 时的旧版本归档，只在部署副本侧累积，
// 仓库不拥有（详见 knowledge-base/index.md §ID 跳号说明）。
const EXCLUDE_PATH_PREFIXES = ['knowledge-base/fixes/archive/'];
// 备份文件前缀（kilo.json.bak.*）
const BAK_PREFIX_RE = /\.bak\./;

function parseArgs(argv) {
  const out = { repo: SELF_ROOT, target: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1]) { out.repo = path.resolve(argv[++i]); }
    else if (a.startsWith('--repo=')) { out.repo = path.resolve(a.slice(7)); }
    else if (a === '--target' && argv[i + 1]) { out.target = path.resolve(argv[++i]); }
    else if (a.startsWith('--target=')) { out.target = path.resolve(a.slice(9)); }
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
  }
  if (!out.target) {
    out.target = path.resolve(process.env.KILO_INSTALL_TARGET || globalRoot());
  }
  return out;
}

function isExcluded(rel, name) {
  // 镜像 install 的 Should-Exclude：同一个名字集合同时判文件项与目录段，不分两侧维护
  if (EXCLUDE_NAMES.has(name)) return true;
  // 根级排除按**首段**命中（清单里既有根级文件也有 reports 这种根级目录）；
  // 旧写法在仓库侧另写一条 `ROOT_ONLY_EXCLUDE.has(rel)` 精确匹配，对目录项失灵 → 假 MISSING。
  if (isRootOnlyExcluded(rel, ROOT_ONLY_EXCLUDE)) return true;
  if (BAK_PREFIX_RE.test(name)) return true;
  for (const s of EXCLUDE_SUFFIX) { if (name.endsWith(s)) return true; }
  for (const p of EXCLUDE_PATH_PREFIXES) { if (rel.startsWith(p)) return true; }
  // 任一父目录命中排除
  const segs = rel.split('/');
  for (let i = 0; i < segs.length - 1; i++) { if (EXCLUDE_NAMES.has(segs[i])) return true; }
  return false;
}

function walk(absRoot, dir, out) {
  const abs = path.join(absRoot, dir);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = (dir ? dir + '/' : '') + e.name;
    if (isExcluded(rel, e.name)) continue;   // 含根级排除（首段语义），无需在此再判一次
    if (e.isDirectory()) walk(absRoot, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 仓库侧期望文件集：优先用 git 列举（tracked + 未忽略的 untracked）。
 * 这样自动排除 .gitignore 里的运行时产物（docs/lessons/、.tmp/、kilo.json.bak.* 等）——
 * 它们在仓库与部署副本两侧各自独立累积，纳入比对只会产生漂移噪声。
 * git 不可用时回退到目录遍历（仍受 EXCLUDE_* 约束）。
 * @returns {{files:string[], via:string}}
 */
function listRepoFiles(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8', timeout: 30000,
  });
  if (r.error || r.status !== 0 || !r.stdout) {
    return { files: walk(repoRoot, '', []), via: 'walk' };
  }
  const files = r.stdout.split(/\r?\n/)
    .filter((l) => l.length > 0)
    .filter((rel) => !isExcluded(rel, path.posix.basename(rel)))
    .filter((rel) => fs.existsSync(path.join(repoRoot, rel)))
    .sort();
  return { files, via: 'git' };
}

/** 读文件并归一化（去 BOM + CRLF->LF）；二进制/读取失败返回 null */
function readNormalized(absPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return null; }
  if (buf.indexOf(0) >= 0) return { binary: true, hash: sha(buf) };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  return { binary: false, text, hash: sha(Buffer.from(text, 'utf8')) };
}

function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** 部署副本逆变换：把目标绝对路径还原为 ${KILO_CONFIG_DIR} 占位符 */
function unsubstitute(text, target) {
  const variants = [target, target.replace(/\\/g, '/'), target.replace(/\//g, '\\')];
  let out = text;
  for (const v of variants) {
    if (!v) continue;
    out = out.split(v).join('${KILO_CONFIG_DIR}');
  }
  return out;
}

// ===== 主流程 =====
const args = parseArgs(process.argv.slice(2));

if (!fs.existsSync(args.repo) || !fs.statSync(args.repo).isDirectory()) {
  process.stderr.write(`[FAIL] repo 目录不存在: ${args.repo}\n`);
  process.exit(2);
}
if (!fs.existsSync(args.target) || !fs.statSync(args.target).isDirectory()) {
  process.stderr.write(`[FAIL] target 目录不存在: ${args.target}\n`);
  process.stderr.write('       先跑 install.ps1 / install.sh 部署，或用 --target 指定部署副本根。\n');
  process.exit(2);
}

// 两份清单都必须在拿到 args.repo、且确认它存在之后才能定（见 initExcludes / initMdSubst 注释）。
initExcludes([args.repo, SELF_ROOT]);
initMdSubst([args.repo, SELF_ROOT]);

const repoListing = listRepoFiles(args.repo);
const repoFiles = repoListing.files;
const targetFiles = walk(args.target, '', []);
const repoSet = new Set(repoFiles);
const targetSet = new Set(targetFiles);

const missing = [];  // 仓库有、部署副本无 → 运行时读不到（最危险）
const extra = [];    // 部署副本有、仓库无且非运行时自有数据 → 陈旧残留 / 待回收
const runtimeData = []; // install 声明的部署侧自有数据（仓库不拥有该路径）→ 不计漂移
const runtimeOwn = parseRuntimeOwn(args.repo);
const repoPrefixCache = new Map();
/** 仓库（git 期望集）在该目录下是否拥有任何文件；用于区分「完全不拥有的路径」与「拥有目录但缺文件」 */
function repoHasFileUnder(prefix) {
  if (repoPrefixCache.has(prefix)) return repoPrefixCache.get(prefix);
  const hit = repoFiles.some((f) => f === prefix || f.startsWith(prefix + '/'));
  repoPrefixCache.set(prefix, hit);
  return hit;
}
const diff = [];     // 两侧都有但内容不同

for (const rel of repoFiles) {
  if (!targetSet.has(rel)) { missing.push(rel); continue; }
  const a = readNormalized(path.join(args.repo, rel));
  const b = readNormalized(path.join(args.target, rel));
  if (!a || !b) { diff.push({ rel, reason: 'unreadable' }); continue; }
  if (a.binary || b.binary) {
    if (a.hash !== b.hash) diff.push({ rel, reason: 'binary hash differs' });
    continue;
  }
  // 占位符逆变换范围 = install 实际替换的那些目录（从 $MdFilePatterns / md_dir 解析，不硬编码）。
  const needsUnsub = rel.endsWith('.md') && MD_SUBST_DIRS.some((d) => rel.startsWith(d));
  const bText = needsUnsub ? unsubstitute(b.text, args.target) : b.text;
  if (a.text !== bText) {
    diff.push({
      rel,
      reason: `content differs (repo ${Buffer.byteLength(a.text, 'utf8')}B vs target ${Buffer.byteLength(b.text, 'utf8')}B)`,
    });
  }
}
for (const rel of targetFiles) {
  if (repoSet.has(rel)) continue;
  // 区分「install 声明的部署侧自有数据」与「真残留」：前者每次 install 都会出现，
  // 一律打成 [EXTRA] 、要人工确认 = 每次都是误报（误报门禁等于训练人去忽略门禁）。
  if (classifyExtra(rel, runtimeOwn, repoHasFileUnder) === 'runtime') runtimeData.push(rel);
  else extra.push(rel);
}

const drifted = missing.length + diff.length;
const result = {
  ok: drifted === 0,
  repo: args.repo,
  target: args.target,
  listed_via: repoListing.via,
  scanned: repoFiles.length,
  missing_count: missing.length,
  diff_count: diff.length,
  extra_count: extra.length,
  runtime_data_count: runtimeData.length,
  runtime_data_via: runtimeOwn.via,
  missing,
  diff,
  extra,
  runtime_data: runtimeData,
  excludes_source: EXCLUDE_SOURCE,
  subst_source: MD_SUBST_SOURCE,
};

if (args.json) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(drifted === 0 ? 0 : 1);
}

const say = (s) => process.stdout.write(s + '\n');
say(`[DRIFT] repo=${args.repo}`);
say(`[DRIFT] target=${args.target}`);
say(`[DRIFT] scanned=${repoFiles.length} (repo 列举方式=${repoListing.via}) missing=${missing.length} diff=${diff.length} extra=${extra.length} runtime_data=${runtimeData.length}`);
// 排除清单来源：解析到 install 脚本 = 跟随事实源（带 `@<解析根>`）；fallback = `--repo` 与脚本所在树都读不到。
// 出现 fallback 即异常信号（install 双脚本传了 --repo，正常必须命中事实源）：排除集会停在手工镜像旧值，
// 那份镜像已实测漂过两次——所以这里必须可见，不能静默。
say(`[DRIFT] excludes=${EXCLUDE_SOURCE} (${EXCLUDE_NAMES.size} names, ${ROOT_ONLY_EXCLUDE.size} root-only)`
  + ` subst-dirs=${MD_SUBST_SOURCE} (${MD_SUBST_DIRS.length})`
  + (INSTALL_MISMATCH.length ? ` | [MISMATCH] 双端排除清单不一致: ${INSTALL_MISMATCH.join(', ')}` : ''));

if (!args.quiet || missing.length) {
  for (const f of missing.slice(0, 40)) say(`  [MISSING] ${f}`);
  if (missing.length > 40) say(`  [MISSING] … 另 ${missing.length - 40} 项`);
}
if (!args.quiet || diff.length) {
  for (const d of diff.slice(0, 40)) say(`  [DIFF]    ${d.rel} — ${d.reason}`);
  if (diff.length > 40) say(`  [DIFF]    … 另 ${diff.length - 40} 项`);
}
if (!args.quiet && extra.length) {
  for (const f of extra.slice(0, 20)) say(`  [EXTRA]   ${f}`);
  if (extra.length > 20) say(`  [EXTRA]   … 另 ${extra.length - 20} 项`);
}
// 预期内的部署侧自有数据：给一行计数而不逐条打「需人工确认」（清单源 = install 脚本；
// via=none 表示没读到安装脚本，此时上方 EXTRA 已回落为「全按残留」）。
if (!args.quiet && runtimeData.length) {
  say(`  [RUNTIME] ${runtimeData.length} 项为 install 声明的部署侧自有数据（不计漂移，源=${runtimeOwn.via}）：`
    + runtimeData.slice(0, 6).join(', ')
    + (runtimeData.length > 6 ? ` … 另 ${runtimeData.length - 6} 项` : ''));
}

if (drifted === 0) {
  say('[OK] 部署副本与仓库一致（无 MISSING / DIFF）');
  process.exit(0);
}
process.stderr.write(`[DEPLOY_DRIFT] 部署副本与仓库不一致：missing=${missing.length} diff=${diff.length}\n`);
process.stderr.write('               重跑 install.ps1 / install.sh 后复验；[EXTRA] 为部署侧残留或运行时新增待回收项（install 声明的自有数据已归入 [RUNTIME]，不在此列），需人工确认。\n');
process.exit(1);
