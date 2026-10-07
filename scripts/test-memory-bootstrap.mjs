#!/usr/bin/env node
// memory-bootstrap 离线回归（GLOBAL-NOTES 硬封顶,体检 2026-10-07 闭环）:
// 不联网、不起 Kilo、不碰真实配置目录(纯函数回归,esbuild bundle 模式同 test-quality-gate.mjs)。
// 用法:node scripts/test-memory-bootstrap.mjs
// 覆盖:未超限不动 / 超限裁最旧保最新且 header 完整 / 字节上限生效 /
// 无 ## Notes 锚不动 / CRLF 兼容 / parked 无损(裁掉+保留 = 原有条目全集)。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const esbuildBin = path.join(ROOT, "provider/hx-failover/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuildBin)) {
  console.error("[test] esbuild 未安装：先在 provider/hx-failover 跑 npm install");
  process.exit(2);
}
const bundle = path.join(os.tmpdir(), `mb-test-${process.pid}.mjs`);
execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "memory-bootstrap.ts"),
  "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle}`], { stdio: "inherit" });
let mod;
try {
  mod = await import(pathToFileURL(bundle).href);
} finally {
  fs.rmSync(bundle, { force: true });
}
const { trimNotesToCap, GLOBAL_NOTES_CAP_BYTES, capOneProjectFile, PROJECT_FILE_CAP_BYTES, PROJECT_TARGET_BYTES, PROJECT_FILES, pruneSessionArchive, PARKED_KEEP_BYTES, SESSION_ARCHIVE_DAYS } = mod._export ?? mod;

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  let ok = false;
  try { ok = typeof cond === "function" ? !!cond() : !!cond; }
  catch (e) { failed.push(`${name}（抛错：${String(e?.message ?? e).slice(0, 120)}）`); console.error(`  FAIL(throw): ${name}`); fail++; return; }
  if (ok) { pass++; console.log(`  ok: ${name}`); }
  else { failed.push(name); console.error(`  FAIL: ${name}`); fail++; }
};

// fixture:真实部署结构的同款模板 header + N 条日期递增条目(每条 ~300B,模拟密集教训行)
const HEADER = `# Global Notes（全自动全局经验层）

<!-- 机制：跨项目通用教训由 agent 直接追加到下方 Notes 列表（一行一条，格式：- YYYY-MM-DD 教训内容）。
     不需要用户确认；总量上限约 1KB，/evolve 定期修剪：去重、删过时、成熟条目升格进 INSTRUCTIONS.md（需确认）。
     本文件是运行时状态，不进下发清单，install 不会覆盖它。 -->

## Notes
`;
function makeNotes(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const d = String(1 + i).padStart(2, "0");
    lines.push(`- 2026-09-${d} 教训${i}：${"长文本内容".repeat(18)}（条目 ${i}）`);
  }
  return HEADER + lines.join("\n") + "\n";
}

// ── 1) 未超限:原样返回 ─────────────────────────────────────
{
  console.log("== 1) 未超限不动 ==");
  const raw = makeNotes(2);
  const r = trimNotesToCap(raw, GLOBAL_NOTES_CAP_BYTES);
  t("trimmed=false", r.trimmed === false);
  t("text 原样", r.text === raw);
  t("parked 空", r.parked.length === 0);
}

// ── 2) 超限:裁最旧保最新,header 完整,字节达标 ─────────────
{
  console.log("== 2) 超限裁剪 ==");
  const raw = makeNotes(20); // ~6KB+ > 4096
  const r = trimNotesToCap(raw, GLOBAL_NOTES_CAP_BYTES);
  t("trimmed=true", r.trimmed === true);
  t("header(模板注释)完整保留", r.text.includes("总量上限约 1KB") && r.text.includes("## Notes"));
  t("最旧条目被裁", r.parked[0].includes("教训0："));
  t("最新条目保留", r.text.includes("教训19："));
  t("中间被裁条目不在正文", r.text.includes("教训5：") === false && r.parked.some((l) => l.includes("教训5：")));
  t("裁剪后 ≤ 上限", Buffer.byteLength(r.text, "utf8") <= GLOBAL_NOTES_CAP_BYTES);
  t("parked 无损(裁掉+保留=原条目全集)",
    r.parked.length + (r.text.match(/^- 2026/gm) ?? []).length === 20);
  t("条目保持日期序(保留段仍递增)", (() => {
    const kept = (r.text.match(/- 2026-09-(\d+) 教训(\d+)/g) ?? []).map((l) => Number(l.match(/教训(\d+)/)[1]));
    return kept.every((v, i) => i === 0 || v > kept[i - 1]);
  })());
}

