#!/usr/bin/env node
// lessons-inject.mjs
// 检索注入: 在 INIT 阶段扫描当月经验文件, 把与当前 intent 相关的历史失败教训注入
// task_context.intent.prior_lessons, 供 conductor 参考 (避免重复踩坑)。
//
// 用法:
//   node scripts/lessons-inject.mjs <task_id> --month <YYYY-MM>   # CLI: 读 task_context 的 intent.raw 并打印命中 JSON
//   node scripts/lessons-inject.mjs --self-check
//
// 导出: scanLessons(intentRaw, { month | months }) -> lesson[]   (供 init-gate.mjs import)
// 命中规则: intentRaw 与 lesson.intent_keywords 交集 >=1 词, 或与 root_cause 关键词重叠。
// 返回按 count 降序前 3 条, 每条 {code, root_cause, see, count, months}。
// 跨月: opts.months 数组 (缺省 [当月,上月]) 扫描多个月份文件, 同 code 跨月聚合 (count 求和、文本取较新月、months 记录来源月份)。
// 仅使用 Node 内置模块。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readContext } from './task-context-runtime.mjs';
import { resolveLessonsDir } from './lessons-recorder.mjs';
import { readLessonsFile, extractKeywords } from './lessons-recorder.mjs';

const __filename = fileURLToPath(import.meta.url);

// 分词 (与 lessons-recorder 一致的轻量分词; root_cause 也按同样规则拆)。
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return extractKeywords(text, 20);
}

// 命中规则:
//   - intentRaw 关键词 与 lesson.intent_keywords 交集 >=1
//   - 或 intentRaw 关键词 与 root_cause 关键词交集 >=1
function hitLesson(intentTokens, lesson) {
  const lessonKws = Array.isArray(lesson.intent_keywords) ? lesson.intent_keywords : [];
  for (const t of intentTokens) {
    if (lessonKws.some((k) => String(k).toLowerCase() === t)) return true;
  }
  const rcKws = tokenize(lesson.root_cause);
  for (const t of intentTokens) {
    if (rcKws.some((k) => String(k).toLowerCase() === t)) return true;
  }
  return false;
}

// 主函数: 读 <month>.md, 解析 lesson 条目, 返回命中 (count 降序, 前 3)。
export function scanLessons(intentRaw, opts = {}) {
  // 月份集合: 显式 months 优先; 兼容旧 opts.month; 缺省 [当月, 上月]
  let months;
  if (Array.isArray(opts.months) && opts.months.length > 0) {
    months = opts.months;
  } else if (opts.month) {
    months = [opts.month];
  } else {
    const now = new Date().toISOString().slice(0, 7);
    const y = parseInt(now.slice(0, 4), 10);
    const m = parseInt(now.slice(5, 7), 10);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    months = [now, prev];
  }

  const intentTokens = tokenize(intentRaw);
  if (intentTokens.length === 0) return [];

  // 逐月读取并收集命中条目 (带来源月份)
  const rawHits = [];
  for (const month of months) {
    const filePath = path.join(resolveLessonsDir(), `${month}.md`);
    if (!fs.existsSync(filePath)) continue;
    const entries = readLessonsFile(filePath);
    for (const e of entries) {
      if (hitLesson(intentTokens, e)) rawHits.push({ ...e, _month: month });
    }
  }
  if (rawHits.length === 0) return [];

  // 同 code 跨月聚合: count 求和, 文本字段取较新月, months 记录来源月份数组
  const byCode = new Map();
  for (const h of rawHits) {
    const key = h.code;
    if (!byCode.has(key)) {
      byCode.set(key, { ...h, months: [h._month] });
      continue;
    }
    const agg = byCode.get(key);
    agg.count = (agg.count || 0) + (h.count || 1);
    if (h._month > agg.months[0]) {
      agg.root_cause = h.root_cause || agg.root_cause;
      agg.see = h.see || agg.see;
    }
    if (!agg.months.includes(h._month)) agg.months.push(h._month);
  }

  const hits = [...byCode.values()];
  hits.sort((a, b) => ((b.count || 0) - (a.count || 0)));
  return hits.slice(0, 3).map((e) => ({
    code: e.code,
    root_cause: e.root_cause || '',
    see: e.see || '',
    count: e.count || 1,
    months: e.months || [],
  }));
}

