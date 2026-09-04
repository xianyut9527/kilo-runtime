#!/usr/bin/env node
// lessons-archive.mjs
// 遗忘归档: 扫描 docs/lessons/*.md (排除 archive/ 子目录), 对 date 超过 90 天且 count<5 的
// 条目标记归档。归档动作:
//   - 文件内全部条目归档 → 整个文件移到 docs/lessons/archive/<原名>
//   - 部分归档 → 归档条目剪切到 archive/<原名>, 保留条目留在原文件
//
// 用法:
//   node scripts/lessons-archive.mjs            # 实际归档
//   node scripts/lessons-archive.mjs --dry-run  # 只打印将归档条目, 不移动
//   node scripts/lessons-archive.mjs --self-check
//
// 仅使用 Node 内置模块。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveLessonsDir, readLessonsFile, formatEntry } from './lessons-recorder.mjs';

const __filename = fileURLToPath(import.meta.url);
const ARCHIVE_SUBDIR = 'archive';

function isArchivable(e, refDays = 90) {
  if (!e || typeof e.date !== 'string') return false;
  const cutoff = Date.now() - refDays * 24 * 3600 * 1000;
  const ts = Date.parse(e.date);
  if (!Number.isFinite(ts)) return false;
  const count = (typeof e.count === 'number') ? e.count : 1;
  return ts < cutoff && count < 5;
}

// 扫描 docs/lessons/*.md (排除 archive/), 返回 { file, archivable: [entries], fileMoves: boolean }
export function scanForArchive(refDays = 90) {
  const dir = resolveLessonsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /\.md$/.test(f) && f !== '.gitkeep')
    .filter((f) => f !== ARCHIVE_SUBDIR);
  const results = [];
  for (const f of files) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    const entries = readLessonsFile(full);
    const archivable = entries.filter((e) => isArchivable(e, refDays));
    const keep = entries.filter((e) => !isArchivable(e, refDays));
    if (archivable.length === 0) continue;
    results.push({ file: full, filename: f, archivable, keep, moveWholeFile: archivable.length === entries.length });
  }
  return results;
}

// 执行归档: 返回移动/剪切的条目清单。
export function runArchive(refDays = 90, dryRun = false) {
  const plan = scanForArchive(refDays);
  const archiveDir = path.join(resolveLessonsDir(), ARCHIVE_SUBDIR);
  const moved = [];
  for (const item of plan) {
    if (dryRun) {
      moved.push(...item.archivable.map((e) => ({ code: e.code, file: item.filename, action: 'archive', count: e.count, date: e.date })));
      continue;
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    const destFull = path.join(archiveDir, item.filename);
    if (item.moveWholeFile) {
      // 整个文件移到 archive/
      fs.copyFileSync(item.file, destFull);
      fs.unlinkSync(item.file);
      for (const e of item.archivable) moved.push({ code: e.code, file: item.filename, action: 'move-whole-file', count: e.count, date: e.date });
    } else {
      // 归档条目剪切到 archive/<原名>, 保留条目留在原文件
      const existingArch = fs.existsSync(destFull) ? readLessonsFile(destFull) : [];
      const merged = [...existingArch, ...item.archivable];
      // 重写 archive 文件 (保留文件头)
      const month = item.filename.replace(/\.md$/, '');
      const archBlocks = merged.map((e) => '```yaml\n' + formatEntry(e) + '\n```');
      const archContent = `# 经验沉淀 ${month}\n\n${archBlocks.join('\n')}\n`;
      writeFileAtomic(destFull, archContent);
      // 重写原文件 (仅保留条目)
      const keepBlocks = item.keep.map((e) => '```yaml\n' + formatEntry(e) + '\n```');
      const keepContent = `# 经验沉淀 ${month}\n\n${keepBlocks.join('\n')}\n`;
      writeFileAtomic(item.file, keepContent);
      for (const e of item.archivable) moved.push({ code: e.code, file: item.filename, action: 'cut-to-archive', count: e.count, date: e.date });
    }
  }
  return moved;
}

function writeFileAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  try { fs.unlinkSync(filePath); } catch { /* 不存在则忽略 */ }
  try { fs.renameSync(tmpPath, filePath); } catch { fs.copyFileSync(tmpPath, filePath); try { fs.unlinkSync(tmpPath); } catch {} }
}

