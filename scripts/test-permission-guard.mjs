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

// ── Windows 破坏性命令（2026-09-29 查漏补缺：命令位锚定 + 误伤回归） ──
// 拦截侧：磁盘格式化/分区、动态执行任意字符串（含链式调用与 sudo 前缀）
for (const cmd of [
  "format C: /q",
  "format.com D: /fs:ntfs",
  "format",                       // 裸 format（交互式喂盘符是真实格式化路径，r1 反向必修项）
  "echo c:|format",               // 管道喂盘符
  "format>nul",                   // 重定向直连（r2 必修：无空白同构漏拦）
  "format|more",                  // 管道直连（r2 必修）
  "format/q",                     // 无空格参数（r2 必修）
  "format.com/q",
  "format \\\\.\\PhysicalDrive0 /q", // 设备路径形态（无盘符冒号）
  "C:\\Windows\\System32\\format.com D:", // 绝对路径命令名（r2 必修）
  ".\\format C:",
  "./format C:",
  "(format C:)",                  // subshell 形态（CMD_START 分隔符补 (）
  "foo && format C:",
  "; format D:",
  "sudo format C:",
  "sudo -u root format",          // wrapper 带参（r2 必修）
  "env -i A=1 format",
  "nice -n 5 format",
  "env format C:",
  "Format-Volume -DriveLetter D", // 命令位 Format-Volume
  "diskpart",
  "diskpart /s x.txt",
  "C:\\Windows\\System32\\diskpart.exe /s x",
  "foo; diskpart",
  "Invoke-Expression $x",
  "iex(New-Object x)",
  "iex $x",
  "& iex $x",
  "; iex $x",
  "foo | iex $x",
  "sudo iex $x",
  "iex.exe $x",
  "sudo mkfs.ext4 /dev/sda1",     // mkfs 命令位（含 wrapper 与后缀）
  "/sbin/mkfs.ext4 /dev/sda1",    // 绝对路径 mkfs
  "C:format.com D:",              // 盘符相对路径（r3 必修）
  "C:format D:",
  "env -i format C:",             // wrapper 无值单 flag（r3 反向高1，必修）
  "sudo -n format C:",
  "sudo -E mkfs.ext4 /dev/sda1",
  "sudo --user=root format",
  "sudo env format C:",           // 链式 wrapper（r3 反向高2，必修）
  "command exec format C:",
  "timeout 5 mkfs.ext4 /dev/sda1",
  "doas format C:",
  "format;rm -rf /tmp/x",         // 分号直连（r3 正向）
  "format.bat C: /q",             // 可执行扩展名 .bat/.cmd（r3 中1；仅可执行后缀，非任意）
  "format.cmd /q",
  "./iex.exe $x",                 // iex 路径前缀（r3 低项）
  // ── r4：嵌套 shell 载体（裸/引号 payload）与控制流关键字 ──
  "cmd /c format C:",             // cmd.exe 载体 + /x 风格 flag
  'cmd /c "format C:"',           // 引号 payload（winCmd 引号前缀）
  "sh -c format C:",
  'sh -c "format C:"',
  'bash -c "Format-Volume -DriveLetter D"',
  "bash -lc format",              // 组合 flag（-lc）裸 payload
  "pwsh -Command iex $x",
  'pwsh -Command "iex $x"',
  "runas /u:admin format C:",     // runas 载体 + /u:参数
  "time format C:",               // time 计时前缀
  "if x; then format C:; fi",     // then 控制流关键字
  "for f in *; do diskpart /s x; done",
  "{ format C:; }",               // 花括号块
  // ── r4：shutdown 家族（裸词误伤修复后的拦截面回归） ──
  "shutdown",
  "shutdown /s /t 0",
  "sudo shutdown -h now",
  "Stop-Computer -Force",
  "Restart-Computer",
  "C:\\Windows\\System32\\shutdown.exe /s",
  "env -i shutdown",              // wrapper 参数值不吞危险词（DANGER_WORDS 补 shutdown）
  "sudo -n Stop-Computer",
]) {
  t(`DENY_BASH 拦截：${cmd}`, await blocked("bash", { command: cmd }));
}
// 放行侧（本次修复的反向锁）：危险词作参数/检索词/普通动词时不误伤
for (const cmd of [
  "npm run format",
  "npm run format c:",
  "git log --format=%H:%s",
  "git log --format=%s --author=x",
  'git commit --format="%s"',
  "npx eslint --format=json .",
  "grep -n diskpart README.md",
  "Get-Help diskpart",
  'rg "iex " .',
  "cat format.txt",
  "cat src/format.ts",            // 路径前缀形态的非命令位（防 r2 路径分支过度拦截）
  "node foo/format.js",
  "node iex.mjs",
  "echo iex",
  "Get-Help Format-Table",
  "Get-Help Format-Volume", // 帮助查询不是格式化（同类误伤修复的反向锁）
  "grep mkfs README.md",    // mkfs 作检索词（与 format 规则口径统一的反向锁）
  "man mkfs",
  "Get-ChildItem | Format-Table",
  "env -i node format.js",        // wrapper 吞解释器后脚本名落命令位（r3 实测误伤，防回归）
  "sudo -u deploy node format.js",
  "timeout 30 node ./format.mjs",
  // ── r4：shutdown 作普通名词/脚本名（裸词规则同类误伤的反向锁） ──
  "npm run shutdown",             // npm 生命周期脚本
  "grep -n shutdown README.md",
  "Get-Help shutdown",
  "Get-Help Stop-Computer",
  "cat shutdown.log",
  "man shutdown",
  // ── r4：shell 载体跑非危险 payload ──
  "sh -c \"echo hi\"",
  "bash -c \"ls -la\"",
  "pwsh -Command Get-Date",
  "cmd /c dir",
  "pwsh -File format.ps1",        // ps1 脚本名非可执行后缀
  "bash format.sh",
  "sh format.txt",
  "time npm test",
]) {
  t(`DENY_BASH 放行：${cmd}`, !(await blocked("bash", { command: cmd })));
}

