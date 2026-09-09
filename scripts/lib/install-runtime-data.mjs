// scripts/lib/install-runtime-data.mjs
// 解析 install 脚本声明的路径清单 —— 单一事实源是安装脚本，本文件不重抄路径。
// 目前解析两类：① 「部署侧自有数据」（RuntimeData*）② 拷贝排除清单（*Exclude / *_EXCLUDE）。
//
// 立项根因（2026-09 实测）：`deploy-drift-check.mjs` 的仓库侧期望集用 git 列举，因此
// .gitignore 里的运行时产物（`docs/lessons/*.md`、`kilo.jsonc`、`.bash-permission-migrated`）
// 每次 install 都会被打成 `[EXTRA] …为部署侧残留，需人工确认`——三行**每次都是误报**。
// 误报门禁等于训练人去忽略门禁；而 install.ps1 的注释又写着「与 deploy-drift-check.mjs
// RUNTIME_ONLY 保持同步」，那个标识符根本不存在（第 4 处假陈述）。
//
// 判定规则（刻意保守，宁可多报不可漏报）：
//   1. 命中 install 声明的 RuntimeData**Files**（精确文件名）→ runtime（部署侧自有，永远不是漂移）
//   2. 落在声明的 RuntimeData**Dirs** 下，且**仓库在该目录下没有任何被跟踪文件** → runtime
//      （仓库完全不拥有这条路径，target 里有属正常）
//   3. 落在声明目录下但仓库拥有该目录（如 `knowledge-base/`）→ stale
//      —— 这正是"运行时新增待回收进仓库"（kb.mjs add 只写部署副本）或真残留，必须继续报出来
//   4. 其余 → stale
//
// install 脚本读不到（用户从别处跑 drift）时返回空清单：行为回落到「全部按 stale 报」，
// 即修复前的语义，不会静默放过任何疑似残留。

import fs from 'node:fs';
import path from 'node:path';

function toPosix(s) {
  return s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}

/** 从 `NAME = @("a", "b\c")` / `NAME=("a" "b")` 两种写法里抽字符串字面量 */
function extractLiterals(text, varRe) {
  const m = varRe.exec(text);
  if (!m) return [];
  const re = /"([^"]+)"|'([^']+)'/g;
  const out = [];
  let x;
  while ((x = re.exec(m[1])) !== null) {
    const v = toPosix(x[1] !== undefined ? x[1] : x[2]);
    if (v) out.push(v);
  }
  return out;
}

/**
 * 解析安装脚本声明的运行时数据清单。
 * @param {string} rootDir 含 install.ps1 / install.sh 的目录（通常是仓库根）
 * @returns {{dirs:string[], files:string[], via:string}}
 */
export function parseRuntimeOwn(rootDir) {
  const dirs = new Set();
  const files = new Set();
  const sources = [];
  for (const [name, read] of [
    ['install.ps1', () => fs.readFileSync(path.join(rootDir, 'install.ps1'), 'utf8')],
    ['install.sh', () => fs.readFileSync(path.join(rootDir, 'install.sh'), 'utf8')],
  ]) {
    let text = '';
    try { text = read(); } catch { continue; }
    const d = extractLiterals(text, /\$(?:RuntimeDataDirs|RUNTIME_DATA_DIRS)\s*=\s*[@(]\(([^)]*)\)/)
      .concat(extractLiterals(text, /RUNTIME_DATA_DIRS\s*=\s*\(([^)]*)\)/));
    const f = extractLiterals(text, /\$(?:RuntimeDataFiles|RUNTIME_DATA_FILES)\s*=\s*[@(]\(([^)]*)\)/)
      .concat(extractLiterals(text, /RUNTIME_DATA_FILES\s*=\s*\(([^)]*)\)/));
    if (d.length + f.length === 0) continue;
    for (const v of d) dirs.add(v);
    for (const v of f) files.add(v);
    sources.push(name);
  }
  return { dirs: [...dirs], files: [...files], via: sources.length ? sources.join('+') : 'none' };
}

/**
 * 分类一条「部署副本有、仓库期望集没有」的路径。
 * @param {string} rel posix 相对路径
 * @param {{dirs:string[],files:string[]}} own parseRuntimeOwn 结果
 * @param {(prefix:string)=>boolean} repoHasFileUnder 仓库是否在该目录下拥有任何被跟踪文件
 * @returns {'runtime'|'stale'}
 */
export function classifyExtra(rel, own, repoHasFileUnder) {
  const norm = toPosix(rel);
  if (own.files.includes(norm)) return 'runtime';
  for (const d of own.dirs) {
    if (norm !== d && !norm.startsWith(d + '/')) continue;
    if (!repoHasFileUnder(d)) return 'runtime';
    return 'stale';
  }
  return 'stale';
}

