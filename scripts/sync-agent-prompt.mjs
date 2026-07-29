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
//   node scripts/sync-agent-prompt.mjs [--check] [--verbose]
//     --check   只检查 drift，不写 kilo.json（CI 用）；有 drift 返回 exit 1
//     --verbose 打印每个 agent 的同步详情
//
// 退出码：0=同步成功/无 drift，1=有 drift（--check 模式）或同步失败

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const agentDir = path.join(repoRoot, 'agent');
const kiloJsonPath = path.join(repoRoot, 'kilo.json');

// 从 md 全文提取 frontmatter 块（首个 --- ... --- 之间）
function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// 从 frontmatter 块提取 description（支持单行和多行）
function extractDescription(frontmatter) {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 单行：description: xxx
    const single = line.match(/^description:\s*(.+)$/);
    if (single) {
      let val = single[1].trim();
      // 处理引号包裹
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
    // 多行：description: > 或 description: |
    const multiStart = line.match(/^description:\s*[>|]/);
    if (multiStart) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j];
        if (/^\S/.test(sub)) break; // 非缩进行 = 多行结束
        parts.push(sub.replace(/^\s+/, ''));
      }
      return parts.join(' ').trim();
    }
  }
  return null;
}

// 从文件名提取 agent 名（去掉 .md）
function agentNameFromFile(filename) {
  return filename.replace(/\.md$/, '');
}

// ===== 主流程 =====

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
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
const drifts = [];

for (const [name, desc] of descriptions) {
  const agentEntry = agents[name];
  if (!agentEntry) {
    console.warn(`[WARN] kilo.json 无 agent.${name}，跳过`);
    skipped++;
    continue;
  }

  const currentPrompt = agentEntry.prompt || '';
  // prompt = description 直接作为系统提示
  // description 已包含角色定位+触发条件+核心流程+关键约束，足够稳定触发
  const newPrompt = desc;

  if (currentPrompt === newPrompt) {
    if (verbose) console.log(`[OK]   ${name}: 已同步 (len=${newPrompt.length})`);
  } else {
    driftCount++;
    drifts.push(name);
    if (checkOnly) {
      console.log(`[DRIFT] ${name}: description ≠ prompt (descLen=${desc.length} vs promptLen=${currentPrompt.length})`);
    } else {
      agentEntry.prompt = newPrompt;
      updated++;
      if (verbose) {
        console.log(`[SYNC] ${name}: prompt 已更新 (len=${currentPrompt.length} → ${newPrompt.length})`);
      }
    }
  }
}

// 4. 写回 kilo.json（非 --check 模式且有更新时）
if (!checkOnly && updated > 0) {
  // 保持 2 空格缩进，无 BOM，末尾换行
  const output = JSON.stringify(kilo, null, 2) + '\n';
  fs.writeFileSync(kiloJsonPath, output, 'utf8');
  console.log(`\n[WRITE] kilo.json 已更新：${updated} 个 agent prompt 已同步`);
} else if (!checkOnly && updated === 0) {
  console.log(`\n[OK]    所有 agent prompt 已是最新，无需写入`);
}

// 5. 汇总
console.log(`\n[SUMMARY] scanned=${descriptions.size} updated=${updated} drift=${driftCount} skipped=${skipped}`);

if (checkOnly && driftCount > 0) {
  console.log(`\n[FAIL] 检测到 ${driftCount} 个 drift: ${drifts.join(', ')}`);
  console.log(`       运行 \`node scripts/sync-agent-prompt.mjs\` 同步`);
  process.exit(1);
}

console.log('[DONE] 同步完成');
process.exit(0);