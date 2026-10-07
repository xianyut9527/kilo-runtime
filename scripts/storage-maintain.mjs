#!/usr/bin/env node
// Kilo 数据目录维护(storage-maintain)——事件流水之外的增长项回收者
// ============================================================
// 背景(2026-10-07 全面体检):kilo.db 由 db-maintain.sh 负责;cleanup.sh 只管
// TEMP 与配置备份;DATA_DIR 下的 session_diff / log / snapshot 三处自 Kilo
// 自带 check-kilo-storage(旧仓库名路径)丢失后无人回收——session_diff 数千
// 个 ses_*.json 持续累积。本脚本按 mtime 保留窗回收这三处,其余只报告不碰。
//
// 用法:
//   node storage-maintain.mjs --status          默认:dry-run 报告(不删任何东西)
//   node storage-maintain.mjs --run --days 30    执行:删 30 天前的目标文件
//   node storage-maintain.mjs --run --keep-snapshots   跳过 snapshot 目录
//   node storage-maintain.mjs --data-dir DIR     测试/特殊部署:覆盖数据目录
//   node storage-maintain.mjs --json             末尾追加机器可读汇总行(测试用)
//   node storage-maintain.mjs --bigfile-bytes N  tool-output 失控看门狗阈值(默认 268435456=256MB,0=禁用)
//   node storage-maintain.mjs --bigfile-idle-min N  看门狗闲置宽限(默认 60 分钟,活跃写入中的文件跳过)
//
// 删除目标(仅 mtime 超期,删除前列全清单+字节):
//   storage/session_diff/**  log/**  snapshot/**(可选)
//   tsc-cache/**(quality-gate 的 .tsbuildinfo 增量缓存,每项目一个、可数十 MB;
//   超期删除只损失一次增量暖机,下次全量自愈——2026-10-07 再体检补上的增长项)
//   tool-output/tool_* 失控大文件(>阈值 且 闲置>宽限;缓存性质,正被写入的文件跳过不删)
// 报告-only(绝不删):
//   kilo.db*(db-maintain.sh 负责)/ tool-output(Kilo 内置 7 天自管)/
//   storage/repos(Kilo 自管)/ memory(记忆根)/ auth.json / telemetry-id /
//   account.json / failover-events.jsonl(自身 5MB 轮换)/
//   session-export.db*(遗留导出,提示人工确认后处理)
//
// 安全边界:
//   - 只在 DATA_DIR 内固定子目录操作;--data-dir 覆盖仅供测试(fixture 隔离)
//   - symlink 一律跳过不跟随(防 reparse point 逃逸——2026-10-04 worktree 事故教训)
//   - dry-run 默认;--run 才动盘;删除失败不中断,末尾汇总失败数
//
// 退出码:0 正常(含无事可做)/ 1 参数或目录不可读错误 / 2 删除存在失败(部分成功)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── 参数解析 ────────────────────────────────────────────────
const args = process.argv.slice(2);
let MODE = "status"; // status | run
let DAYS = 30;
let KEEP_SNAPSHOTS = false;
let JSON_OUT = false;
let DATA_DIR_OVERRIDE = null;
let BIGFILE_BYTES = 256 * 1024 * 1024; // 失控看门狗阈值:256MB(2026-10-03 实测事故=1.35GB,正常输出远低于此)
let BIGFILE_IDLE_MIN = 60; // 闲置宽限:mtime 近 60 分钟视为可能正被写入,跳过
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--run") MODE = "run";
  else if (a === "--status") MODE = "status";
  else if (a === "--days") {
    const v = Number(args[++i]);
    if (!Number.isInteger(v) || v < 1) { console.error("[FAIL] --days 需要正整数"); process.exit(1); }
    DAYS = v;
  }
  else if (a === "--keep-snapshots") KEEP_SNAPSHOTS = true;
  else if (a === "--json") JSON_OUT = true;
  else if (a === "--bigfile-bytes") {
    const v = Number(args[++i]);
    if (!Number.isInteger(v) || v < 0) { console.error("[FAIL] --bigfile-bytes 需要 ≥0 整数(0=禁用)"); process.exit(1); }
    BIGFILE_BYTES = v;
  }
  else if (a === "--bigfile-idle-min") {
    const v = Number(args[++i]);
    if (!Number.isInteger(v) || v < 0) { console.error("[FAIL] --bigfile-idle-min 需要 ≥0 整数"); process.exit(1); }
    BIGFILE_IDLE_MIN = v;
  }
  else if (a === "--data-dir") {
    const v = args[++i];
    if (!v) { console.error("[FAIL] --data-dir 需要路径"); process.exit(1); }
    DATA_DIR_OVERRIDE = v;
  }
  else { console.error(`[FAIL] 未知参数 ${a}(支持 --status/--run/--days/--keep-snapshots/--data-dir/--json/--bigfile-bytes/--bigfile-idle-min)`); process.exit(1); }
}

