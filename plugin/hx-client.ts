// hx 上游客户端共享层（W3.8）：moa.ts 与 dual-review.ts 的公共依赖。
// 集中：配置目录/数据目录定位、kilo.json options + auth.json hx.key 读取（60s 缓存）、
// OpenAI-compatible 非流式请求（AbortSignal 超时、错误信息收敛）。
// ⚠️ 改动凭证布局或 baseURL 规则时只改这里；两处调用方不再各自维护副本。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.KILO_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kilo");
const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kilo");
export const CFG_TTL_MS = 60_000;

let cfgCache = null;
let cfgCacheAt = 0;

export async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < CFG_TTL_MS) return cfgCache;
  const kilo = JSON.parse(await readFile(join(CONFIG_DIR, "kilo.json"), "utf8"));
  const opts = kilo?.provider?.hx?.options ?? {};
  const auth = JSON.parse(await readFile(join(DATA_DIR, "auth.json"), "utf8"));
  const key = auth?.hx?.key;
  if (!opts.baseURL) throw new Error("hx-client: provider.hx.options.baseURL 未配置");
  if (!key) throw new Error("hx-client: auth.json 缺少 hx.key（请先登录/配置 hx provider）");
  cfgCache = { baseURL: String(opts.baseURL).replace(/\/+$/, ""), key, options: opts };
  cfgCacheAt = Date.now();
  return cfgCache;
}

export async function ask({ baseURL, key, model, prompt, timeoutMs }) {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${model} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (typeof text !== "string" || !text) throw new Error(`${model}: 空响应`);
  return text;
}