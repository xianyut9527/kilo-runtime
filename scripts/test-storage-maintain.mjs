#!/usr/bin/env node
// storage-maintain 离线回归:fixture 临时目录,不碰真实数据目录、不联网。
// 用法:node scripts/test-storage-maintain.mjs
// 覆盖:dry-run 不动盘 / --run 删超期保留新窗 / 报告-only 项 --run 后仍存在 /
// --keep-snapshots 跳过 / 空子目录回收 / 非法参数退出码 / symlink 跳过(能力允许时)。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "storage-maintain.mjs");
const DAY = 86400_000;

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  let ok = false;
  try { ok = typeof cond === "function" ? !!cond() : !!cond; }
  catch (e) { failed.push(`${name}（抛错：${String(e?.message ?? e).slice(0, 120)}）`); console.error(`  FAIL(throw): ${name}\n    ${String(e?.message ?? e).split("\n")[0]}`); fail++; return; }
  if (ok) { pass++; console.log(`  ok: ${name}`); }
  else { failed.push(name); console.error(`  FAIL: ${name}`); fail++; }
};

const run = (args, dataDir) => {
  // timeout:被测脚本卡死/等待输入时终止测试,防永久阻塞(层3 审查必修项)
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--data-dir", dataDir, "--json"],
    { encoding: "utf8", timeout: 30_000 });
  if (r.signal === "SIGTERM") throw new Error(`被测脚本超时被终止: ${args.join(" ")}`);
  // 子进程崩溃/被杀时 status 为 null:显式抛错,防后续断言拿 null 比对出误导性失败
  if (r.status === null) throw new Error(`被测进程异常终止: ${args.join(" ")} stderr=${(r.stderr || "").slice(0, 200)}`);
  let json = null;
  if (r.stdout) {
    const jsonLine = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (jsonLine) { try { json = JSON.parse(jsonLine); } catch { throw new Error(`--json 汇总行解析失败: ${jsonLine.slice(0, 160)}`); } }
  }
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", json };
};

