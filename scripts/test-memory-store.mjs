#!/usr/bin/env node
// memory-store 离线回归（2026-10-11 记忆核心闭环改造）:
// 不联网、不起 Kilo、不碰真实配置目录/真实 DATA_DIR（esbuild bundle 模式同 test-memory-bootstrap.mjs）。
// 用法:node scripts/test-memory-store.mjs
// 覆盖:①parseLessonLines 全变体/CRLF/围栏跳过 ②jaccard/去重强化 ③评分序 ④编译预算
//       ⑤trial/archived 生命周期 ⑥exploreState 同日确定性 ⑦applyUsage 聚合
//       ⑧saveStoreAtomic 原子性+prev+坏行容忍 ⑨importOnce 幂等+对账失败
//       ⑩编译产物再摄入零吸收 ⑪inbox 消费 ⑫写路径脱敏
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// DATA_DIR 在 hx-client 模块加载期取 XDG_DATA_HOME——必须在 import bundle 前指向一次性 tmp
// （纪律红线：测试绝不触碰真实 DATA_DIR ~/.local/share/kilo）
const XDG_TMP = fs.mkdtempSync(path.join(os.tmpdir(), `memstore-xdg-${process.pid}-`));
process.env.XDG_DATA_HOME = XDG_TMP;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const esbuildBin = path.join(ROOT, "provider/hx-failover/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuildBin)) {
  console.error("[test] esbuild 未安装：先在 provider/hx-failover 跑 npm install");
  process.exit(2);
}
const bundle = path.join(os.tmpdir(), `ms-test-${process.pid}.mjs`);
execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "memory-store.ts"),
  "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle}`], { stdio: "inherit" });
let X;
try {
  const mod = await import(pathToFileURL(bundle).href);
  X = mod._export ?? mod;
} finally {
  fs.rmSync(bundle, { force: true });
}

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, detail) => {
  let ok = false;
  try { ok = typeof cond === "function" ? !!cond() : !!cond; }
  catch (e) { failed.push(`${name}（抛错：${String(e?.message ?? e).slice(0, 120)}）`); console.error(`  FAIL(throw): ${name}`); fail++; return; }
  if (ok) { pass++; console.log(`  ok: ${name}`); }
  else { failed.push(detail ? `${name}（${detail}）` : name); console.error(`  FAIL: ${name}${detail ? `（${detail}）` : ""}`); fail++; }
};

