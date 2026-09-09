#!/usr/bin/env node
// sync-agent-prompt.mjs
// 单源同步器：从 agent/*.md frontmatter description 自动生成 kilo.json agent.<name>.prompt
//
// 设计动机：
//   kilo.json 的 agent.prompt 手工维护会产生双源 drift——description 改了 prompt 没改。
//   本脚本在 install 时自动同步，确保每次选择该智能体时能稳定触发运行。
//   用户只需维护 agent/*.md frontmatter 的 description（单一真相），prompt 自动派生。
//
// 生成规则：
//   prompt = description（完整角色定位+触发条件+核心流程+关键约束）
//   description 已包含足够信息让模型稳定进入角色，无需额外包装。
//
// 用法：
//   node scripts/sync-agent-prompt.mjs [--check] [--force] [--verbose]
//     --check   只检查 drift，不写 kilo.json（CI 用）；有 drift 返回 exit 1
//     --force   显式强制覆盖所有 agent.prompt，使其与 description 完全同步
//     --verbose 打印每个 agent 的同步详情
//
// 默认策略（description 为唯一真相源）：
//   description != prompt（经 sanitize 清洗后）即覆盖写回 kilo.json。
//   覆盖前必经 sanitize-agent-description.mjs 的 sanitizeDescription 清洗（去控制字符
//   / 长度截断 / XML 配对 / GBK 边界检测），sanitize 是 sync 派生的安全网，不反向污染
//   .md frontmatter（只改 kilo.json，不回写 .md）。
//   --check：把 description != prompt（经 sanitize）计为 drift，CI 阻断用。
//   --force：保留显式重置能力（与 description 完全同步，含已同步的也视为 force-overwrite）。
//
// 退出码：0=同步成功/无 drift，1=有 drift（--check 模式）或同步失败

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sanitizeDescription, extractFrontmatter, extractDescription } from './sanitize-agent-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const agentDir = path.join(repoRoot, 'agent');
const kiloJsonPath = path.join(repoRoot, 'kilo.json');

// 从文件名提取 agent 名（去掉 .md）
function agentNameFromFile(filename) {
  return filename.replace(/\.md$/, '');
}

// ===== 就地改写（保留 kilo.json 原有排版）=====
//
// 历史缺陷：写回时用 JSON.stringify(kilo)（无缩进）把整个文件压成 1 行，
// 部署副本 kilo.json 变成 6KB 单行——人工不可读、git 不可 diff、漂移无法取证。
// 本同步器只改 agent.<name>.prompt 一个字符串字面量，其余字节一律不动：
// 直接在原文本上定位 → 替换 → 再 JSON.parse 复验，格式与内容双保。

