#!/usr/bin/env node
// mmo.mjs — Multi-Model Orchestration
// 3 个顶级大模型并行执行同一任务 → 小模型融合（查漏补全）
// 用法: node mmo.mjs "<任务描述>" [options]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 优先读 .kilo/mmo.json（独立配置，kilo.json schema 不允许 mmo 字段）
const MMO_JSON = path.resolve(process.cwd(), ".kilo", "mmo.json");
let mmo = {};
try {
  mmo = JSON.parse(fs.readFileSync(MMO_JSON, "utf-8"));
} catch {
  // 降级：kilo.json 旧版兼容
  try {
    const KILO_JSON = path.resolve(process.cwd(), "kilo.json");
    const cfg = JSON.parse(fs.readFileSync(KILO_JSON, "utf-8"));
    mmo = cfg.mmo || {};
  } catch {}
}
// provider 配置仍从 kilo.json 读
const KILO_JSON = path.resolve(process.cwd(), "kilo.json");
const cfg = JSON.parse(fs.readFileSync(KILO_JSON, "utf-8"));

const EXECUTORS = mmo.executor_models || ["hx/glm-5.2", "hx/kimi-k2.6", "hx/deepseek-v4-flash"];
const FUSION = mmo.fusion_model || "hx/minimax-m3";
const TEMP_EXEC = mmo.executor_temperature ?? 0.2;
const TEMP_FUSION = mmo.fusion_temperature ?? 0.1;
const TIMEOUT_MS = mmo.timeout_ms || 600000;
const MAX_TOKENS = mmo.max_output_tokens || 16384;
const STRATEGY = mmo.fusion_strategy || "weighted_consensus";
const MIN_EXEC = mmo.min_executors_required || 2;

const provider = cfg.provider?.hx || {};
const baseURL = provider.options?.baseURL;
let API_KEY = process.env.HX_API_KEY || process.env.OPENAI_API_KEY || "";
if (!API_KEY) {
  try {
    const authHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".local", "share", "kilo", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authHome, "utf-8"));
    API_KEY = auth?.hx?.key || "";
  } catch {}
}

if (!baseURL) { console.error("[fatal] provider.hx.options.baseURL 未配置"); process.exit(2); }
if (!API_KEY) { console.error("[fatal] 环境变量 HX_API_KEY 未设置且 Kilo auth.json 无 hx.key"); process.exit(2); }

// CLI 参数
const args = process.argv.slice(2);
const taskDesc = args.find(a => !a.startsWith("--"));
const outFlag = args.indexOf("--out");
const outFile = outFlag >= 0 ? args[outFlag + 1] : null;
const verbose = args.includes("--verbose") || args.includes("-v");

const modelsIdx = args.indexOf("--models");
const fusionIdx = args.indexOf("--fusion");
const anchorsIdx = args.indexOf("--anchors");
const tempExecIdx = args.indexOf("--temp-exec");
const tempFusionIdx = args.indexOf("--temp-fusion");
const preIdx = args.indexOf("--pre");
const dataIdx = args.indexOf("--data");
const fusionModeIdx = args.indexOf("--fusion-mode");

let executors = EXECUTORS;
if (modelsIdx >= 0 && args[modelsIdx + 1]) {
  executors = args[modelsIdx + 1].split(",").map(s => s.trim()).filter(Boolean);
}
let fusionModel = FUSION;
if (fusionIdx >= 0 && args[fusionIdx + 1]) fusionModel = args[fusionIdx + 1].trim();
let anchors = [];
if (anchorsIdx >= 0 && args[anchorsIdx + 1]) {
  anchors = args[anchorsIdx + 1].split(",").map(s => s.trim()).filter(Boolean);
}
let tempExec = TEMP_EXEC;
if (tempExecIdx >= 0 && args[tempExecIdx + 1]) tempExec = parseFloat(args[tempExecIdx + 1]);
let tempFusion = TEMP_FUSION;
if (tempFusionIdx >= 0 && args[tempFusionIdx + 1]) tempFusion = parseFloat(args[tempFusionIdx + 1]);
const preCmd = preIdx >= 0 ? args[preIdx + 1] : null;
const dataFile = dataIdx >= 0 ? args[dataIdx + 1] : null;
const fusionMode = fusionModeIdx >= 0 ? args[fusionModeIdx + 1] : "union";

