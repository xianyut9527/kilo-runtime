#!/usr/bin/env node
// validate-config.mjs
// kilo_config 配置自检脚本（Node ESM，跨平台）
// 校验项：
//   [1/4] kilo.json JSON 合法性
//   [2/4] agent 名单一致性
//   [3/4] instructions 引用存在性
//   [4/4] skills 分类一致性
// 仅使用 Node 内置模块：node:fs / node:path / node:process / node:url
// 退出码：全部 PASS 返回 0；任一 FAIL 返回 1。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 跨平台：从 import.meta.url 解析 __dirname，避免依赖 cwd
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);

// ---------- Check 1: kilo.json JSON 合法性 ----------
function check1KiloJson() {
  const name = 'kilo.json JSON 合法性';
  const abs = path.resolve(ROOT, 'kilo.json');
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    return { name, pass: false, detail: `读取失败: ${e.message}` };
  }
  // UTF-8 BOM 检测（0xEF 0xBB 0xBF）
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { name, pass: false, detail: '文件含 UTF-8 BOM（0xEF 0xBB 0xBF），请去除后重试' };
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { name, pass: false, detail: `JSON 解析失败: ${e.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { name, pass: false, detail: '解析结果不是对象' };
  }
  if (
    !('agent' in parsed) ||
    typeof parsed.agent !== 'object' ||
    parsed.agent === null ||
    Array.isArray(parsed.agent)
  ) {
    return { name, pass: false, detail: '缺少 agent 字段或 agent 不是对象' };
  }
  return { name, pass: true, detail: '' };
}

// ---------- Check 2: agent 名单一致性 ----------
function check2Agents(config) {
  const name = 'agent 名单一致性';
  if (!config || typeof config !== 'object' || !config.agent || typeof config.agent !== 'object') {
    return { name, pass: false, detail: 'kilo.json.agent 不可用（依赖 [1/4]）' };
  }
  const declared = new Set(Object.keys(config.agent));
  const agentDir = path.resolve(ROOT, 'agent');
  let entries;
  try {
    entries = fs.readdirSync(agentDir, { withFileTypes: true });
  } catch (e) {
    return { name, pass: false, detail: `读取 agent/ 失败: ${e.message}` };
  }
  const actual = new Set(
    entries
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => d.name.slice(0, -3))
  );
  const onlyInJson = [...declared].filter((x) => !actual.has(x)).sort();
  const onlyInFs = [...actual].filter((x) => !declared.has(x)).sort();
  if (onlyInJson.length === 0 && onlyInFs.length === 0) {
    return { name, pass: true, detail: `共 ${declared.size} 个 agent 全部对齐` };
  }
  const parts = [];
  if (onlyInJson.length) {
    parts.push(`kilo.json 声明但 agent/ 缺少文件: [${onlyInJson.join(', ')}]`);
  }
  if (onlyInFs.length) {
    parts.push(`agent/ 存在但 kilo.json 未声明: [${onlyInFs.join(', ')}]`);
  }
  return { name, pass: false, detail: parts.join('; ') };
}

// ---------- Check 3: instructions 引用存在性 ----------
function check3Instructions(config) {
  const name = 'instructions 引用存在性';
  if (!config || typeof config !== 'object') {
    return { name, pass: false, detail: 'kilo.json 不可用（依赖 [1/4]）' };
  }
  const list = config.instructions;
  if (!Array.isArray(list)) {
    return { name, pass: false, detail: 'kilo.json.instructions 不是数组' };
  }
  const missing = [];
  for (const p of list) {
    if (typeof p !== 'string' || p.length === 0) {
      missing.push(`<非字符串: ${JSON.stringify(p)}>`);
      continue;
    }
    const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
    if (!fs.existsSync(abs)) missing.push(p);
  }
  if (missing.length === 0) {
    return { name, pass: true, detail: `共 ${list.length} 条引用全部存在` };
  }
  return { name, pass: false, detail: `缺失: [${missing.join(', ')}]` };
}

// ---------- Check 4: skills 分类一致性 ----------
// 从 .kilo/instructions/skills-lifecycle.md 的分类表中解析出"目录"列
function parseSkillsDocumentedDirs() {
  const file = path.resolve(ROOT, '.kilo/instructions/skills-lifecycle.md');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const dirs = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue; // 表格分隔行 |---|---|
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    // 第 2 列是"目录"，形如 `architecture/`
    const dirCell = cells[1];
    const m = dirCell.match(/^`?([A-Za-z0-9_\-]+)\/`?$/);
    if (m) dirs.add(m[1]);
  }
  return dirs;
}

function check4Skills() {
  const name = 'skills 分类一致性';
  let documented;
  try {
    documented = parseSkillsDocumentedDirs();
  } catch (e) {
    return { name, pass: false, detail: `解析 skills-lifecycle.md 失败: ${e.message}` };
  }
  const skillsDir = path.resolve(ROOT, '.kilo/skills');
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (e) {
    return { name, pass: false, detail: `读取 .kilo/skills/ 失败: ${e.message}` };
  }
  const actual = new Set(entries.filter((d) => d.isDirectory()).map((d) => d.name));
  const extraDirs = [...actual].filter((x) => !documented.has(x)).sort();
  const missingDirs = [...documented].filter((x) => !actual.has(x)).sort();
  if (extraDirs.length === 0 && missingDirs.length === 0) {
    return { name, pass: true, detail: `共 ${actual.size} 个分类与文档一致` };
  }
  const parts = [];
  if (extraDirs.length) {
    parts.push(`目录存在但未在文档声明: [${extraDirs.join(', ')}]`);
  }
  if (missingDirs.length) {
    parts.push(`文档声明但目录缺失: [${missingDirs.join(', ')}]`);
  }
  return { name, pass: false, detail: parts.join('; ') };
}

// ---------- 主流程：读取 kilo.json 一次，供后续 check 复用 ----------
const kiloBuf = (() => {
  try {
    return fs.readFileSync(path.resolve(ROOT, 'kilo.json'));
  } catch {
    return null;
  }
})();
let config = null;
if (kiloBuf && !(kiloBuf[0] === 0xef && kiloBuf[1] === 0xbb && kiloBuf[2] === 0xbf)) {
  try {
    config = JSON.parse(kiloBuf.toString('utf8'));
  } catch {
    /* 解析失败留给 check1 报错 */
  }
}

const r1 = check1KiloJson();
const r2 = check2Agents(config);
const r3 = check3Instructions(config);
const r4 = check4Skills();
const results = [r1, r2, r3, r4];

// ---------- 输出 ----------
const out = [];
out.push('== kilo_config 配置自检 ==');
results.forEach((r, i) => {
  const status = r.pass ? 'PASS' : `FAIL (${r.detail})`;
  out.push(`[${i + 1}/4] ${r.name}: ${status}`);
});
const failCount = results.filter((r) => !r.pass).length;
out.push(failCount === 0 ? '== 总结: 全部 PASS ==' : `== 总结: ${failCount} 项 FAIL ==`);
console.log(out.join('\n'));

process.exit(failCount === 0 ? 0 : 1);
