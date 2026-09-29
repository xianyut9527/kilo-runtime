// 构建脚本：把 @ai-sdk/openai-compatible 及其依赖打包进 dist/index.js，
// 使 provider 包自包含（Kilo 加载 file:// 包时不解析外部 node_modules，实测确认）。
//
// 路径必须基于脚本自身位置解析：Kilo/CI/人工都可能从任意 cwd 调用，
// 用相对路径会在非包目录下报 "Could not resolve src/index.js"（踩过）。
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "src/index.js");

// 多入口防御（dual-review 必修项①，r2 扩口径）：指纹锚定 src/index.js 单文件，仅当
// bundle 确为该单入口时才准确——若未来 src 拆分多文件或经导入引入同仓其他 src，
// 改动不参与指纹会 silent fail（dist 过期但指纹仍 MATCH）。构建期断言拦截：
// 违反即 fail-fast，由维护者升级指纹口径（哈希全部参与 bundle 的 src 文件集合）。
// 口径（r2 修订）：枚举 bundle 可能参与的脚本文件 = .js/.ts/.tsx/.jsx/.mjs/.cjs，
// 但排除 .d.ts（类型声明被 esbuild 磨掉、不进 bundle）——避免合法类型文件误报阻断。
const srcDir = join(here, "src");
const srcFiles = await readdir(srcDir, { recursive: true, withFileTypes: true });
const BUNDLEABLE = /\.(?:js|ts|tsx|jsx|mjs|cjs)$/;
const srcEntries = srcFiles
  .filter((e) => e.isFile())
  .map((e) => join(e.parentPath ?? e.path, e.name))
  .filter((p) => BUNDLEABLE.test(p) && !p.endsWith(".d.ts"));
if (srcEntries.length !== 1 || srcEntries[0] !== srcPath) {
  throw new Error(
    `kilo-build: src 目录有 ${srcEntries.length} 个可参与 bundle 的脚本文件（期望仅 index.js）。` +
      ` 指纹口径只锚定 src/index.js——新增同仓 src 依赖会使改动逃过新鲜度检查，` +
      ` 请先升级 build.mjs 指纹为「哈希全部参与 bundle 的 src 文件集合」再添加文件。` +
      ` 当前文件: ${srcEntries.map((p) => relative(srcDir, p)).join(", ")}`,
  );
}
// 同仓相对导入防御（r3 必修项①：正则可被注释/模板字面量绕过 → 改构建事实校验）：
// src/index.js 若引用同仓文件（bundle 会内联进 dist），单文件指纹失准。r2 的四分支
// 正则漏拦 import(/*c*/'./x')、import(`./x`) 等插入形态。node22 无内置 AST 解析器，
// 但 esbuild 自带精确依赖图：metafile.inputs 就是 bundle 实际吞下的全部输入文件，
// 任何导入形态（注释/模板/动态/require）都无处可逃。断言下移至 build 调用之后。
const srcText = await readFile(srcPath, "utf8");

// dist 新鲜度指纹（2026-09-28）：install 脚本曾用 mtime 对比 src/dist 判断 dist 是否
// 过期，但 git checkout/还原会同步两个文件的 mtime（本机实证同秒），毫秒级精度即误报。
// 改为内容锚定：构建时把 src 内容 sha256 写进 dist 首行注释，install 端提取比对——
// 不依赖文件系统时间、可跨端/跨时区/跨 checkout 复现。
const srcHash = createHash("sha256").update(srcText).digest("hex");

const buildResult = await build({
  entryPoints: [srcPath],
  outfile: join(here, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 不外部化任何依赖：全部内联，保证 file:// 加载时零 node_modules
  external: [],
  // r3 必修项①：metafile 记录 bundle 实际吞下的全部输入文件（含 node_modules 依赖）
  metafile: true,
  // cwd 无关锚定（2026-09-29 修复）：metafile 键默认相对 process.cwd()——从仓库根
  // 调用构建时键形如 provider/hx-failover/src/index.js，下方 src/ 前缀过滤被击穿
  // （断言误报 0 输入）。锚定包目录后键恒为 src/index.js，任意 cwd 可调用。
  absWorkingDir: here,
  logLevel: "info",
});

// 参与 bundle 的 src 侧输入断言（metafile 事实，非源码形态扫描——注释/模板/动态
// import/require 任何形态引入的文件都会出现在 inputs 里，零绕过面）：
// 期望 inputs 中属于本包 src/ 的文件恰好只有 src/index.js。
const srcInputs = Object.keys(buildResult.metafile.inputs).filter((k) => {
  const norm = k.replaceAll("\\", "/");
  return norm.startsWith("src/") || norm.startsWith("./src/");
});
const onlyIndex = srcInputs.length === 1 && srcInputs[0].replace(/^\.\//, "").replace(/\\/g, "/") === "src/index.js";
if (!onlyIndex) {
  const rel = srcInputs.map((k) => k.replace(/^\.\//, "")).join(", ");
  throw new Error(
    `kilo-build: bundle 吞入了 ${srcInputs.length} 个 src 侧文件（期望仅 src/index.js）: ${rel}——` +
      "单文件指纹口径失准（任何导入形态引入的同仓 src 都会在此暴露），" +
      "请升级 build.mjs 指纹为「哈希全部参与 bundle 的 src 文件集合」或改用 package 依赖。",
  );
}

const banner = `// kilo-build: src-sha256=${srcHash}\n`;
const distPath = join(here, "dist/index.js");
const distSrc = await readFile(distPath, "utf8");
await writeFile(distPath, banner + distSrc, "utf8");
console.log(`dist 嵌入 src 指纹: ${srcHash.slice(0, 16)}…`);