// ── r5：git 全局旗标链（`git -C repo push --force` 等穿插形态）与 +refspec 强推 ──
for (const cmd of [
  "git -C repo push --force origin main",
  "git --git-dir=x/.git push --force",
  "git --git-dir=x push -f",
  "git -c a=b push -f",
  "git -C repo -c a=b push --force",
  "git push origin +master",
  "git push --force-with-lease origin main",
  "git -C repo reset --hard",
  "git -C \"E:\\repo x\" reset --hard",
  "git -C repo clean -fd",
  "git -C repo checkout -- .",
  "git -C repo restore .",
  "git --no-pager push --force",
]) {
  t(`DENY_BASH 拦截：${cmd}`, await blocked("bash", { command: cmd }));
}
// r5 放行侧反向锁：旗标链不得把检索词/日志命令一并拦下
for (const cmd of [
  "git push origin main",
  "git --no-pager push",
  "git --no-pager log --oneline",
  "git log --grep \"reset --hard\" docs",
  "git grep \"push --force\" docs",
  "git grep \"reset --hard\" docs",
  "git -C repo status",
  "git -C repo log --format=%H",
  "git -C repo clean -n",
  "git -C repo restore src/x.ts",
  "git commit --format=\"%s\"",
  "npm publish --dry-run",
  "npm publish --dry-run --json",
]) {
  t(`DENY_BASH 放行：${cmd}`, !(await blocked("bash", { command: cmd })));
}

// ── r5：rm 拆分旗标 / rd /s /q（Windows 版 rm -rf） ──
for (const cmd of [
  "rm -r -f /tmp/x",
  "rm -f -r /tmp/x",
  "rm --recursive --force /tmp/x",
  "rm --force --recursive /tmp/x",
  "rm -r --force /tmp/x",
  "rm -R -F /tmp/x",
  "rm -rv -f /tmp/x",
  "rd /s /q C:\\build",
  "rd /q /s C:\\x",
  "rmdir /s /q C:\\build",
  "cmd /c rd /s /q C:\\x",
]) {
  t(`DENY_BASH 拦截：${cmd}`, await blocked("bash", { command: cmd }));
}
for (const cmd of [
  "rm -i file.txt",
  "rm -r -v dir",
  "rm -v -r dir",
  "rm -f file.sql",
  "rm -r dist",
  "rd tempdir",
  "Get-Help rd",
]) {
  t(`DENY_BASH 放行：${cmd}`, !(await blocked("bash", { command: cmd })));
}

// ── r5：Start-Process 载体 / 磁盘 cmdlet / 卷影副本 ──
for (const cmd of [
  "Start-Process format C:",
  "Start-Process -FilePath diskpart",
  "pwsh -Command Start-Process format C:",
  "pwsh -Command Clear-Disk -Number 0",
  "Clear-Disk -Number 0",
  "Initialize-Disk -Number 1",
  "sudo Clear-Disk -Number 0",
  "vssadmin delete shadows /all /quiet",
  "sudo vssadmin delete shadows",
  "wbadmin delete catalog",
  "mke2fs /dev/sda1",
  "sudo mke2fs /dev/sda1",
  "env -i mke2fs /dev/sda1",
]) {
  t(`DENY_BASH 拦截：${cmd}`, await blocked("bash", { command: cmd }));
}
for (const cmd of [
  "Start-Process notepad",
  "Start-Process npm test",
  "Get-Help Clear-Disk",
  "Get-Help Initialize-Disk",
  "grep vssadmin README.md",
  "Get-Help vssadmin",
  "vssadmin list shadows",
  "wbadmin get versions",
  "cat mke2fs.txt",
  "node mke2fs.js",
]) {
  t(`DENY_BASH 放行：${cmd}`, !(await blocked("bash", { command: cmd })));
}

// ── r5：凭证文件面扩（.git-credentials / id_dsa） ──
t("read .git-credentials 拦截", await blocked("read", { filePath: "proj/.git-credentials" }));
t("bash cat .git-credentials 拦截", await blocked("bash", { command: "cat ~/.git-credentials" }));
t("bash cp .git-credentials 拦截", await blocked("bash", { command: "cp .git-credentials /tmp/x" }));
t("read id_dsa 拦截", await blocked("read", { filePath: "proj/id_dsa" }));
t("read .git-credentials.example 放行", !(await blocked("read", { filePath: "proj/.git-credentials.example" })));

console.log(`\n${fail === 0 ? "✅" : "❌"} permission-guard 回归：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`失败用例：\n  - ${failed.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
