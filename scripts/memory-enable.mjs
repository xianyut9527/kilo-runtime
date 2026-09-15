#!/usr/bin/env node
// 记忆批量启用/体检工具（repo 侧运维脚本，同步部署到 ~/.config/kilo/scripts/ 供 /memory-setup 调用）
//
// 用法：
//   node memory-enable.mjs                 # 体检：列出全部记忆根及启用状态
//   node memory-enable.mjs <dir> [dir...]  # 为指定目录启用原生记忆（任意目录，不必是 git 仓库）
//   node memory-enable.mjs --db            # 从 kilo.db project 表拉全部项目根，批量启用
//
// 与 plugin/memory-bootstrap.ts 共用同一套 canonical 解析与 scaffold 布局
//（已与官方 POST /memory/enable 产物逐字节比对；插件只覆盖 git 仓库，本脚本可显式启用任意目录）。
// 只在 state.json 缺失时创建；已有状态一律不动（禁用状态也不会被重新打开）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TAG = "[memory-enable]";

const STATE_ENABLED = `{
  "version": 1,
  "enabled": true,
  "scope": "project",
  "autoInject": true,
  "autoConsolidate": true,
  "verbose": false,
  "capture": {
    "mode": "selective",
    "turnClose": true,
    "explicit": true,
    "maxOpsPerRun": 16,
    "minIntervalMs": 300000,
    "timeoutMs": 30000
  },
  "stats": {
    "lastInjectedAt": null,
    "lastInjectedBytes": 0,
    "lastInjectedTokens": 0,
    "lastInjectedSessionID": null,
    "lastTypedConsolidationAt": null,
    "lastSessionSavedAt": null,
    "lastConsolidatedMessageID": null,
    "lastConsolidationCost": 0,
    "lastConsolidationTokens": 0,
    "lastOperationCount": 0,
    "lastRecallAt": null,
    "lastRecallCount": 0,
    "lastRecallSessionID": null
  }
}
`;

function dataDir() {
  return process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "kilo") : path.join(os.homedir(), ".local", "share", "kilo");
}

function safeName(name) {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "project";
}

// 与 plugin/memory-bootstrap.ts 同构：git 根向上查找 + worktree 经 gitdir 归并主仓
function canonicalRoot(dir) {
  try {
    let cur = fs.realpathSync.native(dir);
    for (let i = 0; i < 30; i++) {
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
      if (parent === cur) return null;
      cur = parent;
    }
  } catch {}
  return null;
}

function folderFor(canonical) {
  return `${safeName(path.basename(canonical))}-${createHash("sha1").update(canonical).digest("hex").slice(0, 12)}`;
}

function writeIfAbsent(file, content) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, "utf8");
}

function enableDir(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`${TAG} skip (dir not on disk, stale DB row?): ${dir}`);
    return { canonical: dir, root: null, changed: false };
  }
  const canonical = canonicalRoot(dir) ?? fs.realpathSync.native(dir);
  const display = safeName(path.basename(canonical));
  const folder = folderFor(canonical);
  const root = path.join(dataDir(), "memory", folder);
  const stateFile = path.join(root, "state.json");
  if (fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    console.log(`${TAG} skip (state exists, enabled=${st.enabled}): ${canonical} -> ${root}`);
    return { canonical, root, changed: false };
  }
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  writeIfAbsent(path.join(root, ".gitignore"), "*\n!.gitignore\n");
  writeIfAbsent(
    path.join(root, "manifest.json"),
    JSON.stringify({ kind: "kilo-memory", version: 1, display, canonical, folder, createdAt: new Date().toISOString() }, null, 2) + "\n"
  );
  writeIfAbsent(path.join(root, "project.md"), "# Project Memory\n\n## Facts\n\n## Decisions\n\n## Constraints\n\n## Open Questions\n");
  writeIfAbsent(path.join(root, "environment.md"), "# Environment Memory\n\n## Commands\n\n## Paths\n\n## Tooling\n");
  writeIfAbsent(path.join(root, "corrections.md"), "# Corrective Memory\n\n## Corrections\n");
  writeIfAbsent(path.join(root, "index.kmem"), "");
  fs.writeFileSync(stateFile, STATE_ENABLED, "utf8");
  console.log(`${TAG} enabled: ${canonical} -> ${root}`);
  return { canonical, root, changed: true };
}

function countRecords(root) {
  try {
    const md = fs.readFileSync(path.join(root, "project.md"), "utf8");
    return (md.match(/^- /gm) || []).length;
  } catch {
    return 0;
  }
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
      let enabled = "?";
      let canonical = "";
      try {
        enabled = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")).enabled;
      } catch {}
      try {
        canonical = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).canonical;
      } catch {}
      return { folder: d, enabled, records: countRecords(root), canonical };
    });
  console.table(rows);
}

// 定位 kilo.exe：优先 VS Code 扩展内嵌 CLI（版本随扩展走），退回 PATH
function findKiloBin() {
  const extBase = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const cands = fs
      .readdirSync(extBase)
      .filter((d) => /^kilocode\.kilo-code-/.test(d))
      .sort()
      .map((d) => path.join(extBase, d, "bin", "kilo.exe"));
    const exe = cands.filter((p) => fs.existsSync(p)).at(-1);
    if (exe) return exe;
  } catch {}
  return "kilo";
}

function dbProjects() {
  const bin = findKiloBin();
  const out = execFileSync(bin, ["db", "SELECT worktree FROM project"], { encoding: "utf8", timeout: 60000 });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^worktree$/i.test(l) && /^[A-Za-z]:[\\/]/.test(l));
}

const args = process.argv.slice(2);
if (args.length === 0) {
  status();
} else if (args.includes("--db")) {
  let dirs = [];
  try {
    dirs = [...new Set(dbProjects())];
  } catch (e) {
    console.error(`${TAG} kilo db unavailable (${String(e).split("\n")[0]}); pass dirs explicitly`);
    process.exit(1);
  }
  for (const d of dirs) enableDir(d);
} else {
  for (const d of args) enableDir(d);
}
