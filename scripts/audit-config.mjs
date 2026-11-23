#!/usr/bin/env node
// 配置规范审计（只读，不联网、不写盘；仓库工具，非下发资产）
// 用法：node scripts/audit-config.mjs
// 对照 INSTRUCTIONS「Kilo 配置硬约束」+ 本仓库路由不变式，审计**部署副本**并与 SSOT 模板对齐：
//   strict JSON / 无 `//` 自定义键 / 无未展开 `~` 路径 / provider.npm 三斜杠 /
//   权限兜底 `*` 在最前且 deny 不被后续 allow 遮蔽（最后匹配生效）/ agent 模型与 variant 全解析 /
//   failover 链全注册且全视觉 / modalities⇔attachment 一致 / 审查三席互异 + 引用 ≤5 /
//   部署与模板路由逐字段一致 / provider spec v3 / 运行时钉选不覆盖路由。
// 背景：2026-11-14 视觉修复后固化——「配置看起来对」不算证据，规范符合性须可一键复跑。
// 退出码：全绿 0；任一 FAIL 1（可挂预提交/下发后核对）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const deployedPath = path.join(HOME, ".config", "kilo", "kilo.json");
const tmplPath = path.join(ROOT, "kilo.json.tmpl");

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };

const raw = fs.readFileSync(deployedPath, "utf8");
let cfg;
try { cfg = JSON.parse(raw); t("R1 部署副本 strict JSON（无注释/自定义语法）", true, `${raw.length}B`); }
catch (e) { t("R1 部署副本 strict JSON", false, e.message); process.exit(1); }