// DATA_DIR 口径与 lib/hx-client.ts 同源:XDG_DATA_HOME 优先,否则 ~/.local/share/kilo。
// (维护脚本不做 tmpdir 三级降级——tmpdir 下没有维护价值,宁缺勿错。)
const DATA_DIR = path.resolve(
  DATA_DIR_OVERRIDE || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share", "kilo")
);

// 误用防护(2026-10-07 层3 审查必修):--data-dir 指向盘符根/用户主目录/系统临时目录
// 本身时,固定子目录(storage/session_diff、log、tsc-cache...)会组合出越权系统路径。
// 解析后等于这三类危险路径一律拒绝(exit 1);正常值(默认目录/测试 fixture 子目录)不受影响。
{
  const dangerous = new Set([
    path.parse(DATA_DIR).root,                 // 盘符根: C:\ / /
    path.resolve(os.homedir()),                // 用户主目录本身
    path.resolve(os.tmpdir()),                 // 系统临时目录本身
  ]);
  if (dangerous.has(DATA_DIR)) {
    console.error(`[FAIL] --data-dir/XDG_DATA_HOME 拒绝危险路径: ${DATA_DIR}(盘符根/主目录/临时目录会越权删固定子目录)`);
    process.exit(1);
  }
}

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const KB = (n) => `${Math.round(n / 1024)} KB`;

// 删除目标:固定子目录(体检实证的增长项);目录不存在 = 无事可做,不算错误。
const TARGETS = [
  { rel: path.join("storage", "session_diff"), optional: false },
  { rel: "log", optional: false },
  { rel: "tsc-cache", optional: false }, // quality-gate tsbuildinfo:闲置项目的增量缓存就是垃圾
  { rel: "snapshot", optional: true }, // 可被 --keep-snapshots 跳过
];

// 报告-only 清单:固定名 → 提示语(绝不删除,只算体量给人看)
const REPORT_ONLY = [
  { rel: "kilo.db", note: "db-maintain.sh 负责(事件/过期会话瘦身)" },
  { rel: "kilo.db-wal", note: "db-maintain.sh 负责" },
  { rel: "kilo.db-shm", note: "db-maintain.sh 负责" },
  { rel: "tool-output", note: "Kilo 内置 7 天自管,不代管" },
  { rel: path.join("storage", "repos"), note: "Kilo 自管,不代管" },
  { rel: "memory", note: "记忆根,不代管" },
  { rel: "auth.json", note: "凭证,不碰" },
  { rel: "telemetry-id", note: "标识,不碰" },
  { rel: "account.json", note: "账号,不碰" },
  { rel: "failover-events.jsonl", note: "自身 5MB 轮换,不代管" },
  { rel: "session-export.db", note: "遗留导出?人工确认陈旧后移除" },
  { rel: "session-export.db-wal", note: "遗留导出?人工确认陈旧后移除" },
  { rel: "session-export.db-shm", note: "遗留导出?人工确认陈旧后移除" },
];

