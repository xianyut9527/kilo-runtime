// 构建脚本：把 @ai-sdk/openai-compatible 及其依赖打包进 dist/index.js，
// 使 provider 包自包含（Kilo 加载 file:// 包时不解析外部 node_modules，实测确认）。
//
// 路径必须基于脚本自身位置解析：Kilo/CI/人工都可能从任意 cwd 调用，
// 用相对路径会在非包目录下报 "Could not resolve src/index.js"（踩过）。
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "src/index.js")],
  outfile: join(here, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 不外部化任何依赖：全部内联，保证 file:// 加载时零 node_modules
  external: [],
  logLevel: "info",
});
