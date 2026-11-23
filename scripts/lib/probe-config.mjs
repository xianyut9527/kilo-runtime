// 探针共享配置加载（probe-models / probe-cache 共用；只读、不联网、不回显 key）。
// 口径与 lib/hx-client 一致：kilo.json 读部署副本，key 不在 kilo.json（provider 只有
// name/npm/options/models），按 openllamas.key（fallback hx.key）从 auth.json 取；
// 数据目录与 kilo.db / failover-events.jsonl 同根（XDG_DATA_HOME 优先）。
// 调用方负责在 key/baseURL 缺失时给出自己的诊断输出并退出。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadProbeConfig() {
  const cfgPath = path.join(os.homedir(), ".config", "kilo", "kilo.json");
  const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
  const cfg = JSON.parse(raw);
  const prov = cfg.provider && cfg.provider.openllamas;
  const opts = prov?.options || {};
  const baseURL = String(prov?.baseURL || opts.baseURL || "").replace(/\/+$/, "");

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

  return { cfgPath, cfg, prov, opts, baseURL, key, authPath };
}

export function probeHeaders(key) {
  return { Authorization: "Bearer " + key, "Content-Type": "application/json" };
}
