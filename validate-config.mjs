#!/usr/bin/env node
// validate-config.mjs
// kilo_config 配置自检脚本（Node ESM，跨平台）
// 校验项：
//   [1/11] kilo.json JSON 合法性
//   [2/11] agent 名单一致性
//   [3/11] skills 分类一致性
//   [4/11] agent 文件 frontmatter 合规性（含 color / hidden）
//   [5/11] kilo.json prompt 中引用的文档路径存在性
//   [6/11] README.md 目录树一致性
//   [7/11] AGENTS.md / CONFIG_CHANGE_CHECKLIST.md 索引一致性
//   [8/11] prompt 与 agent.md 过度文本重复检测（4-gram Jaccard）
//   [9/11] coderAgent prompt 锚点关键词校验（防 compaction 误删）
//   [10/11] SKILL.md frontmatter 合规性（name 与目录名一致 / description ≤1024 / keywords 数量 [3,20]）
//   [11/11] install.sh 与 install.ps1 EXCLUDE 列表一致性（ROOT_ONLY + RECURSIVE）
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
    return { name, pass: false, detail: 'kilo.json.agent 不可用（依赖 [1/11]）' };
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

// ---------- Check 3: skills 分类一致性 ----------
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

function check3Skills() {
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

// ---------- Check 4: agent 文件 frontmatter 合规性 ----------
// 极简 YAML frontmatter 解析器（仅支持本项目使用的子集）：
//   - 顶层 `key: value` 与嵌套 `key:` + 缩进子项
//   - 标量：字符串（可被 `"`/`'` 包裹）、整数、布尔（true/false）、null
//   - 键名可为裸标识符，也可被 `"`/`'` 包裹（用于 glob 模式作 key）
function parseScalar(val) {
  if (val === '' || val === '~' || val === 'null') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const root = {};
  // 栈：每层 { indent, container }，顶层 indent=-1
  const stack = [{ indent: -1, container: root }];

  for (let i = 1; i < endIdx; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const content = raw.trim();

    // YAML 列表项：`- item`（行内不允许键值对），属于栈顶（缩进 < 当前）的容器。
    // 栈顶容器原本是被空值 key 创建的空对象 {}，首次遇到列表项时把它就地转成数组并 push；
    // 后续项直接 push 即可。
    if (content.startsWith('- ')) {
      // 弹到缩进 < 当前的父层
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top.indent < indent && top.container && typeof top.container === 'object') {
        // 仅当容器仍是空对象 {} 时转换为数组
        if (!Array.isArray(top.container) && Object.keys(top.container).length === 0) {
          const parentStack = stack[stack.length - 2];
          if (parentStack) {
            for (const k of Object.keys(parentStack.container)) {
              if (parentStack.container[k] === top.container) {
                const arr = [];
                parentStack.container[k] = arr;
                top.container = arr;
                break;
              }
            }
          }
        }
        if (Array.isArray(top.container)) {
          top.container.push(parseScalar(content.slice(2).trim()));
        }
      }
      continue;
    }

    // 弹出缩进 ≥ 当前的所有父层，找到真正的父容器
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;

    // 优先匹配带引号的 key（glob 模式），再匹配裸 key
    let m =
      content.match(/^["']([^"']+)["']\s*:\s*(.*)$/) ||
      content.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, container: child });
    } else {
      parent[key] = parseScalar(val);
    }
  }
  return root;
}

function isValidPermissionValue(val, agentName, fieldPath, errors) {
  if (val === null || val === undefined) {
    errors.push(`${agentName}: permission.${fieldPath} 不能为 null/undefined`);
    return false;
  }
  if (typeof val === 'string') {
    if (val !== 'allow' && val !== 'deny') {
      errors.push(`${agentName}: permission.${fieldPath} 字符串值必须为 "allow" 或 "deny"，实际为 "${val}"`);
      return false;
    }
    return true;
  }
  if (Array.isArray(val)) {
    return true;
  }
  if (typeof val === 'object') {
    for (const [subKey, subVal] of Object.entries(val)) {
      isValidPermissionValue(subVal, agentName, `${fieldPath}.${subKey}`, errors);
    }
    return true;
  }
  errors.push(`${agentName}: permission.${fieldPath} 值类型不合法（期望 string/object/array）`);
  return false;
}

