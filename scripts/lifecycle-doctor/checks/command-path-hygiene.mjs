// checks/command-path-hygiene.mjs
// 运行时文档里的可执行命令必须「在任何工作目录下都能跑」——静态装配维度。
//
// 立项根因（2026-09 实测）：install 的占位符替换只覆盖 agent/*.md + .kilo/instructions/*.md，
// 而 lifecycle/stages/*.md（conductor 进每个阶段都要读的执行逻辑）里写的是相对命令
// `node scripts/task-context.mjs ...`。部署副本实测残留 7 处（init.md 硬规则 1/2/4 全在里面）。
// 运行时 bash 的 cwd 是**用户项目目录**，不是配置根 → 这些命令直接 MODULE_NOT_FOUND：
// 要么白耗一个失败回合再自己猜路径，要么被当成「可选步骤」跳过（门禁静默失效）。
// 同一次排查还捞出一条死命令：output-schema.md 证据示例里的 `node scripts/lifecycle-doctor.mjs`
// ——该文件早已拆成 lifecycle-doctor/index.mjs，示例照抄即错。
//
// 四条机械规则：
//   A  被替换集合内的 *.md 不得出现「相对/无路径」的 node 命令（必须写 ${KILO_CONFIG_DIR} 形式）
//   B  出现 ${KILO_CONFIG_DIR} 命令的文件必须落在被替换前缀内（否则占位符原样进运行时，更坏）
//   C  node 命令指向的 .mjs 文件必须真实存在（拦死命令/改名残留）
//   D  install.ps1 与 install.sh 的替换清单必须一致（双端事实源对齐；部署副本侧自动跳过）
//
// 被替换前缀**从 install 脚本解析**而非在本文件重写一份——本检查要防的正是「清单与文档不同步」，
// 自己再抄一份就成了第二个会漂的源。install 脚本缺失（部署副本）时回落到 DEFAULT_SUBSTITUTED，
// 此时 A/C 仍有效（这两条才是运行时正确性的主防线），D 跳过。
//
// 性能：纯字符串扫描，候选文件 < 40 个，无子进程。

import fs from 'node:fs';
import path from 'node:path';

// 与 install.ps1 $MdFilePatterns / install.sh md_dir 对齐的兜底清单（本根无安装脚本时使用）；
// 导出在 lib，夹具可跟真实清单交叉校验。
import { parseMdSubstDirs, FALLBACK_MD_SUBST_DIRS as DEFAULT_SUBSTITUTED } from '../../lib/install-runtime-data.mjs';

// 占位符形式命令（正确）：node "${KILO_CONFIG_DIR}/scripts/x.mjs" / node ${KILO_CONFIG_DIR}/scripts/x.mjs
const RE_PLACEHOLDER = /node\s+"?\$\{KILO_CONFIG_DIR\}\/([^\s"']+?\.mjs)/g;
// 相对路径命令（错误）：node scripts/x.mjs / node "./scripts/x.mjs" / node scripts\x.mjs
const RE_RELATIVE = /node\s+"?((?:\.\/|scripts\/|scripts\\)[^\s"']+?\.mjs)/g;
// 无路径命令（错误）：node task-context.mjs
const RE_BARE = /node\s+"?([a-zA-Z0-9._-]+\.mjs)(?=[\s"']|$)/g;

function toPosix(s) { return s.replace(/\\/g, '/'); }

/**
 * 替换清单的解析已下沉到 scripts/lib/install-runtime-data.mjs#parseMdSubstDirs——
 * 本文件原先自己解一份、deploy-drift-check.mjs 又硬编码一份，同一事实源两处读法必漂。
 */

function readIfExists(absPath) {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
}

function listMd(dirAbs) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) out.push(e.name);
  }
  return out.sort();
}

