#!/usr/bin/env node
// kb.mjs — 跨项目故障-根因-修复经验库（knowledge-base）命令行工具
//
// 用途：
//   - add     新增一条经验（生成 fixes/FX-0NN.md + 重建 index.md 索引表；写入前近似查重）
//   - query   按症状词检索（symptoms×3 / aliases×3 / name×2 / category×1 计分，输出 top3）
//   - rebuild 重建 index.md 的「症状 → FX 索引表」表体
//   - hit     命中计数 +1 并刷新 last_used（仅改 frontmatter 块，正文不动）
//   - archive 归档一条经验到 archive/ 目录
//   - selftest 在 $env:TEMP 沙箱跑全链自测（add/query/hit/doctor/archive），不碰真实库
//   - --help  打印命令用法
//
// 用法：
//   node scripts/kb.mjs add --symptoms "a,b" --name "..." --category 执行 [--confidence high|medium|low] [--aliases "a,b"] [--body "症状|根因|修复|复验"] [--force]
//   node scripts/kb.mjs query "<症状词>"
//   node scripts/kb.mjs rebuild [--root <路径>]
//   node scripts/kb.mjs hit FX-0NN [--root <路径>]
//   node scripts/kb.mjs archive FX-0NN [--root <路径>]
//   node scripts/kb.mjs selftest
//   node scripts/kb.mjs --help
//
// 全局参数：
//   --root <路径>  覆盖 KB 根目录（默认锚定脚本位置 ../knowledge-base，不用 cwd）
//
// 退出码：
//   0 = 成功 / 有命中
//   1 = 参数校验失败 / 无命中（stderr "no match"）/ 疑似重复（add 查重）
//   2 = 未知命令
//
// 评分权重（单源常量，query 与 add 查重共用）：
//   SCORE_WEIGHTS = { symptoms: 3, name: 2, category: 1, aliases: 3 }
//   aliases 为可选 frontmatter 字段（同义词扩展位），权重与 symptoms 相同。
//
// 仅使用 Node 内置模块：node:fs / node:path / node:process / node:url / node:os / node:child_process
// 写文件一律 fs.writeFileSync(p, s, 'utf8')（显式 UTF-8 无 BOM，历史教训）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readLessonsFile, resolveLessonsDir } from './lessons-recorder.mjs';
import { globalRoot } from './lib/global-root.mjs';

// 跨平台 __dirname：从 import.meta.url 解析，避免依赖 cwd
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(__filename), '../knowledge-base');
const DEFAULT_SYNC_ROOT = path.join(globalRoot(), 'knowledge-base');
const TMP = os.tmpdir();

const CATEGORIES = ['编排', '方法', '执行', '需求'];
const CONFIDENCES = ['high', 'medium', 'low'];
const TITLE = '## 症状 → FX 索引表';

// 评分权重单源常量（query 与 add 近似查重共用，禁止在别处硬编码权重）
const SCORE_WEIGHTS = { symptoms: 3, name: 2, category: 1, aliases: 3 };

// ============================================================
// 工具函数
// ============================================================

/** 今天日期 YYYY-MM-DD */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 行级解析 frontmatter（单源）：返回 { fm, keys }。
 * fm 含全部字段（缺省默认），keys 为实际出现的字段名列表。
 * symptoms/aliases 为 yaml 数组语法 [a, b, c]。
 * 本函数是全文件唯一做行级 key 切分的地方（行级解析单源化）。
 */
function parseFrontmatterLines(text) {
  const fm = { id: '', name: '', symptoms: [], aliases: [], category: '', hit_count: 0, confidence: '', last_used: '' };
  const keys = [];
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm, keys };
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    keys.push(key);
    if (key === 'symptoms' || key === 'aliases') {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
      fm[key] = inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : [];
    } else if (key === 'hit_count') {
      fm.hit_count = parseInt(val, 10) || 0;
    } else if (key in fm) {
      fm[key] = val;
    }
  }
  return { fm, keys };
}

/** 解析 frontmatter 字段（返回含默认值的字段对象） */
function parseFrontmatter(text) {
  return parseFrontmatterLines(text).fm;
}

/** 提取 frontmatter 中实际出现的字段名列表（复用单源行级解析） */
function frontmatterKeys(text) {
  return parseFrontmatterLines(text).keys;
}

/**
 * 在 frontmatter 块（首行 --- 到下一个 ---）内按 key 精准替换/插入，块外正文不动。
 * patchMap: { key: value }，value 为字符串（写入 `key: value`）。
 * 已存在 key 原位替换；缺失 key 在最后一个字段行后、--- 前插入。
 * 返回 true 表示有变更写盘。
 */
function updateFrontmatter(filePath, patchMap) {
  const text = fs.readFileSync(filePath, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length < 2 || lines[0].trim() !== '---') return false;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return false;
  const keys = Object.keys(patchMap);
  const present = new Set();
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.includes(':')) continue;
    present.add(line.split(':')[0].trim());
  }
  const out = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.includes(':')) {
      const key = line.split(':')[0].trim();
      if (key in patchMap) {
        out.push(`${key}: ${patchMap[key]}`);
        continue;
      }
    }
    out.push(line);
  }
  for (const k of keys) {
    if (!present.has(k)) out.push(`${k}: ${patchMap[k]}`);
  }
  const newText = [lines[0], ...out, lines[end], ...lines.slice(end + 1)].join(eol);
  if (newText !== text) {
    fs.writeFileSync(filePath, newText, 'utf8');
    return true;
  }
  return false;
}

