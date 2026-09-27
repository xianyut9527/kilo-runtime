#!/usr/bin/env node
// permission-guard 动态守护离线回归：不联网、不起 Kilo。
// 用法：node scripts/test-permission-guard.mjs
// 原理：用 esbuild（provider 的既有依赖）把 plugin/permission-guard.ts 打包到临时文件，
// 经公开工厂 `PermissionGuard({})` 取 `tool.execute.before` 钩子直接调用——throw 即拦截。
// 覆盖（2026-09-27 .env.example 误伤专项）：模板型 .env 变体（.example/.sample/.template/
// .tmpl/.dist）必须放行（read/write/bash 三通道），真实机密 .env 系列必须拦住；
// 其余 SECRET_PATH/PROTECTED_PATH/DENY_BASH 行为抽测防止宽化回归。
// 任何把模板误伤回来的宽化、或把真实机密放行的窄化，都会让本测试变红。
// 注意：本文件必须在 scripts/ 下（不进 install.manifest）——放 plugin/ 会随整目录部署进生产配置。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const esbuildBin = path.join(ROOT, "provider/hx-failover/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuildBin)) {
  console.error("[test] esbuild 未安装：先在 provider/hx-failover 跑 npm install");
  process.exit(2);
}
const bundle = path.join(os.tmpdir(), `pg-test-${process.pid}.mjs`);
execFileSync(process.execPath, [esbuildBin, path.join(ROOT, "plugin", "permission-guard.ts"),
  "--bundle", "--platform=node", "--format=esm", "--external:node:*", `--outfile=${bundle}`], { stdio: "inherit" });
const mod = await import(pathToFileURL(bundle).href);
fs.rmSync(bundle, { force: true });

const plugin = await mod.PermissionGuard({});
const hook = plugin["tool.execute.before"];
if (typeof hook !== "function") {
  console.error("[test] 工厂未返回 tool.execute.before 钩子");
  process.exit(2);
}

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; failed.push(name); console.error(`  FAIL: ${name}`); }
};

async function blocked(tool, args) {
  try { await hook({ tool }, { args }); return false; }
  catch { return true; }
}

// ── 模板型 .env 变体：必须放行（2026-09-27 误伤修复） ──
for (const name of [".env.example", ".env.sample", ".env.template", ".env.tmpl", ".env.dist"]) {
  t(`read ${name} 放行`, !(await blocked("read", { filePath: `proj/${name}` })));
  t(`write ${name} 放行`, !(await blocked("write", { filePath: `proj/${name}` })));
  t(`bash cat ${name} 放行`, !(await blocked("bash", { command: `cat /tmp/proj/${name}` })));
}

// ── 真实机密 .env 系列：必须拦住（防豁免宽化） ──
for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.test"]) {
  t(`read ${name} 拦截`, await blocked("read", { filePath: `proj/${name}` }));
}
t("bash cat .env 拦截", await blocked("bash", { command: "cat /tmp/proj/.env" }));
t("bash cp .env.production 拦截", await blocked("bash", { command: "cp proj/.env.production /tmp/x" }));
t("Windows 反斜杠路径 .env.local 拦截", await blocked("read", { filePath: "D:\\work\\proj\\.env.local" }));
t("Windows 反斜杠路径 .env.example 放行", !(await blocked("read", { filePath: "D:\\work\\proj\\.env.example" })));

// ── 其它 SECRET_PATH 抽测（防本次改动误伤） ──
t("auth.json 拦截", await blocked("read", { filePath: "proj/auth.json" }));
t("id_rsa 拦截", await blocked("read", { filePath: "proj/id_rsa" }));
t(".ssh 目录 拦截", await blocked("read", { filePath: "/home/u/.ssh/config" }));

// ── 通道与形态补全（2026-09-27 二轮审查：list/edit 工具、大小写、非 ASCII、重定向写） ──
t("list .env.example 放行", !(await blocked("list", { path: "proj/.env.example" })));
t("list .env.production 拦截", await blocked("list", { path: "proj/.env.production" }));
t("edit .env.example 放行", !(await blocked("edit", { filePath: "proj/.env.example" })));
t("edit .env.local 拦截", await blocked("edit", { filePath: "proj/.env.local" }));
t(".ENV.EXAMPLE 大写放行（两则正则均 /i，口径一致）", !(await blocked("read", { filePath: "proj/.ENV.EXAMPLE" })));
t(".ENV 大写拦截", await blocked("read", { filePath: "proj/.ENV" }));
t(".env.example.bak 后缀失配回落拦截（豁免只精确五后缀）", await blocked("read", { filePath: "proj/.env.example.bak" }));
t("中文目录 .env.example 放行", !(await blocked("read", { filePath: "D:\\work\\项目甲\\.env.example" })));
t("中文目录 .env.local 拦截", await blocked("read", { filePath: "D:\\work\\项目甲\\.env.local" }));
t("bash 重定向写模板 .env.example 放行", !(await blocked("bash", { command: "echo x > proj/.env.example" })));
t("bash 重定向写真实 .env 拦截", await blocked("bash", { command: "echo x > proj/.env" }));
t("bash node 脚本读 .env 拦截", await blocked("bash", { command: "node -e \"require('fs').readFileSync('proj/.env')\"" }));
t("bash node 脚本读裸 .env 拦截（无分隔符形态，2026-09-27 二轮审查补）", await blocked("bash", { command: "node -e \"const s=require('fs').readFileSync('.env','utf8')\"" }));
t("bash python 读反斜杠 .env 拦截", await blocked("bash", { command: "python -c \"open('D:\\\\work\\\\proj\\\\.env').read()\"" }));
t("bash node 读普通文件放行（提取器不得误伤）", !(await blocked("bash", { command: "node -e \"require('fs').readFileSync('README.md','utf8')\"" })));
t("无路径普通命令放行", !(await blocked("bash", { command: "npm run build" })));
t("空参数不炸（放行）", !(await blocked("bash", { command: "" })));
t("read 无参数不炸（放行）", !(await blocked("read", {})));

// ── PROTECTED_PATH 与 DENY_BASH 抽测 ──
t("package-lock.json 写入拦截", await blocked("write", { filePath: "proj/package-lock.json" }));
t("package-lock.json 读取放行", !(await blocked("read", { filePath: "proj/package-lock.json" })));
t("agent-manager.json 写入拦截", await blocked("write", { filePath: "proj/.kilo/agent-manager.json" }));
t("rm -rf 拦截", await blocked("bash", { command: "rm -rf /tmp/x" }));
t("git push --force 拦截", await blocked("bash", { command: "git push --force origin main" }));
t("普通文件读取放行", !(await blocked("read", { filePath: "src/main.ts" })));
t("普通命令放行", !(await blocked("bash", { command: "git status" })));

console.log(`\n${fail === 0 ? "✅" : "❌"} permission-guard 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
