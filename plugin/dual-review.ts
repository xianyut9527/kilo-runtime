// W3.8 双向异源审查（三层交付检查的层 3，复杂任务专用）
//
// 定位：对一次改动/一份结论做正反两路独立审查——
//   正向（证成为主）：找「为什么这个方案/改动是对的、完备的」，漏检点、边界遗漏；
//   反向（证伪为主）：专门找错——逻辑缺陷、边界条件、安全漏洞、遗漏需求、过度设计。
// 两路并行、不同参考模型分别承担（默认值见 kilo.json provider.hx.options.dual_review，
// 与主执行模型异源），最后由异源聚合模型综合出裁决：通过 / 有条件通过（列出必须修复项）/ 不通过。
// 与 moa 工具的区别：moa 是通用多视角聚合；本工具是改动审查专用协议，正反视角由 prompt 明确分工。
//
// 依赖：plugin/hx-client.ts（与 moa.ts 共享的配置读取与请求层，改凭证/baseURL 规则只改那边）。
// 成本控制：仅复杂任务调用；参考模型各 1 次 + 聚合 1 次 = 3 次上游调用。
//
// 全自动闭环（W3.9）：导出 runDualReview(subject) 供 quality-gate 在交付节点直接调用——
// 不再「提醒模型手动调」，而是插件自身执行正反审查+裁决，结果回注工具结果流。
// tool: dual_review 仍保留，供模型主动发起（例如覆盖更细粒度的审查对象）。
//
// 2026-09-18 性能改造：全链路 SSE 流式 + ctx.metadata 实时进度标题 + 聚合输入截断
//（subject 8k / 两路结论各 10k），长 diff 审查不再静默等待 1-2 分钟。
// 2026-09-20 可观测性补漏：quality-gate 钩子直调路径无 ctx.metadata，进度标题降级 stderr
//（10s 节流、阶段首现立即输出），自动审查不再黑盒；makeTitle 具名导出供离线回归覆盖。

import { loadCfg, ask, FALLBACK_TIMEOUT_MS } from "./hx-client";

// 超时统一走配置：kilo.json provider.hx.options.timeout（主链路同口径）；
// 配置缺失/非法才回退，兜底值取 hx-client 共享常量。
// 空闲看门狗与主链路 chunkTimeout 同源，流式中无 chunk 判死快速失败进重试。

const TITLE_THROTTLE_MS = 800;
const STDERR_THROTTLE_MS = 10_000; // stderr 降级通道节流：按阶段各自计时，防两路交替标题刷屏
const AGG_SUBJECT_LIMIT = 8_000;   // 聚合 prompt 中审查对象截断
const AGG_REVIEW_LIMIT = 10_000;   // 聚合 prompt 中单路结论截断

const TAG = "[dual-review] ";

export function makeTitle(ctx, label) {
  // 优先 ctx.metadata 实时进度（手动 dual_review 工具调用有此通道）；
  // quality-gate 钩子自动审查只有 (input, output)，无 ctx —— 降级 stderr 节流输出，
  // 与层 3 开头那条「双向审查执行中…」同通道（CLI 终端可见；VS Code 扩展是否转发
  // 插件 stderr 取决于其实现，可在扩展输出日志查看），消除交付节点黑盒等待。
  const useMeta = !!(ctx && typeof ctx.metadata === "function");
  const throttleMs = useMeta ? TITLE_THROTTLE_MS : STDERR_THROTTLE_MS;
  const emit = useMeta
    // 同步抛错（metadata 异常）与异步 rejection 都必须吞掉：onDelta 由 hx-client 的
    // try/catch 包裹且不 await，逃逸会变成未处理 rejection。
    ? (text) => {
        try {
          const r = ctx.metadata({ title: text || label });
          if (r && typeof r.catch === "function") r.catch(() => {});
        } catch { /* metadata 不可用则静默 */ }
      }
    : (text) => console.error(`${TAG}${text || label}`);
  let last = 0;
  const stageAt = new Map(); // stderr 路径：按阶段各自节流（正反两路标题交替到达，单一计时器会失效）
  return async (text) => {
    const now = Date.now();
    if (useMeta) {
      // 工具卡标题可原地刷新：维持原全局节流语义
      if (now - last < throttleMs && text) return;
      last = now;
      emit(text);
      return;
    }
    // stderr 不可原地刷新：阶段首次出现立即输出，同阶段后续按 10s 节流防刷屏
    const stage = String(text || label).replace(/\d+/g, "#");
    const prev = stageAt.get(stage);
    if (prev !== undefined && now - prev < throttleMs && text) return;
    stageAt.set(stage, now);
    emit(text);
  };
}