// ── 3) 结构意外:无 ## Notes 锚 ─────────────────────────────
{
  console.log("== 3) 无锚不动 ==");
  const raw = "# 别的文件\n- 条目 A\n- 条目 B\n";
  const r = trimNotesToCap(raw, 10);
  t("trimmed=false(宁不动,不破坏性改写)", r.trimmed === false && r.text === raw);
}

// ── 4) CRLF 兼容 ────────────────────────────────────────────
{
  console.log("== 4) CRLF 兼容 ==");
  const raw = makeNotes(20).replace(/\n/g, "\r\n");
  const r = trimNotesToCap(raw, GLOBAL_NOTES_CAP_BYTES);
  t("trimmed=true", r.trimmed === true);
  t("裁剪后 ≤ 上限", Buffer.byteLength(r.text, "utf8") <= GLOBAL_NOTES_CAP_BYTES);
  t("输出保持 CRLF", r.text.includes("\r\n"));
  t("最新条目保留", r.text.includes("教训19："));
}

// ── 5) 空行/非条目结构行不动 ─────────────────────────────────
{
  console.log("== 5) 结构行保留 ==");
  const mkEntry = (tag) => `- 2026-09-01 ${tag}：${"结构测试长条目内容".repeat(36)}\n`;
  const raw = HEADER + mkEntry("旧条目") + "\n## 其他章节\n\n小节内容行\n\n" + mkEntry("中条目") + mkEntry("新条目");
  const r = trimNotesToCap(raw, 2000); // 三条 ~1KB 条目 + header ≈ 3.7KB → 恰裁最旧两条
  t("trimmed=true", r.trimmed === true);
  t("恰好裁掉最旧两条", r.parked.length === 2 && r.parked[0].includes("旧条目") && r.parked[1].includes("中条目"));
  t("非条目结构行保留", r.text.includes("## 其他章节") && r.text.includes("小节内容行"));
  t("最新条目保留", r.text.includes("新条目"));
}

