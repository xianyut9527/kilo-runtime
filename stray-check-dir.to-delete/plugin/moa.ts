// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：lib/hx-client.ts（与 dual-review.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 配置：kilo.json -> provider.hx.options.moa.{references,aggregator}；凭证：auth.json 的 hx.key。
//
// 2026-09-22 终裁：插件工具无 UI 进度通道——ctx.metadata（server 7.7.6 不存在）、
// preliminary/asyncIterator 流式卡、stderr（落 server 进程调试日志，视图不可见）
// 三次证伪（契约细节见 lib/hx-client.ts）。进度机制已整体拆除；
// 可观测性由结果字符串自带（总耗时/每路字数与耗时/参与模型）。
// 同日 execute 契约钉死：必须返回 Promise<string>——async 函数原生满足。

import { loadCfg, ask, circuitState, timeoutsOf, clipText } from "../lib/hx-client";

const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）
const AGG_VIEW_LIMIT = 12_000; // 聚合 prompt 单路参考截断上限（字符）
const MAX_TASK_CHARS = 50_000; // 任务输入上限：防无界文本多次灌入上游（成本/上下文）

const MoaImpl = async () => {
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
        // ⚠️ execute 契约（2026-09-22 两次工具路径崩溃实证钉死，详见 lib/hx-client.ts
        // 契约注释）：必须返回 Promise<string>——async 函数原生满足。
        async execute(args) {
          const t0 = Date.now();
          const cfg = await loadCfg();
          let task = String(args?.task ?? "").trim();
          if (!task) return "moa: 缺少 task 参数";
          // 输入上限：超长任务截断并内联标注（截断事实随 prompt 可见，聚合模型知道输入是残件）
          task = clipText(task, MAX_TASK_CHARS);

          // 模型唯一真源 = kilo.json provider.hx.options.moa（改模型只改配置文件，代码不留兜底默认值）
          const cfgMoa = cfg.options?.moa ?? {};
          // 去重后再截断：["m","m","m"] 这类重复配置/参数不得绕过 MAX_REFS 成本红线（审查必须项）
          const refs = [...new Set(
            (Array.isArray(args?.references) && args.references.length
              ? args.references
              : (Array.isArray(cfgMoa.references) ? cfgMoa.references : [])
            )
              .filter((m) => typeof m === "string" && m)
          )].slice(0, MAX_REFS);
          const aggregator = typeof args?.aggregator === "string" && args.aggregator
            ? args.aggregator
            : (typeof cfgMoa.aggregator === "string" ? cfgMoa.aggregator : "");

          if (refs.length === 0 || !aggregator) {
            return "moa: 参考模型/聚合模型未配置——请在 kilo.json 的 provider.hx.options.moa 配置 references 与 aggregator（模型唯一真源在配置文件，代码不留兜底默认值）";
          }

          // 超时/空闲看门狗：timeoutsOf 单点解析（kilo.json provider.hx.options，缺省回退共享兜底）
          const { timeoutMs: totalMs, idleMs } = timeoutsOf(cfg.options);

          // 断路器预检（2026-09-22 网关过载专项）：网关 open 态时 2-3 路并行 = 对过载网关的
          // 集体施压 + 每路 8-15s 空烧。fail fast 并给用户明确信号（等恢复 vs 换时段重试）。
          if (circuitState() === "open") {
            return "moa: 上游网关断路器开启（近期连续 503 过载）——并行请求会加剧过载，请约 30s 后重试，或稍后再跑本任务。";
          }

          // 分路计时账本：结果报告的「产出规模」行用（每路在各自 promise 落定时记时，
          // 不随最慢路膨胀）
          const durations = refs.map(() => 0);
          const promises = refs.map((m, i) => {
            const t0m = Date.now();
            const p = ask({
              baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: task,
              timeoutMs: totalMs, idleMs,
            });
            p.then(
              () => { durations[i] = Date.now() - t0m; },
              () => { durations[i] = Date.now() - t0m; },
            );
            return p;
          });
          const settled = await Promise.allSettled(promises);

            const views = [];
            const failures = [];
            const perf = [];
            settled.forEach((r, i) => {
              if (r.status === "fulfilled") {
                views.push({ model: refs[i], text: r.value });
                perf.push(`${refs[i]}：${r.value.length} 字 / ${(durations[i] / 1000).toFixed(1)}s`);
              } else {
                failures.push(`${refs[i]}: ${r.reason?.message ?? r.reason}（${(durations[i] / 1000).toFixed(1)}s）`);
              }
            });

            if (views.length === 0) {
              return `moa: 所有参考模型失败\n${failures.join("\n")}`;
            }

            // 聚合阶段：截断超长参考（clipText 内联标注残件事实），防聚合 prompt 爆上下文
            const clipped = views.map((v) => ({ ...v, text: clipText(v.text, AGG_VIEW_LIMIT) }));

            const aggregatePrompt = [
              "你是聚合器。下面是同一任务由多个模型给出的独立分析。",
              "综合它们，输出一份更可靠的结论：保留有共识的部分，指出分歧并给出你的取舍与理由；不要简单罗列各家观点。",
              "",
              `## 任务\n${task}`,
              "",
              ...clipped.map((v) => `## 参考模型 ${v.model}\n${v.text}`),
            ].join("\n");

            let conclusion;
            try {
              conclusion = await ask({
                baseURL: cfg.baseURL,
                key: cfg.key,
                model: aggregator,
                prompt: aggregatePrompt,
                timeoutMs: totalMs,
                idleMs,
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

// never-throw 包装（爆炸半径收口，2026-09-22）：工厂抛错会导致 Kilo 插件注册表留洞 →
// config hook 级联 → provider 列表全挂 → 模型选择器空。工厂期异常只禁用本插件。
export const Moa = async (ctx = {}) => {
  try {
    return await MoaImpl(ctx);
  } catch (e) {
    console.error("[moa] init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};
