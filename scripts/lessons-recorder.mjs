#!/usr/bin/env node
// lessons-recorder.mjs
// 失败回写: 把 transition-check 的 die(1,...) 失败统一沉淀为经验条目, 供 lessons-inject 检索注入。
//
// 用法:
//   node scripts/lessons-recorder.mjs <task_id> --code <ERROR_CODE|PROCESS_VIOLATION|...> --stage <FROM->TO> --root-cause "<一句话根因>"
//   node scripts/lessons-recorder.mjs --self-check
//
// 输出: docs/lessons/YYYY-MM.md (默认锚定本仓 docs/lessons, 不依赖 cwd), 按 code+evidence[0].file 聚合去重, count 累计。
// Breaking Change: 默认目录从 process.cwd()/docs/lessons 改为 __dirname/../docs/lessons (本仓 docs/lessons)。
//   调用方若以非仓库根 cwd 运行, 写入位置会变化; 需固定位置时用 LESSONS_DIR 环境变量覆盖。
// 失败安全: 任何 IO/解析错误只 stderr 打印, 不抛给调用方 (recordThenDie 内部 try/catch)。
// 仅使用 Node 内置模块; 遵循本仓库脚本风格 (transition-check.mjs)。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readContext, contextPath } from './task-context-runtime.mjs';
import { ERROR_CODES } from './error-codes.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 经验目录: 默认 docs/lessons; 支持 LESSONS_DIR 环境覆盖 (self-check 用临时目录, 防污染真实仓库)。
export function resolveLessonsDir() {
  if (process.env.LESSONS_DIR) return path.resolve(process.env.LESSONS_DIR);
  return path.resolve(__dirname, '..', 'docs', 'lessons');
}

// 中文/英文通用停用词 (去噪, 保留业务词)
const STOPWORDS = new Set([
  '的','了','和','与','或','在','中','为','对','将','把','被','是','有','不','无','需','要','请','并','以及','等','一个','我们','你们','他们','这个','那个','进行','通过','使用','相关','需要','必须','可以','应该','之后','之前','当前','现有','以及',
  'a','an','the','to','for','and','or','of','in','on','with','is','are','be','please','must','should','need','do','not','that','this','from','into','after','before','about'
]);

