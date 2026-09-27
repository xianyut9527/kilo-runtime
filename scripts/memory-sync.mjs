#!/usr/bin/env node
// 跨项目记忆定向同步（2026-09-26 记忆防丢专项）
//
// 问题：kilo_memory_save 只写当前项目记忆根（<data>/memory/<dir>/），在 A 项目会话里讨论
// B 项目产生的知识（B 的构建命令/环境怪癖/决策）沉淀进 A 的记忆——B 侧 kilo_memory_recall
// 永远检索不到，知识随 A 项目的记忆边界丢失。
//
// 本脚本把一条记忆定向写入目标项目的记忆根：
//   node memory-sync.mjs <目标项目根> <kind> <key> <text...>
//     kind ∈ facts|decisions|constraints|open-questions|corrections|commands|paths|tooling
//     写入对应记忆文件（project.md / corrections.md / environment.md 的段落），
//     同 key 行原位更新（追加日期戳标记，历史不删——与 /evolve「同 key 重复写入更新而非堆积」
//     口径一致），幂等（内容相同零改动）、原子写（tmp+rename，同 quality-gate 沉淀口径）。
//   node memory-sync.mjs            # 无参：用法 + 全部记忆根体检（含孤儿根检测）
//
// 同步规则（INSTRUCTIONS.md 自我进化段下发）：A 项目会话沉淀了 B 项目专属事实时，
// 立即用本脚本镜像到 B 的记忆根——「同步即沉淀的一部分」，不同步等于没记。
//
// 安全边界：
//   - 只动 project.md / corrections.md / environment.md 三个文件（不碰 state.json/index.kmem/sessions/）；
//     index.kmem 由 Kilo autoConsolidate 自动重建（rebuild 亦可用 /memory rebuild），
//     手写格式错误的索引比过期索引更危险。
//   - 目标记忆根按 manifest.json canonical 字段精确匹配（realpath 后比对，与
//     quality-gate memoryRootFor 同口径——前缀兜底会让相似目录串号）。
//   - 记忆根不存在时中止退出（记忆未启用的项目先跑 /memory-setup，不在此静默创建——
//     创建归 memory-enable.mjs 管，职责不混）。
//
// 与 scripts/memory-enable.mjs 共用 canonical 解析口径（git 根向上找 + worktree 归并主仓）。
// 纯本地 fs 操作，零模型调用。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TAG = "[memory-sync]";

function dataDir() {
  return process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "kilo") : path.join(os.homedir(), ".local", "share", "kilo");
}

