#!/usr/bin/env node
// db-maintain.sh 离线回归：全部在临时目录里跑，靠伪造的 kilo.exe 桩离线应答每条 SQL，
// 并用 XDG_DATA_HOME 把末段 storage-maintain 关进沙箱——绝不触碰真实 kilo.db 与数据目录。
// 用法：node scripts/test-db-maintain.mjs
// 覆盖：写者门禁降级（不中止）/ VACUUM 阈值门控 / --status 报告 / 参数校验 /
//       storage-maintain 调用的 MSYS 路径转换（cygpath -m，此前 MODULE_NOT_FOUND）/
//       真实 SQLite 金标准组（node:sqlite 真库，不用镜像 WHERE 的桩）
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DBMT = path.join(here, "..", "db-maintain.sh");

// Windows PATH 的 bash 常指向 WSL（未装发行版时只会打印乱码），优先解析 Git Bash；
// 与 scripts/kilo-maintenance.ps1 的 Resolve-Bash 同口径，KILO_BASH 可显式覆盖。
function resolveBash() {
  if (process.env.KILO_BASH) return process.env.KILO_BASH;
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
  }
  return "bash";
}
const BASH = resolveBash();

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL: ${name}${extra ? ` — ${extra}` : ""}`); }
};
const firstLine = (re, s) => (re.exec(s) || [""])[0];

// ── 隔离沙箱：临时数据目录 + 离线库副本 + kilo.exe 桩 ─────────────────
const sand = fs.mkdtempSync(path.join(os.tmpdir(), "dbmt-test-"));
const DATA = path.join(sand, "data");
const DB = path.join(sand, "kilo-copy.db");
const STUB = path.join(sand, "kilo-stub.sh");
const LOG = path.join(sand, "stub.log");
const ORPHAN = path.join(sand, "orphan.cnt");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(DB, "SQLite format 3\u0000" + "x".repeat(4096)); // 只要求存在：桩不真读

// 桩：按 SQL 签名应答；PRAGMA 数值由 STUB_PC/STUB_FC/STUB_AV 注入（空闲页占比/auto_vacuum 模式）；
// VACUUM/checkpoint/DELETE/incremental_vacuum 落 STUB_LOG，供断言「到底执行了什么」。
fs.writeFileSync(STUB, `#!/usr/bin/env bash
sql="$2"; log="\${STUB_LOG:-/dev/null}"
case "$sql" in
  *"PRAGMA page_count"*)       printf 'page_count\\n%s\\n' "\${STUB_PC:-1000}" ;;
  *"PRAGMA freelist_count"*)   printf 'freelist_count\\n%s\\n' "\${STUB_FC:-0}" ;;
  *"PRAGMA page_size"*)        printf 'page_size\\n4096\\n' ;;
  *"PRAGMA auto_vacuum"*)      printf 'auto_vacuum\\n%s\\n' "\${STUB_AV:-0}" ;;
  *"PRAGMA integrity_check"*)  printf 'integrity_check\\nok\\n' ;;
  *wal_checkpoint*)            echo checkpoint >>"$log"; echo ok ;;
  *VACUUM*)                    echo vacuum >>"$log"; echo ok ;;
  *incremental_vacuum*)        echo incremental >>"$log"; echo ok ;;
  *sqlite_master*)             printf 'c\\n1\\n' ;;
  *"COUNT(*) c FROM part WHERE"*)  ofile="\${ORPHAN_FILE:-/tmp/dbmt-orphan.cnt}"; printf 'c\\n%s\\n' "$(cat "$ofile" 2>/dev/null || echo "\${STUB_ORPHAN:-0}")" ;;
  *"COUNT(*) c FROM event"*)       printf 'c\\n%s\\n' "\${STUB_EVENT:-0}" ;;
  *"DELETE FROM part WHERE"*)      ofile="\${ORPHAN_FILE:-/tmp/dbmt-orphan.cnt}"; lim="$(printf '%s' "$sql" | sed -n 's/.*LIMIT \\([0-9][0-9]*\\).*/\\1/p')"; cur="$(cat "$ofile" 2>/dev/null || echo "\${STUB_ORPHAN:-0}")"; nxt=$(( cur > lim ? cur - lim : 0 )); printf '%s' "$nxt" >"$ofile"; echo "delete:part" >>"$log"; printf 'ok\\n' ;;
  *"COUNT(*) c FROM"*)         printf 'c\\n0\\n' ;;
  *"DELETE FROM"*)            tbl="$(printf '%s' "$sql" | awk '{print $3}')"; echo "delete:$tbl" >>"$log"; printf 'ok\\n' ;;
  *)                           printf 'ok\\n' ;;