/** 提取 ## 修复 段第一句（首个非空非标题行） */
function firstFixLine(text) {
  const lines = text.split(/\r?\n/);
  let inFix = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^##\s+修复/.test(t)) { inFix = true; continue; }
    if (inFix) {
      if (/^##\s+/.test(t)) break; // 进入下一段
      if (t.length > 0) return t;
    }
  }
  return '';
}

/** 切词：latin 词(\w+) + CJK bigram（相邻两字为一词，跳过单字），全小写 */
function tokenize(s) {
  const tokens = [];
  const lower = s.toLowerCase();
  for (const m of lower.match(/\w+/g) || []) tokens.push(m);
  const cjk = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i] + cjk[i + 1]);
  return tokens;
}

/** 扫描 fixes/FX-*.md，返回 { 文件路径, 编号, frontmatter, 修复首句 } 列表，按编号升序 */
function scanFixes(root) {
  const fixesDir = path.join(root, 'fixes');
  const out = [];
  if (!fs.existsSync(fixesDir)) return out;
  for (const name of fs.readdirSync(fixesDir)) {
    if (!/^FX-\d+\.md$/.test(name)) continue;
    const p = path.join(fixesDir, name);
    const text = fs.readFileSync(p, 'utf8');
    const fm = parseFrontmatter(text);
    const num = parseInt(name.replace(/^FX-/, '').replace(/\.md$/, ''), 10);
    out.push({ file: p, name, num, fm, firstFix: firstFixLine(text) });
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

/** 生成 FX-0NN 编号（max+1，3 位补零） */
function nextFxNumber(fixes) {
  let max = 0;
  for (const f of fixes) if (f.num > max) max = f.num;
  return String(max + 1).padStart(3, '0');
}

/**
 * 对全部 fixes 按 tokens 评分（SCORE_WEIGHTS 单源），返回 score>0 的列表，
 * 已按 score 降序、num 升序排序。query 与 add 近似查重共用。
 */
function scoreFixes(fixes, tokens) {
  const scored = fixes.map((f) => {
    let score = 0;
    for (const t of tokens) {
      if (f.fm.symptoms.some((s) => s.includes(t))) score += SCORE_WEIGHTS.symptoms;
      if ((f.fm.aliases || []).some((a) => a.includes(t))) score += SCORE_WEIGHTS.aliases;
      if (f.fm.name.includes(t)) score += SCORE_WEIGHTS.name;
      if (f.fm.category.includes(t)) score += SCORE_WEIGHTS.category;
    }
    return { ...f, score };
  }).filter((f) => f.score > 0);
  scored.sort((a, b) => b.score - a.score || a.num - b.num);
  return scored;
}

// ============================================================
// 命令：sync（写操作自动镜像到全局根）
// ============================================================

/**
 * 解析生效的同步根。
 * - noSync 为 true → 返回 null（全局禁用）
 * - 显式 --sync-root 覆盖 → 始终启用（镜像时按需建目录）
 * - 默认全局根 → 仅当存在才启用
 */
function resolveSyncRoot(explicitSyncRoot, noSync) {
  if (noSync) return null;
  if (explicitSyncRoot) return explicitSyncRoot;
  return fs.existsSync(DEFAULT_SYNC_ROOT) ? DEFAULT_SYNC_ROOT : null;
}

/** 收集 fixes/ 与 fixes/archive/ 下 FX-*.md 的相对路径集合（含 archive） */
function collectFxRelPaths(root) {
  const set = new Set();
  const fixesDir = path.join(root, 'fixes');
  if (!fs.existsSync(fixesDir)) return set;
  for (const name of fs.readdirSync(fixesDir)) {
    if (/^FX-\d+\.md$/.test(name)) set.add(`fixes/${name}`);
  }
  const archDir = path.join(fixesDir, 'archive');
  if (fs.existsSync(archDir)) {
    for (const name of fs.readdirSync(archDir)) {
      if (/^FX-\d+\.md$/.test(name)) set.add(`fixes/archive/${name}`);
    }
  }
  return set;
}

/** 复制单文件到同步根同相对路径；失败 → stderr [SYNC_FAIL]，返回 false（尽力语义，不阻断主流程） */
function syncCopy(localRoot, syncRoot, relPath) {
  const src = path.join(localRoot, relPath);
  const dst = path.join(syncRoot, relPath);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (e) {
    process.stderr.write(`[SYNC_FAIL] ${e.message}\n`);
    return false;
  }
}

/** 对同步根重建 index.md；失败 → stderr [SYNC_FAIL] */
function syncRebuild(syncRoot) {
  try {
    rebuildIndex(syncRoot);
    return true;
  } catch (e) {
    process.stderr.write(`[SYNC_FAIL] rebuildIndex: ${e.message}\n`);
    return false;
  }
}

/** add/hit 镜像：复制文件 + 重建同步根索引 */
function syncMirrorFile(localRoot, syncRoot, relPath) {
  if (!syncRoot) return;
  syncCopy(localRoot, syncRoot, relPath);
  syncRebuild(syncRoot);
}

/** archive 镜像：复制到 archive/ + 移除同步根旧 fixes 副本 + 重建索引 */
function syncMirrorArchive(localRoot, syncRoot, fxName) {
  if (!syncRoot) return;
  syncCopy(localRoot, syncRoot, path.join('fixes', 'archive', fxName));
  const stale = path.join(syncRoot, 'fixes', fxName);
  try {
    if (fs.existsSync(stale)) fs.rmSync(stale);
  } catch (e) {
    process.stderr.write(`[SYNC_FAIL] ${e.message}\n`);
  }
  syncRebuild(syncRoot);
}

// ============================================================
// 命令：add
// ============================================================

function cmdAdd(root, syncRoot, args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symptoms') opts.symptoms = args[++i];
    else if (args[i] === '--name') opts.name = args[++i];
    else if (args[i] === '--category') opts.category = args[++i];
    else if (args[i] === '--confidence') opts.confidence = args[++i];
    else if (args[i] === '--aliases') opts.aliases = args[++i];
    else if (args[i] === '--body') opts.body = args[++i];
    else if (args[i] === '--force') opts.force = true;
  }

  // 必填校验：缺任一 → stderr + exit 1，不写盘
  const missing = [];
  if (!opts.symptoms) missing.push('--symptoms');
  if (!opts.name) missing.push('--name');
  if (!opts.category) missing.push('--category');
  if (missing.length > 0) {
    process.stderr.write(`Error: missing required option(s): ${missing.join(', ')}\n`);
    process.exit(1);
  }

  // category 枚举校验
  if (!CATEGORIES.includes(opts.category)) {
    process.stderr.write(`Error: invalid --category "${opts.category}", must be one of: ${CATEGORIES.join('/')}\n`);
    process.exit(1);
  }

  // confidence 校验（默认 medium）
  const confidence = opts.confidence || 'medium';
  if (!CONFIDENCES.includes(confidence)) {
    process.stderr.write(`Error: invalid --confidence "${confidence}", must be one of: ${CONFIDENCES.join('|')}\n`);
    process.exit(1);
  }

  const symptoms = opts.symptoms.split(',').map((s) => s.trim()).filter(Boolean);
  if (symptoms.length === 0) {
    process.stderr.write('Error: --symptoms must contain at least one symptom word\n');
    process.exit(1);
  }

  // 近似查重：写入前内部跑 query 逻辑，top1 分 ≥ SCORE_WEIGHTS.symptoms 即疑似重复
  if (!opts.force) {
    const scored = scoreFixes(scanFixes(root), tokenize(symptoms.join(' ')));
    if (scored.length > 0 && scored[0].score >= SCORE_WEIGHTS.symptoms) {
      process.stderr.write(`疑似与 ${scored[0].fm.id} 重复，建议 kb hit 合并；确要新建加 --force\n`);
      process.exit(1);
    }
  }

  // 交叉查重：与 docs/lessons/YYYY-MM.md 当月经验比对（复用 lessons-recorder 的 readLessonsFile）
  if (!opts.force) {
    const month = today().slice(0, 7);
    const lessonsDir = resolveLessonsDir();
    const lessonsFile = path.join(lessonsDir, `${month}.md`);
    const symptomTokens = new Set(tokenize(symptoms.join(' ')));
    const dup = readLessonsFile(lessonsFile).find((e) => {
      const kw = (e.intent_keywords || []).map((k) => k.toLowerCase());
      const rc = tokenize(e.root_cause || '');
      return kw.some((k) => symptomTokens.has(k)) || rc.some((t) => symptomTokens.has(t));
    });
    if (dup) {
      process.stderr.write(`疑似与 lessons 库重复（code=${dup.code}），建议仅写一处；确要新建加 --force\n`);
      process.exit(1);
    }
  }

  const fixes = scanFixes(root);
  const num = nextFxNumber(fixes);
  const fxName = `FX-${num}.md`;
  const newFile = path.join(root, 'fixes', fxName);

  const aliases = opts.aliases ? opts.aliases.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // 正文四段：--body 提供时用 "症状|根因|修复|复验" 替换 TODO 占位，否则保持占位（向后兼容）
  const bodyParts = opts.body ? opts.body.split('|').map((s) => s.trim()) : [];
  const bodyLine = (idx, fallback) => {
    const v = bodyParts[idx];
    return v ? `- ${v}` : fallback;
  };

  const fm = [
    '---',
    `id: FX-${num}`,
    `name: ${opts.name.replace(/[\r\n]+/g, ' ')}`,
    `symptoms: [${symptoms.join(', ')}]`,
    ...(aliases.length > 0 ? [`aliases: [${aliases.join(', ')}]`] : []),
    `category: ${opts.category}`,
    'hit_count: 0',
    `confidence: ${confidence}`,
    `last_used: ${today()}`,
    '---',
    '',
    '## 症状',
    '',
    bodyLine(0, '- TODO: 描述触发诱因词与现象'),
    '',
    '## 根因',
    '',
    bodyLine(1, '- TODO: 描述根因'),
    '',
    '## 修复',
    '',
    bodyLine(2, '- TODO: 描述修复步骤'),
    '',
    '## 复验',
    '',
    bodyLine(3, '- TODO: 描述复验命令与预期'),
    '',
  ].join('\n');

  fs.writeFileSync(newFile, fm, 'utf8');
  rebuildIndex(root);
  syncMirrorFile(root, syncRoot, path.join('fixes', fxName));
  console.log(newFile);
}

// ============================================================
// 命令：query
// ============================================================

function cmdQuery(root, args) {
  const query = args[0];
  if (!query) {
    process.stderr.write('Error: query requires a symptom word\n');
    process.exit(1);
  }
  const tokens = tokenize(query);
  const fixes = scanFixes(root);
  const scored = scoreFixes(fixes, tokens);

  if (scored.length === 0) {
    process.stderr.write('no match\n');
    process.exit(1);
  }

  const top = scored.slice(0, 3);
  for (const f of top) {
    console.log(`${f.fm.id} | ${f.fm.name} | ${f.firstFix}`);
  }
  process.exit(0);
}

// ============================================================
// 命令：rebuild（重建 index.md 索引表）
// ============================================================

function rebuildIndex(root) {
  const indexFile = path.join(root, 'index.md');
  const fixes = scanFixes(root);

  const header = '| 症状（诱因词） | FX ID | 类别 | 说明 |';
  const sep = '|----------------|-------|------|------|';
  const rows = fixes.map((f) => {
    const firstTwo = f.fm.symptoms.slice(0, 2).join(',');
    return `| ${firstTwo} 等 | [${f.name}](fixes/${f.name}) | ${f.fm.category} | ${f.fm.name} |`;
  });
  const tableBlock = [header, sep, ...rows].join('\n');

  let content;
  if (fs.existsSync(indexFile)) {
    content = fs.readFileSync(indexFile, 'utf8');
  } else {
    content = `# knowledge-base — 跨项目故障-根因-修复经验库\n\n`;
  }

  const lines = content.split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => l.trim() === TITLE);

  if (titleIdx === -1) {
    // 无该标题 → append 区块
    const block = `\n${TITLE}\n\n${tableBlock}\n`;
    content = content.replace(/\s*$/, '') + block;
  } else {
    // 找到标题后第一个 `|` 行（表头）与连续 `|` 行末（表体结束）
    let start = -1;
    let end = -1;
    for (let i = titleIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('|')) {
        if (start === -1) start = i;
        end = i;
      } else if (start !== -1) {
        break; // 表体结束
      }
    }
    if (start === -1) {
      // 有标题但无表体 → 在标题后插入表体
      const block = `\n${tableBlock}\n`;
      lines.splice(titleIdx + 1, 0, '', ...tableBlock.split('\n'));
      content = lines.join('\n');
    } else {
      // 替换表体（含表头行与分隔行）
      const newLines = tableBlock.split('\n');
      lines.splice(start, end - start + 1, ...newLines);
      content = lines.join('\n');
    }
  }

  fs.writeFileSync(indexFile, content, 'utf8');
}