function check4AgentFrontmatter() {
  const name = 'agent 文件 frontmatter 合规性';
  const agentDir = path.resolve(ROOT, 'agent');
  let entries;
  try {
    entries = fs.readdirSync(agentDir, { withFileTypes: true });
  } catch (e) {
    return { name, pass: false, detail: `读取 agent/ 失败: ${e.message}` };
  }
  const mdFiles = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
    .map((d) => d.name)
    .sort();

  const errors = [];
  let checked = 0;
  for (const fname of mdFiles) {
    const filePath = path.join(agentDir, fname);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      errors.push(`${fname}: 读取失败 ${e.message}`);
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm) {
      errors.push(`${fname}: 缺少或不合法的 YAML frontmatter（需以 --- 包裹）`);
      continue;
    }
    checked++;
    const missing = [];
    if (typeof fm.description !== 'string' || fm.description.length === 0) {
      missing.push('description(非空字符串)');
    }
    if (typeof fm.mode !== 'string' || fm.mode.length === 0) {
      missing.push('mode(非空字符串)');
    }
    if (typeof fm.color !== 'string' || fm.color.length === 0) {
      missing.push('color(非空字符串)');
    }
    if (typeof fm.hidden !== 'boolean') {
      missing.push('hidden(布尔值)');
    } else if (fm.mode === 'subagent' && fm.hidden !== true) {
      errors.push(`${fname}: mode === 'subagent' 时 hidden 必须为 true，实际为 ${fm.hidden}`);
    }
    if (
      typeof fm.steps !== 'number' ||
      !Number.isInteger(fm.steps) ||
      fm.steps <= 0
    ) {
      missing.push('steps(正整数)');
    }
    if (
      !fm.permission ||
      typeof fm.permission !== 'object' ||
      Array.isArray(fm.permission)
    ) {
      missing.push('permission(必须为对象)');
    } else {
      const permFields = ['bash', 'edit', 'read', 'task', 'glob', 'grep'];
      const presentFields = permFields.filter((k) => k in fm.permission);
      if (presentFields.length === 0) {
        missing.push('permission(必须包含 bash/edit/read/task/glob/grep 至少一项)');
      } else {
        for (const f of presentFields) {
          isValidPermissionValue(fm.permission[f], fname, f, errors);
        }
      }
    }
    if (missing.length) {
      errors.push(`${fname}: 缺失 [${missing.join(', ')}]`);
    }
  }

  if (errors.length === 0) {
    return { name, pass: true, detail: `共 ${checked} 个 agent 文件 frontmatter 合规` };
  }
  return { name, pass: false, detail: errors.join('; ') };
}

// ---------- Check 5: kilo.json prompt 中引用的文档路径存在性 ----------
// 递归展开 `{a,b,c}` 大括号列表（支持嵌套）。
function expandBraces(s) {
  if (!s.includes('{')) return [s];
  const m = s.match(/\{([^{}]+)\}/);
  if (!m) return [s];
  const prefix = s.slice(0, m.index);
  const suffix = s.slice(m.index + m[0].length);
  const alts = m[1].split(',').map((x) => x.trim());
  const out = [];
  for (const alt of alts) {
    for (const expanded of expandBraces(prefix + alt + suffix)) {
      out.push(expanded);
    }
  }
  return out;
}