console.log(`== storage-maintain start  mode=${MODE} days=${DAYS} data=${DATA_DIR} ==`);
if (!fs.existsSync(DATA_DIR)) {
  console.log("[OK] 数据目录不存在,无事可做");
  if (JSON_OUT) console.log(JSON.stringify({ mode: MODE, days: DAYS, plannedBytes: 0, deleted: 0, deleteFailed: 0 }));
  process.exit(0);
}

// ── 遍历与体量 ─────────────────────────────────────────────
// 递归收集目标树内普通文件(lstat:绝不跟随 symlink,防 reparse point 逃逸)。
function walk(dir, out) {
  let names;
  try { names = fs.readdirSync(dir); } catch { out.unreadable++; return; }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { out.unreadable++; continue; }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.files.push({ p, mtimeMs: st.mtimeMs, size: st.size });
    else out.links++; // symlink/socket 等特殊文件一律跳过
  }
}

function tree(dir) {
  const out = { files: [], links: 0, unreadable: 0 };
  if (fs.existsSync(dir)) walk(dir, out);
  return out;
}

const bytesOf = (t) => t.files.reduce((a, f) => a + f.size, 0);

// ── 失控大文件看门狗(tool-output)────────────────────────────
// 背景(2026-10-03 事故):`node -e` 死循环可把单条工具输出灌到 1.35GB;Kilo 内置
// hourly 清理只删 7 天外文件,对「正在膨胀的活跃文件」无防线。看门狗按
// 「大小>阈值 且 mtime 闲置>宽限」双条件删(缓存性质,删了只丢历史输出);
// 正被写入的文件 mtime 持续更新,天然落在宽限期内被跳过。删除写审计日志。
function bigfileWatch() {
  const dir = path.join(DATA_DIR, "tool-output");
  if (BIGFILE_BYTES === 0) { console.log("[KEEP] tool-output 看门狗禁用(--bigfile-bytes 0)"); return; }
  if (!fs.existsSync(dir)) { console.log("[OK] tool-output 不存在(跳过)"); return; }
  const tr = tree(dir);
  const idleMs = BIGFILE_IDLE_MIN * 60_000;
  const big = tr.files.filter((f) => f.size > BIGFILE_BYTES && (Date.now() - f.mtimeMs) > idleMs);
  console.log(`== tool-output 看门狗(阈值 ${MB(BIGFILE_BYTES)},闲置宽限 ${BIGFILE_IDLE_MIN}min):` +
    `命中 ${big.length} 文件 / ${MB(big.reduce((a, f) => a + f.size, 0))} ==`);
  for (const f of big) {
    const rel = path.relative(DATA_DIR, f.p);
    const audit = `${new Date().toISOString()} ${rel} ${f.size}B mtime=${new Date(f.mtimeMs).toISOString()}`;
    if (DRY) console.log(`[DRY] 删除失控大文件 ${rel}  ${MB(f.size)}`);
    else {
      try {
        fs.rmSync(f.p);
        console.log(`[DEL] 失控大文件 ${rel}  ${MB(f.size)}`);
        deleted++; deletedBytes += f.size;
        bigfileDeleted++; bigfileBytes += f.size;
        // 审计日志:误删可追溯(追加,失败不阻断)
        try { fs.appendFileSync(path.join(DATA_DIR, "storage-maintain-audit.log"), audit + "\n"); } catch {}
      } catch (e) {
        // Windows 被占用(EPERM/EBUSY)降级为告警跳过,不中断流程
        deleteFailed++; failures.push(`${rel}: ${e.message}`);
        console.error(`[WARN] 失控大文件删除失败(可能被占用,跳过) ${rel}: ${e.message}`);
      }
    }
  }
  plannedBytes += big.reduce((a, f) => a + f.size, 0);
  if (big.length === 0) console.log("  无失控文件");
}

