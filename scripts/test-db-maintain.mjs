#!/usr/bin/env node
// db-maintain.sh 离线回归：全部在临时目录里跑，靠伪造的 kilo.exe 桩离线应答每条 SQL，
// 并用 XDG_DATA_HOME 把末段 storage-maintain 关进沙箱——绝不触碰真实 kilo.db 与数据目录。
// 用法：node scripts/test-db-maintain.mjs
// 覆盖：写者门禁降级（不中止）/ VACUUM 阈值门控 / --status 报告 / 参数校验 /
//       storage-maintain 调用的 MSYS 路径转换（cygpath -m，此前 MODULE_NOT_FOUND）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DBMT = path.join(here, "..", "db-maintain.sh");

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
  *"COUNT(*) c FROM"*)         printf 'c\\n0\\n' ;;
  *"DELETE FROM"*)             echo "delete" >>"$log"; printf 'ok\\n' ;;
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
  const r = spawnSync("bash", [DBMT, ...args], {
    encoding: "utf8",
    cwd: sand,
    // KSQLITE3 缺省指向 sqlite3 桩（覆盖 command -v sqlite3 探测）；要模拟「sqlite3
    // 缺失/损坏」时给 KSQLITE3 传 ""（脚本按 `${KSQLITE3-...}` 无冒号展开取显式空串）。
    env: { ...process.env, KILO_DB: DB, KILO_EXE: STUB, KSQLITE3: S3STUB, STUB_LOG: LOG, S3_LOG: S3LOG, XDG_DATA_HOME: DATA, ...env },
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
  t("DELETE 真的发出去了", log().includes("delete"));
  t("仍执行 WAL checkpoint 与 integrity", log().includes("checkpoint") && /integrity:\s*ok/.test(r.out));
  t("未真的 VACUUM", !log().includes("vacuum"));
  const src = fs.readFileSync(DBMT, "utf8");
  const gate = src.slice(src.indexOf('if [ "$DO_VACUUM" = "1" ] && [ "$FORCE" != "1" ]'), src.indexOf("CUTOFF=$(node -e"));
  t("门禁段内无 exit 1（只置 SKIP_VACUUM=1）", /SKIP_VACUUM=1/.test(gate) && !/^\s*exit 1$/m.test(gate));
}

// ── 2) VACUUM 阈值门控：空闲页占比 < VACUUM_MIN_PCT 时不白付独占锁 ──
{
  console.log("== 2) VACUUM 阈值门控 ==");
  const hi = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "25", STUB_AV: "0" });
  t("空闲 40% ≥ 25% → 真执行 VACUUM/同连接转换", log().includes("vacuum") || s3log().includes("s3convert"), firstLine(/VACUUM[^\n]*/, hi.out));
  t("并在输出里标注占比", /VACUUM（空闲占比 40%/.test(hi.out));

  const lo = run(["--days", "30", "--force"], { STUB_PC: "1000", STUB_FC: "400", VACUUM_MIN_PCT: "50", STUB_AV: "0" });
  t("空闲 40% < 50% → 跳过 VACUUM", !log().includes("vacuum") && /VACUUM 跳过（空闲占比/.test(lo.out));

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
  const live = spawnSync("bash", [DBMT, "--status"], { encoding: "utf8", cwd: sand });
  t("真实库路径打印维护建议行（--status 只读，安全）",
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