const tmplRaw = fs.readFileSync(tmplPath, "utf8");
let tmpl;
try { tmpl = JSON.parse(tmplRaw.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1")); t("R1b 模板剥注释后可解析", true); }
catch (e) { t("R1b 模板剥注释后可解析", false, e.message); process.exit(1); }

const badKeys = [];
(function walk(o, p) {
  if (!o || typeof o !== "object") return;
  for (const k of Object.keys(o)) { if (k.startsWith("//")) badKeys.push(p + "." + k); walk(o[k], p + "." + k); }
})(cfg, "$");
t("R2 无 `//` 自定义键（会让整份配置 Unrecognized keys 失效）", badKeys.length === 0, badKeys.join(","));

const tilde = [];
(function walk(o, p) {
  if (typeof o === "string") { if (/(^|[\s"'=(])~[\\/]/.test(o)) tilde.push(`${p}=${o.slice(0, 60)}`); return; }
  if (o && typeof o === "object") for (const k of Object.keys(o)) walk(o[k], p + "." + k);
})(cfg, "$");
t("R3 无未展开 `~` 路径（Kilo 不展开 ~）", tilde.length === 0, tilde.join(" | "));

const pv = cfg.provider.openllamas;
const reg = pv.models;
const ids = Object.keys(reg);
t("R4 provider.npm 为 file:///（三斜杠）", String(pv.npm).startsWith("file:///"), pv.npm);

// 权限：兜底 `*` 若存在必须最前；后续 allow 不得遮蔽先前 deny（最后匹配生效）。
// 纯 deny-list 覆盖层（无 `*`）是合法形态：未命中项继承全局默认。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (pat) => new RegExp("^" + pat.split("*").map(esc).join(".*") + "$", "i");
const permIssues = [];
const checkMap = (label, pval) => {
  if (!pval || typeof pval !== "object" || Array.isArray(pval)) return;
  const rules = Object.entries(pval).map(([pattern, action]) => ({ pattern, action }));
  const starIdx = rules.findIndex((r) => r.pattern === "*");
  if (starIdx > 0) permIssues.push(`${label} 兜底 * 在 index ${starIdx}（须最前）`);
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].action !== "deny") continue;
    const core = rules[i].pattern.replace(/\*/g, "");
    for (let k = i + 1; k < rules.length; k++) {
      if (rules[k].action === "allow" && toRe(rules[k].pattern).test(core)) permIssues.push(`${label} deny "${rules[i].pattern}" 被后续 allow "${rules[k].pattern}" 遮蔽`);
    }
  }
};
for (const [aname, a] of Object.entries(cfg.agent ?? {})) {
  for (const [pname, pval] of Object.entries(a.permission ?? {})) checkMap(`${aname}.${pname}`, pval);
}
for (const [pname, pval] of Object.entries(cfg.permission ?? {})) checkMap(`top.${pname}`, pval);
t("R5 权限顺序（兜底最前 / deny 不被遮蔽）", permIssues.length === 0, permIssues.join(" | "));

const agentIssues = [];
for (const [name, a] of Object.entries(cfg.agent ?? {})) {
  if (!a.model) continue;
  const mid = String(a.model).split("/").pop();
  if (!reg[mid]) { agentIssues.push(`${name}: ${mid} 不在注册表`); continue; }
  if (a.variant && !reg[mid].variants?.[a.variant]) agentIssues.push(`${name}: variant ${a.variant} 未在 ${mid} 声明`);
}
t("R6 agent 模型/variant 全解析", agentIssues.length === 0, agentIssues.join(" | "));

const chain = pv.options.failover.chain.models;
t("R7 failover 链全注册", chain.every((m) => reg[m]), chain.filter((m) => !reg[m]).join(","));
t("R7b failover 链全视觉可用（末跳不得为盲模型）", chain.every((m) => (reg[m]?.modalities?.input ?? []).includes("image")), chain.filter((m) => !(reg[m]?.modalities?.input ?? []).includes("image")).join(","));
t("R7c 链互异且 ≥2 跳", new Set(chain).size === chain.length && chain.length >= 2, chain.join(" -> "));

const modIssues = [];
for (const id of ids) {
  const m = reg[id];
  const img = (m.modalities?.input ?? []).includes("image");
  if (!m.modalities) modIssues.push(`${id}: modalities 未声明`);
  if (img && m.attachment !== true) modIssues.push(`${id}: 可收图但 attachment!=true`);
  if (!img && m.attachment === true) modIssues.push(`${id}: 纯文本但 attachment=true`);
}
t("R8 modalities⇔attachment 一致（docs 要求同设）", modIssues.length === 0, modIssues.join(" | "));

const dr = pv.options.dual_review, moa = pv.options.moa;
const seats = [dr.positive, dr.negative, dr.aggregator];
t("R9 审查三席全注册", seats.every((m) => reg[m]), seats.filter((m) => !reg[m]).join(","));
t("R9b 审查三席互异（防自审）", new Set(seats).size === 3, seats.join("/"));
const refs = [...(dr.positive_fallbacks ?? []), ...(dr.negative_fallbacks ?? []), ...(dr.aggregator_fallbacks ?? []), ...(moa.aggregator_fallbacks ?? []), ...moa.references, moa.aggregator];
t("R9c fallback/参考席全注册", [...new Set(refs)].every((m) => reg[m]), [...new Set(refs)].filter((m) => !reg[m]).join(","));
const union = new Set([...seats, ...refs, ...chain, ...Object.values(cfg.agent ?? {}).map((a) => String(a.model ?? "").split("/").pop()).filter(Boolean)]);
t("R9d 路由引用合计 ≤5", union.size <= 5, `${union.size}: ${[...union].join(",")}`);

for (const k of ["small_model", "subagent_model"]) {
  const v = cfg[k];
  t(`R10 ${k} 已配且在注册表`, Boolean(v) && Boolean(reg[String(v).split("/").pop()]), String(v ?? "(缺)"));
}

t("R11 无单模型钉扎残留（singleModel/single_model）", !("singleModel" in cfg) && !pv.options.single_model);
t("R11b 无单模型备份残留", fs.readdirSync(path.join(HOME, ".config", "kilo")).filter((f) => f.startsWith("kilo.json.bak-single")).length === 0);

// 部署 vs 模板：安装器会替换路径占位符，故只比对路由相关子树（逐字段）
const pick = (c) => JSON.stringify({
  agents: Object.fromEntries(Object.entries(c.agent ?? {}).map(([k, v]) => [k, { model: v.model, variant: v.variant }])),
  failover: c.provider.openllamas.options.failover,
  moa: c.provider.openllamas.options.moa,
  dual_review: c.provider.openllamas.options.dual_review,
  models: Object.fromEntries(Object.entries(c.provider.openllamas.models).map(([k, v]) => [k, { modalities: v.modalities, attachment: v.attachment, variants: v.variants, limit: v.limit }])),
  small: c.small_model, subagent: c.subagent_model,
});
t("R12 部署副本与模板路由逐字段一致（零漂移）", pick(cfg) === pick(tmpl), pick(cfg) === pick(tmpl) ? "" : "DRIFT");

const v = cfg.agent.verify;
t("R13 verify 座席视觉可用", (reg[String(v.model).split("/").pop()]?.modalities?.input ?? []).includes("image"), `${v.model}@${v.variant}`);
t("R13b verify description 含 qwen 异源守卫", /qwen4-max/.test(v.description ?? "") && /降级复核/.test(v.description ?? ""));

// R13c：verify 只读契约的写通道静态补全（2026-11-17 P2-6）。断言 SSOT 模板而非部署
// 副本——本次整改明确不改 ~/.config/kilo，部署侧由 install 下发后继承；detail 会点名
// 部署副本仍缺的键，便于下发后复核。
const VERIFY_WRITE_CHANNELS = ["kilo_memory_save", "mem_add", "mem_cite", "mem_flag", "todowrite"];
const tmplVerifyPerm = tmpl.agent?.verify?.permission ?? {};
const deployedVerifyPerm = cfg.agent?.verify?.permission ?? {};
const missingVerifyDeny = VERIFY_WRITE_CHANNELS.filter((k) => tmplVerifyPerm[k] !== "deny");
const deployedMissingDeny = VERIFY_WRITE_CHANNELS.filter((k) => deployedVerifyPerm[k] !== "deny");
t(
  "R13c verify 写通道全禁（模板 SSOT）",
  missingVerifyDeny.length === 0,
  missingVerifyDeny.length
    ? missingVerifyDeny.join(",")
    : (deployedMissingDeny.length ? `部署副本待下发: ${deployedMissingDeny.join(",")}` : ""),
);

const distPath = path.join(ROOT, "provider", "hx-failover", "dist", "index.js");
const distOk = fs.existsSync(distPath) && /specificationVersion\s*=\s*"v3"/.test(fs.readFileSync(distPath, "utf8"));
t("R14 provider 声明 LanguageModel spec v3（v2 会丢 finishReason/usage）", distOk, distOk ? "" : "dist 缺失或非 v3");

// 运行时钉选优先于 agent.*.model（HISTORY 实证教训）：确认没有静默覆盖本次路由
const stateDir = path.join(HOME, ".local", "state", "kilo");
const pinIssues = [];
for (const f of ["model.json", "vscode-model.json"]) {
  const p = path.join(stateDir, f);
  if (!fs.existsSync(p)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    for (const [slot, val] of Object.entries(j.model ?? {})) {
      const mid = String(val?.modelID ?? val ?? "").split("/").pop();
      const want = String(cfg.agent?.[slot]?.model ?? "").split("/").pop();
      if (mid && want && mid !== want) pinIssues.push(`${f}:${slot}=${mid} 覆盖配置 ${want}`);
    }
    const pref = j.preferred?.modelID;
    if (pref && !reg[pref]) pinIssues.push(`${f}:preferred=${pref} 不在注册表`);
  } catch (e) { pinIssues.push(`${f} 解析失败: ${e.message}`); }
}
t("R15 运行时钉选未覆盖路由（model.json/vscode-model.json）", pinIssues.length === 0, pinIssues.join(" | "));

console.log(`\n[audit-config] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
