#!/usr/bin/env node
// lessons.mjs
// 能力沉淀教训库 CLI（C 层核心）--把编码能力长在程序里，随使用越来越强，跟模型解耦。
//
// 原则：LLM 判定的门禁随模型智商缩放，机械断言的门禁不缩放。每一次失败自动沉淀成
// 永久能力（程序规则或机械脚本门），agent 带着系统犯过并修过的全部错误开干。
// 模板：scripts/scan-encoding.mjs 就是一条手动沉淀的机械教训；本脚本把沉淀系统化。
//
// 存储（<ROOT>/docs/lessons/，ROOT 由 __dirname 解析，源仓库/安装目录都生效）：
//   registry.jsonl   原始捕获日志，一行一条教训，跨任务持久增长
//   <category>.md    晋级后的程序类规则（按分类），每次 dispatch 注入对应角色
//
// 闭环：捕获(record) -> 检测复发+晋级(audit) -> 注入(get)。
//   程序类教训复发≥阈值 -> 自动追加规则到 <category>.md（用户经 git diff 审阅，可回退）
//   机械类教训复发≥阈值 -> 仅输出提案，需人工建脚本门（范本 scan-encoding.mjs，高风险不自动）
//
// 用法：
//   node scripts/lessons.mjs record --category <tag> --symptom <t> --root-cause <t> --prevention <t> \
//     --type mechanical|procedural --source-task <id>
//   node scripts/lessons.mjs get --role <role>            返回该角色已晋级规则文本（供 conductor 注入）
//   node scripts/lessons.mjs audit [--promote-threshold 3]  复发检测 + 自动晋级程序类 + 机械类提案
//   node scripts/lessons.mjs promote <id>                 显式晋级一条程序类教训
//   node scripts/lessons.mjs list [--category <tag>]      列教训
//
// 退出码：0=成功，1=未找到/机械类拒绝自动晋级，2=参数错误
//
// 分类（= reverse-auditor issues[].tag + ACCEPTANCE_FAIL）：
//   SCOPE_CREEP / LOCAL_PATCH / COPY_PASTE_FIX / FAKE_CONTEXT / FORBIDDEN_TOUCH /
//   DEBUG_LEFTOVER / UNCOVERED_CHANGE / PROCESS_VIOLATION / TRUST_TRANSFER / ACCEPTANCE_FAIL

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LESSONS_DIR = path.join(ROOT, 'docs', 'lessons');
const REGISTRY = path.join(LESSONS_DIR, 'registry.jsonl');

const CATEGORIES = [
  'SCOPE_CREEP', 'LOCAL_PATCH', 'COPY_PASTE_FIX', 'FAKE_CONTEXT',
  'FORBIDDEN_TOUCH', 'DEBUG_LEFTOVER', 'UNCOVERED_CHANGE',
  'PROCESS_VIOLATION', 'TRUST_TRANSFER', 'ACCEPTANCE_FAIL',
];

// 角色 -> 该角色 dispatch 时应注入的教训分类（只注入相关，避免噪音）
const ROLE_CATEGORIES = {
  coder: ['SCOPE_CREEP', 'LOCAL_PATCH', 'COPY_PASTE_FIX', 'DEBUG_LEFTOVER', 'UNCOVERED_CHANGE', 'ACCEPTANCE_FAIL'],
  verifier: ['FAKE_CONTEXT', 'ACCEPTANCE_FAIL', 'UNCOVERED_CHANGE'],
  reviewer: ['SCOPE_CREEP', 'LOCAL_PATCH', 'COPY_PASTE_FIX', 'FORBIDDEN_TOUCH'],
  'reverse-auditor': ['SCOPE_CREEP', 'LOCAL_PATCH', 'COPY_PASTE_FIX', 'FAKE_CONTEXT', 'FORBIDDEN_TOUCH', 'DEBUG_LEFTOVER', 'UNCOVERED_CHANGE'],
  fixer: ['ACCEPTANCE_FAIL', 'LOCAL_PATCH', 'DEBUG_LEFTOVER'],
  conductor: CATEGORIES,
};

