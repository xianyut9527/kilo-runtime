// 路由健康双验证探针（只读，不回显 key；仓库工具，非下发资产）
// 用法：node scripts/probe-models.mjs <model[@effort]> [more...]
//   ① 无参打印 /v1/models 在册清单；② 逐个实弹探测参数里的模型。
// 在册 ≠ 可路由（2026-10-27 qwen3.8-max 在册仍 404 实证；2026-11-12 单日 404 亦可能只是
// 暂时性渠道故障，2026-11-13 复测全部恢复）——死跳/复活判定以本探针实弹结果为地面真值，
// 路由配置改动（kilo.json.tmpl 座席/failover 链）前后各跑一次对照。
// 支持 "model@effort" 语法：@后缀映射为请求体 reasoning_effort（变体可路由性验证）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgPath = path.join(os.homedir(), ".config", "kilo", "kilo.json");
const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
const cfg = JSON.parse(raw);
const prov = cfg.provider && cfg.provider.openllamas;
if (!prov) {
  console.log("NO_PROVIDER, provider keys:", Object.keys(cfg.provider || {}));
  process.exit(1);
}
console.log("provider fields:", Object.keys(prov).join(","));
const opts = prov.options || {};
const baseURL = String(prov.baseURL || opts.baseURL || "").replace(/\/+$/, "");
// key 不在 kilo.json（provider 只有 name/npm/options/models）：按 hx-client 同口径从 auth.json 取
// openllamas.key（fallback hx.key），数据目录与 kilo.db / failover-events.jsonl 同根
const dataDirs = [
  process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, "kilo"),
  path.join(os.homedir(), ".local", "share", "kilo"),
  path.join(os.homedir(), ".config", "kilo"),
].filter(Boolean);
let key = "";
let authPath = "";
for (const d of dataDirs) {
  const p = path.join(d, "auth.json");
  if (!fs.existsSync(p)) continue;
  try {
    const auth = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    key = (auth && ((auth.openllamas && auth.openllamas.key) || (auth.hx && auth.hx.key))) || "";
    if (key) { authPath = p; break; }
  } catch { /* 下一个候选 */ }
}
console.log("baseURL:", baseURL, "| keyFound:", Boolean(key), "| authPath:", authPath);
if (!baseURL || !key) process.exit(1);
const H = { Authorization: "Bearer " + key, "Content-Type": "application/json" };

// ① 在册清单
try {
  const r = await fetch(baseURL + "/models", { headers: { Authorization: H.Authorization } });
  const j = await r.json();
  const ids = (j.data || []).map((x) => x.id).sort();
  console.log("=== /v1/models (" + ids.length + ") ===");
  console.log(ids.join("\n"));
} catch (e) {
  console.log("models list failed:", String((e && e.message) || e));
}

// ② 实弹探测（参数即待测模型，顺序执行防压网关）
for (const spec of process.argv.slice(2)) {
  const at = spec.indexOf("@");
  const m = at === -1 ? spec : spec.slice(0, at);
  const effort = at === -1 ? null : spec.slice(at + 1);
  const body = {
    model: m,
    messages: [{ role: "user", content: "只回复两个字母：OK" }],
    max_tokens: 1024,
    stream: false,
  };
  if (effort) body.reasoning_effort = effort;
  const label = effort ? `${m}@${effort}` : m;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("probe-timeout-45s")), 45000);
    const r = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const c = j.choices && j.choices[0];
      const txt = String((c && c.message && c.message.content) || "").trim().slice(0, 40);
      console.log(`ALIVE  ${label}  ${ms}ms  finish=${c && c.finish_reason}  reply=${JSON.stringify(txt)}`);
    } else {
      const body2 = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
      console.log(`DEAD   ${label}  HTTP ${r.status}  ${ms}ms  ${body2}`);
    }
  } catch (e) {
    console.log(`ERR    ${label}  ${Date.now() - t0}ms  ${String((e && e.message) || e).slice(0, 120)}`);
  }
}
