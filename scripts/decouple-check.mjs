#!/usr/bin/env node
/**
 * decouple-check.mjs — 扫全仓第三方 MCP 工具名残留
 *
 * 扫 gitnexus / context7 / GitNexus / Context7 / @playwright / .playwright-mcp
 * 自动发现遗漏(.gitignore 漏改教训)
 *
 * exit 0 = 0 critical
 * exit 1 = ≥1 critical
 * exit 2 = usage error
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const KEYWORDS = ['gitnexus', 'context7', 'GitNexus', 'Context7', '@playwright', '.playwright-mcp'];
const EXCLUDES = [
  '.git/', 'node_modules/', '.worktrees/', '.kilo_tmp/', '.playwright-mcp', 'CHANGELOG.md', 'docs/archive/', '.kilo/skills/', 'lifecycle/stages/archive/',
  // 自豁免:扫描器自身 + lifecycle-doctor 集成
  'scripts/decouple-check.mjs',
  'lifecycle-doctor/checks/decouple-audit.mjs',
  'lifecycle-doctor/index.mjs'
];

function getAllFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // 路径规范化(防路径陷阱):path.join 在 Windows 用 \,EXCLUDES 用 /,必 replace 避免 includes 永不匹配
    if (EXCLUDES.some(e => full.replace(/\\/g, '/').includes(e))) continue;
    if (entry.isDirectory()) {
      getAllFiles(full, files);
    } else if (/\.(mjs|js|json|ps1|sh|md|yml|yaml)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function checkFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const kw of KEYWORDS) {
      if (lines[i].includes(kw)) {
        // 排除配置段 _comment / _usage(允许保留的元数据)
        if (kw === 'context7' || kw === 'gitnexus' || kw === 'playwright' || kw === '@playwright') {
          if (/_comment|_usage/.test(lines[i])) continue;
        }
        // 排除 kilo.json mcp 段(允许 enabled: false 保留工具名作为配置)
        if (file.endsWith('kilo.json') && /mcp/.test(lines[i])) {
          // 仅当是配置对象本身允许
          if (lines[i].includes('"name"') || lines[i].includes('"type"') || lines[i].includes('"url"') || lines[i].includes('"command"') || lines[i].includes('"timeout"') || lines[i].includes('"enabled"') || lines[i].includes('"_usage"') || lines[i].includes('"_comment"')) {
            continue;
          }
        }
        hits.push({
          file: file.replace(ROOT + path.sep, ''),
          line: i + 1,
          keyword: kw,
          text: lines[i].trim().slice(0, 80)
        });
      }
    }
  }
  return hits;
}

function main() {
  const files = getAllFiles(ROOT);
  const allHits = [];
  for (const f of files) {
    const hits = checkFile(f);
    allHits.push(...hits);
  }
  // 严重度:文档/配置段→info,脚本/.gitignore/install→critical
  const report = allHits.map(h => {
    let severity = 'warning';
    if (/\.mjs$|\.gitignore$|install\./.test(h.file)) {
      // install 脚本 EXCLUDE 数组中声明 .playwright-mcp 不算 critical（排除列表语义）
      if (/["'][^"']*\.playwright-mcp[^"']*["']/.test(h.text)) severity = 'warning';
      else severity = 'critical';
    }
    if (/\.md$/.test(h.file) && h.text.includes('GitNexus')) severity = 'warning';  // 历史文档允许
    return { ...h, severity };
  });
  const critical = report.filter(h => h.severity === 'critical');
  console.log(JSON.stringify({
    scan_time: new Date().toISOString(),
    total_files: files.length,
    total_hits: report.length,
    critical_count: critical.length,
    warning_count: report.filter(h => h.severity === 'warning').length,
    hits: report
  }, null, 2));
  process.exit(critical.length > 0 ? 1 : 0);
}

main();