// 分词策略:
//   - 英文/数字词: 按分隔符拆分
//   - CJK 连续串: 拆 2-gram (bigram), 适配中文无空格语义
// 去停用词 + 去重, 返回至多 limit 个。
export function extractKeywords(raw, limit = 5) {
  if (!raw || typeof raw !== 'string') return [];
  const head = raw.slice(0, 200);
  // 先按分隔符拆出词块
  const parts = head.split(/[\s，。、；：,!?;:.()（）\[\]{}"''<>\/\\|+=*\-_~`@#%^&]+/).filter((t) => t.length > 0);
  const tokens = [];
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (/^[A-Za-z0-9_]+$/.test(part)) {
      const low = part.toLowerCase();
      if (low.length > 1 && !STOPWORDS.has(low)) tokens.push(low);
      continue;
    }
    // 含 CJK: 对连续 CJK 段拆 bigram, 非 CJK 段按英文规则
    for (const seg of part.split(/([^\x00-\x7F]+)/)) {
      if (!seg) continue;
      if (/[\u4e00-\u9fff]/.test(seg)) {
        // CJK 段 → bigram
        for (let i = 0; i < seg.length - 1; i++) {
          const bg = seg.slice(i, i + 2);
          if (!STOPWORDS.has(bg)) tokens.push(bg);
        }
      } else if (/^[A-Za-z0-9_]+$/.test(seg)) {
        const low = seg.toLowerCase();
        if (low.length > 1 && !STOPWORDS.has(low)) tokens.push(low);
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

// 构造 YAML 条目字符串 (fenced block 内容, 不含 ``` 围栏)。
function yamlQuote(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  }
  return value;
}

export function formatEntry(e) {
  const lines = [];
  lines.push(`  - code: ${yamlQuote(e.code)}`);
  lines.push(`    date: ${yamlQuote(e.date)}`);
  lines.push(`    stage: ${yamlQuote(e.stage)}`);
  lines.push(`    tier: ${yamlQuote(e.tier)}`);
  const ts = (e.t1_strength === undefined || e.t1_strength === null || e.t1_strength === 'undefined') ? 'null' : e.t1_strength;
  lines.push(`    t1_strength: ${yamlQuote(ts)}`);
  const kws = Array.isArray(e.intent_keywords) ? e.intent_keywords : [];
  lines.push(`    intent_keywords: [${kws.map((k) => yamlQuote(String(k))).join(', ')}]`);
  const ev = Array.isArray(e.evidence) ? e.evidence : [];
  if (ev.length === 0) {
    lines.push('    evidence: []');
  } else {
    lines.push('    evidence:');
    for (const item of ev) {
      lines.push(`      - file: ${yamlQuote(item.file)}`);
      lines.push(`        line: ${yamlQuote(item.line)}`);
    }
  }
  lines.push(`    root_cause: ${yamlQuote(e.root_cause)}`);
  lines.push(`    see: ${yamlQuote(e.see)}`);
  lines.push(`    count: ${typeof e.count === 'number' ? e.count : 1}`);
  return lines.join('\n');
}

// YAML 单行值解包: 去外引号 + 反转义
function unquote(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/^["']|["']$/g, '');
  return t.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

// 单条目解析: 把 block 文本解析为 flat entry 对象。
// 关键键 (root_cause/see/count/date/stage/tier/t1_strength/intent_keywords) 始终按行解析,
// 不受 evidence 块状态影响; 仅 - file: / line: 属于 evidence 子项。
function parseBlock(text) {
  const e = { evidence: [] };
  let inEvidence = false;
  let curEv = null;
  const SET_KEYS = new Set(['date', 'stage', 'tier', 't1_strength', 'root_cause', 'see', 'code']);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line.trim()) continue;

    // 条目起始 / code
    const codeM = line.match(/^-\s*code\s*:\s*(.+)$/);
    if (codeM) { e.code = unquote(codeM[1]); inEvidence = false; curEv = null; continue; }

    // evidence 块
    if (/^evidence\s*:\s*$/.test(line)) { inEvidence = true; curEv = null; continue; }
    const evInline = line.match(/^evidence\s*:\s*\[\s*\]\s*$/);
    if (evInline) { inEvidence = false; curEv = null; continue; }

    // evidence 子项
    const evFile = line.match(/^-\s*file\s*:\s*(.+)$/);
    if (evFile) { curEv = { file: unquote(evFile[1]) }; e.evidence.push(curEv); continue; }
    const evLine = line.match(/^line\s*:\s*(.+)$/);
    if (evLine) { if (curEv) curEv.line = unquote(evLine[1]); continue; }

    // 常规 key: value (含 count / intent_keywords 特殊分支)
    const kwM = line.match(/^intent_keywords\s*:\s*\[(.*)\]$/);
    if (kwM) {
      const inner = kwM[1].trim();
      e.intent_keywords = inner.length === 0 ? [] : inner.split(',').map((s) => unquote(s.trim()));
      inEvidence = false; curEv = null;
      continue;
    }
    const kv = line.match(/^([a-z_0-9]+)\s*:\s*(.+)$/);
    if (kv) {
      const k = kv[1];
      const v = unquote(kv[2]);
      if (k === 'count') { e.count = parseInt(v, 10) || 1; inEvidence = false; curEv = null; continue; }
      if (k === 't1_strength' && (v === 'null' || v === 'undefined')) { e.t1_strength = null; inEvidence = false; curEv = null; continue; }
      if (SET_KEYS.has(k)) { e[k] = v; inEvidence = false; curEv = null; continue; }
      continue;
    }
  }
  return e;
}

// 读 monthly 文件全部 lesson entries (解析所有 yaml fenced blocks)。
export function readLessonsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const blocks = [...text.matchAll(/```yaml\s*\r?\n([\s\S]*?)\r?\n```/g)];
  const entries = [];
  for (const m of blocks) {
    const block = m[1];
    // 一个 block 内可含多个 "- code:" 条目
    const items = block.split(/\r?\n(?=\s*-\s*code\s*:)/);
    for (const item of items) {
      const e = parseBlock(item);
      if (e && e.code) entries.push(e);
    }
  }
  return entries;
}

// 追加单条 lesson 到 monthly 文件, 支持聚合去重。
// 返回 { entry, created }。
export function appendLesson(lesson) {
  const month = (lesson.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const dir = resolveLessonsDir();
  const filePath = path.join(dir, `${month}.md`);
  fs.mkdirSync(dir, { recursive: true });

  let entries = [];
  if (fs.existsSync(filePath)) entries = readLessonsFile(filePath);

  const keyOf = (e) => e.code + '|' + (e.evidence && e.evidence[0] ? e.evidence[0].file : '');
  const dedupKey = keyOf(lesson);
  let target = null;
  let created = false;
  target = entries.find((e) => keyOf(e) === dedupKey) || null;
  if (target) {
    target.count = (target.count || 1) + 1;
    target.date = lesson.date;
    target.root_cause = lesson.root_cause;
    target.stage = lesson.stage;
  } else {
    target = {
      code: lesson.code,
      date: lesson.date,
      stage: lesson.stage,
      tier: lesson.tier,
      t1_strength: lesson.t1_strength,
      intent_keywords: lesson.intent_keywords || [],
      evidence: lesson.evidence || [],
      root_cause: lesson.root_cause,
      see: lesson.see,
      count: 1,
    };
    entries.push(target);
    created = true;
  }

  // 整体重写文件: 头部 + 全部条目 fenced blocks。
  let out = `# 经验沉淀 ${month}\n\n`;
  const blocks = entries.map((e) => '```yaml\n' + formatEntry(e) + '\n```');
  out += blocks.join('\n') + '\n';
  writeFileAtomic(filePath, out);
  return { entry: target, created };
}

function writeFileAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  try { fs.unlinkSync(filePath); } catch { /* 不存在则忽略 */ }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
  }
}


// === bumpLessonCount: 经验命中后回写计数 (反馈闭环) ===
// 按纯 code 聚合 (忽略 evidence file): 同 code 所有条目 count 求和后再 +1。
// code 不存在 / 月文件不存在 -> {bumped:false, count:0} (不创建新条目)。
export function bumpLessonCount(code, month) {
  const m = month || new Date().toISOString().slice(0, 7);
  const dir = resolveLessonsDir();
  const filePath = path.join(dir, `${m}.md`);
  if (!fs.existsSync(filePath)) return { bumped: false, count: 0 };
  const entries = readLessonsFile(filePath);
  const matches = entries.filter((e) => e.code === code);
  if (matches.length === 0) return { bumped: false, count: 0 };
  matches[0].count = (matches[0].count || 1) + 1;
  const total = matches.reduce((s, e) => s + (e.count || 1), 0);
  let out = `# 经验沉淀 ${m}\n\n`;
  const blocks = entries.map((e) => '\`\`\`yaml\n' + formatEntry(e) + '\n\`\`\`');
  out += blocks.join('\n') + '\n';
  writeFileAtomic(filePath, out);
  return { bumped: true, count: total, entry: matches[0] };
}

// === recordThenDie: transition-check 失败的统一出口 ===
// 内部 try/catch 调 recorder 主体; 失败只 stderr, 然后复制 die 语义 (stderr + exit exitCode)。
export function recordThenDie(exitCode, msg, opts = {}) {
  try {
    const { taskId, code, stage, rootCause } = opts || {};
    if (taskId && code) {
      let root = rootCause;
      if (typeof root !== 'string' || root.trim() === '') {
        // 从 msg 提取根因句: 去掉 [CODE] 前缀后的主体
        root = (msg || '').replace(/^\[[A-Z_]+\]\s*/, '').trim();
      }
      record({ taskId, code, stage, rootCause: root });
    } else if (taskId) {
      // 有 taskId 但无 code: 从 msg 提取 [CODE] 前缀
      const m = (msg || '').match(/^\[([A-Z_]+)\]/);
      const code2 = m ? m[1] : 'PROCESS_VIOLATION';
      record({ taskId, code: code2, stage, rootCause: (msg || '').replace(/^\[[A-Z_]+\]\s*/, '').trim() });
    }
  } catch (e) {
    process.stderr.write(`[lessons-recorder] record failed (non-fatal): ${e && e.stack || e}\n`);
  }
  // die 语义
  process.stderr.write(msg + '\n');
  process.exit(exitCode);
}

// recorder 主体: CLI 与 recordThenDie 共用。
export function record({ taskId, code, stage, rootCause }) {
  let ctxObj = null;
  // task-context-runtime.readContext 内部对缺失文件会 die(process.exit),
  // 无法被 try/catch 捕获——先查路径存在性, 缺失则跳过证据提取, 仍记录最小条目。
  try {
    if (fs.existsSync(contextPath(taskId))) {
      ctxObj = readContext(taskId).ctx;
    }
  } catch (e) {
    // 意外解析错误: 仅跳过证据提取, 不阻断记录。
  }

  const intent = (ctxObj && ctxObj.intent) || {};
  const sizing = (ctxObj && ctxObj.sizing) || {};
  const raw = typeof intent.raw === 'string' ? intent.raw : '';
  const keywords = extractKeywords(raw);

  let evidence = [];
  const ver = (ctxObj && ctxObj.verification) || {};
  const fwd = (ver && ver.forward) || {};
  if (Array.isArray(fwd.evidence) && fwd.evidence.length > 0) {
    const e0 = fwd.evidence[0];
    if (e0 && typeof e0.file === 'string') {
      evidence = [{ file: e0.file, line: e0.line != null ? e0.line : 0 }];
    }
  }

  const tier = sizing.tier || 'T0';
  const t1Strength = sizing.t1_strength || undefined;

  const see = (ERROR_CODES[code] && ERROR_CODES[code].see) || '';

  const lesson = {
    code: String(code),
    date: new Date().toISOString().slice(0, 10),
    stage: String(stage || 'unknown->unknown'),
    tier: String(tier),
    t1_strength: t1Strength,
    intent_keywords: keywords,
    evidence,
    root_cause: String(rootCause || '').replace(/[\r\n]+/g, ' ').slice(0, 500),
    see,
    count: 1,
  };

  const res = appendLesson(lesson);
  return { entry: res.entry, created: res.created, file: path.join(resolveLessonsDir(), `${lesson.date.slice(0, 7)}.md`) };
}

// === CLI 主入口 ===
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) { selfCheck(); return; }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write([
      'Usage:',
      '  node scripts/lessons-recorder.mjs <task_id> --code <CODE> --stage <FROM->TO> --root-cause "<文本>"',
      '  node scripts/lessons-recorder.mjs --self-check',
      '  node scripts/lessons-recorder.mjs --bump <CODE> [--month YYYY-MM]',
      '',
      'Records a failure lesson into docs/lessons/YYYY-MM.md (aggregated by code+evidence file).',
    ].join('\n') + '\n');
    process.exit(0);
  }
  if (args.includes('--bump')) {
    const bi = args.indexOf('--bump');
    const code = args[bi + 1];
    const mi = args.indexOf('--month');
    const month = mi !== -1 && args[mi + 1] ? args[mi + 1] : undefined;
    if (!code) {
      process.stderr.write('Error: --bump requires a CODE\n');
      process.exit(2);
    }
    try {
      const res = bumpLessonCount(code, month);
      if (res.bumped) process.stdout.write(`ok: bumped code=${code} month=${month || 'default'} -> count=${res.count}\n`);
      else process.stdout.write(`no-op: code=${code} not found in month=${month || 'default'}\n`);
      process.exit(0);
    } catch (e) {
      process.stderr.write(`[lessons-recorder] error: ${e && e.message || e}\n`);
      process.exit(1);
    }
  }
  const taskId = args[0];
  const codeIdx = args.indexOf('--code');
  const stageIdx = args.indexOf('--stage');
  const rcIdx = args.indexOf('--root-cause');
  const code = codeIdx !== -1 && args[codeIdx + 1] ? args[codeIdx + 1] : null;
  const stage = stageIdx !== -1 && args[stageIdx + 1] ? args[stageIdx + 1] : 'unknown->unknown';
  const rootCause = rcIdx !== -1 && args[rcIdx + 1] ? args[rcIdx + 1] : '';
  if (!taskId || !code) {
    process.stderr.write('Error: lessons-recorder requires <task_id> and --code <CODE>\n');
    process.exit(2);
  }
  try {
    const res = record({ taskId, code, stage, rootCause });
    process.stdout.write(`ok: lesson ${res.created ? 'created' : 'aggregated'} code=${code} -> ${res.file}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[lessons-recorder] error: ${e && e.message || e}\n`);
    process.exit(1);
  }
}