function check5PromptPaths(config) {
  const name = 'kilo.json prompt 引用文档存在性';
  if (!config || typeof config !== 'object') {
    return { name, pass: false, detail: 'kilo.json 不可用（依赖 [1/11]）' };
  }
  if (!config.agent || typeof config.agent !== 'object') {
    return { name, pass: false, detail: 'kilo.json.agent 不可用（依赖 [1/11]）' };
  }

  // 匹配 `agent/<...>.md` 与 `.kilo/instructions/<...>.md`。
  // <...> 部分允许字母/数字/_-/./,{}（用于 `{a,b,c}` 展开），以 `.md` 结尾。
  // 不依赖外层定界符（`/`、反引号、中英括号、引号、代码块标记都会被自然排除）。
  const pathRegex = /(?:agent\/|\.kilo\/instructions\/)([A-Za-z0-9_\-.\/{},]+\.md)\}?/g;

  const missing = [];
  const seen = new Set();
  let totalChecked = 0;

  for (const [agentName, agentConfig] of Object.entries(config.agent)) {
    if (!agentConfig || typeof agentConfig !== 'object') continue;
    const rawPrompt = agentConfig.prompt;
    if (typeof rawPrompt !== 'string') continue;

    // 模板变量 `{name}` 约定为"当前 agent 自己的文件名"，先做替换
    const prompt = rawPrompt.replace(/\{name\}/g, agentName);

    let m;
    pathRegex.lastIndex = 0;
    while ((m = pathRegex.exec(prompt)) !== null) {
      const fullMatch = m[0];
      const expanded = expandBraces(fullMatch);
      for (const p of expanded) {
        // 仍含花括号 → 未能展开的占位符，视为非具体路径，跳过
        if (p.includes('{') || p.includes('}')) continue;
        const key = `${agentName}|${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        totalChecked++;
        const abs = path.resolve(ROOT, p);
        if (!fs.existsSync(abs)) {
          missing.push(`${agentName}: ${p}`);
        }
      }
    }
  }

  if (missing.length === 0) {
    return {
      name,
      pass: true,
      detail: `共 ${totalChecked} 条 prompt 引用全部存在`,
    };
  }
  return { name, pass: false, detail: `缺失: [${missing.join(', ')}]` };
}

// ---------- Check 6: README.md 目录树一致性 ----------
// 解析 README.md 中含 `.kilo/instructions/` 的目录树代码块，
// 提取 `instructions/` 子树下列出的全部 `.md` 文件，与文件系统比对。
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseInstructionsTreeFiles(blockText) {
  const lines = blockText.split(/\r?\n/);

  // 1) 定位 `instructions/` 目录行，记录其前缀（用于判断子树边界）
  let instrIndent = -1;
  let instrLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\s│]*)[├└]──\s*instructions\/\s*$/);
    if (m) {
      instrIndent = m[1].length;
      instrLineIdx = i;
      break;
    }
  }
  if (instrLineIdx === -1) {
    return { ok: false, reason: '代码块中未找到 `instructions/` 目录条目' };
  }

  const instrPrefix = lines[instrLineIdx].slice(0, instrIndent);
  // 子节点行形如：`<instrPrefix>│   ├── X.md` 或 `... └── X.md`，允许 `# 注释` 后缀
  const childRe = new RegExp(
    '^' + escapeRegex(instrPrefix) + '│\\s+[├└]──\\s*([^\\s#]+\\.md)\\s*(?:#.*)?$'
  );

  const files = new Set();
  for (let i = instrLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < instrIndent) break;
    if (!line.startsWith(instrPrefix)) break;
    const next = line[instrIndent];
    if (next === '├' || next === '└') break; // instructions/ 的兄弟节点 → 离开子树
    if (next !== '│') continue; // 缩进延续但非有效子行
    const m = line.match(childRe);
    if (m) files.add(m[1]);
  }
  return { ok: true, files };
}

function check6ReadmeTree() {
  const name = 'README.md 目录树一致性';
  const readmePath = path.resolve(ROOT, 'README.md');
  let text;
  try {
    text = fs.readFileSync(readmePath, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `读取 README.md 失败: ${e.message}` };
  }

  // 收集所有围栏代码块，挑选含 `.kilo/instructions/` 的第一个
  const blockRe = /```\w*\r?\n([\s\S]*?)```/g;
  let picked = null;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    if (m[1].includes('instructions/')) {
      picked = m[1];
      break;
    }
  }
  if (picked === null) {
    return { name, pass: false, detail: 'README.md 中未找到含 instructions/ 的代码块' };
  }

  const parsed = parseInstructionsTreeFiles(picked);
  if (!parsed.ok) {
    return { name, pass: false, detail: parsed.reason };
  }
  const treeFiles = parsed.files;

  const dir = path.resolve(ROOT, '.kilo/instructions');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { name, pass: false, detail: `读取 .kilo/instructions/ 失败: ${e.message}` };
  }
  const actualFiles = new Set(
    entries
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => d.name)
  );

  const onlyInTree = [...treeFiles].filter((x) => !actualFiles.has(x)).sort();
  const onlyInFs = [...actualFiles].filter((x) => !treeFiles.has(x)).sort();

  if (onlyInTree.length === 0 && onlyInFs.length === 0) {
    return {
      name,
      pass: true,
      detail: `共 ${actualFiles.size} 个 instructions 文件与 README 目录树一致`,
    };
  }
  const parts = [];
  if (onlyInTree.length) {
    parts.push(`README 列出但目录缺失: [${onlyInTree.join(', ')}]`);
  }
  if (onlyInFs.length) {
    parts.push(`目录存在但 README 未列出: [${onlyInFs.join(', ')}]`);
  }
  return { name, pass: false, detail: parts.join('; ') };
}

