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
const { trimNotesToCap, GLOBAL_NOTES_CAP_BYTES } = mod._export ?? mod;

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

console.log(`\n${fail === 0 ? "✅" : "❌"} memory-bootstrap 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);