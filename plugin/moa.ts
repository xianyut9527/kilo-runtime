// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：lib/hx-client.ts（与 dual-review.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 配置：kilo.json -> provider.hx.options.moa.{references,aggregator}；凭证：auth.json 的 hx.key。
//
// 2026-09-18 性能改造：
//   - 全链路 SSE 流式（hx-client.ask 内置），首 token 即可见；
//   - ctx.metadata({title}) 实时刷新工具卡标题（Kilo SessionProcessor.metadata 支持 running 态 title 更新，
//     已从 kilo.exe 源码反编译确认：state.title=kH.title??…）；
//   - 聚合阶段对超长参考结论截断（每路 12k 字符），防聚合 prompt 超上下文导致二次长等待；
//   - 每路参考的耗时/字数进入结果报告，可观测性对齐。
//
// 2026-09-22 可见性修复（用户实测：工具卡全程只显示 "moa"，无任何进度）：
//   - 根因：setTitle 只由 onDelta 触发 —— 上游一个 chunk 都没吐（过载/断流）时
//     ctx.metadata 从未被调用，卡片停留在默认标题；且分路状态不可见。
//   - 启动即写标题（不等首 chunk）：「MoA 启动：<模型列表>」；
//   - 每路独立计数（字数/✓完成/✗失败）合成单行标题，实时看各路差异；
//   - 聚合阶段立即切换标题，不再等待聚合首个 chunk；
//
// 2026-09-22 进度通道根因修复（用户二次实测仍黑盒）：
//   - ctx.metadata 在 server 7.7.6 中不存在（execute 第二参数只有 toolCallId/messages/
//     abortSignal/experimental_context），此前所有 title 更新被静默吞掉；
//   - 改走 preliminary 流：execute 返回 bridgeProgress async generator，每个 yield 的
//     中文进度文本流式显示在工具卡正文（不进对话历史），最后 yield 最终结果；
//   - 进度文本全面中文化（用户反馈 "moa"/"dual_review" 不语义化）。
//   - 三修（工具路径实测 f.split 崩溃，与 dual-review 同根因）：execute 曾为 async——
//     Promise 包装使 kilo a5$ 判非 iterable，generator 对象被当 final output 下发致下游
//     崩溃；execute 必须 sync 返回 iterable（契约红线详见 lib/hx-client.ts 注释）。

import { loadCfg, ask, FALLBACK_TIMEOUT_MS, FALLBACK_CHUNK_TIMEOUT_MS, circuitState, bridgeProgress } from "../lib/hx-client";

const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）
const AGG_VIEW_LIMIT = 12_000; // 聚合 prompt 单路参考截断上限（字符）
const MAX_TASK_CHARS = 50_000; // 任务输入上限：防无界文本多次灌入上游（成本/上下文）