// ---------- Check 7: AGENTS.md / CONFIG_CHANGE_CHECKLIST.md 索引一致性 ----------
function extractMdPaths(text) {
  const paths = new Set();
  const re = /\.kilo\/instructions\/[A-Za-z0-9_\-]+\.md/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    paths.add(m[0]);
  }
  return paths;
}

function check7DocIndex() {
  const name = 'AGENTS.md / CONFIG_CHANGE_CHECKLIST.md 索引一致性';

  let agentsText;
  try {
    agentsText = fs.readFileSync(path.resolve(ROOT, 'AGENTS.md'), 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `读取 AGENTS.md 失败: ${e.message}` };
  }
  let checklistText;
  try {
    checklistText = fs.readFileSync(path.resolve(ROOT, 'CONFIG_CHANGE_CHECKLIST.md'), 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `读取 CONFIG_CHANGE_CHECKLIST.md 失败: ${e.message}` };
  }

  const agentsPaths = extractMdPaths(agentsText);
  const checklistPaths = extractMdPaths(checklistText);
  const indexedPaths = new Set([...agentsPaths, ...checklistPaths]);

  // 读取 README 树中的 instructions 文件列表，作为"必须被索引"的来源
  const treeResult = check6ReadmeTree();
  let requiredFiles;
  if (treeResult.pass) {
    requiredFiles = new Set();
    const detailMatch = treeResult.detail.match(/共 (\d+) 个 instructions 文件/);
    if (detailMatch) {
      // 解析成功但拿不到文件集合：从 README 重新解析一次
      const readmeText = fs.readFileSync(path.resolve(ROOT, 'README.md'), 'utf8');
      const blockRe = /```\w*\r?\n([\s\S]*?)```/g;
      let picked = null;
      let bm;
      while ((bm = blockRe.exec(readmeText)) !== null) {
        if (bm[1].includes('instructions/')) {
          picked = bm[1];
          break;
        }
      }
      if (picked) {
        const parsed = parseInstructionsTreeFiles(picked);
        if (parsed.ok) {
          for (const f of parsed.files) {
            requiredFiles.add(`.kilo/instructions/${f}`);
          }
        }
      }
    }
  } else {
    return { name, pass: false, detail: `无法获取 README 目录树: ${treeResult.detail}` };
  }

  const missingIndex = [];
  for (const p of requiredFiles) {
    if (!indexedPaths.has(p)) {
      missingIndex.push(p);
    }
  }

  const missingFiles = [];
  for (const p of indexedPaths) {
    if (!fs.existsSync(path.resolve(ROOT, p))) {
      missingFiles.push(p);
    }
  }

  if (missingIndex.length === 0 && missingFiles.length === 0) {
    return {
      name,
      pass: true,
      detail: `AGENTS.md 索引 ${agentsPaths.size} 条，CONFIG_CHANGE_CHECKLIST.md 索引 ${checklistPaths.size} 条，README 目录树 ${requiredFiles.size} 个文件全部被索引覆盖`,
    };
  }

  const parts = [];
  if (missingIndex.length) {
    parts.push(`README 目录树中的文件未被 AGENTS.md 或 CONFIG_CHANGE_CHECKLIST.md 索引: [${missingIndex.join(', ')}]`);
  }
  if (missingFiles.length) {
    parts.push(`AGENTS.md / CONFIG_CHANGE_CHECKLIST.md 引用了不存在的文件: [${missingFiles.join(', ')}]`);
  }
  return { name, pass: false, detail: parts.join('; ') };
}

