/**
 * anchor-refs.mjs — lifecycle-doctor check
 *
 * 死引用门禁：文档里的 `§锚点` / `铁律 #N` / `xxx.md §锚点` 必须真能解析到目标锚点。
 *
 * 立项根因：`铁律 #11`、`§全局默认并行策略`、`§异常处理派发表` 曾被 6 处引用（含 AGENTS.md
 * 硬锚点 12）却在 conductor.md 里根本不存在——纯人工清理必然复发，只有机械化才能止血。
 *
 * 精度优先于召回（path-normalize 的教训：13/13 假阳性 = 零信号 = 门禁被当噪声断开）：
 * 1. 先剥离围栏代码块再抽标题——`docs/conductor-full-spec.md` L236 的 `## 强制流程日志`
 *    在 ```markdown 模板内，不是真标题；byte-level-verify.md L58-67 的 `# 1. SHA256` 同理。
 * 2. 标题命名双侧归一：定义侧部分带 `§` 前缀（`## §结论枚举`）、部分不带（`## 标记语言`），
 *    引用侧统一写 `§xxx` → 两侧都剥 `§` 再比。
 * 3. 双向 prefix 匹配：引用常是标题截断（`§委派包` → `## 委派包 SOP`）或标题+后缀
 *    （`§返回超限约束分档` → `## §返回超限约束（…）`），两个方向都算命中。
 * 4. 锚点集合 = markdown 标题 + 行首粗体标签（`- **委派不亲为**：…` 在本文档体系里
 *    就是可导航锚点，`§委派不亲为` 属合法引用）。标题/粗体均容忍缩进与有序列表前缀
 *    ——conductor.md 的 `### 10.1`、full-spec 的 `5. **超时守卫**` 都嵌在列表项里。
 * 5. 文件绑定只看 §之前的**近窗口**（上一处 § 之后），否则同一行早先出现的
 *    `init.md` 会把后面的 `§10.1` 劫持过去；并支持无扩展名引用（`见 output-schema §返回超限约束`）。
 * 6. `.yaml` 目标按字面文本命中（锚点是 YAML 注释段，如 `config.yaml §on_fail 默认值规则`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_REL = path.join('scripts', 'lifecycle-doctor', 'checks', 'anchor-refs.mjs');

// 扫描范围：LLM 运行时会读到的文档 + 人类维护清单（docs/archive 是历史档案，豁免）
const SCAN_DIRS = ['agent', '.kilo/instructions', 'lifecycle/stages'];
const SCAN_FILES = ['AGENTS.md', 'CONFIG_CHANGE_CHECKLIST.md', 'README.md'];
const SCAN_DOCS_DIR = 'docs';

// 铁律定义的唯一归属文件（`铁律 #N` 引用一律回此解析）
const IRONLAW_FILE = 'agent/conductor.md';

// 建全仓 basename 索引时跳过的目录：产物/依赖/历史 + 所有点目录。
// 不枚举具体工具目录名（会被 decouple-check 当成厂商耦合 critical）；
// 唯一例外是 `.kilo`——它承载运行时 instructions，必须索引。
const SKIP_DIR = /^(node_modules|reports|archive)$/;
const isSkippedDir = (name) => SKIP_DIR.test(name) || (name.charAt(0) === '.' && name !== '.kilo');

const norm = (p) => String(p).replace(/\\/g, '/');

/** 全仓文件 basename 索引：支持 `config.yaml §xxx` 这类不带目录的任意扩展名引用 */
function buildFileIndex(root, dir, out) {
  out = out || {};
  const abs = dir ? path.join(root, dir) : root;
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (isSkippedDir(e.name)) continue;
      buildFileIndex(root, norm(path.join(dir, e.name)), out);
    } else if (e.isFile()) {
      (out[e.name] = out[e.name] || []).push(norm(dir ? path.join(dir, e.name) : e.name));
    }
  }
  return out;
}

/** 围栏代码块内的行置空（保留行号对齐，避免模板/示例里的 `#` 与 `§` 被当成真锚点） */
function blankFences(lines) {
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    out.push(inFence ? '' : lines[i]);
  }
  return out;
}

/** 标题归一：去 `#`、去前导 `§`、去尾部括注与标点 */
function normHeading(raw) {
  let s = raw.replace(/^#+\s*/, '').replace(/^§\s*/, '').trim();
  s = s.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
  s = s.replace(/[.。:：,，、\s]+$/, '').trim();
  return s;
}

/** 引用串归一（与标题同规则，保证可比） */
function normRef(raw) {
  let s = String(raw).replace(/^§\s*/, '').trim();
  s = s.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
  s = s.replace(/[.。:：,，、\s]+$/, '').trim();
  return s;
}

function collectTargets(root) {
  const files = [];
  for (const f of SCAN_FILES) {
    if (fs.existsSync(path.join(root, f))) files.push(f);
  }
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(norm(path.join(d, e.name)));
    }
  }
  // docs/*.md（不含 archive/：历史档案允许保留失效锚点）
  const docsAbs = path.join(root, SCAN_DOCS_DIR);
  if (fs.existsSync(docsAbs)) {
    for (const e of fs.readdirSync(docsAbs, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(norm(path.join(SCAN_DOCS_DIR, e.name)));
    }
  }
  return files;
}

