#!/usr/bin/env node
// 插件加载契约回归（2026-09-22 启动崩溃复盘的结构性防线）：
// 不联网、不起 Kilo。
// 用法：bun scripts/test-plugin-contract.mjs（bun 可直接执行 TS 插件）
//
// 背景（实证）：Kilo 7.7.6 启动时逐个求值 plugin/*.ts，任一模块求值抛错即
// "failed to load plugin" → 插件注册表留洞 → "plugin config hook failed"(N.config)
// → ProviderAuth.state/Provider.list 级联抛错(j.auth/YH.provider) → provider 列表全挂
// → 模型选择器空（run=918d7609 完整链）。三类真实签名：
//   quality-gate.ts 'undefined is not an object (evaluating s.highRisk.size/s.edited)'
//   plugin/hx-client.ts 'fetch() URL is invalid'（库文件被当插件加载）
//   dual-review.ts 'Unexpected comma'（半写文件）
//
// 本测试断言（每条对应一个已发生的故障模式）：
//   1. 每个 plugin/*.ts 都能被真实 import（模块求值期不抛）；
//   2. 每个插件工厂可被调用且不抛（never-throw 契约）——工厂期异常的爆炸半径
//      被限制在本插件，不再污染 provider 面；
//   3. plugin/ 目录下不存在"库文件"（非插件入口）——库必须放 lib/，否则会被当插件加载；
//   4. 每个插件至少导出一个工厂函数。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// node 不能直接 import .ts（无 loader 时 7 条断言会假失败），必须用 bun 运行。
if (typeof Bun === "undefined") {
  console.error("需要 bun 运行（node 无法直接 import .ts，会产生假失败）：bun scripts/test-plugin-contract.mjs");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PLUGIN_DIR = path.join(ROOT, "plugin");
const LIB_DIR = path.join(ROOT, "lib");

const results = [];
const assert = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) process.exitCode = 1;
};

// 已知非插件文件的豁免（如需在 plugin/ 放纯数据/类型声明，在此登记并写明理由）
const NON_PLUGIN_ALLOW = new Set();

// 库文件名模式：出现在 plugin/ 下即为「被当插件加载」的隐患
const LIB_LIKE = /(-client|shared|util|helpers?)\.ts$/i;

const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".ts"));

// ── 断言 3：plugin/ 下不得有库文件（hx-client.ts 曾在此，产生 "fetch() URL is invalid"）──
for (const f of files) {
  if (NON_PLUGIN_ALLOW.has(f)) continue;
  assert(`plugin/ 不含库文件（${f} 应放 lib/）`, !LIB_LIKE.test(f));
}

// ── 断言 1 & 2 & 4：逐个真实加载 + 调用工厂 ──
// 工厂调用上下文给最小桩，插件应对缺失的 client/$ 优雅降级（其内部 try/catch）。
const CTX = { directory: ROOT, client: {}, $: () => {} };