esac
exit 0
`, "utf8");
fs.chmodSync(STUB, 0o755);

// sqlite3 桩：KSQLITE3 指向假 sqlite3（记录 SQL、按签名应答）——auto_vacuum 同连接转换路径
// 需要可编程应答，真 sqlite3 对假库文件只会报错，无法进测试。S3 未设置时脚本回落真
// sqlite3/缺失降级（2b 组用 KSQLITE3 显式注入）。
const S3STUB = path.join(sand, "sqlite3-stub.sh");
const S3LOG = path.join(sand, "s3.log");
fs.writeFileSync(S3STUB, `#!/usr/bin/env bash
sql="$2"; log="\${S3_LOG:-/dev/null}"
case "$sql" in
  *"PRAGMA auto_vacuum=2; VACUUM;"*)  echo s3convert >>"$log"; printf '2\\n' ;;
  *"PRAGMA auto_vacuum"*)             printf 'auto_vacuum\\n%s\\n' "\${S3_AV:-0}" ;;
  *)                                  echo "s3: $sql" >>"$log"; printf 'ok\\n' ;;
esac
exit 0
`, "utf8");
fs.chmodSync(S3STUB, 0o755);

const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : []);
const s3log = () => (fs.existsSync(S3LOG) ? fs.readFileSync(S3LOG, "utf8").trim().split("\n").filter(Boolean) : []);
function run(args, env = {}) {
  fs.rmSync(LOG, { force: true });
  fs.rmSync(S3LOG, { force: true });
  fs.rmSync(ORPHAN, { force: true });
  const r = spawnSync(BASH, [DBMT, ...args], {
    encoding: "utf8",
    cwd: sand,
    // KSQLITE3 缺省指向 sqlite3 桩（覆盖 command -v sqlite3 探测）；要模拟「sqlite3
    // 缺失/损坏」时给 KSQLITE3 传 ""（脚本按 `${KSQLITE3-...}` 无冒号展开取显式空串）。
    env: { ...process.env, KILO_DB: DB, KILO_EXE: STUB, KSQLITE3: S3STUB, STUB_LOG: LOG, S3_LOG: S3LOG, ORPHAN_FILE: ORPHAN, XDG_DATA_HOME: DATA, ...env },
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ── 1) 写者门禁：有 kilo 写者时【降级跳过 VACUUM】而非 exit 1 中止整个脚本 ──
// 背景（真实事故）：旧实现 exit 1，而 kilo.exe 常驻使 writers 恒 >0 —— DELETE 清理与
// WAL checkpoint 自 2026-09-27 起从未执行。本组断言的就是「清理必须照跑」。
{
  console.log("== 1) 写者门禁降级（不中止）==");
  const r = run(["--days", "30"]);
  t("退出码 0（旧行为 exit 1）", r.status === 0, `status=${r.status}`);
  t("明示跳过 VACUUM", /跳过 VACUUM|VACUUM 跳过/.test(r.out), firstLine(/VACUUM[^\n]*/, r.out));
  t("仍执行清理阶段", /== 清理（保留最近 30 天） ==/.test(r.out));
  t("DELETE 真的发出去了", log().some((l) => l.startsWith("delete")));
  t("仍执行 WAL checkpoint 与 integrity", log().includes("checkpoint") && /integrity:\s*ok/.test(r.out));
  t("未真的 VACUUM", !log().includes("vacuum"));
  const src = fs.readFileSync(DBMT, "utf8");
  const gate = src.slice(src.indexOf('if [ "$DO_VACUUM" = "1" ] && [ "$FORCE" != "1" ]'), src.indexOf("CUTOFF=$(node -e"));
  t("门禁段内无 exit 1（只置 SKIP_VACUUM=1）", /SKIP_VACUUM=1/.test(gate) && !/^\s*exit 1$/m.test(gate));
}

// ── 1b) event 并发写入：残留不判失败（2026-10-26）──
// 背景：event 是唯一持续写入的表，活跃使用时「删一批又来一批」是常态；旧实现返回非零
// 导致每日维护恒 exit 1、state.json 不更新。这里用 STUB_EVENT=1 恒定计数模拟并发写入。
{
  console.log("== 1b) event 并发写入不误判失败 ==");
  const r = run(["--days", "30", "--no-vacuum"], { STUB_EVENT: "1" });
  t("退出码 0（并发残留不计失败）", r.status === 0, `status=${r.status}\n${r.out.slice(-800)}`);
  t("输出并发残留提示", /event 有并发新写入/.test(r.out), firstLine(/event 有并发[^\n]*/, r.out));
  t("event_sequence 仍清空", log().includes("delete:event_sequence"));
}

// ── 2) VACUUM 阈值门控：空闲页占比 < VACUUM_MIN_PCT 时不白付独占锁 ──
{
  console.log("== 2) VACUUM 阈值门控 ==");
  const hi = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "0" });
  t("空闲 40% ≥ 25% → 真执行 VACUUM/同连接转换", log().includes("vacuum") || s3log().includes("s3convert"), firstLine(/VACUUM[^\n]*/, hi.out));
  t("并在输出里标注占比", /VACUUM（清理后空闲占比 40%/.test(hi.out));

  const lo = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "50", STUB_AV: "0" });
  t("空闲 40% < 50% → 跳过 VACUUM", !log().includes("vacuum") && /VACUUM 跳过（清理后空闲占比/.test(lo.out));

  const off = run(["--days", "30", "--force", "--no-vacuum"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "1", STUB_AV: "0" });
  t("--no-vacuum 显式关闭", !log().includes("vacuum"));
}

// ── 2b) auto_vacuum 同连接转换 + incremental_vacuum 闭环（2026-10-08 专项）──
// kilo db CLI 的 PRAGMA 写不持久化（每调用一条语句即独立连接，实测），转换必须走
// sqlite3 直连 `PRAGMA auto_vacuum=2; VACUUM;` 一次成型。
{
  console.log("== 2b) auto_vacuum 转换 + incremental_vacuum 闭环 ==");
  // 库当前 auto_vacuum=0 → sqlite3 multi-statement 同连接转换；不重复跑 kilo-CLI VACUUM
  const conv = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "0" });
  t("退出码 0", conv.status === 0, `status=${conv.status}`);
  t("走 sqlite3 同连接转换", s3log().includes("s3convert"), firstLine(/s3[^\n]*/, conv.out));
  t("输出宣告转换成功", /auto_vacuum=2 已转换/.test(conv.out));
  t("不再跑 kilo-CLI 旧 VACUUM（避免重复整库重写）", !log().includes("vacuum"), `log=${log().join(",")}`);

  // 库已是 auto_vacuum=2 → 直接 VACUUM，不再转换（S3_AV/STUB_AV 同置 2：
  // 库真实转换后两条连接看到的都是 2）
  const already = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "2", S3_AV: "2" });
  t("已转换库直接 VACUUM", log().includes("vacuum") && !s3log().includes("s3convert"), `stub=${log().join(",")} s3=${s3log().join(",")}`);
  t("已转换时不重复宣告转换", !/auto_vacuum=2 已转换/.test(already.out));

  // 全量 VACUUM 没跑（空闲占比低）+ 库已转换 + freelist ≥ --ivac → incremental_vacuum 兜底
  const iv = run(["--days", "30", "--ivac", "300"], { STUB_PC: "1000", STUB_FC: "399", VACUUM_MIN_PCT: "50", STUB_AV: "2" });
  t("低占比但已转换 → 走增量回收", log().includes("incremental"), firstLine(/incremental[^\n]*/, iv.out));
  t("增量回收输出 freelist 变化", /freelist \d+ -> \d+ 页/.test(iv.out), firstLine(/freelist[^\n]*/, iv.out));

  // freelist < --ivac → 不白付锁
  const small = run(["--days", "30", "--force", "--ivac", "1000"], { STUB_PC: "1000", STUB_FC: "399", VACUUM_MIN_PCT: "50", STUB_AV: "2" });
  t("freelist 低于阈值不做增量回收", !log().includes("incremental") && /收益小于风险/.test(small.out));

  // 模式仍为 0（sqlite3 缺失没转成）→ 不跑 incremental（它只在 incremental 模式下有效）
  const notConv = run(["--days", "30", "--force", "--ivac", "10"], { STUB_PC: "1000", STUB_FC: "399", VACUUM_MIN_PCT: "50", STUB_AV: "0" });
  t("auto_vacuum=0 时跳过增量回收", !log().includes("incremental") && /收益小于风险/.test(notConv.out));

  // sqlite3 缺失（KSQLITE3="" 显式覆盖）→ 旧 VACUUM 照跑 + 告警，绝不中断
  const noS3 = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "0", KSQLITE3: "" });
  t("sqlite3 缺失降级普通 VACUUM（清理照跑）", log().includes("vacuum") && noS3.status === 0, `status=${noS3.status}`);
  t("缺失时明示告警", /sqlite3 不可用/.test(noS3.out));

  // 转换失败（假 sqlite3 退出非零）→ 降级 kilo-CLI VACUUM，不中断
  const badS3STUB = path.join(sand, "sqlite3-bad.sh");
  fs.writeFileSync(badS3STUB, '#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n', "utf8");
  fs.chmodSync(badS3STUB, 0o755);
  const badS3 = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "0", KSQLITE3: badS3STUB });
  t("转换失败降级旧 VACUUM（不致命）", log().includes("vacuum") && badS3.status === 0, `status=${badS3.status} log=${log().join(",")}`);
  t("降级路径有告警", /auto_vacuum 转换失败/.test(badS3.out));
}

// ── 2c) 孤儿 part 回收（2026-10-26：kilo db CLI 连接不开外键，删 message 不级联 part，必须显式清）──
// 桩对 part 带 WHERE 的计数/删除做有状态应答（orphan.cnt 按 LIMIT 递减），真实镜像
// delete_batched 的收敛循环；不设 STUB_ORPHAN 时计 0，验证「无孤儿零开销」。
{
  console.log("== 2c) 孤儿 part 批量清理 ==");
  const r = run(["--days", "30", "--no-vacuum", "--batch-part", "2"], { STUB_ORPHAN: "5" });
  t("退出码 0", r.status === 0, `status=${r.status}`);
  t("清理段包含孤儿 part 步骤", /DELETE orphan parts \(batched 2\)/.test(r.out));
  const partDels = log().filter((l) => l === "delete:part").length;
  t("5 行按批 2 分 3 批删完", partDels === 3, `partDels=${partDels} log=${log().join(",")}`);
  t("批次收敛输出", /orphan part: 5 -> 3/.test(r.out) && /orphan part: 1 -> 0/.test(r.out));
  run(["--days", "30", "--no-vacuum"]);
  t("无孤儿时零 part DELETE 且照常退出", log().filter((l) => l === "delete:part").length === 0);
  t("--batch-part 0 拒绝", run(["--batch-part", "0"]).status === 2);
}

// ── 2d) 真实 SQLite 金标准组（2026-10-26）──────────────────────────────
// 桩只验证「脚本发了什么 SQL」，无法证明 SQL 在真库上的语义（复合主键/无 id 主键/
// NOT EXISTS 的 NULL 语义/删序）。本组在沙箱里生成真 CLI + 临时真库，让脚本实际执行。
const REAL_DB = path.join(sand, "real-kilo.db");
const REAL_FAIL_DB = path.join(sand, "real-kilo-fail.db");
const REAL_LOG = path.join(sand, "real-sql.log");
const REAL_FAIL_LOG = path.join(sand, "real-sql-fail.log");
const REAL_CLI = path.join(sand, "real-kilo.mjs");
const REAL_WRAPPER = path.join(sand, "real-kilo.sh");

// 真 CLI：只做 db <sql> → 真执行 → TSV 输出；SQL 落盘供批次/删序断言。
// REAL_DB 永远是临时文件，绝不读取真实 kilo.db。
fs.writeFileSync(REAL_CLI, `import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "db" || !args[1]) {
  console.error("real-kilo: expected: db <sql> --format tsv --pure");
  process.exit(2);
}
const sql = args[1];
fs.appendFileSync(process.env.REAL_SQL_LOG, sql + "\\n");
const db = new DatabaseSync(process.env.REAL_DB);
try {
  db.exec("PRAGMA foreign_keys=OFF");
  const stmt = db.prepare(sql);
  if (/^\\s*(SELECT|PRAGMA|WITH|EXPLAIN)\\b/i.test(sql)) {
    const rows = stmt.all();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    process.stdout.write(cols.join("\\t") + "\\n");
    for (const row of rows) {
      process.stdout.write(cols.map((c) => (row[c] === null ? "" : String(row[c]))).join("\\t") + "\\n");
    }
  } else {
    stmt.run();
    process.stdout.write("ok\\n");
  }
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exitCode = 1;
} finally {
  db.close();
}
`, "utf8");
fs.writeFileSync(REAL_WRAPPER, `#!/usr/bin/env bash
exec node --no-warnings "${REAL_CLI.replace(/\\/g, "/")}" "$@"
`, "utf8");
fs.chmodSync(REAL_WRAPPER, 0o755);

const NOW = Date.now();
const OLD = NOW - 100 * 86400000;
// 最小但覆盖全部目标表的 schema：FK 列故意 nullable（比生产更宽，覆盖 NULL 反例），
// 并声明 FK/CASCADE —— 真 CLI 每条连接都 PRAGMA foreign_keys=OFF，证明不会发生级联。
const seedSql = `
CREATE TABLE event (id INTEGER PRIMARY KEY);
CREATE TABLE event_sequence (id INTEGER PRIMARY KEY);
CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT);
CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  time_created INTEGER,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE part (
  id INTEGER PRIMARY KEY,
  message_id TEXT,
  session_id TEXT,
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE todo (
  session_id TEXT,
  position INTEGER,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE session_share (
  session_id TEXT PRIMARY KEY,
  id TEXT,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE session_context_epoch (
  session_id TEXT PRIMARY KEY,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE session_input (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE kilo_board (
  root_session_id TEXT PRIMARY KEY,
  FOREIGN KEY (root_session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE kilo_board_message (
  id TEXT PRIMARY KEY,
  board_root_session_id TEXT,
  sender_session_id TEXT,
  source_message_id TEXT,
  FOREIGN KEY (board_root_session_id) REFERENCES kilo_board(root_session_id) ON DELETE CASCADE
);

INSERT INTO event (id) VALUES (1), (2);
INSERT INTO event_sequence (id) VALUES (1), (2);
INSERT INTO credential (id, value) VALUES ('cred_live', 'secret');
INSERT INTO session (id, time_created) VALUES ('s_live', ${NOW}), ('s_old', ${OLD});

INSERT INTO message (id, session_id, time_created) VALUES
  ('m_live', 's_live', ${NOW}),
  ('m_old', 's_old', ${OLD});

INSERT INTO part (id, message_id, session_id) VALUES
  (1, 'm_live', 's_live'),
  (2, 'm_old', 's_old'),
  (3, 'm_gone', 's_live'),
  (4, 'm_live', 's_gone'),
  (5, NULL, 's_live'),
  (6, 'm_live', NULL);

INSERT INTO todo (session_id, position) VALUES ('s_live', 1), ('s_old', 1), ('s_gone', 1), (NULL, 9);
INSERT INTO session_share (session_id, id) VALUES ('s_live', 'share_live'), ('s_old', 'share_old'), ('s_gone', 'share_gone'), (NULL, 'share_null');
INSERT INTO session_context_epoch (session_id) VALUES ('s_live'), ('s_old'), ('s_gone'), (NULL);
INSERT INTO session_input (id, session_id) VALUES ('input_live', 's_live'), ('input_old', 's_old'), ('input_gone', 's_gone'), ('input_null', NULL);
INSERT INTO session_message (id, session_id) VALUES ('sm_live', 's_live'), ('sm_old', 's_old'), ('sm_gone', 's_gone'), ('sm_null', NULL);

INSERT INTO kilo_board (root_session_id) VALUES ('s_live'), ('s_old'), ('s_gone');
INSERT INTO kilo_board_message (id, board_root_session_id, sender_session_id, source_message_id) VALUES
  ('kbm_live', 's_live', NULL, 'm_live'),
  ('kbm_live_sender_gone', 's_live', 's_gone', 'm_live'),
  ('kbm_old_board', 's_old', 's_live', 'm_live'),
  ('kbm_gone_board', 's_gone', 's_live', 'm_live'),
  ('kbm_no_parent', 'b_nonexistent', 's_live', 'm_live');
`;

function seedRealDb(file) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(seedSql);
  } finally {
    db.close();
  }
}

function rowsOf(file, sql) {
  const db = new DatabaseSync(file);
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
const column = (file, sql, name) => rowsOf(file, sql).map((r) => r[name]);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sqlLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : []);

{
  console.log("== 2d) 真实 SQLite 金标准组 ==");
  seedRealDb(REAL_DB);
  fs.rmSync(REAL_LOG, { force: true });
  const realEnv = { KILO_DB: REAL_DB, KILO_EXE: REAL_WRAPPER, KSQLITE3: "", REAL_DB, REAL_SQL_LOG: REAL_LOG };
  const r = run(["--days", "30", "--no-vacuum", "--batch-part", "2"], realEnv);
  t("真实库：退出码 0", r.status === 0, `status=${r.status}\n${r.out.slice(-1200)}`);

  t("真实库：session 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM session", "id"), ["s_live"]),
    column(REAL_DB, "SELECT id FROM session", "id").join(","));
  t("真实库：message 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM message", "id"), ["m_live"]),
    column(REAL_DB, "SELECT id FROM message", "id").join(","));
  t("真实库：part 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM part", "id"), [1]),
    column(REAL_DB, "SELECT id FROM part", "id").join(","));
  const todoKeys = rowsOf(REAL_DB, "SELECT session_id, position FROM todo").map((x) => `${x.session_id}|${x.position}`);
  t("真实库：todo 仅剩有效项（复合主键 rowid 分批）", sameSet(todoKeys, ["s_live|1"]), todoKeys.join(","));
  t("真实库：session_share 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM session_share", "id"), ["share_live"]));
  t("真实库：session_context_epoch 仅剩有效项", sameSet(column(REAL_DB, "SELECT session_id FROM session_context_epoch", "session_id"), ["s_live"]));
  t("真实库：session_input 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM session_input", "id"), ["input_live"]));
  t("真实库：session_message 仅剩有效项", sameSet(column(REAL_DB, "SELECT id FROM session_message", "id"), ["sm_live"]));
  t("真实库：有效 board 保留、孤儿 board 删除", sameSet(column(REAL_DB, "SELECT root_session_id FROM kilo_board", "root_session_id"), ["s_live"]),
    column(REAL_DB, "SELECT root_session_id FROM kilo_board", "root_session_id").join(","));
  t("真实库：board 消息只按父 board+root session 判定（sender 缺失存活/孤儿父删除）",
    sameSet(column(REAL_DB, "SELECT id FROM kilo_board_message", "id"), ["kbm_live", "kbm_live_sender_gone"]),
    column(REAL_DB, "SELECT id FROM kilo_board_message", "id").join(","));
  t("真实库：credential 未动", sameSet(column(REAL_DB, "SELECT id FROM credential", "id"), ["cred_live"]));
  const count = (table) => Number(rowsOf(REAL_DB, `SELECT COUNT(*) c FROM ${table}`)[0].c);
  t("真实库：event/event_sequence 清空", count("event") === 0 && count("event_sequence") === 0,
    `event=${count("event")} seq=${count("event_sequence")}`);

  const realSqls = sqlLog(REAL_LOG);
  const partDels = realSqls.filter((l) => /^DELETE FROM part WHERE rowid IN\b/.test(l));
  t("真实库：5 个孤儿 part 按 --batch-part 2 恰好 3 批", partDels.length === 3, `partDels=${partDels.length}`);
  t("真实库：两遍孤儿 part 均收敛（message 缺失 3→1 / session 缺失 2→0）",
    /orphan part: 3 -> 1/.test(r.out) && /orphan part: 2 -> 0/.test(r.out));
  const iKbm = realSqls.findIndex((l) => /^DELETE FROM kilo_board_message WHERE /.test(l));
  const iBoard = realSqls.findIndex((l) => /^DELETE FROM kilo_board WHERE /.test(l));
  t("真实库：首个 kbm DELETE 在首个 board DELETE 前", iKbm >= 0 && iBoard > iKbm, `kbm=${iKbm} board=${iBoard}`);
}

{
  console.log("== 2e) 真实库 kbm 失败注入（跳过 board）==");
  seedRealDb(REAL_FAIL_DB);
  const db = new DatabaseSync(REAL_FAIL_DB);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("CREATE TRIGGER fail_kbm_delete BEFORE DELETE ON kilo_board_message BEGIN SELECT RAISE(ABORT, 'forced kbm failure'); END;");
  } finally {
    db.close();
  }
  fs.rmSync(REAL_FAIL_LOG, { force: true });
  const r = run(["--days", "30", "--no-vacuum", "--batch-part", "2"], {
    KILO_DB: REAL_FAIL_DB, KILO_EXE: REAL_WRAPPER, KSQLITE3: "", REAL_DB: REAL_FAIL_DB, REAL_SQL_LOG: REAL_FAIL_LOG,
  });
  t("失败注入：退出码 1", r.status === 1, `status=${r.status}\n${r.out.slice(-1200)}`);
  const failSqls = sqlLog(REAL_FAIL_LOG);
  t("失败注入：没有 DELETE FROM kilo_board（不误匹配 kilo_board_message）",
    !failSqls.some((l) => /^DELETE FROM kilo_board WHERE /.test(l)),
    failSqls.filter((l) => /kilo_board/.test(l)).slice(-3).join(" | "));
  t("失败注入：所有 board 仍保留",
    sameSet(column(REAL_FAIL_DB, "SELECT root_session_id FROM kilo_board", "root_session_id"), ["s_live", "s_old", "s_gone"]),
    column(REAL_FAIL_DB, "SELECT root_session_id FROM kilo_board", "root_session_id").join(","));
  t("失败注入：输出明确 skip 警告", /skip: kilo_board_message .*跳过 kilo_board/.test(r.out), firstLine(/skip:[^\n]*/, r.out));
  t("失败注入：独立清理继续（session/part 收敛）",
    sameSet(column(REAL_FAIL_DB, "SELECT id FROM session", "id"), ["s_live"]) &&
    sameSet(column(REAL_FAIL_DB, "SELECT id FROM part", "id"), [1]),
    `session=${column(REAL_FAIL_DB, "SELECT id FROM session", "id").join(",")} part=${column(REAL_FAIL_DB, "SELECT id FROM part", "id").join(",")}`);
}

// ── 3) --status：只读体检 + 空闲占比 + 维护建议 ──
{
  console.log("== 3) --status 体检 ==");
  const r = run(["--status"], { STUB_PC: "2000", STUB_FC: "1000" });
  t("退出码 0", r.status === 0);
  t("打印「空闲页 / 有效页（空闲占比 N%）」", /可回收:\s+[\d.]+ GB 空闲页 \/ [\d.]+ GB 有效页（空闲占比 50%）/.test(r.out),
    firstLine(/可回收[^\n]*/, r.out));
  t("不写库（无 DELETE / VACUUM）", log().length === 0);
  // 引导死锁自诊断（2026-10-08）：auto_vacuum≠2 + 空闲占比≥阈值 → 必须显式报「引导死锁」；
  // auto_vacuum=2（健康态）→ 绝不报警。防「库被 Kilo 更新重置回 0 后静默膨胀无人知」回归。
  // 告警置于 IS_LIVE 判断之外（只看 auto_vacuum + 空闲占比），故 stub 副本库也能触发。
  t("死锁态(auto_vacuum=0 + 空闲 50%)报「引导死锁」", /引导死锁/.test(r.out), firstLine(/引导死锁[^\n]*/, r.out));
  const healthy = run(["--status"], { STUB_PC: "2000", STUB_FC: "1000", STUB_AV: "2" });
  t("健康态(auto_vacuum=2)不误报死锁", !/引导死锁/.test(healthy.out) && /auto_vacuum: 2/.test(healthy.out), firstLine(/auto_vacuum[^\n]*/, healthy.out));
  // IS_LIVE=1 分支用沙箱 HOME 复现：默认路径命中即视为真实库。旧写法直接扫真实 kilo.db，
  // 20GB 库上 integrity_check 要数分钟（实测），测试不该每次都扫用户真实库。
  const liveHome = path.join(sand, "live-home");
  const liveDbDir = path.join(liveHome, ".local", "share", "kilo");
  fs.mkdirSync(liveDbDir, { recursive: true });
  fs.copyFileSync(DB, path.join(liveDbDir, "kilo.db"));
  const liveEnv = { ...process.env, HOME: liveHome, USERPROFILE: liveHome, KILO_EXE: STUB, KSQLITE3: S3STUB, STUB_LOG: LOG, STUB_PC: "2000", STUB_FC: "1000", STUB_AV: "0", XDG_DATA_HOME: DATA };
  delete liveEnv.KILO_DB;
  const live = spawnSync(BASH, [DBMT, "--status"], { encoding: "utf8", cwd: sand, env: liveEnv });
  t("默认路径(IS_LIVE)打印维护建议行（沙箱 HOME，不扫真实库）",
    /维护建议:/.test((live.stdout || "") + (live.stderr || "")), firstLine(/维护建议[^\n]*/, live.stdout || ""));
}

// ── 4) 参数校验：非法值必须在动手前被拒 ──
{
  console.log("== 4) 参数校验 ==");
  t("--days 0 → exit 2（0 会删光当日消息）", run(["--days", "0"]).status === 2);
  t("--batch 0 → exit 2（否则 DELETE…LIMIT 0 死循环）", run(["--batch", "0"]).status === 2);
  t("未知参数 → exit 2", run(["--nope"]).status === 2);
  // usage() 的 sed 区间锚点若改错，--help 会截断/为空（2026-10-08 五查修复过该锚点）
  const help = run(["--help"]);
  t("--help 列出 --ivac（usage 锚点回归）", help.status === 0 && /--ivac/.test(help.out), firstLine(/ivac[^\n]*/, help.out));
}

// ── 5) storage-maintain 的 MSYS 路径转换 ──
// 背景（真实事故）：原生 node 收到 /d/work/... 会解析成 D:\d\work\... → MODULE_NOT_FOUND，
// 回收步骤因此静默失败。断言正向可用 + 反向确实会炸。
{
  console.log("== 5) storage-maintain 路径转换 ==");
  const src = fs.readFileSync(DBMT, "utf8");
  t("源码经 cygpath -m 转换后调用", /STORAGE_SCRIPT="\$\(cygpath -m /.test(src) && /node "\$STORAGE_SCRIPT"/.test(src));
  const conv = spawnSync("cygpath", ["-m", path.join(here, "storage-maintain.mjs").replace(/\\/g, "/")], { encoding: "utf8" }).stdout.trim();
  t("cygpath -m 产出 D:/ 形式", /^[A-Z]:\//.test(conv), conv);
  const good = spawnSync("node", [conv, "--status", "--data-dir", DATA], { encoding: "utf8" });
  t("转换后的路径真能跑（非 MODULE_NOT_FOUND）", good.status === 0 && !/MODULE_NOT_FOUND/.test(good.stderr || ""),
    `status=${good.status}`);
  const bad = spawnSync("node", ["/d/work/kilo-runtime/scripts/storage-maintain.mjs", "--status"], { encoding: "utf8" });
  t("（反证）未转换的 /d/... 确实 MODULE_NOT_FOUND", /MODULE_NOT_FOUND|Cannot find module/.test(bad.stderr || ""));
}

fs.rmSync(sand, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILED:\n" + failed.map((f) => "  " + f).join("\n")); }
process.exit(fail ? 1 : 0);
