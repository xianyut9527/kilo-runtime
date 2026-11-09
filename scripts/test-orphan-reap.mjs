#!/usr/bin/env node
// test-orphan-reap.mjs —— 孤儿进程收割器回归（MoA P0-1 安全模型钉死）
// 断言分两层：
//   1) 静态结构钉死（跨平台，无 PowerShell 也能跑）：kilo-maintenance.ps1 源码里必须
//      同时存在安全护栏——deny 优先（chrome/msedge 跳过）、候选只收 node/kilo、
//      三条件 AND（父死 + 年龄 >24h + 签名 allowlist）、杀前 PID+CreationDate 复验、
//      pm2 只报告不杀、树杀 taskkill /T /F、无孤儿不落盘。
//   2) win32 动态干跑（只读）：-ListOrphans 退出码 0、输出 DRY-RUN 摘要、绝不出现
//      KILLED；-Status 含 [BOOT]/[REAP]/[DIR] 可见性行。
// 用法：node scripts/test-orphan-reap.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAINT = path.join(here, "kilo-maintenance.ps1");
const src = fs.readFileSync(MAINT, "utf8");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { failed.push(name); console.error(`  FAIL: ${name}${extra ? " | " + extra : ""}`); fail++; }
};

console.log("== 1) 静态安全护栏（deny 优先 + 签名 allowlist + 复验）==");
t("deny：chrome/msedge 命令行直接跳过", /'chrome\|msedge'/.test(src));
t("候选只收 node.exe/kilo.exe（chrome/用户 shell 不在列）",
  /\$p\.Name -ne 'node\.exe' -and \$p\.Name -ne 'kilo\.exe'/.test(src));
t("父活豁免：父 PID 在存活集 = 非孤儿", /live\.Contains\(\[uint32\]\$p\.ParentProcessId\)/.test(src));
t("年龄门：默认 24h 观察窗 + CreationDate 门", /\$ReapMinAgeHours = 24/.test(src) && /CreationDate -ge \$cut/.test(src));
t("签名 allowlist 收敛（runner/npm dev/start:test/npx/MCP/jest）", /__background-process-runner/.test(src)
  && /npm-cli\\\.js/.test(src) && /start:test/.test(src) && /npx-cli\\\.js/.test(src)
  && /modelcontextprotocol/.test(src) && /jest/.test(src));
t("测试驱动扩面：playwright/puppeteer/vitest/mocha（浏览器随树杀，chrome 仍 deny）",
  /playwright\[/.test(src) && /puppeteer\[/.test(src) && /vitest\|mocha/.test(src));
t("pm2 只报告不杀（reportOnly 优先于 kill 签名）", /reportOnlySigs = @\('pm2'\)/.test(src));
t("杀前 PID+CreationDate 复验（PID 复用防线）", /SKIP-REVALIDATE/.test(src));
t("树杀：taskkill /PID <id> /T /F", /taskkill\.exe \/PID \$p\.ProcessId \/T \/F/.test(src));
t("收割日志 yyyyMMdd-HHmmss-reap.log（匹配既有轮转模式）", /\$stamp-reap\.log/.test(src));
t("惰性落盘：无孤儿不写文件", /considered -gt 0/.test(src));

console.log("== 2) win32 只读干跑 ==");
if (process.platform === "win32") {
  const runPs = (args) => spawnSync("powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MAINT, ...args],
    { encoding: "utf8", timeout: 120000 });
  let r = runPs(["-ListOrphans"]);
  const out = (r.stdout || "") + (r.stderr || "");
  t("-ListOrphans 退出码 0", r.status === 0, `status=${r.status}`);
  t("输出 DRY-RUN 摘要行", /\[REAP\] DRY-RUN 完成：/.test(out), (out.match(/\[REAP\][^\n]*/) || [""])[0].slice(0, 120));
  t("干跑绝不真杀（无 KILLED 行）", !/\[REAP\]\[KILLED\]/.test(out));
  r = runPs(["-Status"]);
  const so = (r.stdout || "") + (r.stderr || "");
  t("-Status 退出码 0", r.status === 0, `status=${r.status}`);
  t("-Status 含开机通道状态行", /\[BOOT\] 开机通道：/.test(so));
  t("-Status 含孤儿收割可见性行", /\[REAP\] (孤儿收割：|最近收割（)/.test(so));
  const maintDir = path.join(os.homedir(), ".local", "state", "kilo", "maintenance");
  if (fs.existsSync(maintDir)) t("-Status 含状态目录体量行", /\[DIR \] /.test(so));
  else console.log("  skip: 维护目录不存在，跳过 [DIR] 断言");
} else {
  console.log("  skip: 非 win32 平台跳过动态干跑（静态护栏已覆盖）");
}

console.log(`\n${pass} passed, ${fail} failed${failed.length ? `；失败：${failed.join(" | ")}` : ""}`);
process.exit(fail ? 1 : 0);