for (const f of files) {
  if (NON_PLUGIN_ALLOW.has(f)) continue;
  const rel = path.relative(ROOT, path.join(PLUGIN_DIR, f)).replace(/\\/g, "/");
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(PLUGIN_DIR, f)).href);
    assert(`加载成功：${rel}`, true);
  } catch (e) {
    assert(`加载成功：${rel}（模块求值抛错 → 会导致 failed to load plugin）: ${e?.message ?? e}`, false);
    continue;
  }

  // ── vE2 真根因契约（2026-09-22 逆向 kilo.exe vE2/iE2/kE2 确认）──
  // Kilo 把模块里**每个导出函数**都当插件工厂用 (ctx, options) 调一遍（引用去重）。
  // 非工厂导出函数：抛错 → "failed to load plugin"(s.edited 类启动崩溃)；
  // 返回 undefined → 钩子数组污染 → "plugin config hook failed"(N.config) → provider 全挂。
  // 对象导出含 server 函数 → kE2 把 obj.server 当工厂调用。
  // 因此契约是：**全模块恰好 1 个不同函数导出引用**（工厂；default 与具名同引用算 1），
  // 工厂用 (ctx, undefined) 调用不抛且返回对象；对象导出不得含 server 函数。
  // 工具函数一律经 _export 命名空间对象暴露。
  const exportEntries = Object.entries(mod);
  const fnByRef = new Map(); // 引用去重（与 kilo vE2 的 Set 同语义）
  for (const [name, v] of exportEntries) {
    if (typeof v !== "function") {
      if (v && typeof v === "object" && typeof v.server === "function") {
        assert(`对象导出无 server 函数：${rel}#${name}（kE2 会把 obj.server 当工厂调用）`, false);
      }
      continue;
    }
    if (!fnByRef.has(v)) fnByRef.set(v, name);
  }
  assert(
    `唯一工厂引用：${rel}（实际 ${fnByRef.size} 个不同函数导出；多余引用会被 vE2 各当插件注册/调用 → 启动崩溃级缺陷）`,
    fnByRef.size === 1,
  );
  // Map 键 = 函数引用，值 = 导出名（迭代解构按 [fn, name] 取）
  for (const [fn, refName] of fnByRef) {
    try {
      const hooks = await fn(CTX, undefined);
      // never-throw 契约：工厂必须返回对象（钩子表），不能是 undefined/null
      assert(`工厂不抛且返回对象：${rel}#${refName}`, hooks !== null && typeof hooks === "object");
    } catch (e) {
      assert(`工厂不抛且返回对象：${rel}#${refName}（工厂抛错 → 插件注册表留洞 → provider 级联）: ${e?.message ?? e}`, false);
    }
  }
}

// ── 断言 5：lib/ 下的共享库必须能独立加载（供插件 import）──
if (fs.existsSync(LIB_DIR)) {
  for (const f of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith(".ts"))) {
    const rel = `lib/${f}`;
    try {
      await import(pathToFileURL(path.join(LIB_DIR, f)).href);
      assert(`共享库可加载：${rel}`, true);
    } catch (e) {
      assert(`共享库可加载：${rel}: ${e?.message ?? e}`, false);
    }
  }
}

// ── 断言 6：流式工具 execute 契约（2026-09-22 moa/dual_review f.split 崩溃根因）──
// kilo 消费端（a5$，逆向实证）同步检查 execute 返回值是否带 Symbol.asyncIterator：
// async execute 返回 Promise<AsyncGenerator> 不带该属性 → generator 对象被 await 后当
// final output 整体下发 → 下游渲染 f.split 崩溃（"undefined is not an object
// (evaluating 'f.split')"，17ms 必现、与参数无关）。契约：execute 为普通函数（非 async）、
// 同步返回 async iterable；模拟 a5$ 消费到结束，final yield 必须是字符串。
const STREAM_TOOLS = [
  { plugin: "moa.ts", tool: "moa", args: { task: "" } },
  { plugin: "dual-review.ts", tool: "dual_review", args: { subject: "" } },
];
for (const { plugin, tool, args } of STREAM_TOOLS) {
  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, plugin)).href);
  const factory = Object.values(mod).find((v) => typeof v === "function");
  const hooks = await factory(CTX, undefined);
  const execute = hooks?.tool?.[tool]?.execute;
  if (typeof execute !== "function") {
    assert(`execute 存在：plugin/${plugin}#${tool}`, false);
    continue;
  }
  const r = execute(args, {});
  assert(`execute 非 Promise（async 污染 → kilo f.split 崩溃）：plugin/${plugin}#${tool}`, !(r && typeof r.then === "function"));
  assert(`execute 同步返回 async iterable：plugin/${plugin}#${tool}`, r != null && typeof r[Symbol.asyncIterator] === "function");
  try {
    let last = undefined, n = 0;
    for await (const chunk of r) { last = chunk; n++; }
    assert(`a5$ 消费到结束 final 为字符串：plugin/${plugin}#${tool}（${n} 个 yield，final="${String(last).slice(0, 40)}"）`, typeof last === "string");
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 环境缺 kilo.json/auth.json（CI 等）时 loadCfg 抛错属环境问题，不算契约失败
    const envMissing = /hx-client|baseURL|auth\.json/.test(msg);
    assert(`a5$ 消费：plugin/${plugin}#${tool}${envMissing ? "（环境缺配置，final 断言跳过）" : `: ${msg}`}`, envMissing);
  }
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ""}`);
process.exit(process.exitCode ?? 0);