// 进度发射助手：emit 存在（工具路径，bridgeProgress 注入）时转发流式进度；
// 不存在（异常降级路径）时静默——节流由 bridgeProgress 统一处理。
function makeTitle(emit, label) {
  return async (text, force) => {
    if (typeof emit !== "function") return;
    emit(String(text || label), force);
  };
}

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
        // ⚠️ 不得改为 async（2026-09-22 f.split 工具崩溃根因，kilo.exe a5$ 逆向 + 17ms 复现实证）：
        // kilo 消费端先同步检查 execute 返回值是否带 Symbol.asyncIterator（preliminary 流式契约）；
        // async 函数返回 Promise<AsyncGenerator> 不带该属性 → generator 对象被 await 后当
        // final output 整体下发，下游渲染对它取字段得 undefined 再 .split →
        // "undefined is not an object (evaluating 'f.split')"（必现、与参数无关）。
        // 含 await 的逻辑与快速失败路径全部移入 run 函数，early-return 字符串成为唯一（final）yield。
        execute(args, ctx) {
          return bridgeProgress((emit) => (async () => {
          const t0 = Date.now();
          const cfg = await loadCfg();
          let task = String(args?.task ?? "").trim();
          if (!task) return "moa: 缺少 task 参数";
          // 输入上限：超长任务截断并内联标注（截断事实随 prompt 可见，聚合模型知道输入是残件）
          if (task.length > MAX_TASK_CHARS) {
            task = task.slice(0, MAX_TASK_CHARS) + `\n（截断：原始 ${task.length} 字符）`;
          }

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

          const totalMs = Number(cfg.options?.timeout) > 0 ? Number(cfg.options.timeout) : FALLBACK_TIMEOUT_MS;
          // 空闲看门狗：与主链路 chunkTimeout 同源（流式中 X ms 无新 chunk 即判死，快速失败进重试）
          const idleMs = Number(cfg.options?.chunkTimeout) > 0 ? Number(cfg.options.chunkTimeout) : FALLBACK_CHUNK_TIMEOUT_MS;

          // 断路器预检（2026-09-22 网关过载专项）：网关 open 态时 2-3 路并行 = 对过载网关的
          // 集体施压 + 每路 8-15s 空烧。fail fast 并给用户明确信号（等恢复 vs 换时段重试）。
          if (circuitState() === "open") {
            return "moa: 上游网关断路器开启（近期连续 503 过载）——并行请求会加剧过载，请约 30s 后重试，或稍后再跑本任务。";
          }

            const setTitle = makeTitle(emit, `【多模型协作】参考并行中`);

            // 分路进度账本：单行进度聚合各路状态（生成中：N字… / 完成：✓N字 / 失败：✗）
            const kb = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
            const refState = refs.map((m) => ({ model: m, chars: 0, done: false, failed: false, t0: 0, ms: 0 }));
            const renderRefs = (prefix, force) => {
              const line = refState
                .map((s) => `${s.model} ${s.failed ? "✗" : s.done ? `✓${kb(s.chars)}字` : `${kb(s.chars)}字…`}`)
                .join(" | ");
              return setTitle(`${prefix} ${line}`, force);
            };

            // 参考阶段：启动即发进度（不等首 chunk——断流/过载时这里是唯一的可见反馈），
            // 各路 onDelta 更新自己的计数；promise 落定即打 ✓/✗，不等整批 allSettled。
            await renderRefs(`【多模型协作】启动（${refs.length} 路并行）：`, true);
            const promises = refs.map((m, i) => {
              refState[i].t0 = Date.now();
              const p = ask({
                baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: task,
                timeoutMs: totalMs, idleMs,
                onDelta: (_d, total) => { refState[i].chars = total; renderRefs(`【多模型协作】${refs.length} 路并行`); },
              });
              p.then(
                () => { refState[i].done = true; refState[i].ms = Date.now() - refState[i].t0; renderRefs(`【多模型协作】${refs.length} 路并行`, true); },
                () => { refState[i].failed = true; refState[i].ms = Date.now() - refState[i].t0; renderRefs(`【多模型协作】${refs.length} 路并行`, true); },
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
                perf.push(`${refs[i]}：${r.value.length} 字 / ${(refState[i].ms / 1000).toFixed(1)}s`);
              } else {
                failures.push(`${refs[i]}: ${r.reason?.message ?? r.reason}（${(refState[i].ms / 1000).toFixed(1)}s）`);
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

            const aggTitle = makeTitle(emit, `【多模型协作】聚合中`);
            // 聚合阶段切换进度不等待首 chunk：参考阶段的结果差异（成功/失败数）立刻可见
            await aggTitle(`【多模型协作】参考完成 ${views.length}/${refs.length} → 聚合中（${aggregator}）`, true);
            let conclusion;
            try {
              conclusion = await ask({
                baseURL: cfg.baseURL,
                key: cfg.key,
                model: aggregator,
                prompt: aggregatePrompt,
                timeoutMs: totalMs,
                idleMs,
                onDelta: (_d, total) => aggTitle(`【多模型协作】聚合生成中 ${total} 字`),
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

            await aggTitle(`【多模型协作】完成`, true);
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
          })());
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