/**
 * 解析不到安装脚本时的**回落清单**（export 而非内嵌在调用方：
 * 调用方与回归夹具 import 同一份，避免「测试用正则抓对方源码」这种随写法失灵的比对）。
 *
 * ⚠ 这是一份手工镜像，而手工镜像正是本文件立项要消灭的东西。实测代价（同一会话内两次漂移）：
 *   ① install 侧 RootOnly 新增 `reports` 而这里没跟 → 夹具「回落副本与真实清单一致」变红；
 *   ② 清单里含第三方 MCP 工具名的那一项触发 decouple-audit critical（install 侧有豁免、这里没同步）。
 *   即「镜像不只漂数据，还会漂围绕数据的元规则」。因此：
 *   - 常态路径**不应命中这里**：drift-check 会按 `--repo` → 脚本所在树依次找真实 install 脚本，
 *     只有两者都读不到才回落（输出行的 `excludes=fallback` 就是异常信号）；
 *   - 改 install 排除清单必须同步这里，由 checks/__tests__/install-runtime-data.test.mjs 钉住；
 *   - 新增项若含第三方 MCP 工具名，还须扩 scripts/decouple-check.mjs 的 BENIGN 豁免。
 *   见 CONFIG_CHANGE_CHECKLIST.md「修改 install 排除清单」条目。
 */
export const FALLBACK_RECURSIVE_EXCLUDE = [
  '.git', '.gitignore', 'node_modules',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'yarn.lock',
  'agent-manager.json', '.tmp', 'worktrees', '.pytest_cache', '__pycache__',
  '.kilo_tmp', '.claude', '.playwright-mcp', '_test_target_orig', '.mcp-tmp',
];
export const FALLBACK_ROOT_ONLY_EXCLUDE = ['install.ps1', 'install.sh', 'README.md', 'LICENSE', 'reports'];

/**
 * 比对侧独有名字：install 是「仓库 → 目标」单向拷贝，这些在仓库侧不存在、无需排除；
 * 但会在部署副本侧真实出现（运行期产物 / OS 垃圾），比对必须挡掉。它们不是「第二份排除清单」。
 */
export const DRIFT_ONLY_NAMES = [
  '.generated',            // scripts/lib/.generated/：预派生缓存，只在使用中生成
  'skills', 'task_context', 'mmo-audit', // 部署副本侧运行时目录
  '.DS_Store', 'Thumbs.db',
];

/**
 * 解析 install 脚本声明的**拷贝排除清单**。
 *
 * 立项根因（2026-09 自查）：`deploy-drift-check.mjs` 为了算「仓库期望集 / 部署侧集合」，
 * 自己又声明了一份 `EXCLUDE_DIRS` / `EXCLUDE_FILES` / `ROOT_ONLY_EXCLUDE`，注释写
 * 「与 install.ps1 对齐」= 靠人工维持的镜像。同一会话我已在 README 里宣称「排除清单
 * 各维护一份必然漂移」这条缺陷被消灭，实际只消灭了 RuntimeData 一份，排除清单仍是两份
 * ——install 侧新增排除项（或改 RootOnly）而 drift 未同步时，会直接产出假 MISSING/EXTRA。
 * 本函数把「读哪一份」变成「读事实源」。
 *
 * @param {string} rootDir 含 install.ps1 / install.sh 的目录
 * @returns {{recursive:string[], rootOnly:string[], recursiveSet:Set<string>, rootOnlySet:Set<string>,
 *            via:string, mismatch:string[], present:string[]}}
 *          mismatch=双端清单差异（`name@only-in-install.ps1` 形态）；
 *          present=**本根实际存在的安装脚本**（与 via 分开记：「有脚本但解析不出」与
 *          「根本没有脚本」两种情形的修法完全不同，归为一类会把门禁降级成静默回落）。
 */