if (!taskDesc) {
  console.error("用法: node mmo.mjs \"<任务描述>\" [options]");
  console.error("");
  console.error("Options:");
  console.error("  --out <file>           输出文件路径");
  console.error("  --pre \"<cmd>\"          执行前先跑命令，输出注入执行模型");
  console.error("  --data <file>          指定数据文件，内容注入执行模型");
  console.error("  --anchors \"f1,f2\"     融合模型读这些文件核对共识");
  console.error("  --fusion-mode <mode>   union(查漏补全,默认) | weighted_consensus(共识提取)");
  console.error("  --models \"m1,m2,m3\"   临时覆盖执行模型");
  console.error("  --fusion <model>       临时覆盖融合模型");
  console.error("  --temp-exec <0-1>      执行模型温度 (默认 0.2)");
  console.error("  --temp-fusion <0-1>    融合模型温度 (默认 0.1)");
  console.error("  --verbose, -v          详细日志");
  process.exit(1);
}

function ts() { return new Date().toISOString().slice(11, 19); }

// --pre 钩子：执行命令抓数据
let preOutput = "";
if (preCmd) {
  console.log(`[mmo] 执行 pre 命令: ${preCmd.slice(0, 80)}${preCmd.length > 80 ? "..." : ""}`);
  try {
    const { execSync } = await import("node:child_process");
    preOutput = execSync(preCmd, { maxBuffer: 50 * 1024 * 1024, cwd: process.cwd(), encoding: "utf-8", timeout: 120000 });
    console.log(`[mmo] pre 输出: ${preOutput.length} 字符`);
  } catch (e) {
    console.error(`[fatal] pre 命令失败: ${e.message}`);
    process.exit(5);
  }
}
// --data 文件
let dataContent = "";
if (dataFile) {
  try {
    dataContent = fs.readFileSync(path.resolve(process.cwd(), dataFile), "utf-8");
    console.log(`[mmo] data 文件: ${dataFile} (${dataContent.length} 字符)`);
  } catch (e) {
    console.error(`[fatal] data 文件读取失败: ${e.message}`);
    process.exit(5);
  }
}
const dataInjection = (preOutput || dataContent) ? `\n\n## 输入数据（pre 命令输出 / data 文件内容）\n\n~~~\n${preOutput || dataContent}\n~~~\n` : "";

console.log(`[mmo] 任务: ${taskDesc.slice(0, 80)}${taskDesc.length > 80 ? "..." : ""}`);
console.log(`[mmo] 执行模型 (${executors.length}): ${executors.join(", ")}`);
console.log(`[mmo] 融合模型: ${fusionModel}`);
console.log(`[mmo] 策略: ${fusionMode}  超时: ${TIMEOUT_MS}ms  最小成功: ${MIN_EXEC}  温度: exec=${tempExec}/fusion=${tempFusion}`);
if (anchors.length) console.log(`[mmo] 锚点文件: ${anchors.join(", ")}`);
console.log("");

// ========== API 调用 ==========
async function callModel(model, messages, opts = {}) {
  const providerModel = model.includes("/") ? model.split("/")[1] : model;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: providerModel,
        messages,
        temperature: opts.temperature ?? tempExec,
        max_tokens: opts.max_tokens || MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const txt = await res.text();
    let content = "";
    let tokens = 0;
    if (txt.trim().startsWith("{")) {
      const json = JSON.parse(txt);
      content = json.choices?.[0]?.message?.content || "";
      tokens = json.usage?.total_tokens || 0;
    } else {
      const lines = txt.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          const delta = ev.choices?.[0]?.delta?.content || "";
          if (delta) content += delta;
          if (ev.usage?.total_tokens) tokens = ev.usage.total_tokens;
        } catch {}
      }
    }
    return { ok: true, model, content, tokens, ms: Date.now() - start };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, model, error: e.name === "AbortError" ? "timeout" : e.message, ms: Date.now() - start };
  }
}