// ── 正反两路 prompt 协议 ─────────────────────────────────────

const POSITIVE_PROMPT = (subject) => `你是代码/方案审查中的「正向审查者」。针对下面的审查对象：
1. 判断它声称要达成的目标是什么；
2. 检查目标是否完整达成——重点找「遗漏」：未覆盖的分支、未处理的边界、缺失的步骤、未验证的假设；
3. 列出你认为成立的部分（简要），以及遗漏或需补充的部分（具体到点）。
只输出结构化结论，不要复述原文全文。立场：倾向承认成立，但遗漏必须列全。

## 审查对象
${subject}`;

const NEGATIVE_PROMPT = (subject) => `你是代码/方案审查中的「反向审查者」（红队）。针对下面的审查对象，专门找问题：
- 逻辑缺陷与错误处理缺失
- 边界条件与异常路径
- 安全隐患（注入/越权/凭证/不可逆操作）
- 与需求的偏差（做了没要求的、漏了要求的）
- 过度设计与可简化点
每条给出【严重度 高/中/低】【位置或依据】【修复建议】。找不到实质问题就明确说「未发现实质问题」，不要为了凑数而编造。

## 审查对象
${subject}`;

const AGGREGATE_PROMPT = (subject, pos, neg) => `你是审查裁决者。同一审查对象收到了正向审查与反向审查两份独立结论。
综合裁决，输出：
## 裁决
通过 / 有条件通过 / 不通过（三选一）
## 必须修复项
（反向审查成立且严重的点，逐条列出；无则写「无」）
## 建议改进项
（正向审查发现的遗漏 + 反向审查的中低严重度点）
## 依据
两路结论的共识与分歧、你的取舍理由。

## 审查对象
${subject.slice(0, AGG_SUBJECT_LIMIT)}

## 正向审查结论
${pos}

## 反向审查结论
${neg}`;