function cmdRebuild(root) {
  rebuildIndex(root);
  console.log(`rebuilt index: ${path.join(root, 'index.md')}`);
}

// ============================================================
// 命令：hit / archive
// ============================================================

function cmdHit(root, syncRoot, args) {
  const fx = args[0];
  if (!fx) {
    process.stderr.write('Error: hit requires FX-0NN\n');
    process.exit(1);
  }
  if (!/^FX-\d+$/.test(fx)) {
    process.stderr.write('Error: invalid FX ID\n');
    process.exit(1);
  }
  const p = path.join(root, 'fixes', `${fx}.md`);
  if (!fs.existsSync(p)) {
    process.stderr.write(`Error: ${fx} not found\n`);
    process.exit(1);
  }
  const fm = parseFrontmatter(fs.readFileSync(p, 'utf8'));
  const newCount = (fm.hit_count || 0) + 1;
  // 仅改 frontmatter 块：正文伪 hit_count 行不受影响（A2 回归）
  updateFrontmatter(p, { hit_count: String(newCount), last_used: today() });
  rebuildIndex(root);
  syncMirrorFile(root, syncRoot, path.join('fixes', `${fx}.md`));
  console.log(`${fx} hit_count -> ${newCount}`);
}

function cmdArchive(root, syncRoot, args) {
  // 兼容旧语法：archive FX-0NN（单条归档）
  if (args.length > 0 && /^FX-\d+$/.test(args[0])) {
    const fx = args[0];
    const src = path.join(root, 'fixes', `${fx}.md`);
    if (!fs.existsSync(src)) {
      process.stderr.write(`Error: ${fx} not found\n`);
      process.exit(1);
    }
    const archiveDir = path.join(root, 'fixes', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, `${fx}.md`);
    fs.renameSync(src, dst);
    rebuildIndex(root);
    syncMirrorArchive(root, syncRoot, `${fx}.md`);
    console.log(`archived ${fx} -> ${dst}`);
    return;
  }

  // 批量语义：archive --unused-days <N> [--dry-run]
  let unusedDays = 90;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--unused-days') {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write('Error: --unused-days requires a non-negative integer\n');
        process.exit(1);
      }
      unusedDays = n;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  const fixes = scanFixes(root);
  const candidates = fixes.filter((f) => {
    if ((f.fm.hit_count || 0) > 1) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fm.last_used)) return false;
    return daysSince(f.fm.last_used) > unusedDays;
  });

  if (dryRun) {
    if (candidates.length === 0) {
      console.log('archive: no candidates');
    } else {
      for (const f of candidates) {
        console.log(`${f.fm.id} | ${f.fm.name} | hit_count=${f.fm.hit_count} | last_used=${f.fm.last_used}`);
      }
    }
    process.exit(0);
  }

  if (candidates.length === 0) {
    console.log('archive: no candidates');
    return;
  }

  const archiveDir = path.join(root, 'fixes', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const f of candidates) {
    const dst = path.join(archiveDir, f.name);
    fs.renameSync(f.file, dst);
    syncMirrorArchive(root, syncRoot, f.name);
    console.log(`archived ${f.fm.id} -> ${dst}`);
  }
  rebuildIndex(root);
}