export function parseInstallExcludes(rootDir) {
  const recursive = new Set();
  const rootOnly = new Set();
  const perSource = new Map();
  const sources = [];
  const present = [];
  for (const name of ['install.ps1', 'install.sh']) {
    let text = '';
    try { text = fs.readFileSync(path.join(rootDir, name), 'utf8'); } catch { continue; }
    present.push(name);
    const r = extractLiterals(text, /\$(?:RecursiveExclude|RECURSIVE_EXCLUDE)\s*=\s*[@(]\(([^)]*)\)/)
      .concat(extractLiterals(text, /^RECURSIVE_EXCLUDE\s*=\s*\(([^)]*)\)/m));
    const o = extractLiterals(text, /\$(?:RootOnlyExclude|ROOT_ONLY_EXCLUDE)\s*=\s*[@(]\(([^)]*)\)/)
      .concat(extractLiterals(text, /^ROOT_ONLY_EXCLUDE\s*=\s*\(([^)]*)\)/m));
    if (r.length + o.length === 0) continue;
    sources.push(name);
    for (const v of r) recursive.add(v);
    for (const v of o) rootOnly.add(v);
    perSource.set(name, { r: new Set(r), o: new Set(o) });
  }
  // 双端差异：任一侧独有项都要报出来（drift 侧不静默取并集了事）
  const mismatch = [];
  if (perSource.size === 2) {
    const keys = [...perSource.keys()];
    for (let i = 0; i < 2; i++) {
      const x = keys[i];
      const y = keys[1 - i];
      for (const setKey of ['r', 'o']) {
        for (const v of perSource.get(x)[setKey]) {
          if (!perSource.get(y)[setKey].has(v)) mismatch.push(`${v}@only-in-${x}`);
        }
      }
    }
  }
  return {
    recursive: [...recursive],
    rootOnly: [...rootOnly],
    recursiveSet: recursive,
    rootOnlySet: rootOnly,
    via: sources.length ? sources.join('+') : 'none',
    mismatch,
    present,
  };
}

/**
 * 按候选根依次解析排除清单，全部读不到才用回落副本。
 *
 * 为什么要候选根而不是直接读脚本所在树（2026-09 实测发现）：`deploy-drift-check.mjs` 从
 * 部署副本跑、install 双脚本传 `--repo <源仓库>` 时，事实源其实在 `--repo` 下，而脚本所在树
 * 按设计不含 install.ps1——只看后者会把回落副本当常态路径用，而回落副本已实测漂过两次。
 *
 * @param {string[]} candidateRoots 按优先级排列的目录（首个可解析者胜）
 * @returns 同 parseInstallExcludes，额外带 `root`（实际使用的解析根）与 `usingFallback`
 */
export function resolveInstallExcludes(candidateRoots) {
  let present = [];
  for (const root of candidateRoots) {
    if (!root) continue;
    const r = parseInstallExcludes(root);
    // 脚本存在但解析不出清单，比「没脚本」更危险：记下来供调用侧区分两种修法
    if (r.present.length > 0) present = r.present;
    if (r.via !== 'none') return { ...r, root, usingFallback: false };
  }
  return {
    recursive: [...FALLBACK_RECURSIVE_EXCLUDE],
    rootOnly: [...FALLBACK_ROOT_ONLY_EXCLUDE],
    recursiveSet: new Set(FALLBACK_RECURSIVE_EXCLUDE),
    rootOnlySet: new Set(FALLBACK_ROOT_ONLY_EXCLUDE),
    via: 'fallback',
    mismatch: [],
    root: null,
    present,
    usingFallback: true,
  };
}

/**
 * drift 比对侧的最终排除集 = install 解析结果（或回落副本）+ 比对侧独有名字。
 *
 * 放在 lib 而非内嵌在 drift-check：`excludeNames` 漏了 DRIFT_ONLY 就会在每次 install 后报一排
 * 假 EXTRA，这是行为关键而不是展示细节，应能在网内直测，而不是靠跑整个 CLI 才能跑到。
 *
 * @param {string[]} candidateRoots 按优先级排列的候选根
 * @returns {{excludeNames:Set<string>, rootOnly:Set<string>, via:string, root:string|null,
 *            mismatch:string[], usingFallback:boolean}}
 */
export function buildDriftExcludes(candidateRoots) {
  const r = resolveInstallExcludes(candidateRoots);
  return {
    excludeNames: new Set([...r.recursive, ...DRIFT_ONLY_NAMES]),
    rootOnly: r.rootOnlySet,
    via: r.via,
    root: r.root,
    mismatch: r.mismatch,
    present: r.present,
    usingFallback: r.usingFallback,
  };
}

/**
 * 根级排除项判定：`rel` 的**首段**命中 rootOnly 即整棵子树排除。
 *
 * 为什么不是精确等于（2026-09 实测踩坑）：RootOnly 清单原本只有根级**文件**
 * （install.ps1 / README.md / LICENSE），“`set.has(rel)`” 刚好够用；加入 `reports`（目录）后
 * 假设被打破：drift 侧的 git 列表给的是 `reports/2026-08-12/xxx.md`，精确匹配不中 → 报假 MISSING，
 * 而 install 侧（递归遍历、根级命中即跳过整目录）行为是对的——典型「同一语义两处实现、只有一处对」。
 * install 两脚本（ps1 根级跳过 / sh `depth -eq 0` 按 basename）都已是本函数的语义。
 *
 * @param {string} rel posix 相对路径
 * @param {Set<string>} rootOnlySet
 */
