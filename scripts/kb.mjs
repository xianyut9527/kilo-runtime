#!/usr/bin/env node
// 全局工程经验库 CLI（W5）
//   node scripts/kb.mjs add --symptom "..." --root-cause "..." --fix "..." [--tags a,b]
//   node scripts/kb.mjs search "关键词"
//   node scripts/kb.mjs list
//
// 默认写入部署副本（~/.config/kilo/knowledge-base/）；用 --repo 写回本仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_KB = path.join(HERE, "..", "knowledge-base");
const GLOBAL_KB = path.join(os.homedir(), ".config", "kilo", "knowledge-base");

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const useRepo = args.includes("--repo");
const KB = useRepo ? REPO_KB : GLOBAL_KB;

// 读取时合并「仓库（SSOT）」与「部署副本（运行时新增）」，按 id 去重（仓库优先）。
function readDirs() {
  return [REPO_KB, GLOBAL_KB];
}

function entryFiles() {
  const merged = new Map();
  for (const dir of readDirs()) {
    const d = path.join(dir, "entries");
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const id = path.basename(f, ".md");
      if (!merged.has(id)) merged.set(id, path.join(d, f));
    }
  }
  return [...merged.entries()]
    .map(([id, file]) => ({ id, file }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 新增编号要同时看两个目录，避免与仓库条目撞号
function readDirEntries() {
  return entryFiles();
}

function parseEntry(file) {
  const text = fs.readFileSync(file, "utf8");
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
  const field = (label) => {
    const m = text.match(new RegExp(`^-\\s*\\*\\*${label}\\*\\*[:：]\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return { title, tags: field("标签"), symptom: field("症状"), rootCause: field("根因"), fix: field("修复"), text };
}

function nextId() {
  // 只按本工具自己的前缀 KB- 编号，避免与历史 FX-* 条目混号
  const nums = entryFiles()
    .filter((e) => /^KB-\d+$/.test(e.id))
    .map((e) => Number(e.id.slice(3)))
    .filter((n) => Number.isFinite(n));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `KB-${String(n).padStart(4, "0")}`;
}

// 脱敏：明显凭证一律拒绝入库
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{12,}/, /api[_-]?key\s*[:=]\s*\S+/i, /Bearer\s+[A-Za-z0-9._-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function guardSecrets(pairs) {
  for (const [k, v] of pairs) {
    if (!v) continue;
    for (const re of SECRET_PATTERNS) {
      if (re.test(v)) {
        console.error(`拒绝入库：字段 ${k} 命中疑似凭证/密钥（${re}）。请用占位符脱敏。`);
        process.exit(2);
      }
    }
  }
}

function runAdd() {
  const symptom = flag("symptom");
  const rootCause = flag("root-cause");
  const fix = flag("fix");
  const tags = flag("tags") ?? "";
  const title = flag("title");

  if (!symptom || !rootCause || !fix) {
    console.error("用法：kb.mjs add --symptom \"...\" --root-cause \"...\" --fix \"...\" [--tags a,b] [--title ...] [--repo]");
    process.exit(1);
  }
  guardSecrets([["symptom", symptom], ["rootCause", rootCause], ["fix", fix], ["title", title]]);

  const id = nextId();
  const entryDir = path.join(KB, "entries");
  fs.mkdirSync(entryDir, { recursive: true });

  const body = `# ${id}：${title ?? symptom.slice(0, 40)}

- **标签**：${tags}
- **症状**：${symptom}
- **根因**：${rootCause}
- **修复**：${fix}
`;
  fs.writeFileSync(path.join(entryDir, `${id}.md`), body, "utf8");

  const indexPath = path.join(KB, "index.md");
  const row = `| ${id} | ${symptom.replace(/\|/g, "\\|").slice(0, 60)} | ${tags} | [${id}](entries/${id}.md) |\n`;
  if (fs.existsSync(indexPath)) {
    fs.appendFileSync(indexPath, row, "utf8");
  } else {
    fs.writeFileSync(indexPath, `# 经验索引\n\n| ID | 症状 | 标签 | 文件 |\n|----|------|------|------|\n${row}`, "utf8");
  }

  console.log(`已写入 ${path.join(KB, "entries", `${id}.md`)}${useRepo ? "" : "（部署副本，回收时用 --repo 写回仓库）"}`);
}

function runSearch() {
  const q = (args[1] ?? "").toLowerCase();
  if (!q) {
    console.error("用法：kb.mjs search \"关键词\"");
    process.exit(1);
  }
  const hits = [];
  for (const e of entryFiles()) {
    const p = parseEntry(e.file);
    const hay = `${p.title} ${p.tags} ${p.symptom} ${p.rootCause} ${p.fix}`.toLowerCase();
    if (hay.includes(q)) hits.push({ id: e.id, ...p });
  }
  if (!hits.length) {
    console.log(`无命中：${q}`);
    return;
  }
  for (const h of hits) {
    console.log(`\n[${h.id}] ${h.title}`);
    console.log(`  症状：${h.symptom}`);
    console.log(`  根因：${h.rootCause}`);
    console.log(`  修复：${h.fix}`);
  }
}

function runList() {
  const merged = new Map();
  for (const dir of readDirs()) {
    const idx = path.join(dir, "index.md");
    if (!fs.existsSync(idx)) continue;
    for (const line of fs.readFileSync(idx, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\|\s*([A-Z]+-\d+)\s*\|/);
      if (m) merged.set(m[1], line);
    }
  }
  if (!merged.size) {
    console.log(`（${REPO_KB} 与 ${GLOBAL_KB} 下暂无索引）`);
    return;
  }
  console.log(`| ID | 症状 | 标签 | 文件 |`);
  console.log(`|----|------|------|------|`);
  for (const id of [...merged.keys()].sort()) console.log(merged.get(id));
}

switch (cmd) {
  case "add":
    runAdd();
    break;
  case "search":
    runSearch();
    break;
  case "list":
    runList();
    break;
  default:
    console.log(`kb.mjs —— 全局工程经验库

  add    新增条目（默认写部署副本；--repo 写回仓库）
  search 关键词检索（合并仓库与部署副本）
  list   列出索引（合并）

  仓库（SSOT）：${REPO_KB}
  部署副本：    ${GLOBAL_KB}${fs.existsSync(GLOBAL_KB) ? "" : "（不存在）"}`);
}