// ============================================================
// 命令：doctor（校验 fixes/FX-*.md 健康度 + 索引一致性 + 归档候选）
// ============================================================

/** 距今天数（本地时区，按自然日） */
function daysSince(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return Infinity;
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((todayMid - d) / 86400000);
}

/** 解析 index.md 索引表体中的 FX ID 集合 */
function parseIndexFxIds(root) {
  const indexFile = path.join(root, 'index.md');
  if (!fs.existsSync(indexFile)) return new Set();
  const content = fs.readFileSync(indexFile, 'utf8');
  const ids = new Set();
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const m = t.match(/\[(FX-\d+)(?:\.md)?\]\(fixes\/FX-\d+\.md\)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function cmdDoctor(root, syncRoot) {
  const fixes = scanFixes(root);
  const problems = [];
  const seenIds = new Set();
  const indexIds = parseIndexFxIds(root);
  const fileIds = new Set(fixes.map((f) => f.name.replace(/\.md$/, '')));

  const required = ['id', 'name', 'symptoms', 'category', 'hit_count', 'confidence', 'last_used'];

  for (const f of fixes) {
    const fm = f.fm;
    const label = f.name;
    const text = fs.readFileSync(f.file, 'utf8');
    const keys = frontmatterKeys(text);

    // 七字段齐备
    for (const key of required) {
      if (!keys.includes(key)) {
        problems.push(`${label}: missing field "${key}"`);
      }
    }

    // aliases 可选：存在则校验 yaml 数组格式（不强制必填）
    if (keys.includes('aliases') && !/^aliases:\s*\[.*\]\s*$/m.test(text)) {
      problems.push(`${label}: invalid aliases format, must be yaml array [a, b]`);
    }

    // id 与文件名一致
    const derivedId = f.name.replace(/\.md$/, '');
    if (fm.id && fm.id !== derivedId) {
      problems.push(`${label}: id "${fm.id}" does not match filename "${derivedId}"`);
    }

    // id 全库唯一
    if (fm.id) {
      if (seenIds.has(fm.id)) {
        problems.push(`${label}: duplicate id "${fm.id}"`);
      } else {
        seenIds.add(fm.id);
      }
    }

    // category 枚举
    if (fm.category && !CATEGORIES.includes(fm.category)) {
      problems.push(`${label}: invalid category "${fm.category}", must be one of: ${CATEGORIES.join('/')}`);
    }

    // last_used 格式
    if (fm.last_used && !/^\d{4}-\d{2}-\d{2}$/.test(fm.last_used)) {
      problems.push(`${label}: invalid last_used "${fm.last_used}", must be YYYY-MM-DD`);
    }
  }

  // 索引表与文件集双向一致
  for (const id of indexIds) {
    if (!fileIds.has(id)) {
      problems.push(`index drift: ${id} in index but no fixes/${id}.md file`);
    }
  }
  for (const id of fileIds) {
    if (!indexIds.has(id)) {
      problems.push(`index missing row: ${id} has file but no index row`);
    }
  }

  // 归档候选报告（hit_count<=1 且 last_used 距今>90 天）
  const candidates = fixes.filter((f) => {
    if ((f.fm.hit_count || 0) > 1) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fm.last_used)) return false;
    return daysSince(f.fm.last_used) > 90;
  });
  if (candidates.length > 0) {
    console.log('archive candidates:');
    for (const f of candidates) {
      console.log(`  ${f.fm.id} | ${f.fm.name} | hit_count=${f.fm.hit_count} | last_used=${f.fm.last_used}`);
    }
  }

  // 同步漂移报告（信息级，不计入 FAIL）：对比两库 fixes/FX-*.md 文件集（含 archive）
  if (syncRoot) {
    const localSet = collectFxRelPaths(root);
    const globalSet = collectFxRelPaths(syncRoot);
    const onlyLocal = [...localSet].filter((rp) => !globalSet.has(rp)).sort();
    const onlyGlobal = [...globalSet].filter((rp) => !localSet.has(rp)).sort();
    if (onlyLocal.length === 0 && onlyGlobal.length === 0) {
      console.log(`sync: in-sync (${localSet.size} entries)`);
    } else {
      for (const rp of onlyLocal) console.log(`drift: only-in-local ${rp}`);
      for (const rp of onlyGlobal) console.log(`drift: only-in-global ${rp}`);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`doctor: ${p}\n`);
    process.exit(1);
  }

  console.log(`doctor: all green (${fixes.length} entries)`);
  process.exit(0);
}

