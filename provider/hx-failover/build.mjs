// 构建脚本：把 @ai-sdk/openai-compatible 及其依赖打包进 dist/index.js，
// 使 provider 包自包含（Kilo 加载 file:// 包时不解析外部 node_modules，实测确认）。
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.js"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 不外部化任何依赖：全部内联，保证 file:// 加载时零 node_modules
  external: [],
  logLevel: "info",
});