// CLI 主入口
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) { selfCheck(); return; }
  if (args.includes('--help') || args[0] === '-h') {
    process.stdout.write([
      'Usage:',
      '  node scripts/lessons-archive.mjs [--dry-run]',
      '  node scripts/lessons-archive.mjs --self-check',
      '',
      'Archives lessons with date > 90 days old and count < 5 into docs/lessons/archive/.',
      '--dry-run prints the plan without moving.',
    ].join('\n') + '\n');
    process.exit(0);
  }
  const dryRun = args.includes('--dry-run');
  try {
    const moved = runArchive(90, dryRun);
    if (dryRun) {
      process.stdout.write(JSON.stringify(moved, null, 2) + '\n');
    } else {
      process.stdout.write(`ok: archived ${moved.length} lesson(s)\n`);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[lessons-archive] error: ${e && e.message || e}\n`);
    process.exit(1);
  }
}

// === self-check: 造 count=1 + 91天前 / count=5 + 91天前 / count=1 + 10天前, 断言只归档第一条 ===
function selfCheck() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-arch-'));
  process.env.LESSONS_DIR = path.join(tmpDir, 'docs', 'lessons');
  const lessonsDir = process.env.LESSONS_DIR;
  fs.mkdirSync(lessonsDir, { recursive: true });
  let fail = 0;
  const eq = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
  const assertEq = (label, got, want) => {
    if (!eq(got, want)) { console.error('FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); fail = 1; }
    else console.log('PASS ' + label);
  };

  const now = new Date();
  const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const month = now.toISOString().slice(0, 7);
  const base = path.join(lessonsDir, `${month}.md`);
  const entries = [
    // 归档条件: count<5 且 date>90天
    { code: 'OLD_LOW', date: daysAgo(91), count: 1 },
    { code: 'OLD_HIGH', date: daysAgo(91), count: 5 },   // count=5 不归档
    { code: 'RECENT_LOW', date: daysAgo(10), count: 1 }, // 10 天不归档
  ];
  const blocks = entries.map((e) => '```yaml\n' +
    `  - code: ${JSON.stringify(e.code)}\n` +
    `    date: ${JSON.stringify(e.date)}\n` +
    '    stage: "TEST->TEST"\n' +
    '    tier: "T0"\n' +
    '    t1_strength: undefined\n' +
    '    intent_keywords: []\n' +
    '    evidence: []\n' +
    '    root_cause: "test"\n' +
    '    see: ""\n' +
    `    count: ${e.count}\n` +
    '```');
  fs.writeFileSync(base, `# 经验沉淀 ${month}\n\n${blocks.join('\n')}\n`, 'utf8');

  try {
    const plan = scanForArchive(90);
    assertEq('plan has 1 file', plan.length, 1);
    const archived = plan[0].archivable.map((e) => e.code);
    assertEq('only OLD_LOW archived', archived, ['OLD_LOW']);
    assertEq('moveWholeFile false (has keep)', plan[0].moveWholeFile, false);

    const moved = runArchive(90, false);
    assertEq('moved 1 lesson', moved.length, 1);
    assertEq('moved code', moved[0].code, 'OLD_LOW');
    const archFile = path.join(lessonsDir, 'archive', `${month}.md`);
    assertEq('archive file created', fs.existsSync(archFile), true);
    const archEntries = readLessonsFile(archFile);
    assertEq('archive has 1 entry', archEntries.length, 1);
    assertEq('archive entry code', archEntries[0].code, 'OLD_LOW');
    const kept = readLessonsFile(base);
    assertEq('original keeps 2 entries', kept.length, 2);
  } catch (e) {
    console.error('FAIL self-check exception: ' + (e && e.stack || e));
    fail = 1;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    delete process.env.LESSONS_DIR;
  }
  console.log(fail ? 'SELF-CHECK FAILED' : 'ALL SELF-CHECK PASS');
  process.exit(fail);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === __filename; } catch { return false; }
})();
if (isMainModule) main();