// 核心执行体：可被 tool: dual_review 调用，也可被 quality-gate 在交付节点直调（全自动闭环）
// ctx 可选：传入工具 execute 的第二参数即可获得实时进度标题（quality-gate 直调时不传，无进度但行为不变）
export async function runDualReview(subject, overrides = {}, ctx = null) {
  const cfg = await loadCfg();
  subject = String(subject ?? "").trim();
  if (!subject) return "dual_review: 缺少 subject 参数";
  if (subject.length < 50) return "dual_review: subject 过短（<50 字符），请带上改动摘要与关键代码片段";

  const timeoutMs = Number(cfg.options?.timeout) > 0 ? Number(cfg.options?.timeout) : FALLBACK_TIMEOUT_MS;
  const idleMs = Number(cfg.options?.chunkTimeout) > 0 ? Number(cfg.options?.chunkTimeout) : 60_000;

  // 模型唯一真源 = kilo.json provider.hx.options.dual_review（改模型只改配置文件，代码不留兜底默认值）
  const dr = cfg.options?.dual_review ?? {};
  const posModel = typeof overrides?.positive_model === "string" && overrides.positive_model ? overrides.positive_model : dr.positive;
  const negModel = typeof overrides?.negative_model === "string" && overrides.negative_model ? overrides.negative_model : dr.negative;
  const aggModel = typeof overrides?.aggregator === "string" && overrides.aggregator ? overrides.aggregator : dr.aggregator;
  if (!posModel || !negModel || !aggModel) {
    return "dual_review: 审查模型未配置——请在 kilo.json 的 provider.hx.options.dual_review 配置 positive/negative/aggregator（模型唯一真源在配置文件，代码不留兜底默认值）";
  }

  const setTitle = makeTitle(ctx, "双向审查两路并行");

  // 正反两路并行；单路失败不废全局（与 moa 同语义）
  const [posRes, negRes] = await Promise.allSettled([
    ask({ baseURL: cfg.baseURL, key: cfg.key, model: posModel, prompt: POSITIVE_PROMPT(subject), timeoutMs, idleMs,
          onDelta: (_d, n) => setTitle(`正向已收 ${n} 字`) }),
    ask({ baseURL: cfg.baseURL, key: cfg.key, model: negModel, prompt: NEGATIVE_PROMPT(subject), timeoutMs, idleMs,
          onDelta: (_d, n) => setTitle(`两路并行已收 ${n} 字`) }),
  ]);

  const posText = posRes.status === "fulfilled" ? posRes.value : null;
  const negText = negRes.status === "fulfilled" ? negRes.value : null;
  const failures = [];
  if (posRes.status === "rejected") failures.push(`正向(${posModel}): ${posRes.reason?.message ?? posRes.reason}`);
  if (negRes.status === "rejected") failures.push(`反向(${negModel}): ${negRes.reason?.message ?? negRes.reason}`);

  if (!posText && !negText) {
    return `dual_review: 两路审查均失败\n${failures.join("\n")}`;
  }

  // 两路至少一路失败时：不做单路裁决（正反缺一裁决会失真），返回幸存方原始结论
  if (!posText || !negText) {
    return [
      `dual_review: 一路审查失败，无法裁决。幸存方原始结论：`,
      failures.join("\n"),
      "",
      posText ? `### 正向审查（${posModel}）\n${posText}` : "",
      negText ? `### 反向审查（${negModel}）\n${negText}` : "",
    ].filter(Boolean).join("\n");
  }

  // 聚合阶段：截断超长输入（正/反各 AGG_REVIEW_LIMIT），防聚合 prompt 爆上下文二次长等待
  const clip = (t) => t.length > AGG_REVIEW_LIMIT ? t.slice(0, AGG_REVIEW_LIMIT) + `\n（截断：原始 ${t.length} 字符）` : t;
  const posC = clip(posText);
  const negC = clip(negText);

  const aggTitle = makeTitle(ctx, `裁决（${aggModel}）`);
  let verdict;
  try {
    verdict = await ask({
      baseURL: cfg.baseURL,
      key: cfg.key,
      model: aggModel,
      prompt: AGGREGATE_PROMPT(subject, posC, negC),
      timeoutMs,
      idleMs,
      onDelta: (_d, total) => aggTitle(`裁决生成中 ${total} 字`),
    });
  } catch (e) {
    return [
      `dual_review: 裁决模型（${aggModel}）失败：${e.message}`,
      "",
      `### 正向审查（${posModel}）\n${posText}`,
      "",
      `### 反向审查（${negModel}）\n${negText}`,
    ].join("\n");
  }

  return [
    `## 双向审查裁决（${posModel} 正向 × ${negModel} 反向 → ${aggModel} 裁决）`,
    verdict,
    "",
    `<details><summary>原始结论</summary>`,
    "",
    `### 正向\n${posText}`,
    `### 反向\n${negText}`,
    "",
    `</details>`,
  ].join("\n");
}

// tool 注册：模型仍可主动发起（传入自定义 subject，如审查某个具体方案而非本次改动）
export const DualReview = async () => {
  return {
    tool: {
      dual_review: {
        description:
          "双向异源审查：对指定改动/方案并行发起正向（查遗漏）与反向（红队找错）两路独立模型审查，再由第三方模型裁决。" +
          "仅在复杂任务交付前调用（多模块改动/公共契约/核心逻辑），简单任务不要调用（成本敏感）。" +
          "复杂任务的交付节点由 quality-gate 自动执行，通常无需手动调用。",
        args: {
          subject: { type: "string", description: "审查对象：改动摘要+关键 diff 片段，或方案全文（含必要上下文）" },
          positive_model: { type: "string", description: "正向审查模型（可选，默认取配置）" },
          negative_model: { type: "string", description: "反向审查模型（可选，默认取配置）" },
          aggregator: { type: "string", description: "裁决模型（可选，默认取配置）" },
        },
        async execute(args, ctx) {
          return runDualReview(args?.subject, args, ctx);
        },
      },
    },
  };
};

export default DualReview;