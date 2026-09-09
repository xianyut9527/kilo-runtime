#!/usr/bin/env node
/**
 * decouple-check.mjs — 扫全仓第三方 MCP 工具名残留（厂商耦合门禁）
 *
 * 扫 gitnexus / context7 / GitNexus / Context7 / @playwright / .playwright-mcp
 * 自动发现遗漏(.gitignore 漏改教训)
 *
 * exit 0 = 0 critical
 * exit 1 = ≥1 critical
 * exit 2 = usage error
 *
 * ---------------------------------------------------------------------------
 * 作用域与白名单为什么必须精确（本门禁曾因恒非零 warning 而沦为噪声）：
 *
 * 1. 只扫「配置与规则本体」。运行时数据里的关键词是**任务题材**不是框架耦合——
 *    `.kilo/mmo-audit/` 一份历史审计因任务主题是某项目分组报告而刷出 6 条命中，
 *    `.tmp/` 的临时扫描报告刷出 1 条。这类命中永远清不干净（每跑一次任务就可能新增），
 *    留着就等于让 warning 恒定非零 = 零信号 = 真耦合出现时没人看。
 * 2. 点目录一律跳过，唯一例外 `.kilo`（承载 instructions/command/scripts 规则本体）。
 *    不在此枚举具体厂商目录名——枚举本身就是耦合，且新工具落地就漏。
 * 3. 白名单只收「反向引用」与「自描述」两类，且每条必须带理由、命中数单独计数输出，
 *    不静默吞掉：把厂商名写进**排除清单**是在拒绝耦合，描述**扫描器自己扫什么**
 *    必须写出关键词，两者都不是依赖。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const KEYWORDS = ['gitnexus', 'context7', 'GitNexus', 'Context7', '@playwright', '.playwright-mcp'];

// 注：`.git/` `.tmp/` `.kilo_tmp/` `.worktrees/` `node_modules/` 等已由下方「点目录一律跳过」
// 与 node_modules 快路覆盖，不在此重复枚举。本清单只收点目录规则盖不住的路径。
const EXCLUDES = [
  'CHANGELOG.md', 'docs/archive/', 'lifecycle/stages/archive/',
  // `.kilo` 是点目录例外的唯一入口，其下运行时数据子目录必须单独排除
  '.kilo/skills/', '.kilo/mmo-audit/', '.kilo/task_context/', '.kilo/worktrees/',
  // 自豁免:扫描器自身 + lifecycle-doctor 集成
  'scripts/decouple-check.mjs',
  'lifecycle-doctor/checks/decouple-audit.mjs',
  'lifecycle-doctor/index.mjs'
];

// 反向引用：整行只有引号字符串列表项（部署排除清单 / drift-check EXCLUDE 数组）
const LIST_ENTRY_LINE = /^\s*(["'][^"']*["']\s*,?\s*)+$/;
// 自描述：说明「本扫描器扫哪些关键词」的行，必须写出关键词才能表达
const SELF_DOC_LINE = /decouple-check/;
// 占位配置键名：`"gitnexus": {` 就是 mcp 节的配置对象本身（默认 enabled:false）
const CONFIG_KEY_LINE = /^\s*"[\w.@/-]+"\s*:\s*\{\s*$/;

/**
 * 定位 kilo.json 里 `"mcp": { ... }` 节的行号集合（花括号配对跟踪）。
 * 该节是**配置声明区**：工具名在此属占位配置本体（键名 + command/url/enabled），
 * 不属「规则假定工具存在」。真正的耦合风险在运行时 instructions / agent 文档 / scripts。
 * （局限：若未来在 mcp 节内写带花括号的字符串值会误配对；当前无此写法。）
 */
function findMcpSectionLines(lines) {
  const set = new Set();
  let inMcp = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!inMcp && /^\s*"mcp"\s*:\s*\{/.test(lines[i])) { inMcp = true; depth = 0; }
    if (!inMcp) continue;
    set.add(i);
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth <= 0) inMcp = false;
  }
  return set;
}

/**
 * 白名单：关键词出现在这些位置属「反耦合」或「自描述」，不计入 warning。
 * 每条带 reason 以便审计；命中数在输出里单列 benign_count，不做静默吞并。
 * test(line, meta) —— meta.inMcpSection 仅在 kilo.json 可能为 true。
 */