function ensureDir() {
  if (!fs.existsSync(LESSONS_DIR)) fs.mkdirSync(LESSONS_DIR, { recursive: true });
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) return [];
  return fs.readFileSync(REGISTRY, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function writeRegistry(lessons) {
  ensureDir();
  fs.writeFileSync(REGISTRY, lessons.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function nextId(lessons) {
  let max = 0;
  for (const l of lessons) {
    const n = parseInt(String(l.id || '').replace(/^L/, ''), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return 'L' + String(max + 1).padStart(4, '0');
}

function normalizeSymptom(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, ' ')
    .trim()
    .slice(0, 80);
}

function appendRule(category, ruleText) {
  ensureDir();
  const p = path.join(LESSONS_DIR, category + '.md');
  let header = '';
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8').trim() === '') {
    header = `# 已沉淀教训：${category}\n\n> 本分类下复发≥阈值的程序类教训自动晋级到此，每次 dispatch 注入对应角色。\n> 机械类教训不自动晋级，需人工建脚本门（范本 scripts/scan-encoding.mjs）。\n\n`;
  }
  fs.appendFileSync(p, header + ruleText + '\n', 'utf8');
}

// ---- record ----
function cmdRecord(o) {
  if (!o.category || !o.symptom) die(2, 'Error: record requires --category <tag> --symptom <text>');
  if (!CATEGORIES.includes(o.category)) die(2, `Error: --category must be one of: ${CATEGORIES.join(', ')}`);
  const lessons = readRegistry();
  const lesson = {
    id: nextId(lessons),
    category: o.category,
    symptom: o.symptom,
    root_cause: o['root-cause'] || '',
    prevention: o.prevention || '',
    type: o.type === 'mechanical' ? 'mechanical' : 'procedural',
    source_task: o['source-task'] || '',
    timestamp: Date.now(),
    status: 'active',
  };
  ensureDir();
  fs.appendFileSync(REGISTRY, JSON.stringify(lesson) + '\n', 'utf8');
  process.stdout.write(`recorded: ${lesson.id} [${lesson.category}] ${lesson.type} :: ${String(lesson.symptom).slice(0, 60)}\n`);
  process.exit(0);
}

// ---- get（注入用）----
function cmdGet(o) {
  const role = o.role;
  if (!role) die(2, 'Error: get requires --role <role>');
  const cats = ROLE_CATEGORIES[role] || CATEGORIES;
  const parts = [];
  for (const cat of cats) {
    const p = path.join(LESSONS_DIR, cat + '.md');
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) parts.push(`### ${cat}\n${text}`);
    }
  }
  if (parts.length === 0) {
    process.stdout.write(`（role=${role}：暂无已晋级教训）\n`);
  } else {
    process.stdout.write(`## 已沉淀教训（role=${role}，按系统历史失败沉淀，编码/验证时遵守）\n\n` + parts.join('\n\n') + '\n');
  }
  process.exit(0);
}

// ---- audit（复发检测 + 自动晋级程序类 + 机械类提案）----
function cmdAudit(o) {
  const threshold = parseInt(o['promote-threshold'] || '3', 10);
  if (!Number.isInteger(threshold) || threshold < 1) die(2, 'Error: --promote-threshold must be a positive integer');
  const lessons = readRegistry();
  if (lessons.length === 0) {
    process.stdout.write('audit: 教训库为空\n');
    process.exit(0);
  }
  // 按 category + 归一化 symptom 分组（已晋级的不重复计）
  const groups = new Map();
  for (const l of lessons) {
    if (l.status === 'promoted') continue;
    const key = l.category + '::' + normalizeSymptom(l.symptom);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const autoPromoted = [];
  const proposals = [];
  for (const [, group] of groups) {
    if (group.length < threshold) continue;
    const rep = group[0];
    if (rep.type === 'procedural') {
      const ruleText = `- [教训 ${rep.id}] ${rep.symptom}\n  - 根因：${rep.root_cause}\n  - 防范：${rep.prevention}\n  - 复发 ${group.length} 次（首次 ${rep.source_task || '未知'}）\n`;
      appendRule(rep.category, ruleText);
      for (const l of group) l.status = 'promoted';
      autoPromoted.push({ count: group.length, category: rep.category, id: rep.id, symptom: rep.symptom });
    } else {
      proposals.push({ count: group.length, category: rep.category, id: rep.id, symptom: rep.symptom, prevention: rep.prevention });
    }
  }
  if (autoPromoted.length > 0) writeRegistry(lessons); // 持久化 status 更新

  let out = `audit: 扫描 ${lessons.length} 条教训（晋级阈值 ${threshold}）\n`;
  if (autoPromoted.length > 0) {
    out += `\n自动晋级（程序类，规则已写入 <category>.md，将注入对应角色；git diff 可审阅/回退）：\n`;
    for (const a of autoPromoted) out += `  - [${a.category}] ${a.id} 复发 ${a.count} 次 :: ${String(a.symptom).slice(0, 50)}\n`;
  }
  if (proposals.length > 0) {
    out += `\n机械类晋级提案（高风险，需人工建脚本门，范本 scripts/scan-encoding.mjs）：\n`;
    for (const p of proposals) {
      out += `  - [${p.category}] ${p.id} 复发 ${p.count} 次 :: ${String(p.symptom).slice(0, 50)}\n`;
      out += `      防范：${p.prevention}\n`;
    }
  }
  if (autoPromoted.length === 0 && proposals.length === 0) out += '（无复发达阈值的教训）\n';
  process.stdout.write(out);
  process.exit(0);
}

// ---- promote（显式，按 id）----
function cmdPromote(o) {
  const id = o.id;
  if (!id) die(2, 'Error: promote requires <id>');
  const lessons = readRegistry();
  const l = lessons.find((x) => x.id === id);
  if (!l) die(1, `not found: ${id}`);
  if (l.type !== 'procedural') die(1, `${id} 是机械类教训，需人工建脚本门（不自动晋级）`);
  if (l.status === 'promoted') { process.stdout.write(`already promoted: ${id}\n`); process.exit(0); }
  const ruleText = `- [教训 ${l.id}] ${l.symptom}\n  - 根因：${l.root_cause}\n  - 防范：${l.prevention}\n`;
  appendRule(l.category, ruleText);
  l.status = 'promoted';
  writeRegistry(lessons);
  process.stdout.write(`promoted: ${id} -> ${l.category}.md\n`);
  process.exit(0);
}

// ---- list ----
function cmdList(o) {
  const lessons = readRegistry();
  if (lessons.length === 0) { process.stdout.write('（教训库为空）\n'); process.exit(0); }
  const cat = o.category;
  const filtered = cat ? lessons.filter((l) => l.category === cat) : lessons;
  if (cat && !CATEGORIES.includes(cat)) die(2, `Error: --category must be one of: ${CATEGORIES.join(', ')}`);
  for (const l of filtered) {
    process.stdout.write(`${l.id} [${l.category}] ${l.type} ${l.status} :: ${String(l.symptom).slice(0, 50)}\n`);
  }
  process.exit(0);
}

// ---- arg 解析 + 路由 ----
function die(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

function parseFlags(args) {
  const o = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1];
      o[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { o, positional };
}

function usage() {
  const txt = [
    'Usage:',
    '  node scripts/lessons.mjs record --category <tag> --symptom <t> --root-cause <t> --prevention <t> --type mechanical|procedural --source-task <id>',
    '  node scripts/lessons.mjs get --role <role>            # 返回该角色已晋级规则文本（注入用）',
    '  node scripts/lessons.mjs audit [--promote-threshold 3] # 复发检测 + 自动晋级程序类 + 机械类提案',
    '  node scripts/lessons.mjs promote <id>                 # 显式晋级一条程序类教训',
    '  node scripts/lessons.mjs list [--category <tag>]      # 列教训',
    '',
    `Categories: ${CATEGORIES.join(', ')}`,
    `Roles: ${Object.keys(ROLE_CATEGORIES).join(', ')}`,
    '',
    'Exit codes: 0=ok, 1=not found/mechanical-refused, 2=usage error',
  ].join('\n');
  process.stdout.write(txt + '\n');
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();
  const sub = args[0];
  const rest = args.slice(1);
  const { o, positional } = parseFlags(rest);
  if (sub === 'record') cmdRecord(o);
  else if (sub === 'get') cmdGet(o);
  else if (sub === 'audit') cmdAudit(o);
  else if (sub === 'promote') cmdPromote({ id: positional[0], ...o });
  else if (sub === 'list') cmdList(o);
  else die(2, `Error: unknown subcommand "${sub}". See --help.`);
}

main();