// ---------- Check 8: prompt 与 agent.md 过度文本重复检测 ----------
// 通用模板剔除规则（按顺序应用；先剥离大块结构，再处理单行模板，最后折叠空白）。
// 维护说明：新增/调整通用模板时，只需在此数组追加或修改对应条目。
const STRIP_RULES = [
  // 1) YAML frontmatter（agent.md 顶部，prompt 无此项）
  { name: 'YAML frontmatter', re: /^---\r?\n[\s\S]*?\r?\n---\r?\n?/ },
  // 2) Markdown 围栏代码块（含 ```text / ```ts 等任意语言）
  { name: 'Markdown code blocks', re: /```\w*\r?\n[\s\S]*?\r?\n```/g },
  // 3) 路径引用：.kilo/...（覆盖 instructions/、experience/log/、memory/、skills/ 等子路径）
  { name: '.kilo/ paths', re: /\.kilo\/[A-Za-z0-9_\-.\/{}]+/g },
  // 4) 路径引用：agent/...
  { name: 'agent/ paths', re: /agent\/[A-Za-z0-9_\-.\/{}]+/g },
  // 5) "详见/参见/参照" 引导句（吞到下一个句号或行尾）
  { name: '详见/参见/参照 引导句', re: /(?:详见|参见|参照)[^。\n]*[。\n]?/g },
  // 6) 角色声明句："你是 X。" 或 "你是 X，Y。"（吞到下一个句号）
  { name: '角色声明句', re: /你是\s*[^\n。]+[。]/g },
  // 7) 花括号占位符残留（{core.md,workflow-core.md,reflection.md} 等）
  { name: '花括号占位符', re: /\{[A-Za-z0-9_\-.,]+\}/g },
];