export function isRootOnlyExcluded(rel, rootOnlySet) {
  if (rootOnlySet.size === 0) return false;
  const norm = toPosix(rel);
  const head = norm.indexOf('/') === -1 ? norm : norm.slice(0, norm.indexOf('/'));
  return rootOnlySet.has(head);
}

/**
 * 占位符替换目录清单（install.ps1 `$MdFilePatterns` / install.sh `for md_dir in ...`）。
 *
 * 立项根因（2026-09 自查）：这份清单原本有三处读法——command-path-hygiene.mjs 自己解一份，
 * `deploy-drift-check.mjs` 的 `needsUnsub` 又硬编码一份正则
 * （`^(agent/|\.kilo/instructions/|lifecycle/stages/)`）且注释写「与 install 保持一致」。
 * install 侧新增一个替换目录时，hygiene 会先报 FAIL，但 drift-check 不会：它对那个目录
 * 不还原占位符，于是目标绝对路径被当成内容差异报假 [DIFF]。同一事实源只留一个解析器。
 *
 * ps1 必须先切出 $MdFilePatterns 块再提 Join-Path：install.ps1 其他地方也大量用
 * `Join-Path $Target`，全文匹配会把 scripts/、.kilo/ 这类非替换目录当成替换范围。
 *
 * @param {string} rootDir 含 install.ps1 / install.sh 的目录
 * @returns {{dirs:string[], via:string, mismatch:string[], present:string[]}} dirs 为带尾斜杠的前缀，如 'agent/'
 */
export function parseMdSubstDirs(rootDir) {
  const perSource = new Map();
  const sources = [];
  const present = [];
  for (const name of ['install.ps1', 'install.sh']) {
    let text = '';
    try { text = fs.readFileSync(path.join(rootDir, name), 'utf8'); } catch { continue; }
    present.push(name);
    const set = name === 'install.ps1' ? ps1SubstDirs(text) : shSubstDirs(text);
    if (set.size === 0) continue;
    sources.push(name);
    perSource.set(name, set);
  }
  const dirs = new Set();
  for (const set of perSource.values()) for (const d of set) dirs.add(d);
  const mismatch = [];
  if (perSource.size === 2) {
    const keys = [...perSource.keys()];
    for (let i = 0; i < 2; i++) {
      const x = keys[i];
      const y = keys[1 - i];
      for (const v of perSource.get(x)) {
        if (!perSource.get(y).has(v)) mismatch.push(`${v}@only-in-${x}`);
      }
    }
  }
  return { dirs: [...dirs], via: sources.length ? sources.join('+') : 'none', mismatch, present };
}

function ps1SubstDirs(text) {
  const out = new Set();
  const block = text.match(/\$MdFilePatterns\s*=\s*@\(([\s\S]*?)\n\s*\)/);
  if (!block) return out;
  const re = /Join-Path\s+\$Target\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    const rel = toPosix(m[1]);
    const idx = rel.lastIndexOf('/');
    if (idx > 0) out.add(rel.slice(0, idx + 1));
  }
  return out;
}

function shSubstDirs(text) {
  const out = new Set();
  const line = text.match(/for\s+md_dir\s+in\s+([^;]+);/);
  if (!line) return out;
  const re = /"\$\{TARGET_DIR\}\/([^"]+)"/g;
  let m;
  while ((m = re.exec(line[1])) !== null) {
    out.add(toPosix(m[1]).replace(/\/+$/, '') + '/');
  }
  return out;
}

/** 解析失败时的回落替换清单（同上：手工镜像，由夹具钉一致性） */
export const FALLBACK_MD_SUBST_DIRS = ['agent/', '.kilo/instructions/', 'lifecycle/stages/'];

/**
 * 按候选根依次解析替换清单，均读不到时回落。
 * @param {string[]} candidateRoots
 * @returns {{dirs:string[], dirSet:Set<string>, via:string, root:string|null,
 *            mismatch:string[], present:string[], usingFallback:boolean}}
 */
export function resolveMdSubstDirs(candidateRoots) {
  let present = [];
  for (const root of candidateRoots) {
    if (!root) continue;
    const r = parseMdSubstDirs(root);
    if (r.present.length > 0) present = r.present;
    if (r.via !== 'none') {
      return { dirs: r.dirs, dirSet: new Set(r.dirs), via: r.via, root, mismatch: r.mismatch, present: r.present, usingFallback: false };
    }
  }
  return {
    dirs: [...FALLBACK_MD_SUBST_DIRS],
    dirSet: new Set(FALLBACK_MD_SUBST_DIRS),
    via: 'fallback', root: null, mismatch: [], present, usingFallback: true,
  };
}