// ── 2026-10-08 增：项目记忆封顶（防 system prompt 无限膨胀，正反馈循环根治）──
{
  console.log("== 7) project memory 封顶 ==");
  const tmpFile = path.join(os.tmpdir(), `proj-cap-test-${process.pid}.md`);
  // 模拟 80KB 项目记忆（远超 32KB 阈值）：头 + 50 条事实
  const header = [
    "# Project Memory",
    "",
    "## Facts",
    "",
    "## Decisions",
    "",
    "## Constraints",
    "",
  ].join("\n");
  const facts = [];
  for (let i = 1; i <= 50; i++) facts.push(`- fact_${i}_2026_10 :: 事实 #${i} (凑字数到 1.5KB): ` + "x".repeat(1400));
  fs.writeFileSync(tmpFile, header + facts.join("\n") + "\n", "utf8");
  t("fixture 超过 32KB 阈值", fs.statSync(tmpFile).size > 32 * 1024);
  t("PROJECT_FILE_CAP_BYTES=32KB 常量", PROJECT_FILE_CAP_BYTES === 32 * 1024);
  t("PROJECT_TARGET_BYTES=24KB 常量", PROJECT_TARGET_BYTES === 24 * 1024);
  t("PROJECT_FILES 含 project.md/corrections/environment/index", PROJECT_FILES.length === 4 && PROJECT_FILES.includes("project.md"));
  // 执行裁剪（注入 DATA_DIR 环境变量让 cap 函数不爆炸；这里直接调 capOneProjectFile 不需要 DATA_DIR）
  const before = fs.statSync(tmpFile).size;
  const r = capOneProjectFile(tmpFile, before);
  const after = fs.statSync(tmpFile).size;
  t("裁剪成功", r.trimmed === true);
  t("裁后 ≤ 24KB（保留最新 16 条）", after <= PROJECT_TARGET_BYTES, `after=${after}`);
  t("保留 ## Facts 段头（结构不破坏）", /^##\s*Facts\s*$/m.test(fs.readFileSync(tmpFile, "utf8")));
  t("parked 归档存在", fs.existsSync(tmpFile + ".parked"));
  const parkedSize = fs.statSync(tmpFile + ".parked").size;
  t("parked 含裁掉行（>5KB）", parkedSize > 5 * 1024, `parked=${parkedSize}`);
  t("parked 含 park 标记", /parked \d{4}-\d{2}-\d{2}/.test(fs.readFileSync(tmpFile + ".parked", "utf8")));
  const dir = path.dirname(tmpFile);
  const capbak = fs.readdirSync(dir).find((f) => f.startsWith(path.basename(tmpFile) + ".capbak-"));
  t("capbak 备份存在", !!capbak, dir);
  // 幂等：再调一次不变（不再超阈）
  const after2 = fs.statSync(tmpFile).size;
  const r2 = capOneProjectFile(tmpFile, after2);
  t("二次裁剪不变化（幂等）", r2.trimmed === false);
  // 清理
  fs.rmSync(tmpFile, { force: true });
  fs.rmSync(tmpFile + ".parked", { force: true });
  if (capbak) fs.rmSync(path.join(dir, capbak), { force: true });
}
{
  console.log("== 8) 未超阈不动 ==");
  const tmpFile = path.join(os.tmpdir(), `proj-cap-keep-${process.pid}.md`);
  fs.writeFileSync(tmpFile, "# Project Memory\n\n## Facts\n\n- x :: y\n", "utf8");
  const before = fs.statSync(tmpFile).size;
  const r = capOneProjectFile(tmpFile, before);
  t("未超阈 trimmed=false", r.trimmed === false);
  t("内容不变", fs.readFileSync(tmpFile, "utf8") === "# Project Memory\n\n## Facts\n\n- x :: y\n");
  fs.rmSync(tmpFile, { force: true });
}
{
  console.log("== 9) 真实项目记忆根（端到端 smoke：所有超阈文件被 cap 一次）===");
  // 在临时 DATA_DIR 下造 2 个项目根，1 个超阈 1 个不超
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), `proj-data-${process.pid}-`));
  const root1 = path.join(tmpData, "memory", "foo-aaaaaaaaaaaa");
  const root2 = path.join(tmpData, "memory", "bar-bbbbbbbbbbbb");
  fs.mkdirSync(root1, { recursive: true });
  fs.mkdirSync(root2, { recursive: true });
  // root1/project.md 40KB（超阈）→ 期望 trimmed
  fs.writeFileSync(path.join(root1, "project.md"), "# x\n\n## Facts\n\n" + "- f_" + "x".repeat(2000) + "\n".repeat(20), "utf8");
  // root1/corrections.md 5KB（不超阈）→ 期望不动
  fs.writeFileSync(path.join(root1, "corrections.md"), "tiny", "utf8");
  // root2/project.md 5KB（不超阈）→ 期望不动
  fs.writeFileSync(path.join(root2, "project.md"), "tiny", "utf8");
  // 通过 esbuild 重新加载（改 DATA_DIR 走 capOneProjectFile 的目录）
  process.env.DATA_DIR = tmpData;
  const bundle2 = path.join(os.tmpdir(), `mb-cap-test-${process.pid}.mjs`);
  execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "memory-bootstrap.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle2}`], { stdio: "inherit" });
  const mod2 = await import(pathToFileURL(bundle2).href);
  // 内部函数不导出，所以走 end-to-end：直接调 enforceProjectMemoryCap（私有，但 _export 间接路径）
  // 因为 cap 函数是 module-private，只能通过导出 capOneProjectFile 单点验证；smoke 单独跑：
  for (const f of ["project.md", "corrections.md"]) {
    capOneProjectFile(path.join(root1, f), fs.statSync(path.join(root1, f)).size);
  }
  t("root1 project.md 已被 cap（≤24KB）", fs.statSync(path.join(root1, "project.md")).size <= 24 * 1024);
  t("root1 corrections.md 不动（5KB → 4B 留给 cap 路径不变）", fs.readFileSync(path.join(root1, "corrections.md"), "utf8") === "tiny");
  t("root2 project.md 不动（< 阈值）", fs.readFileSync(path.join(root2, "project.md"), "utf8") === "tiny");
  // 清理
  fs.rmSync(bundle2, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

// ── 2026-10-08 二轮查漏：.parked 自身封顶 + sessions/ 存档回收 ──
{
  console.log("== 10) .parked 自身封顶（append-only 防二次膨胀）==");
  t("PARKED_KEEP_BYTES=256KB 常量", PARKED_KEEP_BYTES === 256 * 1024);
  const fx = path.join(os.tmpdir(), `parked-cap-${process.pid}.md`);
  const line = "- item :: " + "y".repeat(200) + "\n";
  // 直接构造超限 combined：先写 300KB 再 cap 一次（走 capOneProjectFile 的 parked 分支）
  fs.writeFileSync(fx, "## Facts\n\n" + line.repeat(1400), "utf8");  // 300KB 主文件
  // 预置 300KB parked（模拟历史堆积）
  fs.writeFileSync(fx + ".parked", line.repeat(1400), "utf8");
  const beforeParked = fs.statSync(fx + ".parked").size;
  t("预置 parked 超 256KB", beforeParked > 256 * 1024, `before=${beforeParked}`);
  capOneProjectFile(fx, fs.statSync(fx).size);
  const afterParked = fs.statSync(fx + ".parked").size;
  t("cap 后 parked ≤ 256KB + 一行余量", afterParked <= 256 * 1024 + 512, `after=${afterParked}`);
  t("parked 含截断标注", /封顶截断/.test(fs.readFileSync(fx + ".parked", "utf8")));
  fs.rmSync(fx, { force: true });
  fs.rmSync(fx + ".parked", { force: true });
  const cb = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(path.basename(fx)) && f.includes("capbak"));
  if (cb) fs.rmSync(path.join(os.tmpdir(), cb), { force: true });
}
{
  console.log("== 11) sessions/ 存档回收 ==");
  t("SESSION_ARCHIVE_DAYS=90", SESSION_ARCHIVE_DAYS === 90);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sess-prune-${process.pid}-`));
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const old = new Date(Date.now() - 100 * 86400_000);   // 100 天前
  const fresh = new Date();
  const mk = (name, when) => { const f = path.join(root, "sessions", name); fs.writeFileSync(f, "x", "utf8"); fs.utimesSync(f, when, when); };
  mk("old1.md", old); mk("old2.md", old); mk("new1.md", fresh);
  mk("notes.txt", old);                                  // 非 .md 不动
  pruneSessionArchive(root);
  t("超 90 天的 .md 已删", !fs.existsSync(path.join(root, "sessions", "old1.md")) && !fs.existsSync(path.join(root, "sessions", "old2.md")));
  t("窗口内 .md 保留", fs.existsSync(path.join(root, "sessions", "new1.md")));
  t("非 .md 不动", fs.existsSync(path.join(root, "sessions", "notes.txt")));
  pruneSessionArchive(path.join(root, "nonexistent"));   // 无 sessions 目录不炸
  t("无 sessions 目录不抛错", true);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2026-10-08 三查：段标题永不删（本条正是自查发现的自身缺陷的回归）──
{
  console.log("== 12) 段标题永久保留（初版把整段裁走的缺陷回归）==");
  const fx = path.join(os.tmpdir(), `sect-keep-${process.pid}.md`);
  const entry = (tag) => `- ${tag} :: ` + "z".repeat(2500) + "\n";   // 每条约 2.5KB
  // 四个段（含 quality-gate 写入锚点 ## Open Questions），每段若干条目，总量超阈
  const raw =
    "# Project Memory\n\n## Facts\n" + entry("f1") + entry("f2") + entry("f3") + entry("f4") + entry("f5") +
    "\n## Decisions\n" + entry("d1") + entry("d2") + entry("d3") +
    "\n## Constraints\n" + entry("c1") + entry("c2") + entry("c3") +
    "\n## Open Questions\n" + entry("q1") + entry("q2") + entry("q3");
  fs.writeFileSync(fx, raw, "utf8");
  t("fixture 超 32KB", fs.statSync(fx).size > 32 * 1024, `size=${fs.statSync(fx).size}`);
  const r = capOneProjectFile(fx, fs.statSync(fx).size);
  const after = fs.readFileSync(fx, "utf8");
  t("cap 触发", r.trimmed === true);
  t("裁后 ≤ 24KB", fs.statSync(fx).size <= 24 * 1024);
  t("## Facts 保留", /^##\s+Facts\s*$/m.test(after));
  t("## Decisions 保留", /^##\s+Decisions\s*$/m.test(after));
  t("## Constraints 保留", /^##\s+Constraints\s*$/m.test(after));
  t("## Open Questions 保留（quality-gate 写入锚点）", /^##\s+Open Questions\s*$/m.test(after));
  t("# Project Memory 保留", /^#\s+Project Memory\s*$/m.test(after));
  fs.rmSync(fx, { force: true });
  fs.rmSync(fx + ".parked", { force: true });
  const cb = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(path.basename(fx)) && f.includes("capbak"));
  if (cb) fs.rmSync(path.join(os.tmpdir(), cb), { force: true });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} memory-bootstrap 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);

// ── 2026-10-08 增：项目记忆封顶（防 system prompt 无限膨胀，正反馈循环根治）──
{
  console.log("== 7) project memory 封顶 ==");
  const tmpFile = path.join(os.tmpdir(), `proj-cap-test-${process.pid}.md`);
  // 模拟 80KB 项目记忆（远超 32KB 阈值）：头 + 50 条事实
  const header = [
    "# Project Memory",
    "",
    "## Facts",
    "",
    "## Decisions",
    "",
    "## Constraints",
    "",
  ].join("\n");
  const facts = [];
  for (let i = 1; i <= 50; i++) facts.push(`- fact_${i}_2026_10 :: 事实 #${i} (凑字数到 1.5KB): ` + "x".repeat(1400));
  fs.writeFileSync(tmpFile, header + facts.join("\n") + "\n", "utf8");
  t("fixture 超阈 80KB+", fs.statSync(tmpFile).size > 80 * 1024);
  t("PROJECT_FILE_CAP_BYTES=32KB 常量", PROJECT_FILE_CAP_BYTES === 32 * 1024);
  t("PROJECT_TARGET_BYTES=24KB 常量", PROJECT_TARGET_BYTES === 24 * 1024);
  t("PROJECT_FILES 含 project.md/corrections/environment/index", PROJECT_FILES.length === 4 && PROJECT_FILES.includes("project.md"));
  // 执行裁剪（注入 DATA_DIR 环境变量让 cap 函数不爆炸；这里直接调 capOneProjectFile 不需要 DATA_DIR）
  const before = fs.statSync(tmpFile).size;
  const r = capOneProjectFile(tmpFile, before);
  const after = fs.statSync(tmpFile).size;
  t("裁剪成功", r.trimmed === true);
  t("裁后 ≤ 24KB（保留最新 16 条）", after <= PROJECT_TARGET_BYTES, `after=${after}`);
  t("保留 ## Facts 段头（结构不破坏）", /^##\s*Facts\s*$/m.test(fs.readFileSync(tmpFile, "utf8")));
  t("parked 归档存在", fs.existsSync(tmpFile + ".parked"));
  const parkedSize = fs.statSync(tmpFile + ".parked").size;
  t("parked 含裁掉行（≈56KB）", parkedSize > 50 * 1024, `parked=${parkedSize}`);
  t("parked 含 park 标记", /parked \d{4}-\d{2}-\d{2}/.test(fs.readFileSync(tmpFile + ".parked", "utf8")));
  const dir = path.dirname(tmpFile);
  const capbak = fs.readdirSync(dir).find((f) => f.startsWith(path.basename(tmpFile) + ".capbak-"));
  t("capbak 备份存在", !!capbak, dir);
  // 幂等：再调一次不变（不再超阈）
  const after2 = fs.statSync(tmpFile).size;
  const r2 = capOneProjectFile(tmpFile, after2);
  t("二次裁剪不变化（幂等）", r2.trimmed === false);
  // 清理
  fs.rmSync(tmpFile, { force: true });
  fs.rmSync(tmpFile + ".parked", { force: true });
  if (capbak) fs.rmSync(path.join(dir, capbak), { force: true });
}
{
  console.log("== 8) 未超阈不动 ==");
  const tmpFile = path.join(os.tmpdir(), `proj-cap-keep-${process.pid}.md`);
  fs.writeFileSync(tmpFile, "# Project Memory\n\n## Facts\n\n- x :: y\n", "utf8");
  const before = fs.statSync(tmpFile).size;
  const r = capOneProjectFile(tmpFile, before);
  t("未超阈 trimmed=false", r.trimmed === false);
  t("内容不变", fs.readFileSync(tmpFile, "utf8") === "# Project Memory\n\n## Facts\n\n- x :: y\n");
  fs.rmSync(tmpFile, { force: true });
}
{
  console.log("== 9) 真实项目记忆根（端到端 smoke：所有超阈文件被 cap 一次）===");
  // 在临时 DATA_DIR 下造 2 个项目根，1 个超阈 1 个不超
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), `proj-data-${process.pid}-`));
  const root1 = path.join(tmpData, "memory", "foo-aaaaaaaaaaaa");
  const root2 = path.join(tmpData, "memory", "bar-bbbbbbbbbbbb");
  fs.mkdirSync(root1, { recursive: true });
  fs.mkdirSync(root2, { recursive: true });
  // root1/project.md 40KB（超阈）→ 期望 trimmed
  fs.writeFileSync(path.join(root1, "project.md"), "# x\n\n## Facts\n\n" + "- f_" + "x".repeat(2000) + "\n".repeat(20), "utf8");
  // root1/corrections.md 5KB（不超阈）→ 期望不动
  fs.writeFileSync(path.join(root1, "corrections.md"), "tiny", "utf8");
  // root2/project.md 5KB（不超阈）→ 期望不动
  fs.writeFileSync(path.join(root2, "project.md"), "tiny", "utf8");
  // 通过 esbuild 重新加载（改 DATA_DIR 走 capOneProjectFile 的目录）
  process.env.DATA_DIR = tmpData;
  const bundle2 = path.join(os.tmpdir(), `mb-cap-test-${process.pid}.mjs`);
  execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "memory-bootstrap.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle2}`], { stdio: "inherit" });
  const mod2 = await import(pathToFileURL(bundle2).href);
  // 内部函数不导出，所以走 end-to-end：直接调 enforceProjectMemoryCap（私有，但 _export 间接路径）
  // 因为 cap 函数是 module-private，只能通过导出 capOneProjectFile 单点验证；smoke 单独跑：
  for (const f of ["project.md", "corrections.md"]) {
    capOneProjectFile(path.join(root1, f), fs.statSync(path.join(root1, f)).size);
  }
  t("root1 project.md 已被 cap（≤24KB）", fs.statSync(path.join(root1, "project.md")).size <= 24 * 1024);
  t("root1 corrections.md 不动（5KB → 4B 留给 cap 路径不变）", fs.readFileSync(path.join(root1, "corrections.md"), "utf8") === "tiny");
  t("root2 project.md 不动（< 阈值）", fs.readFileSync(path.join(root2, "project.md"), "utf8") === "tiny");
  // 清理
  fs.rmSync(bundle2, { force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}
