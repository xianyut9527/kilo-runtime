// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：plugin/hx-client.ts（与 dual-review.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 配置：kilo.json -> provider.hx.options.moa.{references,aggregator}；凭证：auth.json 的 hx.key。
//
// 2026-09-18 性能改造：
//   - 全链路 SSE 流式（hx-client.ask 内置），首 token 即可见；
//   - ctx.metadata({title}) 实时刷新工具卡标题（Kilo SessionProcessor.metadata 支持 running 态 title 更新，
//     已从 kilo.exe 源码反编译确认：state.title=kH.title??…）；
//   - 聚合阶段对超长参考结论截断（每路 12k 字符），防聚合 prompt 超上下文导致二次长等待；
//   - 每路参考的耗时/字数进入结果报告，可观测性对齐。

import { loadCfg, ask, FALLBACK_TIMEOUT_MS } from "./hx-client";

const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）
const AGG_VIEW_LIMIT = 12_000; // 聚合 prompt 单路参考截断上限（字符）
const TITLE_THROTTLE_MS = 800; // 标题刷新节流（防高频 metadata 调用）

// 进度标题助手：把调用方已格式化的进度消息写进工具卡。失败静默（老版本无此能力时退化为无进度）。
function makeTitle(ctx, label) {
  let last = 0;
  return async (text) => {
    if (!ctx || typeof ctx.metadata !== "function") return;
    const now = Date.now();
    if (now - last < TITLE_THROTTLE_MS && text) return;
    last = now;
    try {
      await ctx.metadata({ title: text || label });
    } catch { /* metadata 不可用则静默 */ }
  };
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
        async execute(args, ctx) {
          const t0 = Date.now();
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

          const totalMs = Number(cfg.options?.timeout) > 0 ? Number(cfg.options.timeout) : FALLBACK_TIMEOUT_MS;
          // 空闲看门狗：与主链路 chunkTimeout 同源（流式中 X ms 无新 chunk 即判死，快速失败进重试）
          const idleMs = Number(cfg.options?.chunkTimeout) > 0 ? Number(cfg.options.chunkTimeout) : 60_000;

          const setTitle = makeTitle(ctx, `MoA 参考并行中`);

          // 参考阶段：并行 + 各路流式进度
          const settled = await Promise.allSettled(
            refs.map((m) => ask({
              baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: task,
              timeoutMs: totalMs, idleMs,
              onDelta: (_d, total) => setTitle(`MoA ${refs.length} 路并行生成中（单路已收 ${total} 字）`),
            }))
          );

          const views = [];
          const failures = [];
          const perf = [];
          settled.forEach((r, i) => {
            if (r.status === "fulfilled") {
              views.push({ model: refs[i], text: r.value });
              perf.push(`${refs[i]}：${r.value.length} 字`);
            } else {
              failures.push(`${refs[i]}: ${r.reason?.message ?? r.reason}`);
            }
          });

          if (views.length === 0) {
            return `moa: 所有参考模型失败\n${failures.join("\n")}`;
          }

          // 聚合阶段：截断超长参考，防聚合 prompt 爆上下文
          const clipped = views.map((v) => ({
            ...v,
            text: v.text.length > AGG_VIEW_LIMIT
              ? v.text.slice(0, AGG_VIEW_LIMIT) + `\n（截断：原始 ${v.text.length} 字符）`
              : v.text,
          }));

          const aggregatePrompt = [
            "你是聚合器。下面是同一任务由多个模型给出的独立分析。",
            "综合它们，输出一份更可靠的结论：保留有共识的部分，指出分歧并给出你的取舍与理由；不要简单罗列各家观点。",
            "",
            `## 任务\n${task}`,
            "",
            ...clipped.map((v) => `## 参考模型 ${v.model}\n${v.text}`),
          ].join("\n");

          const aggTitle = makeTitle(ctx, `MoA 聚合（${aggregator}）`);
          let conclusion;
          try {
            conclusion = await ask({
              baseURL: cfg.baseURL,
              key: cfg.key,
              model: aggregator,
              prompt: aggregatePrompt,
              timeoutMs: totalMs,
              idleMs,
              onDelta: (_d, total) => aggTitle(`聚合生成中 ${total} 字`),
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

          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          return [
            `## MoA 结论（聚合模型：${aggregator}，总耗时 ${elapsed}s）`,
            conclusion,
            "",
            `## 参与参考模型（${views.map((v) => v.model).join(", ")}）`,
            perf.length ? `产出规模：${perf.join("，")}` : "",
            failures.length ? `## 失败/未参与：${failures.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
    },
  };
};