// 固定假时钟：全部函数显式收 now，测试可复现（不依赖真实时间）
const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const mk = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-`));

// 快捷造条目（绕过 addOrReinforce 直接控制 hits/status/日期，供评分/编译测试）
function ent(id, text, o = {}) {
  return {
    id, text, hash: X.hashText(text),
    tags: o.tags ?? [],
    created: o.created ?? NOW,
    lastUsed: o.lastUsed ?? o.created ?? NOW,
    hits: o.hits ?? 0,
    source: o.source ?? "test",
    status: o.status ?? "active",
    pinned: o.pinned ?? false,
  };
}
// 提取编译产物某个段（## 段名 到下一个 ## / 围栏尾）的 `- ` 行
function section(md, name) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("## ") || l.includes(X.FENCE_END)) break;
    if (l.startsWith("- ")) body.push(l);
  }
  return body;
}

// ── ① parseLessonLines 全变体/CRLF/围栏跳过 ──────────────────
{
  console.log("== 1) parseLessonLines 全变体 ==");
  const src = [
    "# 标题行",
    "",
    "<!-- 注释行 -->",
    "- 2026-09-01 日期前缀条目",
    "- 2026-10-10/11 跨日写法条目",
    "- [a,b] 纯标签条目",
    "- [tag] 2026-09-01 标签加日期条目",
    "- 2026-09-02 [tag] 日期加标签条目",
    "- 裸条目无前缀",
    "- ",
    "-   ",
  ].join("\n");
  const ls = X.parseLessonLines(src);
  t("解析产出 6 条（退化 `- ` 行跳过）", ls.length === 6, `got ${ls.length}`);
  t("日期前缀", ls[0].date === "2026-09-01" && ls[0].text === "日期前缀条目" && ls[0].tags.length === 0);
  t("跨日写法取首日", ls[1].date === "2026-10-10" && ls[1].text.startsWith("跨日"));
  t("纯标签", JSON.stringify(ls[2].tags) === JSON.stringify(["a", "b"]) && ls[2].date === null);
  t("标签+日期", ls[3].tags[0] === "tag" && ls[3].date === "2026-09-01");
  t("日期+标签（组合序）", ls[4].date === "2026-09-02" && ls[4].tags[0] === "tag");
  t("裸条目 date=null", ls[5].date === null && ls[5].text === "裸条目无前缀");
  t("标题/注释/空行跳过", ls.every((l) => !/标题行|注释行/.test(l.text)));

  const crlf = X.parseLessonLines(src.replace(/\n/g, "\r\n"));
  t("CRLF 兼容（结果一致）", JSON.stringify(crlf) === JSON.stringify(ls));

  const fenced = [
    X.FENCE_BEGIN,
    "- 2026-09-01 围栏内条目甲",
    "## 精选",
    "- 2026-09-02 围栏内条目乙",
    X.FENCE_END,
    "- 2026-09-03 围栏外真条目",
  ].join("\n");
  const lf = X.parseLessonLines(fenced);
  t("围栏区整块跳过", lf.length === 1 && lf[0].text === "围栏外真条目");
  t("isLineInFence 行级判定", X.isLineInFence(fenced.split("\n"), 1) === true && X.isLineInFence(fenced.split("\n"), 5) === false);
  t("extractUnfenced 剔围栏", X.extractUnfenced(fenced) === "- 2026-09-03 围栏外真条目");
}

// ── ② jaccard / 去重强化 ─────────────────────────────────────
{
  console.log("== 2) jaccard 与写路径去重 ==");
  t("jaccard 全同=1", X.jaccard("alpha beta", "beta alpha") === 1);
  t("jaccard 不相交=0", X.jaccard("alpha beta", "gamma delta") === 0);
  t("jaccard 空集=0（不 NaN）", X.jaccard("", "alpha") === 0 && X.jaccard("", "") === 0);

  const entries = [];
  const base = "rename EPERM on Windows needs retry loop with MoveFileExW";
  const r1 = X.addOrReinforce(entries, { text: base, tags: ["windows"], date: null, source: "test" }, NOW);
  t("新文本 → added", r1.action === "added" && entries.length === 1);
  t("新条目为 trial/hits 0", entries[0].status === "trial" && entries[0].hits === 0);

  const r2 = X.addOrReinforce(entries, { text: `  ${base}  `.replace("needs", "needs "), tags: [], date: null, source: "test" }, NOW + 1);
  t("hash 精确命中（空白差异归一）→ skip", r2.action === "skip" && entries.length === 1 && entries[0].hits === 0);

  const r3 = X.addOrReinforce(entries, { text: base.replace(" with", ""), tags: [], date: null, source: "test" }, NOW + 2);
  t("Jaccard≥0.85 近似 → reinforced（hits+1 不新增）",
    r3.action === "reinforced" && entries.length === 1 && entries[0].hits === 1 && entries[0].lastUsed === NOW + 2,
    `action=${r3.action} j=${X.jaccard(base, base.replace(" with", "")).toFixed(3)}`);

  const r4 = X.addOrReinforce(entries, { text: "完全无关的另一条经验", tags: [], date: null, source: "test" }, NOW + 3);
  t("Jaccard<0.85 → 新增", r4.action === "added" && entries.length === 2 && entries[1].status === "trial");

  const entriesD = [];
  const rD = X.addOrReinforce(entriesD, { text: "带日期的旧条目", tags: [], date: "2026-01-01", source: "import" }, NOW);
  t("date 前缀 → created/lastUsed 取教训日期", rD.action === "added" && entriesD[0].created === Date.parse("2026-01-01") && entriesD[0].lastUsed === Date.parse("2026-01-01"));

  t("makeId 形如 m<base36>-<rand4>", /^m[0-9a-z]+-[0-9a-z]{4}$/.test(r1.id) === true && /^m/.test(r1.id));
}

// ── ③ 评分序（旧但被用 > 新未用；pinned 置顶；短高分行序）────────
{
  console.log("== 3) 评分与编译行序 ==");
  const c = X.score, d = X.density;
  const A = ent("mA", "old entry with several useful hits", { created: NOW - 100 * DAY, lastUsed: NOW - 1 * DAY, hits: 3 });
  const B = ent("mB", "brand new entry never used", { created: NOW - 1 * DAY, hits: 0 });
  const C = ent("mC", "pinned entry always first", { created: NOW - 30 * DAY, hits: 5, pinned: true });
  const D = ent("mD", "short hot", { created: NOW - 30 * DAY, lastUsed: NOW - 1 * DAY, hits: 2 });
  const E = ent("mE", "long hot " + "word ".repeat(120), { created: NOW - 30 * DAY, lastUsed: NOW - 1 * DAY, hits: 2 });
  t("旧但被用 > 新未用", c(A, NOW) > c(B, NOW), `A=${c(A, NOW).toFixed(2)} B=${c(B, NOW).toFixed(2)}`);
  t("pinned ≥1000 碾压", c(C, NOW) >= 1000);
  t("短高分密度 > 同分长文", d(D, NOW) > d(E, NOW), `dD=${d(D, NOW).toFixed(2)} dE=${d(E, NOW).toFixed(2)}`);

  const entries = [B, A, C, D, E]; // 乱序入参
  const { markdown } = X.buildCompiled(entries, {}, NOW);
  const curated = section(markdown, "精选") ?? [];
  t("pinned 置顶", curated[0]?.includes("pinned entry") === true, JSON.stringify(curated[0]));
  t("旧但被用先于新未用", curated.findIndex((l) => l.includes("old entry")) < curated.findIndex((l) => l.includes("brand new")));
  t("短高分先于长文（密度序）", curated.findIndex((l) => l.includes("short hot")) < curated.findIndex((l) => l.includes("long hot")));
  t("全部条目出现在编译产物", ["old entry", "brand new", "pinned entry", "short hot", "long hot"].every((s) => markdown.includes(s)));
}

// ── ④ 编译预算（字符槽位 + 字节硬顶 + pinned 截 500）──────────
{
  console.log("== 4) 编译预算 ==");
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push(ent(`mc${i}`, `curated entry ${i} ` + "x".repeat(200), { created: NOW - 30 * DAY, hits: i }));
  for (let i = 0; i < 5; i++) entries.push(ent(`mt${i}`, `trial entry ${i} ` + "y".repeat(60), { created: NOW - 1 * DAY, status: "trial", hits: 0 }));
  const { markdown, stats } = X.buildCompiled(entries, { exploreStateFile: path.join(mk("budget"), "exploreState.json") }, NOW);
  const curated = section(markdown, "精选") ?? [];
  const trial = section(markdown, "试用") ?? [];
  t("精选非 pinned 行字符和 ≤2200", curated.filter((l) => !l.includes("pinned entry")).reduce((s, l) => s + l.length, 0) <= 2200,
    `sum=${curated.reduce((s, l) => s + l.length, 0)}`);
  t("试用 ≤3 条", trial.length <= 3, `got ${trial.length}`);
  t("试用字符和 ≤360", trial.reduce((s, l) => s + l.length, 0) <= 360, `sum=${trial.reduce((s, l) => s + l.length, 0)}`);
  t("头两行 ≤200 字符", markdown.split("\n").slice(0, 2).join("\n").length <= 200);
  const domainLine = markdown.split("\n").find((l) => l.startsWith("[") && l.includes("共 "));
  t("域目录行 ≤320", domainLine.length <= 320, `len=${domainLine.length}`);
  const tagNames = (domainLine.match(/\[(.*)\]/)?.[1] ?? "").match(/[^(\s]+/g) ?? [];
  t("域目录 ≤12 tag 且名截 12 字符", tagNames.length <= 12 && tagNames.every((n) => n.length <= 12));

  // 字节硬顶（UTF-8）触发场景：pinned 挂 CJK tag 炸弹（tag 前缀不参与 500 字符 display 截断，
  // 是真实可达的越界形态）+ 全 CJK 槽位内容把字符预算换算成 ~11KB 字节
  const heavy = [];
  heavy.push(ent("mPin", "顶".repeat(2000), { created: NOW - 30 * DAY, hits: 9, pinned: true, tags: Array.from({ length: 40 }, () => "标".repeat(12)) }));
  for (let i = 0; i < 4; i++) heavy.push(ent(`mh${i}`, "选".repeat(500), { created: NOW - 30 * DAY, lastUsed: NOW - 1 * DAY, hits: i + 1 }));
  for (let i = 0; i < 3; i++) heavy.push(ent(`mt${i}`, "试".repeat(118), { created: NOW - (1 + i) * DAY, status: "trial" }));
  heavy.push(ent("meX", "探".repeat(300), { created: NOW - 30 * DAY, hits: 0 })); // 探索候选
  const heavyDir = mk("heavy");
  const r2 = X.buildCompiled(heavy, { exploreStateFile: path.join(heavyDir, "exploreState.json") }, NOW);
  const bytes = Buffer.byteLength(r2.markdown, "utf8");
  t("字节硬顶 ≤10240", bytes <= 10240, `bytes=${bytes}`);
  t("超限剔除顺序：探索先于试用先于精选",
    !r2.markdown.includes("## 探索") && r2.markdown.includes("## 试用") && r2.markdown.includes("## 精选"),
    `explore=${r2.markdown.includes("## 探索")} trial=${r2.markdown.includes("## 试用")}`);
  t("pinned 越字符预算仍收录且 display 截 500", (() => {
    const line = (section(r2.markdown, "精选") ?? []).find((l) => l.includes("顶"));
    if (!line) return false;
    const text = line.replace(/^- \[[^\]]*\] /, "");
    return text.length <= 501;
  })(), "pinned 越字符预算收录但展示截断");
  void stats;
}

// ── ⑤ trial/archived 生命周期 ────────────────────────────────
{
  console.log("== 5) 生命周期转换 ==");
  const entries = [
    ent("t1", "trial young untouched", { created: NOW - 13 * DAY, hits: 0, status: "trial" }),
    ent("t2", "trial with a get", { created: NOW - 13 * DAY, hits: 1, status: "trial" }),
    ent("t3", "trial aged out", { created: NOW - 14 * DAY, hits: 0, status: "trial" }),
    ent("t4", "active stale archived", { created: NOW - 181 * DAY, hits: 0, status: "active" }),
    ent("t5", "active exactly 180d", { created: NOW - 180 * DAY, hits: 0, status: "active" }),
    ent("t6", "pinned never archived", { created: NOW - 200 * DAY, hits: 0, status: "active", pinned: true }),
  ];
  X.buildCompiled(entries, {}, NOW);
  t("trial 未满 14d 无命中 → 保持 trial", entries[0].status === "trial");
  t("trial 有命中 → active", entries[1].status === "active");
  t("trial 满 14d → active", entries[2].status === "active");
  t("active 零命中 >180d → archived", entries[3].status === "archived");
  t("active 恰 180d（严格 >）→ 保持 active", entries[4].status === "active");
  t("pinned 永不归档", entries[5].status === "active");

  // archived 不进精选池，但探索候选含 archived
  const arch = [ent("a1", "archived entry body", { created: NOW - 200 * DAY, hits: 0, status: "archived" })];
  const dir5 = mk("life");
  const { markdown, stats } = X.buildCompiled(arch, { exploreStateFile: path.join(dir5, "exploreState.json") }, NOW);
  t("archived 不进精选", !(section(markdown, "精选") ?? []).some((l) => l.includes("archived entry body")));
  t("探索候选含 archived（探索槽命中）", stats.explore === 1 && (section(markdown, "探索") ?? []).some((l) => l.includes("archived entry body")));
}

// ── ⑥ exploreState 同日确定性 ────────────────────────────────
{
  console.log("== 6) exploreState 确定性 ==");
  const dir6 = mk("explore");
  const stateFile = path.join(dir6, "exploreState.json");
  const candidates = [
    ent("e1", "explore candidate one", { created: NOW - 30 * DAY }),
    ent("e2", "explore candidate two", { created: NOW - 31 * DAY }),
    ent("e3", "explore candidate three", { created: NOW - 32 * DAY }),
  ];
  const r1 = X.buildCompiled([...candidates], { exploreStateFile: stateFile }, NOW);
  const id1 = r1.stats.exploreId;
  t("首次编译选中并持久化探索槽", typeof id1 === "string" && (section(r1.markdown, "探索") ?? []).length === 1);
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  t("state={day,id}（day=floor(now/86400000) UTC）", st.day === Math.floor(NOW / DAY) && st.id === id1);
  const r2 = X.buildCompiled([...candidates], { exploreStateFile: stateFile }, NOW);
  t("同日两连调同 id（fake now 确定性）", r2.stats.exploreId === id1);
  const r3 = X.buildCompiled([...candidates], { exploreStateFile: stateFile }, NOW + DAY);
  const st3 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  t("跨日后 state.day 前进", st3.day === Math.floor((NOW + DAY) / DAY));
  void r3;
}

// ── ⑦ applyUsage 聚合 ────────────────────────────────────────
{
  console.log("== 7) usage 回流 ==");
  const entries = [ent("u1", "used entry", { created: NOW - 5 * DAY }), ent("u2", "untouched entry", { created: NOW - 5 * DAY })];
  const applied = X.applyUsage(entries, [
    { t: "get", id: "u1", ts: NOW },
    { t: "get", id: "u1", ts: NOW },
    { t: "search", id: "u1", ts: NOW },   // 浏览不计分
    { t: "get", id: "nope", ts: NOW },    // 未知 id 忽略
    "bad line",                            // 畸形忽略
    { t: "get", id: "u2", ts: NOW },
  ], NOW);
  t("仅 t:get 计数（2+1=3 次 applied）", applied === 3);
  t("u1 hits=2 且 lastUsed=now", entries[0].hits === 2 && entries[0].lastUsed === NOW);
  t("u2 hits=1", entries[1].hits === 1);
  t("parseUsageLines 跳坏行", X.parseUsageLines('{"t":"get","id":"a"}\nnot json\n\n{"t":"get","id":"b"}\n').length === 2);
}

// ── ⑧ saveStoreAtomic 原子性 + prev + 坏行容忍 ───────────────
{
  console.log("== 8) store 原子落盘 ==");
  const dir8 = mk("store");
  const file = path.join(dir8, "notes.jsonl");
  const e1 = [ent("s1", "first entry", { created: NOW })];
  X.saveStoreAtomic(file, e1);
  t("落盘可读回", X.loadStore(file).entries.length === 1 && X.loadStore(file).entries[0].id === "s1");
  const e2 = [...e1, ent("s2", "second entry", { created: NOW })];
  X.saveStoreAtomic(file, e2);
  const prev = X.loadStore(file + ".prev");
  t("第二次落盘前旧版进 .prev", prev.entries.length === 1 && prev.entries[0].id === "s1");
  fs.appendFileSync(file, "{corrupted json\n", "utf8");
  const r = X.loadStore(file);
  t("坏行跳过并计数（badLines）", r.entries.length === 2 && r.badLines === 1, `bad=${r.badLines}`);
  t("缺失文件 → 空库不抛", (() => { const x = X.loadStore(path.join(dir8, "absent.jsonl")); return x.entries.length === 0 && x.badLines === 0; })());
  t("tmp-<pid> 中间文件不残留", fs.readdirSync(dir8).filter((f) => f.includes(".tmp-")).length === 0);
  X.saveStoreAtomic(file, e2); // 坏行被下一次合法落盘清洗
  t("再次落盘后坏行消失", X.loadStore(file).badLines === 0 && X.loadStore(file).entries.length === 2);
}

// ── ⑨ importOnce 幂等 + 对账失败 ─────────────────────────────
{
  console.log("== 9) legacy 一次性导入 ==");
  const dir9 = mk("import");
  const notesFile = path.join(dir9, "GLOBAL-NOTES.md");
  const parkedFile = path.join(dir9, "GLOBAL-NOTES.parked.md");
  const storePath = path.join(dir9, "notes.jsonl");
  const markerFile = path.join(dir9, "imported.json");
  const archiveDir = dir9;
  fs.writeFileSync(notesFile, ["# 旧全局笔记", "- 2026-09-01 alpha legacy one", "- 2026-09-02 beta legacy two", "- 2026-09-01 alpha legacy one"].join("\n") + "\n", "utf8");
  fs.writeFileSync(parkedFile, "- 2026-08-01 gamma parked three\n", "utf8");

  const r1 = X.importOnce({ notesFile, parkedFile, storePath, markerFile, archiveDir }, NOW);
  t("首次导入 ok 且非 skipped", r1.ok === true && r1.skipped === false);
  t("对账计数 parsed=added+skipped（重复行进 skipped）", r1.counts.parsed === 4 && r1.counts.added === 3 && r1.counts.skipped === 1 && r1.counts.reinforced === 0,
    JSON.stringify(r1.counts));
  t("marker 落盘（version/importedAt/sources/counts）", (() => {
    const m = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    return m.version === 1 && typeof m.importedAt === "string" && Array.isArray(m.sources) && m.sources.length === 2;
  })());
  t("两源归档到 legacy/*.orig", fs.existsSync(path.join(archiveDir, "legacy", "GLOBAL-NOTES.md.orig")) && fs.existsSync(path.join(archiveDir, "legacy", "GLOBAL-NOTES.parked.md.orig")));

  const r2 = X.importOnce({ notesFile, parkedFile, storePath, markerFile, archiveDir }, NOW + 1);
  t("marker 存在 → 幂等 skipped", r2.ok === true && r2.skipped === true);

  // 对账失败：退化 `- ` 行（前缀后无正文）→ parsed > 产出 → 不写 marker、写 import-report
  const dir9b = mk("import-fail");
  const nf2 = path.join(dir9b, "GLOBAL-NOTES.md");
  const sp2 = path.join(dir9b, "notes.jsonl");
  const mf2 = path.join(dir9b, "imported.json");
  fs.writeFileSync(nf2, "- 2026-09-01 valid one\n- 2026-09-02 valid two\n- 2026-09-03\n", "utf8"); // 末行=孤儿日期（退化行：raw 计数可见、解析产出为空）
  const r3 = X.importOnce({ notesFile: nf2, parkedFile: path.join(dir9b, "no-parked.md"), storePath: sp2, markerFile: mf2, archiveDir: dir9b }, NOW);
  t("对账失败 ok:false", r3.ok === false);
  t("对账失败不写 marker", !fs.existsSync(mf2));
  t("对账失败写 import-report.txt", fs.existsSync(path.join(dir9b, "import-report.txt")) && /parsed\(3\)/.test(fs.readFileSync(path.join(dir9b, "import-report.txt"), "utf8")));
  t("store 已落盘（重跑 hash 去重自愈路径）", X.loadStore(sp2).entries.length === 2);
}

// ── ⑩ 编译产物再摄入零吸收 ───────────────────────────────────
{
  console.log("== 10) 编译产物不再摄入 ==");
  const dir10 = mk("reingest");
  const storePath = path.join(dir10, "notes.jsonl");
  const seed = [
    ent("r1", "existing entry one", { created: NOW - 30 * DAY, lastUsed: NOW - 2 * DAY, hits: 3 }),
    ent("r2", "existing entry two", { created: NOW - 30 * DAY }),
  ];
  X.saveStoreAtomic(storePath, seed);
  const { markdown } = X.buildCompiled([...seed], {}, NOW);
  t("extractUnfenced(编译产物) 无条目可再摄入", X.parseLessonLines(X.extractUnfenced(markdown)).length === 0);
  const notesFile = path.join(dir10, "GLOBAL-NOTES.md");
  fs.writeFileSync(notesFile, markdown, "utf8");
  const counts = X.ingestSources({
    notesFile, inboxFile: path.join(dir10, "inbox.md"), storePath,
    consumedFile: path.join(dir10, "inbox.consumed.md"), skipLegacy: false,
  }, NOW);
  t("摄入计数全零", counts.added === 0 && counts.reinforced === 0 && counts.skipped === 0 && counts.consumed === 0, JSON.stringify(counts));
  const after = X.loadStore(storePath).entries;
  t("条目数不变", after.length === 2);
  t("hits 不变（无自强化）", after.find((e) => e.id === "r1").hits === 3 && after.find((e) => e.id === "r2").hits === 0);
}

// ── ⑪ inbox 消费 ─────────────────────────────────────────────
{
  console.log("== 11) inbox 消费 ==");
  const dir11 = mk("inbox");
  const storePath = path.join(dir11, "notes.jsonl");
  const base = "alpha one two three four five";
  const seed = [ent("i1", base, { created: NOW - 30 * DAY })];
  X.saveStoreAtomic(storePath, seed);
  const inboxFile = path.join(dir11, "inbox.md");
  const consumedFile = path.join(dir11, "inbox.consumed.md");
  fs.writeFileSync(inboxFile, [
    "- 2026-09-01 alpha one two three four five six",
    "- [x] fresh brand new lesson line",
  ].join("\n") + "\n", "utf8");
  const counts = X.ingestSources({
    notesFile: null, inboxFile, storePath, consumedFile, skipLegacy: true,
  }, NOW);
  t("强化路径生效（Jaccard 6/7≥0.85）", counts.reinforced === 1, JSON.stringify(counts));
  t("新行入库", counts.added === 1);
  t("消费行计数=2", counts.consumed === 2);
  const consumed = fs.readFileSync(consumedFile, "utf8");
  t("consumed 带时间戳头且含两行", /<!-- consumed \d{4}-\d{2}-\d{2}T/.test(consumed) && consumed.includes("alpha one two three four five six") && consumed.includes("fresh brand new lesson line"));
  t("inbox 截空", fs.readFileSync(inboxFile, "utf8") === "");
  const after = X.loadStore(storePath).entries;
  t("强化命中 hits+1 持久化", after.find((e) => e.id === "i1").hits === 1 && after.length === 2);
}

// ── ⑫ 写路径脱敏 ─────────────────────────────────────────────
{
  console.log("== 12) 红脱敏 ==");
  const entries = [];
  X.addOrReinforce(entries, {
    text: "gateway key leaked as sk-prod-abcdef1234567890 and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig must be masked",
    tags: ["gateway"], date: null, source: "agent",
  }, NOW);
  const stored = entries[0].text;
  t("sk- 密钥打码", !stored.includes("sk-prod-abcdef1234567890") && stored.includes("sk-***"));
  t("eyJ JWT 打码", !stored.includes("eyJhbGciOiJIUzI1NiJ9") && stored.includes("eyJ***"));
  t("正文其余部分保留", stored.includes("must be masked"));
  const dir12 = mk("redact");
  const { markdown } = X.buildCompiled(entries, { exploreStateFile: path.join(dir12, "e.json") }, NOW);
  t("编译产物不含原始密钥", !markdown.includes("sk-prod-abcdef1234567890") && !markdown.includes("eyJhbGciOiJIUzI1NiJ9"));
}

// 清理临时目录
for (const d of [XDG_TMP]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} memory-store 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