/** 从 openIdx（指向 `{`）起做括号配对扫描，返回匹配 `}` 之后的下标；字符串内的括号不计。 */
function findBlockEnd(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 在 kilo.json 原文本中把 agent.<agentName>.prompt 的值替换为 newPrompt。
 * @returns {{ok:true,text:string}|{ok:false,reason:string}}
 */
function replacePromptInPlace(text, agentName, newPrompt) {
  const ak = /"agent"\s*:\s*\{/.exec(text);
  if (!ak) return { ok: false, reason: 'kilo.json 无 "agent" 段' };
  const agentOpen = ak.index + ak[0].length - 1;
  const agentEnd = findBlockEnd(text, agentOpen);
  if (agentEnd < 0) return { ok: false, reason: '"agent" 段括号不配对' };

  const nameRe = new RegExp('"' + reEscape(agentName) + '"\\s*:\\s*\\{');
  const nm = nameRe.exec(text.slice(agentOpen, agentEnd));
  if (!nm) return { ok: false, reason: 'agent 段内未找到 "' + agentName + '"' };
  const blkOpen = agentOpen + nm.index + nm[0].length - 1;
  const blkEnd = findBlockEnd(text, blkOpen);
  if (blkEnd < 0) return { ok: false, reason: 'agent.' + agentName + ' 括号不配对' };

  const pm = /"prompt"\s*:\s*"/.exec(text.slice(blkOpen, blkEnd));
  if (!pm) return { ok: false, reason: 'agent.' + agentName + ' 无 prompt 字段' };
  const valStart = blkOpen + pm.index + pm[0].length;

  let i = valStart;
  let esc = false;
  while (i < blkEnd) {
    const c = text[i];
    if (esc) esc = false;
    else if (c === '\\') esc = true;
    else if (c === '"') break;
    i++;
  }
  if (i >= blkEnd) return { ok: false, reason: 'agent.' + agentName + ' prompt 字符串未闭合' };

  // JSON.stringify(s).slice(1,-1) = 已转义、不含外层引号的字符串字面量内容
  const escaped = JSON.stringify(newPrompt).slice(1, -1);
  return { ok: true, text: text.slice(0, valStart) + escaped + text.slice(i) };
}

// ===== 主流程 =====

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');
const verbose = args.includes('--verbose');

// 1. 扫描 agent/*.md，收集 description
const agentFiles = fs.readdirSync(agentDir).filter(f => f.endsWith('.md'));
const descriptions = new Map(); // agentName -> description

for (const file of agentFiles) {
  const filepath = path.join(agentDir, file);
  const text = fs.readFileSync(filepath, 'utf8');
  const fm = extractFrontmatter(text);
  if (!fm) {
    console.error(`[WARN] ${file}: 无 frontmatter，跳过`);
    continue;
  }
  const desc = extractDescription(fm);
  if (!desc) {
    console.error(`[WARN] ${file}: frontmatter 无 description 字段，跳过`);
    continue;
  }
  const name = agentNameFromFile(file);
  descriptions.set(name, desc);
}

if (descriptions.size === 0) {
  console.error('[FAIL] 未扫描到任何 agent description');
  process.exit(1);
}

console.log(`[SCAN] 已扫描 ${descriptions.size} 个 agent description`);

// 2. 读取 kilo.json
const kiloRaw = fs.readFileSync(kiloJsonPath, 'utf8');
const kilo = JSON.parse(kiloRaw);
const agents = kilo.agent;
if (!agents) {
  console.error('[FAIL] kilo.json 无 agent 段');
  process.exit(1);
}

// 3. 对比 + 同步
let updated = 0;
let skipped = 0;
let driftCount = 0;
let totalWarnings = 0;
let sanitizedCount = 0;
const drifts = [];
const forceOverwrites = []; // --force 模式下将被覆盖的 agent 列表
const pendingWrites = [];  // 待就地写回的 { name, value }（保格式，不重序列化整文件）

for (const [name, desc] of descriptions) {
  const agentEntry = agents[name];
  if (!agentEntry) {
    console.warn(`[WARN] kilo.json 无 agent.${name}，跳过`);
    skipped++;
    continue;
  }

  const currentPrompt = agentEntry.prompt || '';

  // ===== 默认策略（description 为唯一真相源，经 sanitize 清洗）=====
  //   description != prompt(经 sanitize) 即覆盖写回 kilo.json; 否则视为已同步.
  //   sanitize 是 sync 派生的安全网(去控制字符/长度截断/XML 配对/GBK 边界), 不反向污染 .md frontmatter.
  //   --check 把"description != prompt(经 sanitize)"计为 drift, CI 阻断用.
  //   --force 走独立分支(下方), 显式重置时仍允许强制覆盖.

  if (force) {
    // --force：显式覆盖所有 agent 的 prompt（仍必经 sanitize，防止控制字符/超长/未配对 XML 污染 kilo.json）
    // --force 与默认分支差异：默认是条件覆盖（仅 sanitize 后的 desc != prompt 时改），--force 显式覆盖时也走 sanitize
    const san = sanitizeDescription(desc, name);
    totalWarnings += san.warnings.length;
    sanitizedCount++;
    const expectedPrompt = san.sanitized;
    if (currentPrompt === expectedPrompt) {
      if (verbose) {
        console.log(`[OK]   ${name}: 已同步 (len=${expectedPrompt.length})`);
      }
    } else {
      driftCount++;
      drifts.push(name);
      if (checkOnly) {
        console.log(`[FORCE-DRIFT] ${name}: description ≠ prompt after sanitize (descLen=${desc.length} vs promptLen=${currentPrompt.length}, warnings=${san.warnings.length})`);
      } else {
        agentEntry.prompt = expectedPrompt;
        pendingWrites.push({ name, value: expectedPrompt });
        updated++;
        forceOverwrites.push({ name, current: currentPrompt.length, next: expectedPrompt.length });
        if (verbose) {
          console.log(`[FORCE] ${name}: prompt 将被覆盖 (len=${currentPrompt.length} → ${expectedPrompt.length}, warnings=${san.warnings.length})`);
        }
      }
    }
  } else {
    // 默认策略: 必经 sanitize 后比对
    const san = sanitizeDescription(desc, name);
    totalWarnings += san.warnings.length;
    sanitizedCount++;
    const expectedPrompt = san.sanitized;
    if (currentPrompt !== expectedPrompt) {
      if (checkOnly) {
        driftCount++;
        drifts.push(name);
        console.log(`[DRIFT] ${name}: desc(${desc.length}) != prompt(${currentPrompt.length}) after sanitize, ${san.warnings.length} warning(s)`);
      } else {
        agentEntry.prompt = expectedPrompt;
        pendingWrites.push({ name, value: expectedPrompt });
        updated++;
        if (verbose) console.log(`[SYNC] ${name}: prompt 已更新 (${currentPrompt.length} -> ${expectedPrompt.length}), warnings=${san.warnings.length}`);
      }
    } else {
      if (verbose) console.log(`[OK] ${name}: 已同步 (len=${expectedPrompt.length})`);
    }
  }
}

// 4. 写回 kilo.json（非 --check 模式且有更新时）—— 就地替换 + 原子化写 + 备份保留 3 份
if (!checkOnly && updated > 0) {
  // 保格式：只替换 agent.<name>.prompt 的字符串字面量，其余字节（缩进/换行/键序）原样保留。
  // 无 BOM，末尾换行维持原状。
  let output = kiloRaw;
  for (const w of pendingWrites) {
    const r = replacePromptInPlace(output, w.name, w.value);
    if (!r.ok) {
      console.error(`\n[FAIL] 就地写入 agent.${w.name}.prompt 失败: ${r.reason}`);
      console.error('       kilo.json 未被修改。请检查文件格式后重跑。');
      process.exit(1);
    }
    output = r.text;
  }
  // 复验：就地替换后必须仍是合法 JSON，且 prompt 值与预期一致
  try {
    const reparsed = JSON.parse(output);
    for (const w of pendingWrites) {
      const entry = reparsed.agent && reparsed.agent[w.name];
      if (!entry || entry.prompt !== w.value) {
        throw new Error(`agent.${w.name}.prompt 复验不一致`);
      }
    }
  } catch (e) {
    console.error(`\n[FAIL] 就地替换后 kilo.json 校验失败: ${e.message}`);
    console.error('       kilo.json 未被修改。');
    process.exit(1);
  }
  if (!output.endsWith('\n')) output += '\n';
  const tmpPath = `${kiloJsonPath}.tmp`;
  // ISO 精确到秒 + 6 位 hrtime.bigint 后缀, 同秒多次写不覆盖
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.hrtime.bigint().toString(36).slice(-6);
  const bakPath = `${kiloJsonPath}.bak.${ts}`;
  try {
    // 1. 写之前备份（仅当目标存在时）
    if (fs.existsSync(kiloJsonPath)) {
      fs.copyFileSync(kiloJsonPath, bakPath);
    }
    // 2. 写 .tmp（atomic on Windows after close）
    fs.writeFileSync(tmpPath, output, 'utf8');
    // 3. renameSync 原子替换
    fs.renameSync(tmpPath, kiloJsonPath);
    console.log(`\n[WRITE] kilo.json 已更新：${updated} 个 agent prompt 已同步 (备份: ${path.basename(bakPath)})`);
    // 4. 保留最近 3 份 .bak，删最早超出
    const bakFiles = fs.readdirSync(repoRoot)
      .filter(f => f.startsWith('kilo.json.bak.'))
      .sort(); // 文件名含 ISO-ish 时间戳，字典序 == 时间序
    const excess = bakFiles.length - 3;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(repoRoot, bakFiles[i])); } catch {}
    }
  } catch (e) {
    // 失败回滚：清理 .tmp
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    console.error(`\n[FAIL] 写入 kilo.json 失败: ${e.message}`);
    process.exit(1);
  }
} else if (!checkOnly && updated === 0) {
  console.log(`\n[OK]    所有 agent prompt 已是最新，无需写入`);
}

// 4.5 --force 覆盖清单打印（验收 4：将被覆盖的 agent 列表 + 当前/新 prompt 长度）
if (!checkOnly && force && forceOverwrites.length > 0) {
  console.log('\n[FORCE-OVERWRITE] 将被覆盖的 agent：');
  for (const o of forceOverwrites) {
    console.log(`  ${o.name}: prompt ${o.current} → ${o.next} (len)`);
  }
}

// 5. 汇总
console.log(`\n[SUMMARY] scanned=${descriptions.size} updated=${updated} drift=${driftCount} skipped=${skipped} sanitized=${sanitizedCount} warnings=${totalWarnings}`);

if (checkOnly && driftCount > 0) {
  console.log(`\n[FAIL] 检测到 ${driftCount} 个 drift: ${drifts.join(', ')}`);
  console.log(`       运行 \`node scripts/sync-agent-prompt.mjs\` 派生缺失 prompt`);
  process.exit(1);
}

console.log('[DONE] 同步完成');
process.exit(0);
