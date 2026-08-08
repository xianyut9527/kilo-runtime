#!/usr/bin/env node
// bash-guard.mjs
// bash 命令静态分析拦截器 — 检测文件写入/修改意图。
//
// 定位：框架在 conductor 调用 bash 工具前自动执行，命中写入意图则阻断。
// 本脚本为非穷尽黑名单，后续新增模式请同步维护 WRITE_PATTERNS。
//
// 用法：node scripts/bash-guard.mjs "<bash_command_string>"
// 退出码：0=安全（只读）；1=参数错误；2=检测到写入意图（BLOCKED）

import process from 'node:process';

const WRITE_PATTERNS = [
  // PowerShell 写入
  /Set-Content\s/i,
  /Add-Content\s/i,
  /Out-File\s/i,
  /New-Item\s+.*-ItemType\s+File/i,
  // 重定向
  /(?<!\d)>(?!>|\s*\$null|\s*\$\w+|\s*\d|\s*\])[\s]*['"]?\S+/,
  />>(?!>)[\s]*['"]?\S+/,
  // 通用写入命令
  /\becho\b.*>(?!>)/i,
  /\btee\b/i,
  /\bsed\s+-i\b/i,
  /\bawk\b.*>/,
  // Node.js / Python / Ruby 写入
  /writeFileSync\s*\(/,
  /appendFileSync\s*\(/,
  /fs\.writeFile\s*\(/,
  /open\s*\(\s*['"\w]*['"\w]*,\s*['"][wa]/,
  // git 修改性操作
  /\bgit\s+(commit|push|merge|rebase|reset|checkout\s+-b|branch\s+-[dD]|tag\s+-[dD]|rm\s+-[rf]|mv\s+)/i,
  // npm / 包管理器发布
  /\bnpm\s+(publish|unpublish|deprecate|dist-tag)/i,
  /\bnpx\s+/i,
  // 危险的 bash 内置
  /\brm\s+-[rf]/i,
  /\bmv\s+/i,
  /\bcp\s+/i,
  /\bchmod\s+/i,
  /\bchown\s+/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\bln\s+/i,
  /\bdd\b.*\bof=/i,
  /\bcurl\b.*-o\s/i,
  /\bwget\b.*-O\s/i,
  /\bpython\b.*-c\b.*write/i,
];

function analyze(cmd) {
  const hits = [];
  for (const pat of WRITE_PATTERNS) {
    if (pat.test(cmd)) hits.push(pat.toString());
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write('Usage: node scripts/bash-guard.mjs "<bash_command_string>"\n');
    process.exit(1);
  }
  const cmd = args[0];
  const hits = analyze(cmd);
  if (hits.length > 0) {
    process.stdout.write(`[BASH_WRITE_BLOCKED] 检测到写入/修改意图 (${hits.length} 条匹配):\n`);
    for (const h of hits) process.stdout.write(`  - ${h}\n`);
    process.stdout.write(`  原始命令: ${cmd.slice(0, 200)}\n`);
    process.exit(2);
  }
  process.stdout.write(`PASS bash-guard: 命令无写入意图\n`);
  process.exit(0);
}

main();