// ========== 并行执行 ==========
console.log(`[${ts()}] 启动 ${executors.length} 个执行模型 (并行)...`);
const execResults = await Promise.allSettled(
  executors.map(m => callModel(m, [
    { role: "system", content: "你是一名资深工程师，按用户任务描述给出高质量、可机械验证的输出。输出 Markdown 格式，包含：1) 关键数据/结论  2) 数据来源（文件路径/命令/行号）  3) 不确定处明确标注。不要寒暄、不要复述任务。" },
    { role: "user", content: taskDesc + dataInjection },
  ], { temperature: tempExec }))
);

const okResults = [];
const failResults = [];
execResults.forEach((r, i) => {
  const m = executors[i];
  if (r.status === "fulfilled" && r.value.ok) {
    okResults.push(r.value);
    console.log(`  [${ts()}] ✅ ${m}: ${r.value.tokens} tokens, ${r.value.ms}ms`);
  } else {
    const err = r.status === "fulfilled" ? r.value.error : r.reason?.message || "rejected";
    failResults.push({ model: m, error: err });
    console.log(`  [${ts()}] ❌ ${m}: ${err}`);
  }
});

console.log(`\n[${ts()}] 执行完成: ${okResults.length}/${executors.length} 成功`);
if (okResults.length < MIN_EXEC) {
  console.error(`[fatal] 至少需要 ${MIN_EXEC} 个执行模型成功，实际 ${okResults.length}`);
  if (failResults.length) {
    console.error("[失败详情]:");
    failResults.forEach(f => console.error(`  ${f.model}: ${f.error}`));
  }
  process.exit(3);
}

// ========== 读取锚点文件 ==========
let anchorsBlock = "";
if (anchors.length) {
  const chunks = [];
  for (const f of anchors) {
    try {
      const resolved = path.resolve(process.cwd(), f);
      const stat = fs.statSync(resolved);
      if (stat.size > 100000) {
        chunks.push("### " + f + "\n(文件过大 " + Math.round(stat.size/1024) + "KB，跳过)");
        continue;
      }
      const txt = fs.readFileSync(resolved, "utf-8");
      chunks.push("### " + f + "\n~~~\n" + txt + "\n~~~");
    } catch (e) {
      chunks.push("### " + f + "\n(读取失败: " + e.message + ")");
    }
  }
  anchorsBlock = "\n## 锚点文件（供核对共识）\n\n" + chunks.join("\n\n") + "\n";
}

// ========== 融合 ==========
console.log(`\n[${ts()}] 启动融合模型 ${fusionModel} (策略: ${fusionMode})...`);

const inputsBlock = okResults.map((r, i) => {
  return `### 执行模型 ${i + 1}: ${r.model}\n- 耗时: ${r.ms}ms  Tokens: ${r.tokens}\n- 输出:\n<<<\n${r.content}\n>>>`;
}).join("\n\n");

const fusionPrompt = `你是融合智能体（${fusionMode} 策略）。下面有 ${okResults.length} 个顶级大模型对同一任务的独立输出。你的任务：

1. **并集补全（union 模式）**：把每个模型独有的数据点（其他模型没提到的）全部合并到最终输出，标注来源"仅模型 X 提及"
2. **共识提取**：识别所有模型一致同意的事实/数据/结论（标注"3/3 一致"或"2/3 一致"）
3. **分歧标注**：识别模型间不一致的数据点，列出每个模型的说法，标注"⚠️ 分歧"
4. **冲突仲裁**：对分歧点，基于证据可信度（有文件路径/行号 > 无证据）选择最可信的版本
5. **置信度评分**：每个关键结论给出置信度（高/中/低）
6. **最终输出**：综合所有模型输出生成统一的 Markdown 报告

## 任务描述
${taskDesc}${anchorsBlock}

## ${okResults.length} 个执行模型的输出

${inputsBlock}

## 融合输出要求
- 用 Markdown 格式
- 顶部给出"融合统计"（X 条 3/3 一致，Y 条 2/3 一致，Z 条分歧，W 条仅某模型提及）
- 每条结论后注明证据来源（哪个模型 + 哪个文件/命令）
- 末尾给"置信度总评"（高/中/低）+ 1 句话总结
- 不要复述任务描述，直接给融合结果
- 如提供了锚点文件，必须交叉核对执行模型输出与锚点内容；不一致处标注"⚠️ 锚点不符"`;

