// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：零依赖，直接 fetch OpenAI-compatible /chat/completions（不 import AI SDK，避免 plugin runtime 解析问题）。
// 配置：kilo.json -> provider.hx.options.moa.{references,aggregator}；凭证：auth.json 的 hx.key。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// 配置目录支持 KILO_CONFIG_DIR 覆盖（install --target 自定义部署时也不至于读不到配置）
const CONFIG_DIR = process.env.KILO_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kilo");
const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kilo");
const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）
const TIMEOUT_MS = 120000;
const CFG_TTL_MS = 60_000; // 配置缓存 60s：改配置后最多 1 分钟生效，无需重启

let cfgCache = null;
let cfgCacheAt = 0;

async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < CFG_TTL_MS) return cfgCache;
  const kilo = JSON.parse(await readFile(join(CONFIG_DIR, "kilo.json"), "utf8"));
  const opts = kilo?.provider?.hx?.options ?? {};
  const auth = JSON.parse(await readFile(join(DATA_DIR, "auth.json"), "utf8"));
  const key = auth?.hx?.key;
  if (!opts.baseURL) throw new Error("moa: provider.hx.options.baseURL 未配置");
  if (!key) throw new Error("moa: auth.json 缺少 hx.key（请先登录/配置 hx provider）");
  cfgCache = {
    baseURL: String(opts.baseURL).replace(/\/+$/, ""),
    key,
    references: opts?.moa?.references ?? ["glm-5.2", "deepseek-v4.1-flash"],
    aggregator: opts?.moa?.aggregator ?? "kimi-k2.6",
  };
  cfgCacheAt = Date.now();
  return cfgCache;
}

async function ask({ baseURL, key, model, prompt }) {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

export const Moa = async () => {
  return {
    tool: {
      moa: {
        description:
          "Mixture-of-Agents：把同一任务并发交给多个参考模型，再由聚合模型综合出一份结论。仅在需要多视角交叉判断（高风险决策、疑难排错、方案取舍）时按需调用；常规任务不要调用（成本敏感）。",
        args: {
          task: { type: "string", description: "交给多模型分析的任务描述（含必要上下文与约束）" },
          references: {
            type: "array",
            description: `参考模型 id 列表（可选，默认取配置；最多 ${MAX_REFS} 个）`,
            items: { type: "string" },
          },
          aggregator: { type: "string", description: "聚合模型 id（可选，默认取配置）" },
        },
        async execute(args) {
          const cfg = await loadCfg();
          const task = String(args?.task ?? "").trim();
          if (!task) return "moa: 缺少 task 参数";

          const refs = (Array.isArray(args?.references) && args.references.length
            ? args.references
            : cfg.references
          )
            .filter((m) => typeof m === "string" && m)
            .slice(0, MAX_REFS);
          const aggregator = typeof args?.aggregator === "string" && args.aggregator
            ? args.aggregator
            : cfg.aggregator;

          if (refs.length === 0) return "moa: references 为空";

          const settled = await Promise.allSettled(
            refs.map((m) => ask({ baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: task }))
          );

          const views = [];
          const failures = [];
          settled.forEach((r, i) => {
            if (r.status === "fulfilled") views.push({ model: refs[i], text: r.value });
            else failures.push(`${refs[i]}: ${r.reason?.message ?? r.reason}`);
          });

          if (views.length === 0) {
            return `moa: 所有参考模型失败\n${failures.join("\n")}`;
          }

          const aggregatePrompt = [
            "你是聚合器。下面是同一任务由多个模型给出的独立分析。",
            "综合它们，输出一份更可靠的结论：保留有共识的部分，指出分歧并给出你的取舍与理由；不要简单罗列各家观点。",
            "",
            `## 任务\n${task}`,
            "",
            ...views.map((v) => `## 参考模型 ${v.model}\n${v.text}`),
          ].join("\n");

          let conclusion;
          try {
            conclusion = await ask({
              baseURL: cfg.baseURL,
              key: cfg.key,
              model: aggregator,
              prompt: aggregatePrompt,
            });
          } catch (e) {
            // 聚合失败也要返回可用结果（不丢参考视角）
            return [
              `moa: 聚合模型（${aggregator}）失败：${e.message}`,
              "",
              "以下为各参考模型原始结论：",
              ...views.map((v) => `### ${v.model}\n${v.text}`),
              failures.length ? `\n（未参与模型）${failures.join("; ")}` : "",
            ].join("\n");
          }

          return [
            `## MoA 结论（聚合模型：${aggregator}）`,
            conclusion,
            "",
            `## 参与参考模型（${views.map((v) => v.model).join(", ")}）`,
            failures.length ? `## 失败/未参与：${failures.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
    },
  };
};