// === self-check: 聚合去重 (造 2 条同 code+file → count=2 且只 1 条记录) ===
function selfCheck() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-sc-'));
  process.env.LESSONS_DIR = tmpDir;
  let fail = 0;
  const eq = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
  const assertEq = (label, got, want) => {
    if (!eq(got, want)) { console.error('FAIL ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); fail = 1; }
    else console.log('PASS ' + label);
  };

  const taskId = 'lessons-self-' + Date.now();
  const ctxPath = path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
  fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
  fs.writeFileSync(ctxPath, JSON.stringify({
    task_id: taskId,
    intent: { raw: '实现用户登录鉴权中间件防止未授权访问' },
    sizing: { tier: 'T1', t1_strength: 'medium' },
    verification: { forward: { evidence: [{ file: 'src/auth.js', line: 42 }] } },
    dispatch_log: [{ agent: 'coder', mode: 'task', stage: 'EXECUTING' }],
  }, null, 2), 'utf8');

  try {
    const r1 = record({ taskId, code: 'MISSING_PREMISE_AUDIT', stage: 'PLANNING->EXECUTING', rootCause: 'planner 未产出 premise_audit' });
    const r2 = record({ taskId, code: 'MISSING_PREMISE_AUDIT', stage: 'PLANNING->EXECUTING', rootCause: 'planner 未产出 premise_audit' });
    assertEq('second record aggregated (count=2)', r2.entry.count, 2);
    assertEq('second record not created fresh', r2.created, false);
    const filePath = path.join(tmpDir, `${new Date().toISOString().slice(0, 7)}.md`);
    const entries = readLessonsFile(filePath);
    assertEq('only 1 record in file', entries.length, 1);
    assertEq('record code preserved', entries[0].code, 'MISSING_PREMISE_AUDIT');
    assertEq('record evidence file extracted', entries[0].evidence && entries[0].evidence[0].file, 'src/auth.js');
    assertEq('keywords extracted non-empty', Array.isArray(entries[0].intent_keywords) && entries[0].intent_keywords.length >= 2, true);
    assertEq('see from error-codes', entries[0].see, 'lifecycle/stages/planning.md §premise_audit');
    // 无 evidence.file → 每条独立 (不聚合)
    const r3 = record({ taskId, code: 'PROCESS_VIOLATION', stage: 'PLANNING->EXECUTING', rootCause: '无证据文件' });
    const r4 = record({ taskId, code: 'PROCESS_VIOLATION', stage: 'PLANNING->EXECUTING', rootCause: '无证据文件' });
    assertEq('shared code+evidence aggregated (created=false)', r4.created, false);
    assertEq('total entries = 2', readLessonsFile(filePath).length, 2);
  // bumpLessonCount self-check: 命中 bump / 不存在 code / 跨月定向
  const r5 = record({ taskId, code: 'BUMP_TARGET', stage: 'EXECUTING->EXECUTING', rootCause: 'bump 命中' });
  const r5b = record({ taskId, code: 'BUMP_TARGET', stage: 'EXECUTING->EXECUTING', rootCause: 'bump 命中' });
  // 造一条同 code 不同 evidence(file) 的条目 → 验证按纯 code 聚合
  const ctxPath2 = path.join(os.tmpdir(), 'kilo', `task_context_${taskId}_b.json`);
  fs.mkdirSync(path.dirname(ctxPath2), { recursive: true });
  fs.writeFileSync(ctxPath2, JSON.stringify({
    task_id: taskId + '_b',
    intent: { raw: '实现用户登录鉴权中间件防止未授权访问' },
    sizing: { tier: 'T1', t1_strength: 'medium' },
    verification: { forward: { evidence: [{ file: 'src/other-file.js', line: 7 }] } },
    dispatch_log: [{ agent: 'coder', mode: 'task', stage: 'EXECUTING' }],
  }, null, 2), 'utf8');
  const r6 = record({ taskId: taskId + '_b', code: 'BUMP_TARGET', stage: 'EXECUTING->EXECUTING', rootCause: 'bump 跨文件' });
  // 同 code BUMP_TARGET: r5+r5b 聚合 count=2, r6 独立 count=1 → 求和=3, bump 后=4
  const bumpRes = bumpLessonCount('BUMP_TARGET');
  assertEq('bump bumped=true', bumpRes.bumped, true);
  assertEq('bump count=sum(all code entries)+1', bumpRes.count, 4);
  const bumpMiss = bumpLessonCount('NO_SUCH_CODE');
  assertEq('bump missing code -> false/0', [bumpMiss.bumped, bumpMiss.count], [false, 0]);
  const otherMonth = '1999-01';
  const bumpCross = bumpLessonCount('BUMP_TARGET', otherMonth);
  assertEq('bump cross-month missing file -> false/0', [bumpCross.bumped, bumpCross.count], [false, 0]);
  // 跨月定向 bump: 在 otherMonth 已有文件
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, otherMonth + '.md'), '```yaml\n' + formatEntry({ code: 'BUMP_TARGET', date: '1999-01-01', stage: 'EXECUTING->QUALITY', tier: 'T1', t1_strength: null, intent_keywords: [], evidence: [{file:'x.js',line:1}], root_cause: 'm', see: '', count: 2 }) + '\n```\n', 'utf8');
  const bumpCrossHit = bumpLessonCount('BUMP_TARGET', otherMonth);
  assertEq('bump cross-month hit count=3', bumpCrossHit.count, 3);
  // cleanup extra ctx
  try { fs.rmSync(ctxPath2, { force: true }); } catch { /* 忽略 */ }
  } catch (e) {
    console.error('FAIL self-check exception: ' + (e && e.stack || e));
    fail = 1;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(ctxPath, { force: true }); } catch { /* 忽略 */ }
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