const fusionResult = await callModel(fusionModel, [
  { role: "system", content: "你是多模型融合智能体。基于多个模型的独立输出，做并集补全、共识提取、分歧标注、冲突仲裁、置信度评分，输出最终融合报告。" },
  { role: "user", content: fusionPrompt },
], { temperature: tempFusion, timeout: TIMEOUT_MS });

if (!fusionResult.ok) {
  console.error(`[fatal] 融合模型失败: ${fusionResult.error}`);
  console.error("\n[降级] 直接拼接 3 份输出（未融合）:");
  const fallback = okResults.map(r => `## ${r.model}\n\n${r.content}`).join("\n\n---\n\n");
  console.log("\n" + fallback);
  process.exit(4);
}

console.log(`  [${ts()}] ✅ ${fusionModel}: ${fusionResult.tokens} tokens, ${fusionResult.ms}ms`);
console.log(`\n[${ts()}] 融合完成`);

// ========== 输出 ==========
const header = `<!-- mmo generated -->\n<!-- task: ${Buffer.from(taskDesc).toString("base64").slice(0, 40)}... -->\n<!-- executors: ${executors.join(", ")} -->\n<!-- fusion: ${fusionModel} -->\n<!-- strategy: ${fusionMode} -->\n<!-- timestamp: ${new Date().toISOString()} -->\n<!-- exec_success: ${okResults.length}/${executors.length} -->\n<!-- exec_tokens: ${okResults.reduce((s, r) => s + r.tokens, 0)} -->\n<!-- fusion_tokens: ${fusionResult.tokens} -->\n<!-- total_ms: ${okResults.reduce((s, r) => s + r.ms, 0) + fusionResult.ms} -->\n\n`;

const fullOutput = header + fusionResult.content;

console.log("\n" + "=".repeat(60));
console.log("📝 融合报告");
console.log("=".repeat(60));
console.log(fusionResult.content);
console.log("=".repeat(60));

if (outFile) {
  const outPath = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(outPath, fullOutput, "utf-8");
  console.log(`\n[ok] 已写入: ${outPath}`);
}

console.error("\n" + "─".repeat(60));
console.error("📊 执行摘要:");
console.error(`  执行模型成功: ${okResults.length}/${executors.length}`);
console.error(`  执行总 tokens: ${okResults.reduce((s, r) => s + r.tokens, 0)}`);
console.error(`  融合 tokens: ${fusionResult.tokens}`);
console.error(`  总耗时: ${okResults.reduce((s, r) => s + r.ms, 0) + fusionResult.ms}ms`);
if (failResults.length) {
  console.error(`  失败模型: ${failResults.length}`);
  failResults.forEach(f => console.error(`    - ${f.model}: ${f.error}`));
}
console.error("─".repeat(60));

const auditDir = path.resolve(process.cwd(), ".kilo", "mmo-audit");
try { fs.mkdirSync(auditDir, { recursive: true }); } catch {}
const auditId = crypto.createHash("sha256").update(taskDesc + new Date().toISOString()).digest("hex").slice(0, 12);
const audit = {
  id: auditId, task: taskDesc, timestamp: new Date().toISOString(),
  executors: executors, fusion: fusionModel, strategy: fusionMode,
  exec_results: okResults.map(r => ({ model: r.model, tokens: r.tokens, ms: r.ms, content: r.content })),
  fail_results: failResults,
  fusion_result: { model: fusionModel, tokens: fusionResult.tokens, ms: fusionResult.ms, content: fusionResult.content },
};
const auditPath = path.join(auditDir, `${auditId}.json`);
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf-8");
console.error(`[audit] 完整执行记录: ${auditPath}`);

process.exit(0);