/** 抽取一个文件的锚点集合：标题 + 行首粗体标签 */
function anchorsOf(content) {
  const lines = blankFences(content.split('\n'));
  const set = new Set();
  const numbered = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 标题容忍 ≤6 空格缩进（conductor.md `### 10.1 …` 嵌在铁律 #10 列表项下）
    const h = line.match(/^\s{0,6}#{1,6}\s+(.+?)\s*$/);
    if (h) {
      const n = normHeading(h[1]);
      if (n) set.add(n);
      // 标题里的编号（`### 10.1 等级/节点…` / `### 2b. T1 强度判定`）单独入编号集
      const num = n.match(/^(\d+(?:\.\d+)?[a-z]?)\b\.?/);
      if (num) numbered.add(num[1]);
      continue;
    }
    // 行首粗体标签：`- **委派不亲为**：…` / `6. **委派不亲为**：…` / `5. **超时守卫**：…`
    const b = line.match(/^\s*(?:[-*+]\s*|\d+(?:\.\d+)?\.\s*)?\*\*([^*]{1,60})\*\*/);
    if (b) {
      const n = normHeading(b[1]);
      if (n) set.add(n);
      const num = n.match(/^(\d+(?:\.\d+)?[a-z]?)\./);
      if (num) numbered.add(num[1]);
    }
    // 顶层有序列表项：`1. **[意图判定]**：…`（铁律编号来源）
    const ol = line.match(/^(\d+(?:\.\d+)?)\.\s+/);
    if (ol) numbered.add(ol[1]);
  }
  return { set, numbered };
}

