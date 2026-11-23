// W3.5 MoA（Mixture-of-Agents）按需工具
// 定位：主 agent 仅在需要多视角/高风险判断时调用；绝不每轮自动 fanout（红线 R4/R9）。
// 依赖：lib/hx-client.ts（与 dual-review.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 配置：kilo.json -> provider.openllamas.options.moa.{references,aggregator}；凭证：auth.json 的 openllamas.key。
//
// 2026-09-22 终裁：插件工具无 UI 进度通道——ctx.metadata（server 7.7.6 不存在）、
// preliminary/asyncIterator 流式卡、stderr（落 server 进程调试日志，视图不可见）
// 三次证伪（契约细节见 lib/hx-client.ts）。进度机制已整体拆除；
// 可观测性由结果字符串自带（总耗时/每路字数与耗时/参与模型）。
// 同日 execute 契约钉死：必须返回 Promise<string>——async 函数原生满足。

import { loadCfg, askWithDeadline, cbShouldFailFast, timeoutsOf, clipText, modelRoutes, aggReserveOf, AGG_MIN_BUDGET_MS } from "../lib/hx-client";

const MAX_REFS = 3; // 成本上限（红线：单次最多 3 参考 + 1 聚合）
const AGG_VIEW_LIMIT = 12_000; // 聚合 prompt 单路参考截断上限（字符）
const MAX_TASK_CHARS = 50_000; // 任务输入上限：防无界文本多次灌入上游（成本/上下文）

// 视角分工（2026-11-23 多模型视角互补增强）：≥2 参考席时各席领受不同指定视角，
// 把「同一 prompt 多模型复读」升级为「分工互补 + 聚合保留分歧」。调用数不变（成本中性）。
// 内置缺省 lens 是 prompt 文本而非模型——模型唯一真源仍在配置，不违反兜底禁令。
// diversify:false 或单参考席 → 各席 prompt=task 逐字节同旧版（一键禁用通道）。
const DEFAULT_LENSES = [
  "正确性与可行性：结论/方案是否成立，逻辑与事实有无错误，关键假设是否可靠",
  "风险与边界：失败模式、边界条件、安全隐患、回归与兼容性风险",
  "替代与简化：有无更优或更简的路径，是否过度设计，被忽略的替代视角",
];
const LENS_CHAR_LIMIT = 300; // 单条 lens 入 prompt 上限（防病态配置撑爆扇出/聚合输入）

// lens 解析（纯函数，经 _export 离线回归）：
// - diversify===false 或 refCount<2 → null（旧行为）；
// - perspectives 过滤非字符串/空串、trim、去重、限长；空数组回退内置三条（图纸必修①）；
// - lens 数 < 席数时按 i%len 循环复用（输出显式标注），> 席数时多余项不使用。
function lensesOf(cfgMoa, refCount) {
  if (cfgMoa?.diversify === false || !(refCount >= 2)) return null;
  const raw = Array.isArray(cfgMoa?.perspectives) ? cfgMoa.perspectives : [];
  const cleaned = [...new Set(
    raw.filter((x) => typeof x === "string" && x.trim()).map((x) => clipText(x.trim(), LENS_CHAR_LIMIT)),
  )];
  return cleaned.length ? cleaned : DEFAULT_LENSES;
}
// 墙钟预算（2026-10-08「巨卡」专项）：插件工具无 UI 进度通道（2026-09-22 三次证伪），
// 最坏情形 = 扇出与聚合两阶段各等满一次 ask 预算（timeoutMs=480s）→ 单次 moa 卡 ~16min
// 无反馈（遥测实证 timeout_total elapsedMs=480005 / stream_break_rewrap elapsedMs=585647）。
// 修法：整个工具钉总墙钟 ≈ timeoutMs——扇出阶段共享剩余预算（超时路按普通失败处理，
// allSettled 语义不变），聚合阶段使用独立硬预留（aggregator_reserve_ms，缺省 120s、
// 上限 180s）；fallback 另享 AGG_MIN_BUDGET_MS 90s 保底。聚合超时走既有 catch 降级
//（返回原始视角清单），扇出全灭走既有「所有参考模型失败」路径。行为不新增依赖。