export function run(ctx) {
  const { cf, ROOT } = ctx;

  // ---- 解析被替换清单（事实源 = install 脚本；解析器在 lib，与 drift-check 共用）----
  const parsed = parseMdSubstDirs(ROOT);
  let substituted;
  if (parsed.present.length === 0) {
    // 部署副本不部署 install.ps1/install.sh，属正常情形
    cf.pass('cmd-path.installer-consistent', 'install 脚本不在本根（部署副本），跳过 D 规则并使用兜底清单');
    substituted = DEFAULT_SUBSTITUTED;
  } else if (parsed.via === 'none') {
    // 脚本在、但两侧都解析不出清单 = $MdFilePatterns / md_dir 结构被改写。
    // 绝对不能静默用兜底清单——那会把「新增了一个替换目录却没人知道」伪装成全绿。
    cf.fail('cmd-path.installer-consistent',
      `install 脚本存在（${parsed.present.join(', ')}）但解析不出替换清单——$MdFilePatterns / md_dir 写法被改，需同步本门禁解析器`);
    substituted = DEFAULT_SUBSTITUTED;
  } else if (!parsed.via.includes('+')) {
    // 只有一侧脚本：无从比对，但清单本身仍按事实源用（不说「双端一致」这种假话）
    cf.pass('cmd-path.installer-consistent', `仅 ${parsed.via} 存在（无法双端比对），按其清单 ${parsed.dirs.length} 项`);
    substituted = parsed.dirs;
  } else if (parsed.mismatch.length === 0) {
    cf.pass('cmd-path.installer-consistent', `双端替换清单一致 (${parsed.dirs.length} 项): ${parsed.dirs.slice().sort().join(', ')}`);
    substituted = parsed.dirs;
  } else {
    cf.fail('cmd-path.installer-consistent',
      `install.ps1 与 install.sh 的占位符替换清单不一致 — ${parsed.mismatch.join(', ')}`);
    substituted = parsed.dirs;
  }

  const isSubstituted = (rel) => substituted.some((p) => rel.startsWith(p));

  // ---- 收集候选运行时文档：被替换目录 + 根 AGENTS.md + lifecycle/*.md ----
  // README.md 不A规则：目录 README 是维护者文档（给在仓库里跑命令的人），不是 agent 执行逻辑；
  // graph.yaml 只按 stages/<节点小写>.md 派生阶段文件，README 不会被加载，相对路径对它本来就是对的。
  const candidates = []; // rel path（posix）
  for (const prefix of substituted) {
    const dirAbs = path.join(ROOT, prefix.replace(/\/+$/, ''));
    for (const name of listMd(dirAbs)) {
      if (name === 'README.md') continue;
      candidates.push(toPosix(prefix) + name);
    }
  }
  if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) candidates.push('AGENTS.md');
  for (const name of listMd(path.join(ROOT, 'lifecycle'))) {
    const rel = 'lifecycle/' + name;
    if (!candidates.includes(rel)) candidates.push(rel);
  }

  // ---- A / B / C 逐文件判定 ----
  const relHits = [];      // A：相对/无路径命令
  const survives = [];     // B：占位符命令但文件不被替换
  const deadTargets = [];  // C：命令指向的 .mjs 不存在
  let checked = 0;
  let placeholderCommands = 0;

  for (const rel of candidates) {
    const text = readIfExists(path.join(ROOT, rel));
    if (text === null) continue;
    checked++;
    const sub = isSubstituted(rel);

    RE_PLACEHOLDER.lastIndex = 0;
    let m;
    while ((m = RE_PLACEHOLDER.exec(text)) !== null) {
      placeholderCommands++;
      if (!sub) survives.push(`${rel} → ${m[1]}`);
      if (!fs.existsSync(path.join(ROOT, m[1]))) deadTargets.push(`${rel} → scripts/${m[1]}`);
    }

    for (const re of [RE_RELATIVE, RE_BARE]) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        // 只报会被模型照抄的可执行命令形态；被替换目录里的相对命令在项目中必失败
        if (sub) relHits.push(`${rel} → ${m[1]}`);
        else if (!fs.existsSync(path.join(ROOT, m[1]))) deadTargets.push(`${rel} → ${m[1]}`);
      }
    }
  }

  if (relHits.length === 0) {
    cf.pass('cmd-path.no-relative-command', `${checked} 个运行时文档无相对/无路径 node 命令（占位符命令 ${placeholderCommands} 条）`);
  } else {
    cf.fail('cmd-path.no-relative-command',
      `相对路径命令在用户项目 cwd 下必然 MODULE_NOT_FOUND，改写成 node "\${KILO_CONFIG_DIR}/scripts/..." —— ${relHits.slice(0, 8).join('; ')}${relHits.length > 8 ? ` 等 ${relHits.length} 处` : ''}`);
  }

  if (survives.length === 0) {
    cf.pass('cmd-path.placeholder-covered', '所有占位符命令都落在 install 替换范围内');
  } else {
    cf.fail('cmd-path.placeholder-covered',
      `文件不在 install 替换清单内却写了 \${KILO_CONFIG_DIR}（占位符会原样进运行时）—— ${survives.slice(0, 8).join('; ')}；修法：把它加进 install.ps1 $MdFilePatterns 与 install.sh md_dir`);
  }

  if (deadTargets.length === 0) {
    cf.pass('cmd-path.targets-exist', '命令引用的 .mjs 目标均存在');
  } else {
    cf.fail('cmd-path.targets-exist', `命令指向不存在的脚本（改名/拆分残留）—— ${deadTargets.slice(0, 8).join('; ')}`);
  }
}