// ── fixture 构造 ────────────────────────────────────────────
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sm-test-${process.pid}-`));
  const old = new Date(Date.now() - 40 * DAY);
  const fresh = new Date();
  const mk = (rel, size, when) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, "x"));
    fs.utimesSync(p, when, when);
    return p;
  };
  // 删除目标:session_diff / log / tsc-cache / snapshot(嵌套子目录)
  mk(path.join("storage", "session_diff", "ses_old.json"), 1000, old);
  mk(path.join("storage", "session_diff", "ses_new.json"), 500, fresh);
  mk(path.join("log", "kilo.log.old"), 2000, old);
  mk(path.join("log", "kilo.log"), 300, fresh);
  mk(path.join("tsc-cache", "deadbeef01.tsbuildinfo"), 1500, old);
  mk(path.join("tsc-cache", "cafe02.tsbuildinfo"), 200, fresh);
  // snapshot:目录级回收目标 —— 顶层目录含 objects/ 或 .git 且「目录自身 mtime」超期
  mk(path.join("snapshot", "deadbeef", "objects", "aa", "old.bin"), 4000, old);
  mk(path.join("snapshot", "deadbeef", "objects", "bb", "old2.bin"), 1000, old);
  fs.utimesSync(path.join(root, "snapshot", "deadbeef"), old, old); // 目录 mtime 超期
  mk(path.join("snapshot", "cafebabe", "objects", "cc", "new.bin"), 600, fresh);
  // 报告-only:kilo.db / memory / session-export.db(必须存活)
  mk("kilo.db", 3000, old);
  mk(path.join("memory", "proj-abc", "project.md"), 100, old);
  mk("session-export.db", 900, old);
  mk("failover-events.jsonl", 700, old);
  // tool-output 看门狗目标(小阈值测试用 --bigfile-bytes 控制)
  mk(path.join("tool-output", "tool_runaway001"), 5000, new Date(Date.now() - 2 * 3600_000)); // 失控+闲置
  mk(path.join("tool-output", "tool_active001"), 5000, fresh); // 大小够但活跃(1h 内)→保留
  mk(path.join("tool-output", "tool_small001"), 200, old); // 闲置但小→保留
  return root;
}

// ── 1) dry-run:只报告不动盘 ────────────────────────────────
{
  console.log("== 1) --status dry-run 不动盘 ==");
  const root = fixture();
  const before = fs.readdirSync(path.join(root, "storage", "session_diff"));
  const r = run(["--status", "--days", "30"], root);
  t("退出码 0", r.status === 0);
  t("json 解析", r.json != null);
  t("预览字节数 = 文件级超期之和(1000+2000+1500) + snapshot 整目录(4000+1000)", r.json?.plannedBytes === 9500);
  t("dry-run deleted=0", r.json?.deleted === 0);
  t("session_diff 文件未动", fs.readdirSync(path.join(root, "storage", "session_diff")).length === before.length);
  t("旧文件仍在", fs.existsSync(path.join(root, "storage", "session_diff", "ses_old.json")));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2) --run:删超期、留新窗、报告-only 存活、空目录回收 ────
{
  console.log("== 2) --run 删超期保留新窗 ==");
  const root = fixture();
  const r = run(["--run", "--days", "30"], root);
  t("退出码 0", r.status === 0);
  t("删除 4 项(3 文件 + 1 个 snapshot 目录)", r.json?.deleted === 4);
  t("释放字节 = 9500", r.json?.deletedBytes === 9500);
  t("旧 session_diff 已删", !fs.existsSync(path.join(root, "storage", "session_diff", "ses_old.json")));
  t("新 session_diff 保留", fs.existsSync(path.join(root, "storage", "session_diff", "ses_new.json")));
  t("旧 log 已删", !fs.existsSync(path.join(root, "log", "kilo.log.old")));
  t("新 log 保留", fs.existsSync(path.join(root, "log", "kilo.log")));
  t("旧 tsbuildinfo 已删(闲置项目缓存回收)", !fs.existsSync(path.join(root, "tsc-cache", "deadbeef01.tsbuildinfo")));
  t("新 tsbuildinfo 保留", fs.existsSync(path.join(root, "tsc-cache", "cafe02.tsbuildinfo")));
  t("超期 snapshot 目录整份已删", !fs.existsSync(path.join(root, "snapshot", "deadbeef")));
  t("窗口内 snapshot 目录保留", fs.existsSync(path.join(root, "snapshot", "cafebabe", "objects", "cc", "new.bin")));
  t("kilo.db 存活(报告-only)", fs.existsSync(path.join(root, "kilo.db")));
  t("memory 存活(报告-only)", fs.existsSync(path.join(root, "memory", "proj-abc", "project.md")));
  t("session-export.db 存活(报告-only)", fs.existsSync(path.join(root, "session-export.db")));
  t("failover-events.jsonl 存活(报告-only)", fs.existsSync(path.join(root, "failover-events.jsonl")));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 3) --keep-snapshots:snapshot 整体跳过 ───────────────────
{
  console.log("== 3) --keep-snapshots 跳过 snapshot ==");
  const root = fixture();
  const r = run(["--run", "--days", "30", "--keep-snapshots"], root);
  t("退出码 0", r.status === 0);
  t("只删 3 项(session_diff+log+tsc-cache)", r.json?.deleted === 3);
  t("snapshot 旧目录保留(--keep-snapshots)", fs.existsSync(path.join(root, "snapshot", "deadbeef")));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 4) 非法参数 ─────────────────────────────────────────────
{
  console.log("== 4) 非法参数退出码 ==");
  const root = fixture();
  t("--days 0 → exit 1", run(["--run", "--days", "0"], root).status === 1);
  t("未知参数 → exit 1", run(["--frobnicate"], root).status === 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 5) symlink:跳过不跟随(Windows 建链失败则本组整体跳过)───
{
  console.log("== 5) symlink 防逃逸 ==");
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `sm-out-${process.pid}-`));
  fs.writeFileSync(path.join(outside, "victim.txt"), "outside");
  let linked = true;
  try { fs.symlinkSync(outside, path.join(root, "log", "escape-link"), "dir"); }
  catch { linked = false; console.log("  (symlink 创建不可用(权限),本组跳过)"); }
  if (linked) {
    const r = run(["--run", "--days", "30"], root);
    t("退出码 0(链接只是跳过,不算错)", r.status === 0);
    t("链接未删(不跟随)", fs.existsSync(path.join(root, "log", "escape-link")));
    t("链接目标内容未被波及", fs.existsSync(path.join(outside, "victim.txt")));
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

// ── 6) tool-output 失控看门狗:双条件删除 + 禁用 + 审计日志 ──
{
  console.log("== 6) tool-output 失控大文件看门狗 ==");
  const root = fixture();
  const run2 = (args) => run(args, root);
  // 6a) dry-run:命中清单但不动盘
  const rd = run2(["--status", "--days", "30", "--bigfile-bytes", "1024"]);
  t("dry-run 退出码 0", rd.status === 0);
  t("dry-run plannedBytes 含失控大文件(9500+5000)", rd.json?.plannedBytes === 14500);
  t("dry-run bigfileDeleted=0", rd.json?.bigfileDeleted === 0);
  t("失控文件未动", fs.existsSync(path.join(root, "tool-output", "tool_runaway001")));
  // 6b) --run:删失控+闲置,保留活跃与小文件;写审计日志
  const rr = run2(["--run", "--days", "30", "--bigfile-bytes", "1024"]);
  t("run 退出码 0", rr.status === 0);
  t("失控+闲置大文件已删", !fs.existsSync(path.join(root, "tool-output", "tool_runaway001")));
  t("活跃大文件保留(1h 宽限)", fs.existsSync(path.join(root, "tool-output", "tool_active001")));
  t("小文件保留(阈值未命中)", fs.existsSync(path.join(root, "tool-output", "tool_small001")));
  t("bigfileDeleted=1", rr.json?.bigfileDeleted === 1);
  t("bigfileBytes=5000", rr.json?.bigfileBytes === 5000);
  t("总删除=5(时间窗4+看门狗1)", rr.json?.deleted === 5);
  const audit = fs.readFileSync(path.join(root, "storage-maintain-audit.log"), "utf8");
  t("审计日志含被删文件名与大小", audit.includes("tool_runaway001") && audit.includes("5000B"));
  // 6c) --bigfile-bytes 0 禁用看门狗
  const r0root = fixture();
  const r0 = run(["--run", "--days", "30", "--bigfile-bytes", "0"], r0root);
  t("禁用后失控文件保留", fs.existsSync(path.join(r0root, "tool-output", "tool_runaway001")));
  t("禁用后 bigfileDeleted=0", r0?.json?.bigfileDeleted === 0);
  // 6d) 非法阈值
  t("--bigfile-bytes -1 → exit 1", run2(["--run", "--bigfile-bytes", "-1"]).status === 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(r0root, { recursive: true, force: true });
}

// ── 7) 危险 --data-dir 拒绝(盘根/主目录/临时目录本身)────────
{
  console.log("== 7) --data-dir 危险路径防护 ==");
  const dangerous = [path.parse(process.cwd()).root, os.homedir(), os.tmpdir()];
  for (const d of dangerous)
    t(`拒绝 ${d}`, run(["--status"], d).status === 1);
  const ok = run(["--status"], path.join(os.tmpdir(), `sm-ok-${process.pid}-fixture`));
  t("fixture 子目录正常放行(不存在=退出 0)", ok.status === 0);
}

// ── 汇总 ───────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed${fail ? "\nFAILED:\n  " + failed.join("\n  ") : ""}`);
process.exit(fail ? 1 : 0);