// 剥离通用模板，返回折叠空白后的纯文本
function stripCommonTemplates(text) {
  let s = text;
  for (const rule of STRIP_RULES) {
    s = s.replace(rule.re, ' ');
  }
  // 折叠空白（包含换行、tab、连续空格）
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 生成 n-gram 字符集合
function ngramSet(s, n) {
  const set = new Set();
  if (s.length < n) return set;
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

// Jaccard 相似度 = |A ∩ B| / |A ∪ B|
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) {
    if (large.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function check8PromptOverlap(config) {
  const name = 'prompt 与 agent.md 过度文本重复检测';
  if (!config || typeof config !== 'object') {
    return { name, pass: false, detail: 'kilo.json 不可用（依赖 [1/11]）' };
  }
  if (!config.agent || typeof config.agent !== 'object') {
    return { name, pass: false, detail: 'kilo.json.agent 不可用（依赖 [1/11]）' };
  }

  const SIMILARITY_THRESHOLD = 0.30; // > 30% 视为过度重复
  const MIN_PROMPT_LEN = 20; // 剔除后 prompt 短于此值则视为"已充分压缩"，豁免
  const NGRAM = 4; // 4-gram（字符级）
  const agentDir = path.resolve(ROOT, 'agent');

  const perAgent = [];
  const overThreshold = [];
  const exempt = [];
  const errors = [];

  for (const [agentName, agentConfig] of Object.entries(config.agent)) {
    if (!agentConfig || typeof agentConfig !== 'object') continue;
    const rawPrompt = agentConfig.prompt;
    if (typeof rawPrompt !== 'string') continue;

    const agentFile = path.join(agentDir, `${agentName}.md`);
    if (!fs.existsSync(agentFile)) {
      errors.push(`${agentName}: 缺少 agent/${agentName}.md`);
      continue;
    }
    let agentText;
    try {
      agentText = fs.readFileSync(agentFile, 'utf8');
    } catch (e) {
      errors.push(`${agentName}: 读取失败 ${e.message}`);
      continue;
    }

    // 模板变量 {name} → 实际 agent 名（与 check6 保持一致）
    const resolvedPrompt = rawPrompt.replace(/\{name\}/g, agentName);
    const strippedPrompt = stripCommonTemplates(resolvedPrompt);
    const strippedAgent = stripCommonTemplates(agentText);

    if (strippedPrompt.length < MIN_PROMPT_LEN) {
      perAgent.push({ name: agentName, sim: 0, status: 'exempt' });
      exempt.push(agentName);
      continue;
    }

    const gramsPrompt = ngramSet(strippedPrompt, NGRAM);
    const gramsAgent = ngramSet(strippedAgent, NGRAM);
    const sim = jaccardSimilarity(gramsPrompt, gramsAgent);
    const status = sim > SIMILARITY_THRESHOLD ? 'over' : 'ok';
    perAgent.push({ name: agentName, sim, status });
    if (status === 'over') {
      overThreshold.push({ name: agentName, sim });
    }
  }

  if (errors.length) {
    return { name, pass: false, detail: errors.join('; ') };
  }

  const summary = perAgent
    .map((x) => `${x.name}=${x.sim.toFixed(3)}${x.status === 'exempt' ? '(exempt)' : ''}`)
    .join(', ');

  if (overThreshold.length === 0) {
    return {
      name,
      pass: true,
      detail: `共检查 ${perAgent.length} 个 agent: ${summary}; 豁免: [${exempt.join(', ') || '无'}]`,
    };
  }

  const overList = overThreshold
    .sort((a, b) => b.sim - a.sim)
    .map((x) => `${x.name}=${x.sim.toFixed(3)}`)
    .join(', ');
  return {
    name,
    pass: false,
    detail: `超阈值 (>${
      (SIMILARITY_THRESHOLD * 100).toFixed(0)
    }%): [${overList}]; 全部: ${summary}`,
  };
}

// ---------- Check 9: coderAgent prompt 锚点关键词校验 ----------
// 防止未来误删 coderAgent.prompt 中的防 compaction 锚点关键词
const CODER_AGENT_ANCHORS = [
  '意图判定',
  '定级',
  'pre-checker',
  'engineer',
  'checker',
  'fixer',
  'reviewer',
  'compaction',
];
function check9CoderAgentAnchors(config) {
  const name = 'coderAgent prompt 锚点关键词校验';
  if (!config || typeof config !== 'object' || !config.agent || typeof config.agent !== 'object') {
    return { name, pass: false, detail: 'kilo.json.agent 不可用（依赖 [1/11]）' };
  }
  const coderAgent = config.agent.coderAgent;
  if (!coderAgent || typeof coderAgent !== 'object' || typeof coderAgent.prompt !== 'string') {
    return { name, pass: false, detail: 'kilo.json.agent.coderAgent.prompt 不可用' };
  }
  const prompt = coderAgent.prompt;
  const missing = CODER_AGENT_ANCHORS.filter((kw) => !prompt.includes(kw));
  if (missing.length === 0) {
    return { name, pass: true, detail: `coderAgent prompt 锚点关键词 ${CODER_AGENT_ANCHORS.length}/${CODER_AGENT_ANCHORS.length} 齐全` };
  }
  return { name, pass: false, detail: `coderAgent prompt 缺失锚点关键词: [${missing.join(', ')}]` };
}

// ---------- Check 10: SKILL.md frontmatter 合规性 ----------
// 校验 .kilo/skills/*/SKILL.md 的 frontmatter：
//   - name 必填且与目录名一致（兼容 agentskills.io 开放标准）
//   - description 必填且 ≤ 1024 字符
//   - keywords 必填为数组，数量 [3, 20]（与 skills-lifecycle.md 一致）
function check10SkillFrontmatter() {
  const name = 'SKILL.md frontmatter 合规性';
  const skillsDir = path.resolve(ROOT, '.kilo/skills');
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (e) {
    return { name, pass: false, detail: `读取 .kilo/skills/ 失败: ${e.message}` };
  }

  const errors = [];
  let checked = 0;
  const KEYWORDS_MIN = 3;
  const KEYWORDS_MAX = 20;
  const DESC_MAX = 1024;

  for (const d of dirEntries) {
    if (!d.isDirectory()) continue;
    const skillName = d.name;
    const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      errors.push(`${skillName}: 缺少 SKILL.md`);
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(skillFile, 'utf8');
    } catch (e) {
      errors.push(`${skillName}: 读取失败 ${e.message}`);
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm) {
      errors.push(`${skillName}: 缺少或不合法的 YAML frontmatter`);
      continue;
    }
    checked++;
    // name 必填且与目录名一致
    if (typeof fm.name !== 'string' || fm.name.length === 0) {
      errors.push(`${skillName}: frontmatter.name 缺失`);
    } else if (fm.name !== skillName) {
      errors.push(`${skillName}: frontmatter.name="${fm.name}" 与目录名不一致`);
    }
    // description 必填且 ≤ 1024 字符
    if (typeof fm.description !== 'string' || fm.description.length === 0) {
      errors.push(`${skillName}: frontmatter.description 缺失`);
    } else if (fm.description.length > DESC_MAX) {
      errors.push(`${skillName}: frontmatter.description 长度 ${fm.description.length} 超过 ${DESC_MAX}`);
    }
    // keywords 必填为数组，数量 [3, 20]
    if (!Array.isArray(fm.keywords)) {
      errors.push(`${skillName}: frontmatter.keywords 缺失或非数组`);
    } else {
      const len = fm.keywords.length;
      if (len < KEYWORDS_MIN || len > KEYWORDS_MAX) {
        errors.push(`${skillName}: frontmatter.keywords 数量 ${len}，超出 [${KEYWORDS_MIN},${KEYWORDS_MAX}] 范围`);
      }
    }
  }

  if (errors.length === 0) {
    return { name, pass: true, detail: `共 ${checked} 个 SKILL.md frontmatter 合规` };
  }
  return { name, pass: false, detail: errors.join('; ') };
}

// ---------- Check 11: install.sh 与 install.ps1 EXCLUDE 列表一致性 ----------
// 从两个脚本中提取 ROOT_ONLY_EXCLUDE / RootOnlyExclude 与
// RECURSIVE_EXCLUDE / RecursiveExclude 数组条目，按 trim 后字符级相等比较。
// bash 用 `(...)` 数组语法，PowerShell 用 `@(...)` 数组语法。
// 仅匹配双引号内的字符串条目（两个脚本的现有条目都使用双引号）。
function extractBashArray(text, varName) {
  const re = new RegExp(`^${varName}\\s*=\\s*\\(([\\s\\S]*?)\\)`, 'm');
  const m = text.match(re);
  if (!m) return null;
  const body = m[1];
  const items = [];
  const quoteRe = /"([^"]*)"/g;
  let qm;
  while ((qm = quoteRe.exec(body)) !== null) {
    items.push(qm[1].trim());
  }
  return items;
}