// ── 删除阶段(递归目标内超期文件;随后自底向上清空目录)──────
const CUTOFF = Date.now() - DAYS * 86400_000;
const DRY = MODE !== "run";
let plannedBytes = 0, deleted = 0, deletedBytes = 0, deleteFailed = 0;
let bigfileDeleted = 0, bigfileBytes = 0;
const failures = [];

// 只清理「删除后变空」的目录,且不得越过目标根;根目录本身保留
function rmdirIfEmptyBottomUp(dir, root) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) rmdirIfEmptyBottomUp(p, root);
  }
  if (dir === root) return;
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 空目录清理失败不追责 */ }
}

function pruneTarget(t) {
  const dir = path.join(DATA_DIR, t.rel);
  if (t.optional && KEEP_SNAPSHOTS) { console.log(`[KEEP] ${t.rel}(--keep-snapshots 跳过)`); return; }
  if (!fs.existsSync(dir)) { console.log(`[OK] ${t.rel} 不存在(跳过)`); return; }
  const tr = tree(dir);
  const stale = tr.files.filter((f) => f.mtimeMs < CUTOFF);
  const fresh = tr.files.length - stale.length;
  const staleBytes = stale.reduce((a, f) => a + f.size, 0);
  console.log(`== ${t.rel}: 共 ${tr.files.length} 文件 / ${MB(bytesOf(tr))},超 ${DAYS} 天 ${stale.length} 文件 / ${MB(staleBytes)}` +
    `${tr.links ? `,跳过 symlink/特殊文件 ${tr.links}` : ""}${tr.unreadable ? `,不可读 ${tr.unreadable}` : ""} ==`);
  for (const f of stale) {
    const rel = path.relative(DATA_DIR, f.p);
    if (DRY) console.log(`[DRY] 删除 ${rel}  ${KB(f.size)}`);
    else {
      try { fs.rmSync(f.p); console.log(`[DEL] ${rel}  ${KB(f.size)}`); deleted++; deletedBytes += f.size; }
      catch (e) { deleteFailed++; failures.push(`${rel}: ${e.message}`); console.error(`[FAIL] 删除失败 ${rel}: ${e.message}`); }
    }
  }
  plannedBytes += staleBytes;
  if (fresh > 0) console.log(`[KEEP] 保留窗口内 ${fresh} 文件`);
  if (!DRY && stale.length > 0) rmdirIfEmptyBottomUp(dir, dir);
}

console.log("");
console.log(`== 删除目标(保留 ${DAYS} 天)==`);
for (const t of TARGETS) pruneTarget(t);
bigfileWatch();

// ── 报告-only(体量盘点,绝不删)─────────────────────────────
console.log("");
console.log("== 报告-only(以下不删,仅供体量盘点)==");
for (const r of REPORT_ONLY) {
  const p = path.join(DATA_DIR, r.rel);
  if (!fs.existsSync(p)) continue;
  let st;
  try { st = fs.lstatSync(p); } catch { continue; }
  if (st.isFile()) console.log(`[RPT] ${KB(st.size)}  ${r.rel}  (${r.note})`);
  else if (st.isDirectory()) { const tr = tree(p); console.log(`[RPT] ${KB(bytesOf(tr))}  ${r.rel}/ (${tr.files.length} 文件)  (${r.note})`); }
}

// ── 汇总 ──────────────────────────────────────────────────
console.log("");
if (DRY) console.log(`== 预览:可删除 ${KB(plannedBytes)} ==(加 --run 实际执行)`);
else console.log(`== 完成:删除 ${deleted} 项,释放约 ${KB(deletedBytes)}${deleteFailed ? `,失败 ${deleteFailed} 项` : ""} ==`);
if (JSON_OUT) console.log(JSON.stringify({ mode: MODE, days: DAYS, plannedBytes, deleted, deletedBytes, deleteFailed, bigfileDeleted, bigfileBytes }));
process.exit(deleteFailed > 0 ? 2 : 0);