const MoaImpl = async (_ctx = {}) => {
  return {
    tool: {
      moa: {
        description:
          "Mixture-of-Agents：把同一任务并发交给多个参考模型，再由聚合模型综合出一份结论。≥2 参考席时各席默认按不同指定视角分工分析（moa.diversify/perspectives 可配），聚合保留分歧并裁决。仅在需要多视角交叉判断（高风险决策、疑难排错、方案取舍）时按需调用；常规任务不要调用（成本敏感）。",
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

          // 模型唯一真源 = kilo.json provider.openllamas.options.moa（改模型只改配置文件，代码不留兜底默认值）
          const cfgMoa = cfg.options?.moa ?? {};
          // 推理档位（2026-11-17 P2-4）：参考席与聚合席各自可配；空值不发送（网关默认）。
          const effortOf = (v) => (typeof v === "string" ? v.trim() : "");
          const refEffort = effortOf(cfgMoa.reference_effort);
          const aggEffort = effortOf(cfgMoa.aggregator_effort);
          // 去重后再截断：["m","m","m"] 这类重复配置/参数不得绕过 MAX_REFS 成本红线（审查必须项）
          const pin = cfg.singleModel || "";
          const refs = pin ? [pin] : [...new Set(
            (Array.isArray(args?.references) && args.references.length
              ? args.references
              : (Array.isArray(cfgMoa.references) ? cfgMoa.references : [])
            )
              .filter((m) => typeof m === "string" && m)
          )].slice(0, MAX_REFS);
          const aggregator = pin || (typeof args?.aggregator === "string" && args.aggregator
            ? args.aggregator
            : (typeof cfgMoa.aggregator === "string" ? cfgMoa.aggregator : ""));
          // per-call 覆盖视为精确指定，不再套配置 fallback。
          const aggModels = modelRoutes(
            aggregator,
            typeof args?.aggregator === "string" && args.aggregator ? [] : cfgMoa.aggregator_fallbacks,
            pin,
          );

          if (refs.length === 0 || !aggregator) {
            return "moa: 参考模型/聚合模型未配置——请在 kilo.json 的 provider.openllamas.options.moa 配置 references 与 aggregator（模型唯一真源在配置文件，代码不留兜底默认值）";
          }

          // 视角分工：lenses=null 时 refPrompt(i)===task（旧行为逐字节不变）。
          const lenses = lensesOf(cfgMoa, refs.length);
          const lensFor = (i) => lenses[i % lenses.length];
          const refPrompt = (i) => lenses
            ? `你在本次任务中的指定分析视角：${lensFor(i)}。\n请优先从该视角深入分析下面的任务（视角外的重大发现可以附带指出，但以视角内为主）。\n\n${task}`
            : task;

          // 超时/空闲看门狗：timeoutsOf 单点解析（kilo.json provider.openllamas.options，缺省回退共享兜底）
          const { timeoutMs: totalMs, idleMs } = timeoutsOf(cfg.options);

          // 断路器预检（2026-09-22 网关过载专项）：网关 open 态时 2-3 路并行 = 对过载网关的
          // 集体施压 + 每路 8-15s 空烧。fail fast 并给用户明确信号（等恢复 vs 换时段重试）。
          // ⚠️ 2026-09-25 死锁专项：必须用 cbShouldFailFast() 而非 circuitState()==="open"——
          // 冷却到期后 ask() 内的 cbAllowRequest() 才会把 open 迁移到 half-open 放 probe，
          // 预检若只看字符串 "open" 会永远拦住这次 ask()，断路器永久 open（线上实证）。
          if (cbShouldFailFast()) {
            return "moa: 上游网关断路器开启（近期连续 503 过载）——并行请求会加剧过载，请约 30s 后重试，或稍后再跑本任务。";
          }

          // 墙钟预算（2026-10-08「巨卡」专项）：插件工具无 UI 进度通道（2026-09-22 三次证伪），
          // 最坏情形 = 扇出+聚合两阶段各等满一次 ask 预算 → 单次 moa 卡 ~16min 无反馈
          //（遥测实证 timeout_total elapsedMs=480005 / stream_break_rewrap elapsedMs=585647）。
          // 整个工具钉总墙钟 ≈ timeoutMs：扇出共享完整配置预算（超时路按普通失败处理，
          // allSettled 语义不变；askWithDeadline 到点 abort 底层 fetch，不留迟到请求）。
          // 主聚合席另取独立硬预留 reserveMs（与参考席消耗无关）；fallback 仍享
          // AGG_MIN_BUDGET_MS 90s 保底。聚合超时走既有 catch 降级（返回原始视角）。
          const wallStart = Date.now();
          const wallDeadline = wallStart + totalMs;
          const reserveMs = aggReserveOf(cfgMoa, totalMs);

          // 聚合路由兜底：按 aggModels 顺序尝试，共享聚合墙钟；快速失败立即续试。
          // 2026-10-27 终审追修（与 dual-review askRoute 同口径）：首选聚合耗尽预留后，
          // fallback 补一段 AGG_MIN_BUDGET_MS 90s 保底窗口（只补一次、剩余候选共享）——
          // 防首选超时把 aggregator_fallbacks 饿死（最坏 480s 扇出+180s 预留+90s 保底=750s）。
          const askAggregator = async (prompt, deadlineMs) => {
            const failed = [];
            let lastErr = null;
            let effDeadline = deadlineMs;
            let floorArmed = false;
            for (const model of aggModels) {
              if (!floorArmed && Date.now() >= effDeadline) {
                effDeadline = Date.now() + AGG_MIN_BUDGET_MS;
                floorArmed = true;
              }
              const remaining = effDeadline - Date.now();
              if (remaining <= 0) { failed.push(`${model}: 墙钟预算耗尽`); break; }
              try {
                const text = await askWithDeadline(
                  { baseURL: cfg.baseURL, key: cfg.key, model, prompt, timeoutMs: totalMs, idleMs, attempts: undefined, reasoningEffort: aggEffort || undefined },
                  effDeadline,
                  `moa 聚合(${model})`,
                );
                return { model, text, failed };
              } catch (e) {
                lastErr = e;
                failed.push(`${model}: ${e?.message ?? e}`);
              }
            }
            // 全部候选失败：只报最后一条网关错误为主体（同 dual-review 口径：
            // 模型可省略只报计数，错误必须醒目）
            const err = Object.assign(
              new Error(lastErr
                ? `聚合失败（已试 ${aggModels.length} 个模型）：${String(lastErr?.message ?? lastErr)}`
                : (failed[failed.length - 1] ?? "无可用候选模型")),
              lastErr && lastErr.statusCode != null ? { statusCode: lastErr.statusCode } : {},
              lastErr ? { cause: lastErr } : {},
              { attempts: failed },
            );
            throw err;
          };

          // 分路计时账本：结果报告的「产出规模」行用（每路在各自 promise 落定时记时，
          // 不随最慢路膨胀）
          const durations = refs.map(() => 0);
          const promises = refs.map((m, i) => {
            const t0m = Date.now();
            const p = askWithDeadline(
              {
                baseURL: cfg.baseURL, key: cfg.key, model: m, prompt: refPrompt(i),
                timeoutMs: totalMs, idleMs, attempts: undefined, reasoningEffort: refEffort || undefined,
              },
              wallDeadline,
              `moa 扇出(${m})`,
            );
            p.then(
              () => { durations[i] = Date.now() - t0m; },
              () => { durations[i] = Date.now() - t0m; },
            );
            return p;
          });
          // 扇出阶段共享总墙钟：askWithDeadline 到点 abort，超时按普通失败处理
          const settled = await Promise.allSettled(promises);

          const views = [];
          const failures = [];
          const perf = [];
          settled.forEach((r, i) => {
            if (r.status === "fulfilled") {
              views.push({ model: refs[i], text: r.value, lens: lenses ? lensFor(i) : "" });
              perf.push(`${refs[i]}：${r.value.length} 字 / ${(durations[i] / 1000).toFixed(1)}s`);
            } else {
              failures.push({ model: refs[i], reason: r.reason, durS: (durations[i] / 1000).toFixed(1) });
            }
          });

          if (views.length === 0) {
            // 全部参考失败：只报最后一条网关错误为主体（模型可省略只报计数，2026-10-18 用户二次裁定）
            const lastReason = failures.length ? failures[failures.length - 1].reason : null;
            return `moa: ${refs.length} 个参考模型重试均失败——${lastReason?.message ?? lastReason ?? "无上游错误"}`;
          }

          // 聚合阶段：截断超长参考（clipText 内联标注残件事实），防聚合 prompt 爆上下文
          const clipped = views.map((v) => ({ ...v, text: clipText(v.text, AGG_VIEW_LIMIT) }));

          const aggregatePrompt = [
            "你是聚合器。下面是同一任务由多个模型给出的独立分析" + (lenses ? "（各模型按指定视角分工，视角标注见各节标题）" : "") + "。",
            "综合它们，输出一份更可靠的结论，按以下结构：",
            "## 共识：各视角一致认可的要点（附理由）",
            "## 分歧：视角间相互矛盾的判断——逐条保留双方立场与依据，给出你的取舍与理由；不得用折中抹平分歧",
            "## 视角独有发现：仅单一视角提出的关键点——判断是否成立，成立的采纳，不成立的说明理由；不得因少数而直接丢弃",
            "## 最终结论：综合后的整体结论与建议",
            "不要简单罗列各家观点；某路参考缺失时基于现有视角综合并注明。",
            "",
            `## 任务\n${task}`,
            "",
            ...clipped.map((v) => `## 参考模型 ${v.model}${v.lens ? `（视角：${v.lens}）` : ""}\n${v.text}`),
          ].join("\n");

          let agg;
          try {
            // 聚合阶段：主聚合席拿独立硬预留（reserveMs，与参考席消耗无关）；fallback 共享
            // 该预留，耗尽后由 askAggregator 的 AGG_MIN_BUDGET_MS 90s 保底兜住
            const aggDeadline = Math.max(wallDeadline, Date.now() + reserveMs);
            agg = await askAggregator(aggregatePrompt, aggDeadline);
          } catch (e) {
            // 聚合失败也要返回可用结果（不丢参考视角）
            return [
              `moa: ${e.message}`,
              "",
              "以下为各参考模型原始结论：",
              ...views.map((v) => `### ${v.model}\n${v.text}`),
              failures.length ? `\n（未参与模型）${failures.map((f) => `${f.model}: ${f.reason?.message ?? f.reason}`).join("; ")}` : "",
            ].join("\n");
          }

          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          // 降级复核标注（对齐 kilo.json.tmpl 注释与 dual-review 口径）：聚合席落到 fallback
          //（如 1017 与主执行同族）→ 本次结论不再是完整异族交叉验证，必须显式可见。
          const aggDegraded = aggModels.length > 0 && agg.model !== aggModels[0];
          return [
            `## MoA 结论（聚合模型：${agg.model}，总耗时 ${elapsed}s）`,
            lenses ? `> 视角分工：${refs.map((m, i) => `${m}→${lensFor(i)}`).join("；")}${lenses.length < refs.length ? `（视角复用：${refs.length} 席/${lenses.length} 视角）` : ""}` : "",
            aggDegraded ? `> 降级复核：聚合 ${aggModels[0]}→${agg.model}（使用 fallback 非首选聚合模型，交叉验证强度降级）` : "",
            agg.failed.length ? `> 路由兜底：${agg.failed.join("；")}` : "",
            agg.text,
            "",
            `## 参与参考模型（${views.map((v) => v.model).join(", ")}）`,
            perf.length ? `产出规模：${perf.join("，")}` : "",
            failures.length ? `## 失败/未参与：${failures.map((f) => `${f.model}: ${f.reason?.message ?? f.reason}（${f.durS}s）`).join("; ")}` : "",
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

// Kilo vE2 契约：工具函数经 _export 命名空间对象暴露（对象无 server 属性 → 加载器跳过，
// 绝不会被当工厂调用）。离线回归经此访问 lensesOf/DEFAULT_LENSES。
export const _export = { lensesOf, DEFAULT_LENSES, LENS_CHAR_LIMIT };
