// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：plugin/hx-client.ts（与 dual-review.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 配置：kilo.json -> provider.hx.options.moa.{references,aggregator}；凭证：auth.json 的 hx.key。

import { loadCfg, ask, FALLBACK_TIMEOUT_MS } from "./hx-client";

const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）

// 超时统一走配置 provider.hx.options.timeout（与主链路/dual-review 同口径）；
// 兜底值取 hx-client 共享常量 FALLBACK_TIMEOUT_MS（缺失/非法时 120s）

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

          // 模型唯一真源 = kilo.json provider.hx.options.moa（改模型只改配置文件，代码不留兜底默认值）
          const cfgMoa = cfg.options?.moa ?? {};
          const refs = (Array.isArray(args?.references) && args.references.length
            ? args.references
            : (Array.isArray(cfgMoa.references) ? cfgMoa.references : [])
          )
            .filter((m) => typeof m === "string" && m)
            .slice(0, MAX_REFS);
          const aggregator = typeof args?.aggregator === "string" && args.aggregator
            ? args.aggregator
            : (typeof cfgMoa.aggregator === "string" ? cfgMoa.aggregator : "");

          if (refs.length === 0 || !aggregator) {
            return "moa: 参考模型/聚合模型未配置——请在 kilo.json 的 provider.hx.options.moa 配置 references 与 aggregator（模型唯一真源在配置文件，代码不留兜底默认值）";
          }

          const timeoutMs = Number(cfg.options?.timeout) > 0 ? Number(cfg.options.timeout) : FALLBACK_TIMEOUT_MS;

          const settled = await Promise.allSettled(
            refs.map((m) => ask({ baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: task, timeoutMs }))
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
              timeoutMs,
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