const BENIGN = [
  { file: 'kilo.json', test: (line, meta) => meta.inMcpSection || CONFIG_KEY_LINE.test(line), reason: 'mcp 节占位配置（enabled:false，需用时才开）' },
  { file: 'scripts/README.md', test: (line) => SELF_DOC_LINE.test(line), reason: '扫描器自身的功能说明' },
  { file: 'install.ps1', test: (line) => LIST_ENTRY_LINE.test(line), reason: '部署排除清单条目（反向引用）' },
  { file: 'install.sh', test: (line) => LIST_ENTRY_LINE.test(line), reason: '部署排除清单条目（反向引用）' },
  // lib 里的 FALLBACK_*_EXCLUDE 是 install 清单的**回落镜像**（只在读不到 install 脚本时生效），
  // 性质与上面两条完全相同。不豁免会导致：新增一个带工具名的排除项就要改两处（install 清单 + 此处）。
  // 上一版只豁免了 install 两脚本，镜像一份到 lib 时立刻被本门禁判 critical——这是「镜像会漂元规则」的实证。
  { file: 'scripts/lib/install-runtime-data.mjs', test: (line) => LIST_ENTRY_LINE.test(line), reason: '部署排除清单回落镜像条目（反向引用）' }
  // 已删：`scripts/deploy-drift-check.mjs` 同款豁免——该文件的排除清单已改为从 install 解析，
  // 文件内已无清单字面量，留着就是一条形同虚设的规则描述（假陈述）。
];

function getAllFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return files;   // 无权限/被占用的目录不得让整个门禁静默失败
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // 路径规范化(防路径陷阱):path.join 在 Windows 用 \,EXCLUDES 用 /,必 replace 避免 includes 永不匹配
    const rel = full.replace(/\\/g, '/');
    if (EXCLUDES.some(e => rel.includes(e))) continue;
    if (entry.isDirectory()) {
      // 点目录一律跳过，唯一例外 .kilo（规则本体所在）
      if (entry.name.charAt(0) === '.' && entry.name !== '.kilo') continue;
      if (entry.name === 'node_modules') continue;
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
  const benign = [];
  const lines = content.split('\n');
  const rel = file.replace(ROOT + path.sep, '').replace(/\\/g, '/');
  const rules = BENIGN.filter(b => rel === b.file || rel.endsWith('/' + b.file));
  const meta = { inMcpSection: /kilo\.json$/.test(rel) ? findMcpSectionLines(lines) : null };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const kw of KEYWORDS) {
      if (!line.includes(kw)) continue;
      const rec = {
        file: file.replace(ROOT + path.sep, ''),
        line: i + 1,
        keyword: kw,
        text: line.trim().slice(0, 80)
      };
      const m = { inMcpSection: meta.inMcpSection ? meta.inMcpSection.has(i) : false };
      const rule = rules.filter(r => r.test(line, m))[0];
      if (rule) {
        benign.push({ ...rec, reason: rule.reason });
        continue;
      }
      hits.push(rec);
    }
  }
  return { hits, benign };
}

function main() {
  const files = getAllFiles(ROOT);
  const allHits = [];
  const allBenign = [];
  for (const f of files) {
    const r = checkFile(f);
    allHits.push(...r.hits);
    allBenign.push(...r.benign);
  }
  // 严重度:文档/配置段→warning,脚本/.gitignore/install→critical
  const report = allHits.map(h => {
    let severity = 'warning';
    if (/\.mjs$|\.gitignore$|install\./.test(h.file)) {
      severity = 'critical';
    }
    return { ...h, severity };
  });
  const critical = report.filter(h => h.severity === 'critical');
  console.log(JSON.stringify({
    scan_time: new Date().toISOString(),
    total_files: files.length,
    total_hits: report.length,
    critical_count: critical.length,
    warning_count: report.filter(h => h.severity === 'warning').length,
    benign_count: allBenign.length,
    hits: report,
    benign: allBenign
  }, null, 2));
  process.exit(critical.length > 0 ? 1 : 0);
}

main();