// 与 memory-enable.mjs / plugin/memory-bootstrap.ts 同构：
// git 根向上查找 + worktree 经 .git gitdir 归并主仓（worktree 与主仓共享记忆根）
function canonicalRoot(dir) {
  try {
    let cur = fs.realpathSync.native(dir);
    for (;;) {
      const gitPath = path.join(cur, ".git");
      if (fs.existsSync(gitPath)) {
        if (fs.statSync(gitPath).isFile()) {
          const line = (fs.readFileSync(gitPath, "utf8").split(/\r?\n/)[0] || "").trim();
          const m = line.match(/^gitdir:\s*(.+)$/);
          if (!m) return cur;
          const gitdir = path.resolve(cur, m[1].trim());
          const mainGitDir = path.dirname(path.dirname(gitdir));
          return fs.realpathSync.native(path.dirname(mainGitDir));
        }
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null; // 文件系统根兜底（盘符根/UNC 根），天然终止无层数上限
      cur = parent;
    }
  } catch {}
  return null;
}

// kind → { file, heading }：project.md 的四段 + corrections.md 的段 + environment.md 的三段
// （与 memory-enable.mjs scaffold 布局逐段一致；「B 的构建命令」类环境知识走 environment.md）
const KINDS = {
  facts: { file: "project.md", heading: "## Facts" },
  decisions: { file: "project.md", heading: "## Decisions" },
  constraints: { file: "project.md", heading: "## Constraints" },
  "open-questions": { file: "project.md", heading: "## Open Questions" },
  corrections: { file: "corrections.md", heading: "## Corrections" },
  commands: { file: "environment.md", heading: "## Commands" },
  paths: { file: "environment.md", heading: "## Paths" },
  tooling: { file: "environment.md", heading: "## Tooling" },
};

// 记忆根定位：先把目标目录归并到 git 根（子目录/worktree 经 canonicalRoot 归并主仓，
// 非 git 目录退回 realpath 自身——memory-enable.mjs enableDir 同口径），
// 再与 manifest.canonical 精确比对（quality-gate memoryRootFor 同口径，防相似目录串号）
function memoryRootFor(targetDir) {
  const memDir = path.join(dataDir(), "memory");
  if (!fs.existsSync(memDir)) return null;
  const canonical = canonicalRoot(targetDir) ?? (() => {
    try {
      return fs.realpathSync.native(targetDir);
    } catch {
      return null;
    }
  })();
  if (!canonical) return null;
  for (const name of fs.readdirSync(memDir)) {
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(memDir, name, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    if (m?.canonical === canonical) return path.join(memDir, name);
  }
  return null;
}

// 段落维护：定位 ## heading 段，同 key 行原位更新（保留位置与顺序），否则段末追加。
// 返回 { next, changed }——内容完全一致时 changed=false（幂等零写盘）。
// key 匹配口径：`- <key> ::` 前缀（与 kilo_memory_recall 行格式及 quality-gate 沉淀行一致）。
function upsertRecord(md, heading, key, line) {
  const text = String(md ?? "");
  const h = String(heading ?? "");
  let i = text.indexOf(`\n${h}`);
  if (i < 0 && text.startsWith(h)) i = 0;
  if (i < 0) return { next: `${text}\n\n${h}\n\n${line}\n`, changed: true };
  const after = i + h.length + (i === 0 ? 0 : 1);
  const end = text.indexOf("\n## ", after);
  const seg = end < 0 ? text.slice(after) : text.slice(after, end);
  const keyPat = new RegExp(`^-[ ]+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ ]+::`, "m");
  if (keyPat.test(seg)) {
    // 同 key 原位更新：保留行位置与顺序，只替换该行内容
    const lines = seg.split(/\r?\n/);
    const idx = lines.findIndex((l) => keyPat.test(l));
    if (idx < 0) return { next: text, changed: false }; // 多行模式命中但单行失配（防御，理论不可达）
    if (lines[idx].trim() === line.trim()) return { next: text, changed: false }; // 幂等：内容一致零写盘
    lines[idx] = line;
    // 重组段：更新行 + 原段尾换行结构，再拼回段后内容
    const merged = lines.join("\n").replace(/\n*$/, "\n");
    const tail = end < 0 ? "" : text.slice(end);
    return { next: text.slice(0, after) + (end < 0 ? merged : merged.replace(/\n$/, "")) + tail, changed: true };
  }
  // 段末追加（保持段结构：插到下一个 ## 之前或文件尾）
  const insertAt = end < 0 ? text.length : end;
  return { next: `${text.slice(0, insertAt)}\n${line}${text.slice(insertAt)}`, changed: true };
}

// 原子写（tmp+rename，Windows 走 MoveFileExW+REPLACE_EXISTING 直接覆盖——
// windows_rename_overwrite_rotation 教训：先 rm 反而引入丢档窗口）
function atomicWrite(file, content) {
  const tmp = `${file}.ms-tmp-${process.pid}-${Date.now() % 100000}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// 单行化 text：剥首尾空白，内部换行改「；」（记忆行是 `- key :: text` 一行一条，
// 嵌套换行会污染段落结构——quality-gate residualFixupLine 同款语义）
function oneline(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("；");
}

function status() {
  const memRoot = path.join(dataDir(), "memory");
  if (!fs.existsSync(memRoot)) {
    console.log(`${TAG} no memory root at ${memRoot}（尚未启用任何项目）`);
    return;
  }
  const rows = fs
    .readdirSync(memRoot)
    .filter((d) => fs.statSync(path.join(memRoot, d)).isDirectory())
    .map((d) => {
      const root = path.join(memRoot, d);
      let canonical = "";
      try {
        canonical = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).canonical;
      } catch {}
      // 孤儿根检测：canonical 指向的目录已不在盘上（项目目录改名/移动/删除），
      // 该根沉淀的记录检索不到——改名搁浅根会持续吞记忆（2026-09-26 实证）
      const onDisk = canonical ? fs.existsSync(canonical) : false;
      let records = 0;
      try {
        const md = fs.readFileSync(path.join(root, "project.md"), "utf8");
        records = (md.match(/^- /gm) || []).length;
      } catch {}
      // 最近写入时间：三份记忆文件 mtime 的最大值（无文件为空——空根/损坏根一眼可辨）
      let lastWrite = "";
      try {
        lastWrite = new Date(
          Math.max(
            ...["project.md", "corrections.md", "environment.md"].map((f) => {
              try {
                return fs.statSync(path.join(root, f)).mtimeMs;
              } catch {
                return 0;
              }
            })
          )
        )
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");
      } catch {}
      return { folder: d, onDisk, records, lastWrite, canonical: onDisk ? canonical : `${canonical}  <- ORPHANED` };
    })
    .sort((a, b) => Number(a.onDisk) - Number(b.onDisk)); // 孤儿根排最前，体检时第一眼可见
  console.table(rows);
  const orphans = rows.filter((r) => !r.onDisk);
  if (orphans.length) {
    console.log(`${TAG} WARN: ${orphans.length} 个孤儿记忆根（canonical 目录不在盘上，其记录已不可检索）:`);
    for (const o of orphans) console.log(`  - ${o.folder} -> ${o.canonical.replace("  <- ORPHANED", "")}`);
    console.log(`  处置：项目改名/移动后，把记录合并进新目录的记忆根（同 key 去重），或删除该根。`);
  }
}

const args = process.argv.slice(2);
if (args.length < 4) {
  console.log(`用法: node memory-sync.mjs <目标项目根> <kind> <key> <text...>
  kind: ${Object.keys(KINDS).join(" | ")}
  把一条记忆定向同步到目标项目的记忆根（同 key 原位更新，幂等，原子写）。
  目标项目记忆未启用时报错退出（先跑 /memory-setup 启用）。
无参: 列出全部记忆根体检表`);
  if (args.length === 0) status();
  process.exit(args.length === 0 ? 0 : 1);
}

const [targetDir, kind, key, ...rest] = args;
const spec = KINDS[kind];
if (!spec) {
  console.error(`${TAG} FAIL: 未知 kind "${kind}"（可选: ${Object.keys(KINDS).join(" | ")}）`);
  process.exit(1);
}
const body = oneline(rest.join(" "));
if (!key || !body) {
  console.error(`${TAG} FAIL: key 与 text 均不能为空`);
  process.exit(1);
}

const root = memoryRootFor(targetDir);
if (!root) {
  console.error(`${TAG} FAIL: 未定位到 "${targetDir}" 的记忆根（原生记忆未启用，或 manifest 不含该路径）。
  启用方式（二选一）：
  ① 在目标项目会话里跑 /memory-setup；
  ② 免切项目，直接在本会话执行: node ~/.config/kilo/scripts/memory-enable.mjs <目标项目根>`);
  process.exit(1);
}

const file = path.join(root, spec.file);
if (!fs.existsSync(file)) {
  console.error(`${TAG} FAIL: 记忆文件缺失 ${file}（布局不完整，先跑 /memory-setup 修复）`);
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const stamp = `（synced ${date}）`;
const line = `- ${key} :: ${body}${body.includes(stamp) ? "" : stamp}`;
const md = fs.readFileSync(file, "utf8");
const { next, changed } = upsertRecord(md, spec.heading, key, line);
if (!changed) {
  console.log(`${TAG} 已是最新，零改动: ${key} -> ${spec.file} 的 ${spec.heading}`);
  process.exit(0);
}
// EOL/尾换行规范化：防目标文件无尾换行或连续空行导致重组后格式破坏（反向审查低危项加固）
atomicWrite(file, `${next.replace(/\r?\n/g, "\n").replace(/\n+$/, "\n")}`);
console.log(`${TAG} synced: ${key} -> ${root} 的 ${spec.file} ${spec.heading}`);