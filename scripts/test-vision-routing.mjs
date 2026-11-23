#!/usr/bin/env node
// 视觉路由回归（2026-11-14 视觉修复）：不联网，只读仓库模板 kilo.json.tmpl 断言结构与实证事实。
// 背景：实弹探测（红色 PNG data URI → /chat/completions，probe-models.mjs --vision）确认 8 模型里
// glm-5.3 网关纯文本（首探带图 400 code 1210；同日复探 200 但自述「无法看到图片」——200 ≠ 能看图），
// 其余 7 个 VISION-OK；Kilo 对未声明 modalities 的自定义模型按 text-only 处理并剥图
//（kilocode#10102）。本测试把「盲模型不得进收图岗位」固化为永久断言。
// 用法：node scripts/test-vision-routing.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

// 与 test-dual-review-budget 同款 JSONC 清洗（行注释 + 尾逗号）
const raw = fs.readFileSync(path.join(ROOT, "kilo.json.tmpl"), "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/,\s*([}\]])/g, "$1");
const cfg = JSON.parse(raw);
const prov = cfg.provider.openllamas;
const reg = prov.models;
const opts = prov.options;

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  try {
    const v = typeof cond === "function" ? cond() : cond;
    if (v) pass++;
    else { fail++; failed.push(name); console.error(`  FAIL: ${name}`); }
  } catch (e) {
    fail++; failed.push(name); console.error(`  FAIL(throw): ${name}（${String(e?.message ?? e)}）`);
  }
};

const regIds = Array.isArray(reg) ? reg.map((m) => m.id ?? m) : Object.keys(reg);
const entry = (id) => (Array.isArray(reg) ? reg.find((m) => (m.id ?? m) === id) : reg[id]);
const norm = (v) => (typeof v === "string" ? v.replace(/^openllamas\//, "") : "");
const inputs = (id) => (entry(id)?.modalities?.input) ?? [];
const canSee = (id) => inputs(id).includes("image");
const hasAttachment = (id) => entry(id)?.attachment === true;

// ── 实证事实（2026-11-14 实弹；换型时按新探测更新本组）──
t("qwen4-max 声明图像输入（实弹 VISION-OK）", () => canSee("qwen4-max"));
t("qwen4-max attachment:true（UI 附件可用）", () => hasAttachment("qwen4-max"));
t("glm-5.3 显式 text-only（实弹带图 400 / 复探 200 自述失明）", () => {
  const i = inputs("glm-5.3");
  return i.length === 1 && i[0] === "text";
});
t("glm-5.3 attachment:false（text-only 不得挂图）", () => entry("glm-5.3")?.attachment === false);

// ── 结构不变式（换型自动跟随，只锁能力口径不锁型号）──
t("所有注册模型显式声明 modalities（防未声明被当 text-only 剥图）",
  () => regIds.every((id) => Array.isArray(inputs(id)) && inputs(id).length > 0));
t("所有可收图模型 attachment:true（docs 要求同设）",
  () => regIds.filter(canSee).every((id) => hasAttachment(id)));
t("failover 链全部模型具备图像输入（视觉任务双跳降级不剥图/400）",
  () => (opts.failover?.chain?.models ?? []).length > 0 &&
    opts.failover.chain.models.every(canSee));
t("failover 链不含纯文本模型 glm-5.3（本次修复的直接回归）",
  () => !(opts.failover?.chain?.models ?? []).includes("glm-5.3"));
t("所有 agent 路由模型具备图像输入（无盲岗位）",
  () => Object.values(cfg.agent ?? {}).every((a) => !a.model || canSee(norm(a.model))));
t("verify 复核位视觉可用（视觉复核不失明）",
  () => canSee(norm(cfg.agent?.verify?.model)));
t("所有路由引用的模型均在注册表（防悬空引用）", () => {
  const ids = new Set();
  for (const a of Object.values(cfg.agent ?? {})) if (a.model) ids.add(norm(a.model));
  for (const m of opts.failover?.chain?.models ?? []) ids.add(m);
  for (const m of opts.moa?.references ?? []) ids.add(m);
  if (opts.moa?.aggregator) ids.add(opts.moa.aggregator);
  for (const m of opts.moa?.aggregator_fallbacks ?? []) ids.add(m);
  for (const k of ["positive", "negative", "aggregator"]) {
    if (opts.dual_review?.[k]) ids.add(opts.dual_review[k]);
    for (const m of opts.dual_review?.[`${k}_fallbacks`] ?? []) ids.add(m);
  }
  return [...ids].every((id) => regIds.includes(id));
});
t("引用模型合计 ≤5（tmpl ≤5 约束，注册表条目不计入）", () => {
  const ids = new Set();
  for (const a of Object.values(cfg.agent ?? {})) if (a.model) ids.add(norm(a.model));
  for (const m of opts.failover?.chain?.models ?? []) ids.add(m);
  for (const m of opts.moa?.references ?? []) ids.add(m);
  if (opts.moa?.aggregator) ids.add(opts.moa.aggregator);
  for (const m of opts.moa?.aggregator_fallbacks ?? []) ids.add(m);
  for (const k of ["positive", "negative", "aggregator"]) {
    if (opts.dual_review?.[k]) ids.add(opts.dual_review[k]);
    for (const m of opts.dual_review?.[`${k}_fallbacks`] ?? []) ids.add(m);
  }
  console.log(`  引用集合(${ids.size}): ${[...ids].join(", ")}`);
  return ids.size <= 5;
});

console.log(`\n[test-vision-routing] ${pass} passed, ${fail} failed`);
if (fail) { console.error("FAILED:", failed.join("; ")); process.exit(1); }