function extractPsArray(text, varName) {
  const re = new RegExp(`^\\$${varName}\\s*=\\s*@\\(([\\s\\S]*?)\\)`, 'm');
  const m = text.match(re);
  if (!m) return null;
  const body = m[1];
  const items = [];
  const quoteRe = /"([^"]*)"/g;
  let qm;
  while ((qm = quoteRe.exec(body)) !== null) {
    items.push(qm[1].trim());
  }
  return items;
}

function diffSets(aList, bList) {
  const a = new Set(aList);
  const b = new Set(bList);
  const onlyInA = [...a].filter((x) => !b.has(x)).sort();
  const onlyInB = [...b].filter((x) => !a.has(x)).sort();
  return { onlyInA, onlyInB };
}

function check11InstallExcludeSync() {
  const name = 'install.sh 与 install.ps1 EXCLUDE 列表一致性';
  const shPath = path.resolve(ROOT, 'install.sh');
  const ps1Path = path.resolve(ROOT, 'install.ps1');

  let shText, psText;
  try {
    shText = fs.readFileSync(shPath, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `读取 install.sh 失败: ${e.message}` };
  }
  try {
    psText = fs.readFileSync(ps1Path, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `读取 install.ps1 失败: ${e.message}` };
  }

  const shRoot = extractBashArray(shText, 'ROOT_ONLY_EXCLUDE');
  const shRec = extractBashArray(shText, 'RECURSIVE_EXCLUDE');
  const psRoot = extractPsArray(psText, 'RootOnlyExclude');
  const psRec = extractPsArray(psText, 'RecursiveExclude');

  if (shRoot === null) return { name, pass: false, detail: 'install.sh 未找到 ROOT_ONLY_EXCLUDE=(...) 数组' };
  if (shRec === null) return { name, pass: false, detail: 'install.sh 未找到 RECURSIVE_EXCLUDE=(...) 数组' };
  if (psRoot === null) return { name, pass: false, detail: 'install.ps1 未找到 $RootOnlyExclude = @(...) 数组' };
  if (psRec === null) return { name, pass: false, detail: 'install.ps1 未找到 $RecursiveExclude = @(...) 数组' };

  const errors = [];
  const rootDiff = diffSets(shRoot, psRoot);
  if (rootDiff.onlyInA.length || rootDiff.onlyInB.length) {
    const parts = [];
    if (rootDiff.onlyInA.length) parts.push(`install.sh 独有: [${rootDiff.onlyInA.join(', ')}]`);
    if (rootDiff.onlyInB.length) parts.push(`install.ps1 独有: [${rootDiff.onlyInB.join(', ')}]`);
    errors.push(`ROOT_ONLY: ${parts.join('; ')}`);
  }
  const recDiff = diffSets(shRec, psRec);
  if (recDiff.onlyInA.length || recDiff.onlyInB.length) {
    const parts = [];
    if (recDiff.onlyInA.length) parts.push(`install.sh 独有: [${recDiff.onlyInA.join(', ')}]`);
    if (recDiff.onlyInB.length) parts.push(`install.ps1 独有: [${recDiff.onlyInB.join(', ')}]`);
    errors.push(`RECURSIVE: ${parts.join('; ')}`);
  }

  if (errors.length === 0) {
    return {
      name,
      pass: true,
      detail: `ROOT_ONLY ${shRoot.length} 条 + RECURSIVE ${shRec.length} 条在 install.sh / install.ps1 之间完全一致`,
    };
  }
  return { name, pass: false, detail: errors.join('; ') };
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
const r3 = check3Skills();
const r4 = check4AgentFrontmatter();
const r5 = check5PromptPaths(config);
const r6 = check6ReadmeTree();
const r7 = check7DocIndex();
const r8 = check8PromptOverlap(config);
const r9 = check9CoderAgentAnchors(config);
const r10 = check10SkillFrontmatter();
const r11 = check11InstallExcludeSync();
const results = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11];

// ---------- 输出 ----------
const out = [];
out.push('== kilo_config 配置自检 ==');
const TOTAL = results.length;
results.forEach((r, i) => {
  const status = r.pass ? 'PASS' : `FAIL (${r.detail})`;
  out.push(`[${i + 1}/${TOTAL}] ${r.name}: ${status}`);
});
const failCount = results.filter((r) => !r.pass).length;
out.push(failCount === 0 ? '== 总结: 全部 PASS ==' : `== 总结: ${failCount} 项 FAIL ==`);
console.log(out.join('\n'));

process.exit(failCount === 0 ? 0 : 1);