// CLI 主入口
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) { selfCheck(); return; }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write([
      'Usage:',
      '  node scripts/lessons-inject.mjs <task_id> --month <YYYY-MM>',
      '  node scripts/lessons-inject.mjs --self-check',
      '',
      'Scans docs/lessons/<month>.md and prints matched prior lessons as JSON (count desc, top 3).',
    ].join('\n') + '\n');
    process.exit(0);
  }
  const taskId = args[0];
  const monthIdx = args.indexOf('--month');
  const month = monthIdx !== -1 && args[monthIdx + 1] ? args[monthIdx + 1] : new Date().toISOString().slice(0, 7);
  if (!taskId) {
    process.stderr.write('Error: lessons-inject requires <task_id>\n');
    process.exit(2);
  }
  try {
    const { ctx } = readContext(taskId);
    const raw = (ctx.intent && typeof ctx.intent.raw === 'string') ? ctx.intent.raw : '';
    const hits = scanLessons(raw, { month });
    process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[lessons-inject] error: ${e && e.message || e}\n`);
    process.exit(1);
  }
}

// === self-check: 单月命中 + 跨月聚合 (2026-08/2026-09 同 code count 2/3 → 合并 count=5, months 记录来源) ===
function selfCheck() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-inj-'));
  process.env.LESSONS_DIR = tmpDir;
  let fail = 0;
  const eq = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
  const assertEq = (label, got, want) => {
    if (!eq(got, want)) { console.error('FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); fail = 1; }
    else console.log('PASS ' + label);
  };

  // 手写 monthly 文件 (与 lessons-recorder 输出格式一致)
  const writeMonth = (month, entries) => {
    const blocks = entries.map((e) => {
      const kws = e.intent_keywords.map((k) => JSON.stringify(k)).join(', ');
      const rc = JSON.stringify(e.root_cause);
      const see = JSON.stringify(e.see);
      const t1 = e.t1_strength === undefined ? 'undefined' : JSON.stringify(e.t1_strength);
      return '```yaml\n' +
        `  - code: ${JSON.stringify(e.code)}\n` +
        `    date: ${JSON.stringify(e.date)}\n` +
        `    stage: ${JSON.stringify(e.stage)}\n` +
        `    tier: ${JSON.stringify(e.tier)}\n` +
        `    t1_strength: ${t1}\n` +
        `    intent_keywords: [${kws}]\n` +
        '    evidence: []\n' +
        `    root_cause: ${rc}\n` +
        `    see: ${see}\n` +
        `    count: ${e.count}\n` +
        '```';
    });
    fs.writeFileSync(path.join(tmpDir, `${month}.md`), `# 经验沉淀 ${month}\n\n${blocks.join('\n')}\n`, 'utf8');
  };

  // 2026-09: 同 code MISSING_PREMISE_AUDIT count=2 + 独立 code PROCESS_VIOLATION count=3
  writeMonth('2026-09', [
    { code: 'MISSING_PREMISE_AUDIT', date: '2026-09-01', stage: 'PLANNING->EXECUTING', tier: 'T1', t1_strength: 'medium', intent_keywords: ['登录', '鉴权'], evidence: [], root_cause: 'premise_audit 未写 existence_cmd', see: 'planning.md', count: 2 },
    { code: 'PROCESS_VIOLATION', date: '2026-09-02', stage: 'INIT->EXECUTING', tier: 'T1', t1_strength: 'medium', intent_keywords: ['检索', '注入'], evidence: [], root_cause: 'dispatch 记录缺失导致 provenance 校验失败', see: 'AGENTS.md 锚点 8', count: 3 },
  ]);
  // 2026-08: 同 code MISSING_PREMISE_AUDIT count=3 (较旧文本) + 独立 code MISSING_EXECUTION_PRODUCT count=1
  writeMonth('2026-08', [
    { code: 'MISSING_PREMISE_AUDIT', date: '2026-08-15', stage: 'PLANNING->EXECUTING', tier: 'T1', t1_strength: 'medium', intent_keywords: ['登录', '鉴权'], evidence: [], root_cause: '旧月 premise_audit 根因', see: 'planning.md', count: 3 },
    { code: 'MISSING_EXECUTION_PRODUCT', date: '2026-08-20', stage: 'EXECUTING->QUALITY', tier: 'T0', t1_strength: undefined, intent_keywords: ['无关词'], evidence: [], root_cause: '无关教训', see: 'executing.md', count: 1 },
  ]);

  try {
    // 单月兼容: opts.month
    const hits = scanLessons('实现登录鉴权中间件于检索阶段注入', { month: '2026-09' });
    assertEq('single-month hits count = 2', hits.length, 2);
    assertEq('single-month first hit count=3 desc', hits[0].count, 3);
    assertEq('single-month second hit count=2 desc', hits[1].count, 2);
    assertEq('hit field shape incl months', (() => { const k = Object.keys(hits[0]).sort(); return eq(k, ['code', 'count', 'months', 'root_cause', 'see']); })(), true);
    assertEq('single-month months field', hits[0].months, ['2026-09']);

    // 跨月聚合: opts.months = [2026-08, 2026-09]
    const agg = scanLessons('实现登录鉴权中间件于检索阶段注入', { months: ['2026-08', '2026-09'] });
    assertEq('cross-month merged count=5', agg[0].count, 5);
    assertEq('cross-month merged months', agg[0].months, ['2026-08', '2026-09']);
    assertEq('cross-month merged text takes newer month', agg[0].root_cause, 'premise_audit 未写 existence_cmd');
    assertEq('cross-month merged sorts first', agg[0].code, 'MISSING_PREMISE_AUDIT');
    // 独立条目 months 正确
    const pv = agg.find((e) => e.code === 'PROCESS_VIOLATION');
    assertEq('independent entry months', pv && pv.months, ['2026-09']);
    assertEq('independent entry count', pv && pv.count, 3);
    // 非命中独立条目 (无关词) 不应被聚合返回
    const mep = agg.find((e) => e.code === 'MISSING_EXECUTION_PRODUCT');
    assertEq('non-matching independent entry absent', mep, undefined);

    const noHits = scanLessons('编写前端按钮间距与卡片阴影渲染效果', { months: ['2026-08', '2026-09'] });
    assertEq('non-matching intent empty', noHits.length, 0);
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

