/**
 * markdown-hygiene.mjs — lifecycle-doctor check
 *
 * Markdown 内容卫生门禁（自动注入文件里尤其致命——模型每轮都读到，会照着模仿）。
 *
 * 立项根因：本仓库曾在 4 个 .md 里累积 19 处**字面反斜杠+反引号**（`\`cmd\``），
 * 其中 16 处位于每次任务都自动注入的 `core.md`，渲染成一堆反斜杠的坏 markdown。
 * 成因是编辑/生成环节的误转义，属高发易复发缺陷，只靠人工清理必然再来一次。
 *
 * 检测项：
 *   escaped-backtick  字面 `\`` 序列（markdown 里渲染为字面反引号，非合法转义语法）
 *                     例外：同一行若含显式豁免标记 `hygiene-ignore` 则跳过（用于
 *                     讲解转义本身的文档）。
 *
 * 范围纪律（沿用 anchor-refs / decouple-check 的同一手法，不枚举厂商目录名）：
 * 只扫规则本体与仓库文档，点目录一律跳过，唯一例外 `.kilo`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');

const checkName = 'md-hygiene';

const SCAN_DIRS = ['agent', '.kilo/instructions', 'lifecycle/stages', 'docs'];
const SCAN_FILES = ['AGENTS.md', 'CONFIG_CHANGE_CHECKLIST.md', 'README.md', 'CHANGELOG.md'];
// docs/archive/ 是历史档案，允许保留当时的原貌（含当时的缺陷），不追溯修
const SKIP_PATH = /(^|\/)archive\//;
// 点目录一律跳过，唯一例外 `.kilo`（沿用 anchor-refs / decouple-check 的同一手法，不枚举厂商目录名）；
// node_modules 另判——`.kilo` 是可达子树，其下依赖包带的几百份 README 会被误扫。
const isSkippedDir = (name) => name === 'node_modules' || (name.charAt(0) === '.' && name !== '.kilo');

const IGNORE_MARK = 'hygiene-ignore';

function listMarkdown(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      listMarkdown(full, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 字面 `\`` 检测。逐行报告首个命中即可（一个文件里通常成片出现，
 * 数量在 detail 里汇总，避免逐行刷出几十条 cf 记录）。
 */
function findEscapedBackticks(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return null;
  }
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf(IGNORE_MARK) >= 0) continue;
    // 数出现次数：连续 `\`\`` 是一个接一个的转义反引号
    const m = line.match(/\\`/g);
    if (m) hits.push({ line: i + 1, count: m.length });
  }
  if (hits.length === 0) return { rel, hits: [] };
  return { rel, hits };
}

export function run(ctx) {
  const cf = ctx.cf;
  const root = (ctx && ctx.ROOT) || path.resolve(__dirname, '..', '..', '..');

  // 收集要检查的文件（统一用相对正斜杠路径）。注意：不能把 listMarkdown 的输出
  // 直接当成累加目标数组——它 push 的是绝对路径，对同一数组做 forEach 会在迭代中被自身扩展。
  const collected = [];
  for (const f of SCAN_FILES) collected.push(f);
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const p of listMarkdown(abs, [])) {
      collected.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  }

  const seen = new Set();
  const files = [];
  for (const rel of collected) {
    if (SKIP_PATH.test(rel) || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }

  const bad = [];
  let checked = 0;
  for (const rel of files) {
    const r = findEscapedBackticks(root, rel);
    if (!r) continue;
    checked++;
    if (r.hits.length > 0) bad.push(r);
  }

  if (checked === 0) {
    if (cf) cf.fail(checkName + '.targets', 'no markdown target found under ' + root);
    return { name: checkName, status: 'FAIL', detail: 'no target files', issues: [] };
  }

  const issues = bad.map((b) => ({
    kind: 'escaped-backtick',
    file: b.rel,
    lines: b.hits.map((h) => h.line).join(','),
    count: b.hits.reduce((x, h) => x + h.count, 0)
  }));

  if (issues.length === 0) {
    if (cf) cf.pass(checkName + '.escaped-backtick', 'docs=' + checked + ' occurrences=0');
  } else {
    const detail = issues
      .map((i) => i.file + '(' + i.count + ' @L' + i.lines + ')')
      .join(' ');
    if (cf) cf.fail(checkName + '.escaped-backtick', 'docs=' + checked + ' ' + detail);
  }

  return {
    name: checkName,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    detail: 'docs=' + checked + ' escaped-backtick issues=' + issues.length,
    issues
  };
}