// ============================================================
// 命令：selftest（TEMP 沙箱全链自测，不碰真实库）
// ============================================================

/** 在沙箱根跑一条 kb 命令，返回 { code, stdout, stderr } */
function runKb(root, args, envOverride) {
  // 沙箱命令默认 --no-sync，绝不触碰真实全局根；仅显式传 --sync-root 的同步用例启用镜像
  const syncArgs = args.includes('--sync-root') ? [] : ['--no-sync'];
  const r = spawnSync(process.execPath, [__filename, ...args, ...syncArgs, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...(envOverride || {}) },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function cmdSelftest() {
  const checks = [];
  const check = (name, cond, detail) => {
    checks.push({ name, ok: !!cond, detail: detail || '' });
  };
  const sandbox = path.join(TMP, 'kilo', `kb-selftest-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, 'fixes'), { recursive: true });
  // 主进程 LESSONS_DIR 指向沙箱空目录，避免任何直接 add 误读真实 cwd 的 lessons（交叉查重隔离）
  const selftestLessons = path.join(sandbox, 'selftest-lessons');
  fs.mkdirSync(selftestLessons, { recursive: true });
  process.env.LESSONS_DIR = selftestLessons;

  try {
    // 1) add 种子条目 FX-001
    let r = runKb(sandbox, ['add', '--symptoms', 'alpha beta', '--name', 'Base entry', '--category', '方法']);
    check('add seed exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);

    // 2) add 近似查重：同症状 → exit 1 + 警告
    r = runKb(sandbox, ['add', '--symptoms', 'alpha beta', '--name', 'Dup test', '--category', '方法']);
    check('add dedup exit 1', r.code === 1, `code=${r.code}`);
    check('add dedup warning', r.stderr.includes('疑似与 FX-001 重复'), `stderr=${r.stderr.trim()}`);

    // 3) add --force 跳过查重 → exit 0，生成 FX-002
    r = runKb(sandbox, ['add', '--symptoms', 'alpha beta', '--name', 'Force test', '--category', '方法', '--force']);
    check('add --force exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check('add --force created FX-002', fs.existsSync(path.join(sandbox, 'fixes', 'FX-002.md')), '');

    // 4) add 带 --aliases 写入 frontmatter
    r = runKb(sandbox, ['add', '--symptoms', 'gamma delta', '--name', 'Alias test', '--category', '方法', '--aliases', '同义词,别名']);
    check('add --aliases exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    const aliasText = fs.readFileSync(path.join(sandbox, 'fixes', 'FX-003.md'), 'utf8');
    check('add --aliases wrote line', /^aliases: \[同义词, 别名\]$/m.test(aliasText), aliasText.split('\n').find((l) => l.startsWith('aliases')) || '');

    // 5) query 命中
    r = runKb(sandbox, ['query', 'alpha']);
    check('query hit exit 0', r.code === 0, `code=${r.code}`);
    check('query hit contains FX-001', r.stdout.includes('FX-001'), `stdout=${r.stdout.trim()}`);

    // 6) query 未命中
    r = runKb(sandbox, ['query', 'zzzznomatch']);
    check('query miss exit 1', r.code === 1, `code=${r.code}`);
    check('query miss no match', r.stderr.includes('no match'), `stderr=${r.stderr.trim()}`);

    // 7) query 经 aliases 命中（权重=symptoms）
    r = runKb(sandbox, ['query', '同义词']);
    check('query aliases hit exit 0', r.code === 0, `code=${r.code}`);
    check('query aliases contains FX-003', r.stdout.includes('FX-003'), `stdout=${r.stdout.trim()}`);

    // 8) hit 正文伪 hit_count 回归：在 FX-003 正文手动插一行伪 hit_count: 999（不在 frontmatter）
    const hitFile = path.join(sandbox, 'fixes', 'FX-003.md');
    let hitText = fs.readFileSync(hitFile, 'utf8');
    const pseudoLine = '伪hit_count: 999';
    hitText = hitText.replace('## 症状', `## 症状\n\n${pseudoLine}`);
    fs.writeFileSync(hitFile, hitText, 'utf8');
    r = runKb(sandbox, ['hit', 'FX-003']);
    check('hit exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    const afterHit = fs.readFileSync(hitFile, 'utf8');
    check('hit frontmatter count incremented', /^hit_count: 1$/m.test(afterHit), '');
    check('hit body pseudo line unchanged', afterHit.includes(pseudoLine), 'pseudo line was modified');
    // 逐字断言：伪行前后内容一致
    const beforeBody = hitText.split('\n').filter((l) => l === pseudoLine).length;
    const afterBody = afterHit.split('\n').filter((l) => l === pseudoLine).length;
    check('hit body pseudo line verbatim', beforeBody === afterBody && afterBody === 1, `before=${beforeBody} after=${afterBody}`);

    // 9) doctor 全绿
    r = runKb(sandbox, ['doctor']);
    check('doctor exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check('doctor all green', r.stdout.includes('all green'), `stdout=${r.stdout.trim()}`);

    // 10) archive 单条
    r = runKb(sandbox, ['archive', 'FX-001']);
    check('archive exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check('archive moved file', fs.existsSync(path.join(sandbox, 'fixes', 'archive', 'FX-001.md')), '');

    // 11) 同步：add 镜像到伪全局根（--sync-root 指向 TEMP 伪全局）
    const pseudoGlobal = path.join(TMP, 'kilo', `kb-syncroot-${process.pid}`);
    fs.rmSync(pseudoGlobal, { recursive: true, force: true });
    fs.mkdirSync(pseudoGlobal, { recursive: true });
    r = runKb(sandbox, ['add', '--symptoms', 'sync test', '--name', 'Sync entry', '--category', '方法', '--sync-root', pseudoGlobal]);
    check('sync add exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check('sync mirrored file', fs.existsSync(path.join(pseudoGlobal, 'fixes', 'FX-004.md')), '');
    check('sync index rebuilt', fs.existsSync(path.join(pseudoGlobal, 'index.md')), '');

    // 12) --no-sync 全局禁用：伪全局根零写入
    const pseudoGlobal2 = path.join(TMP, 'kilo', `kb-nosync-${process.pid}`);
    fs.rmSync(pseudoGlobal2, { recursive: true, force: true });
    fs.mkdirSync(pseudoGlobal2, { recursive: true });
    r = runKb(sandbox, ['add', '--symptoms', 'nosync test', '--name', 'NoSync entry', '--category', '方法', '--force', '--no-sync', '--sync-root', pseudoGlobal2]);
    check('nosync add exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    const nosyncFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp); else nosyncFiles.push(fp);
      }
    })(pseudoGlobal2);
    check('nosync zero writes', nosyncFiles.length === 0, `files=${nosyncFiles.join(',')}`);
    check('nosync zero writes', nosyncFiles.length === 0, `files=${nosyncFiles.join(',')}`);

    // 13) --body 四段写入：症状|根因|修复|复验 替换 TODO 占位
    r = runKb(sandbox, ['add', '--symptoms', 'bodytest', '--name', 'Body test', '--category', '方法', '--body', '症状B|根因B|修复B|复验B']);
    check('body add exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    const bodyFiles = fs.readdirSync(path.join(sandbox, 'fixes')).filter((n) => /^FX-\d+\.md$/.test(n)).map((n) => parseInt(n.replace(/^FX-/, '').replace(/\.md$/, ''), 10));
    const bodyFile = path.join(sandbox, 'fixes', 'FX-' + String(Math.max(...bodyFiles)).padStart(3, '0') + '.md');
    const bodyText = fs.readFileSync(bodyFile, 'utf8');
    check('body 症状 section', /^## 症状$/m.test(bodyText) && bodyText.includes('- 症状B'), 'missing 症状B');
    check('body 根因 section', /^## 根因$/m.test(bodyText) && bodyText.includes('- 根因B'), 'missing 根因B');
    check('body 修复 section', /^## 修复$/m.test(bodyText) && bodyText.includes('- 修复B'), 'missing 修复B');
    check('body 复验 section', /^## 复验$/m.test(bodyText) && bodyText.includes('- 复验B'), 'missing 复验B');
    check('body no TODO', !bodyText.includes('- TODO:'), 'TODO placeholder remains');

    // 14) 交叉查重阻断：LESSONS_DIR 指向沙箱伪 lessons，含 intent_keywords 命中
    const lessonsDir = path.join(sandbox, 'lessons');
    fs.mkdirSync(lessonsDir, { recursive: true });
    const month = today().slice(0, 7);
    const pseudoLessons = [
      '```yaml',
      '  - code: L-001',
      `    date: '${today()}'`,
      '    stage: \'executing\'',
      '    tier: \'T1\'',
      '    t1_strength: \'medium\'',
      '    intent_keywords: [\'dupword\']',
      '    evidence: []',
      '    root_cause: \'dup root cause\'',
      '    see: \'\'',
      '    count: 1',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(lessonsDir, `${month}.md`), pseudoLessons, 'utf8');
    const lessonsEnv = { LESSONS_DIR: lessonsDir };
    r = runKb(sandbox, ['add', '--symptoms', 'dupword', '--name', 'Dup', '--category', '方法'], lessonsEnv);
    check('cross-dedup exit 1', r.code === 1, `code=${r.code}`);
    check('cross-dedup warning', r.stderr.includes('疑似与 lessons 库重复'), `stderr=${r.stderr.trim()}`);

    // 15) --force 跳过交叉查重 → exit 0
    r = runKb(sandbox, ['add', '--symptoms', 'dupword', '--name', 'Dup force', '--category', '方法', '--force'], lessonsEnv);
    check('cross-dedup --force exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);

    // 16) LESSONS_DIR 隔离：指向空目录，不因真实 cwd 的 lessons 误阻断
    const emptyLessons = path.join(sandbox, 'empty-lessons');
    fs.mkdirSync(emptyLessons, { recursive: true });
    r = runKb(sandbox, ['add', '--symptoms', 'isolated', '--name', 'Iso', '--category', '方法'], { LESSONS_DIR: emptyLessons });
    check('lessons isolation exit 0', r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(path.join(TMP, 'kilo', `kb-syncroot-${process.pid}`), { recursive: true, force: true });
    fs.rmSync(path.join(TMP, 'kilo', `kb-nosync-${process.pid}`), { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    for (const c of failed) {
      process.stderr.write(`selftest FAIL: ${c.name}${c.detail ? ` (${c.detail})` : ''}\n`);
    }
    process.stderr.write(`selftest: ${failed.length}/${checks.length} checks failed\n`);
    process.exit(1);
  }
  console.log(`selftest: all green (${checks.length} checks)`);
  process.exit(0);
}

// ============================================================
// 帮助
// ============================================================

function printHelp() {
  console.log(`kb.mjs — knowledge-base 经验库工具

用法：
  node scripts/kb.mjs add --symptoms "a,b" --name "..." --category 执行 [--confidence high|medium|low] [--aliases "a,b"] [--body "症状|根因|修复|复验"] [--force]
  node scripts/kb.mjs query "<症状词>"
  node scripts/kb.mjs rebuild [--root <路径>]
  node scripts/kb.mjs hit FX-0NN [--root <路径>]
  node scripts/kb.mjs doctor [--root <路径>]
  node scripts/kb.mjs archive FX-0NN [--root <路径>]
  node scripts/kb.mjs archive --unused-days <N> [--dry-run] [--root <路径>]
  node scripts/kb.mjs selftest
  node scripts/kb.mjs --help

全局参数：
  --root <路径>      覆盖 KB 根目录（默认锚定脚本位置 ../knowledge-base）
  --sync-root <路径> 覆盖同步镜像根（默认 ~/.config/kilo/knowledge-base，存在才启用）
  --no-sync          全局禁用写操作镜像到全局根

命令：
  add      新增一条经验（生成 fixes/FX-0NN.md + 重建 index.md 索引表；写入前近似查重，--force 跳过）
  query    按症状词检索（symptoms×3 / aliases×3 / name×2 / category×1 计分，输出 top3）
  rebuild  重建 index.md 的「症状 → FX 索引表」表体
  hit      命中计数 +1 并刷新 last_used（仅改 frontmatter 块，正文不动），随后重建索引
  doctor   校验 fixes/FX-*.md 七字段/唯一性/类别/日期 + 索引双向一致性 + 归档候选
  archive  归档经验：单条 FX-0NN，或批量 --unused-days <N> [--dry-run]
  selftest 在 $env:TEMP 沙箱跑全链自测（add/query/hit/doctor/archive/sync），不碰真实库

同步镜像：
  add/hit/archive 成功落盘后，将对应文件写副本到全局根同相对路径（fixes/FX-*.md、fixes/archive/）
  并对全局根重建 index.md；镜像失败仅 stderr 警告 [SYNC_FAIL]，主命令仍 exit 0（尽力语义）。
  doctor 输出两库漂移报告（drift: only-in-local / only-in-global，信息级不计 FAIL）。
`);
}
// 主入口
// ============================================================

function main() {
  const args = process.argv.slice(2);

  // 提取全局 --root / --sync-root / --no-sync
  let root = DEFAULT_ROOT;
  let explicitSyncRoot = null;
  let noSync = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
      root = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--sync-root') {
      explicitSyncRoot = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--no-sync') {
      noSync = true;
    } else {
      rest.push(args[i]);
    }
  }
  const syncRoot = resolveSyncRoot(explicitSyncRoot, noSync);

  const cmd = rest[0];
  const cmdArgs = rest.slice(1);

  switch (cmd) {
    case 'add': cmdAdd(root, syncRoot, cmdArgs); break;
    case 'query': cmdQuery(root, cmdArgs); break;
    case 'rebuild': cmdRebuild(root); break;
    case 'hit': cmdHit(root, syncRoot, cmdArgs); break;
    case 'doctor': cmdDoctor(root, syncRoot); break;
    case 'archive': cmdArchive(root, syncRoot, cmdArgs); break;
    case 'selftest': cmdSelftest(); break;
    case '--help':
    case '-h':
    case 'help': printHelp(); break;
    case undefined:
      printHelp();
      process.exit(2);
      break;
    default:
      process.stderr.write(`Error: unknown command "${cmd}"\n`);
      process.exit(2);
  }
}

main();