function resolveFile(refPath, fromFile, targets, root, fileIndex) {
  const p = norm(refPath).replace(/^\.\//, '');
  // 1) 相对 ROOT 直接命中
  if (fs.existsSync(path.join(root, p))) return { rel: p, exists: true };
  const base = p.split('/').pop();
  // 2) 按 basename 在扫描集里找
  for (const t of targets) {
    if (t.split('/').pop() === base) return { rel: t, exists: true };
  }
  // 3) 同目录优先（`§xxx` 无显式文件时不走到这里）
  const sib = norm(path.posix.join(path.dirname(fromFile), base));
  if (fs.existsSync(path.join(root, sib))) return { rel: sib, exists: true };
  // 4) 全仓 basename 索引兜底（`config.yaml` / `graph.yaml` 这类不带目录的引用）
  const idx = fileIndex && fileIndex[base];
  if (idx && idx.length >= 1) return { rel: idx[0], exists: true };
  return { rel: p, exists: false };
}

/**
 * 无扩展名引用解析：`见 output-schema §返回超限约束` → .kilo/instructions/output-schema.md。
 * 仅当 stem **紧邻** § 时才生效（调用方已用尾部锚定正则保证），否则散文里随便出现的
 * agent 名（`派发 coder 的委派包仍按 §委派包 SOP`、`verifier 6 必做路径断言）、§铁律 #9`）
 * 会把引用劫持到错文件。
 */
function resolveStem(stem, targets) {
  const hits = targets.filter((t) => t.split('/').pop().replace(/\.md$/, '') === stem);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // 同名多份（如 docs/x.md 与 agent/x.md）：优先 agent/ 与 .kilo/instructions/
    const pri = hits.filter((t) => /^(agent|\.kilo\/instructions|lifecycle\/stages)\//.test(t));
    if (pri.length === 1) return pri[0];
  }
  return null;
}

/** 双向 prefix 命中：引用是标题截断，或标题是引用前缀 */
function hit(ref, anchorSet) {
  if (anchorSet.has(ref)) return true;
  for (const a of anchorSet) {
    if (a.startsWith(ref) || ref.startsWith(a)) return true;
  }
  return false;
}

export function run(ctx) {
  const checkName = 'anchor-refs';
  const cf = ctx && ctx.cf;
  const root = (ctx && ctx.ROOT) || path.resolve(__dirname, '..', '..', '..');
  const targets = collectTargets(root);
  if (targets.length === 0) {
    const d = 'no docs found, skipped';
    if (cf) cf.pass(checkName, d);
    return { name: checkName, status: 'PASS', detail: d };
  }

  const cache = {};
  const fileIndex = buildFileIndex(root, '', {});
  const load = (rel) => {
    if (Object.prototype.hasOwnProperty.call(cache, rel)) return cache[rel];
    const abs = path.join(root, rel);
    let v = null;
    if (fs.existsSync(abs)) v = anchorsOf(fs.readFileSync(abs, 'utf8'));
    cache[rel] = v;
    return v;
  };

  const issues = [];
  let refCount = 0;
  let lawCount = 0;

  const ironlaw = load(IRONLAW_FILE);

  for (const rel of targets) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = blankFences(content.split('\n'));
    const self = load(rel);

    // --- 重复标题（同文件内归一后完全同名）---
    const seen = {};
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^\s{0,6}#{1,6}\s+(.+?)\s*$/);
      if (!h) continue;
      const n = normHeading(h[1]);
      if (!n) continue;
      if (Object.prototype.hasOwnProperty.call(seen, n)) {
        issues.push({
          file: rel, line: i + 1, kind: 'duplicate-heading',
          text: `「${n}」与 L${seen[n]} 重复`
        });
      } else {
        seen[n] = i + 1;
      }
    }

    // --- 铁律 #N 引用 ---
    for (let i = 0; i < lines.length; i++) {
      const re = /铁律\s*#?\s*(\d+(?:\.\d+)?[a-z]?)/g;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        lawCount++;
        const label = m[1];
        if (!ironlaw || !ironlaw.numbered.has(label)) {
          issues.push({
            file: rel, line: i + 1, kind: 'dangling-ironlaw',
            text: `铁律 #${label} 在 ${IRONLAW_FILE} 无定义`
          });
        }
      }
    }

    // --- §锚点引用 ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const re = /§\s*([^（()，,。；;：:、`"'」）)\s\][*]+)/g;
      let m;
      let windowStart = 0;  // 只看上一处 § 之后的近窗口，防跨句误绑
      let stickyTarget = null;  // `A.md §X + §Y`：后一个 § 继承前一个的目标
      let stickyYaml = false;
      while ((m = re.exec(line)) !== null) {
        const rawRef = m[1];
        const ref = normRef(rawRef);
        const window = line.slice(windowStart, m.index);
        windowStart = re.lastIndex;
        // 单字引用是正则截断产物（如标题内的 `§防 abort`），非导航意图
        if (ref.length < 2) continue;
        refCount++;
        // 目标文件 = **紧邻** § 的 .md/.yaml 文件名或已知文档 stem；
        // 无紧邻文件时，仅当与上一个 § 只隔连词（`§X + §Y`）才继承其目标，否则用本文件。
        // 不限定紧邻则 `AGENTS.md 锚点 15 引用本节——本节是 §Trace-First` 会被劫持到 AGENTS.md；
        // 无条件继承则 `见 init.md §路由规则。…（见 §10.1）` 的 §10.1 会被劫持到 init.md。
        const canInherit = stickyTarget !== null && window.length <= 8 && !/[。；;！!？?]/.test(window);
        let targetRel = canInherit ? stickyTarget : rel;
        let missingFile = false;
        let yamlMode = canInherit ? stickyYaml : false;
        // 文件名/stem 均尾部锚定：中间只允许空白与引号/括号类分隔符
        const fm = window.match(/([A-Za-z0-9_./\\-]+\.(?:md|ya?ml))[\s`'"”’）)\]]*$/);
        const sm = window.match(/([a-z][a-z0-9-]{2,})[\s`'"”’（()\[]*$/);
        if (fm) {
          const r = resolveFile(fm[1], rel, targets, root, fileIndex);
          if (!r.exists) {
            missingFile = true;
            issues.push({
              file: rel, line: i + 1, kind: 'dangling-file',
              text: `引用的 ${fm[1]} 不存在`
            });
          } else {
            targetRel = r.rel;
            yamlMode = /\.ya?ml$/i.test(targetRel);
            stickyTarget = targetRel;
            stickyYaml = yamlMode;
          }
        } else if (sm) {
          const r = resolveStem(sm[1], targets);
          if (r) { targetRel = r; stickyTarget = r; stickyYaml = false; }
        }
        if (missingFile) continue;
        if (yamlMode) {
          // YAML 锚点是注释段标题，按字面文本命中即可
          const ytxt = fs.readFileSync(path.join(root, targetRel), 'utf8');
          if (ytxt.indexOf(ref) === -1) {
            issues.push({
              file: rel, line: i + 1, kind: 'dangling-anchor',
              text: `§${ref} 在 ${targetRel} 无对应文本`
            });
          }
          continue;
        }
        const ta = load(targetRel);
        if (!ta) continue;
        if (!hit(ref, ta.set) && !ta.numbered.has(ref)) {
          issues.push({
            file: rel, line: i + 1, kind: 'dangling-anchor',
            text: `§${ref} 在 ${targetRel} 无对应锚点`
          });
        }
      }
    }
  }

  const detail = `docs=${targets.length} §refs=${refCount} 铁律refs=${lawCount} issues=${issues.length}`;
  if (issues.length === 0) {
    if (cf) cf.pass(checkName, detail);
  } else {
    const head = issues.slice(0, 6).map((i) => `${i.file}:L${i.line} ${i.kind} ${i.text}`).join(' | ');
    if (cf) cf.fail(checkName, `${detail} -> ${head}`);
  }
  return {
    name: checkName,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    detail,
    issues
  };
}
