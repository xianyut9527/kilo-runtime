#!/usr/bin/env node
// validate-agent-prompt.mjs
// 校验 kilo.json agent.<name>.prompt 字段健康度：
//   - prompt 必填 / 是字符串
//   - 长度上限 PROMPT_MAX_LEN（默认 4096）
//   - 无未配对 XML 标签（<tool> 等）——只检测明显未配对的开放/闭合标签
//   - 无控制字符（C0 / C1 / DEL）
//
// zod 优先 + 纯 Node fallback：先 try await import('zod')，失败则走内置校验器。
// 不写 package.json scripts、不触发 npm install——zod 缺失时自动降级。
//
// 用法：
//   node scripts/validate-agent-prompt.mjs                # 校验根目录 kilo.json
//   node scripts/validate-agent-prompt.mjs <file.json>    # 校验指定文件（测试用副本）
//
// 退出码：
//   0 = 全部 agent.prompt 校验 PASS
//   2 = 至少一个 agent.prompt 违规（输出 agent 名 + 违规类型）
//
// 导出：
//   validatePrompt(promptStr, agentName) -> { valid, errors: string[] }
//     供 future pre-dispatch 钩子 import 复用（纯函数，无 IO）。
//
// 仅使用 Node 内置模块：node:fs / node:path / node:url / node:process
// 跨平台：Windows PowerShell 5.1 + Linux bash 兼容
// 输出仅 ASCII，避免 PowerShell 5.1 GBK 乱码（error 消息用英文）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PROMPT_MAX_LEN } from './sanitize-agent-description.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ============================================================
// 配置
// ============================================================
// prompt 字符串长度上限：与 config.yaml dispatch_prompt_threshold 留 1.5x 余量
// PROMPT_MAX_LEN 改从 ./sanitize-agent-description.mjs 共享导入，避免重复定义

// 需配对的 XML 标签名（仅检测我们关心的标签；不穷举所有 XML 标签）
const XML_TAGS = ['tool', 'dispatch', 'agent'];

// 控制字符检测范围
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const C1_CONTROL_RE = /[\u0080-\u009F]/;
// 制表符 / 换行 / 回车为合法空白，不视为控制字符违规
const ALLOWED_CONTROLS = new Set(['\t', '\n', '\r']);

// ============================================================
// 纯函数：校验单个 prompt
// ============================================================

/**
 * 校验 XML 标签配对。对每个需配对的标签：
 *   - 统计 <tag 与 </tag> 出现次数（仅匹配完整单词边界，避免 <toolbar> 误判）
 *   - 两者不等 -> 未配对
 * 返回违规的标签名列表。
 */
function checkXmlBalance(promptStr, agentName) {
  const problems = [];
  for (const tag of XML_TAGS) {
    const openRe = new RegExp(`<${tag}(\\s|>)`, 'g');
    const closeRe = new RegExp(`</${tag}>`, 'g');
    let openCount = 0;
    let closeCount = 0;
    let m;
    while ((m = openRe.exec(promptStr)) !== null) openCount++;
    while ((m = closeRe.exec(promptStr)) !== null) closeCount++;
    if (openCount !== closeCount) {
      problems.push(
        `unbalanced XML tag "<${tag}>": open=${openCount} close=${closeCount}`
      );
    }
  }
  return problems;
}

/**
 * 纯函数：校验单个 prompt 字符串。
 * @param {string} promptStr 待校验的 prompt 内容
 * @param {string} agentName 所属 agent 名（仅用于错误消息，无逻辑分支）
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePrompt(promptStr, agentName) {
  const errors = [];

  // 必填 + 字符串
  if (promptStr === undefined || promptStr === null) {
    errors.push('missing required field "prompt"');
    return { valid: false, errors };
  }
  if (typeof promptStr !== 'string') {
    errors.push(`prompt must be a string, got ${typeof promptStr}`);
    return { valid: false, errors };
  }

  // 非空
  if (promptStr.trim().length === 0) {
    errors.push('prompt must be a non-empty string');
  }

  // 长度上限
  if (promptStr.length > PROMPT_MAX_LEN) {
    errors.push(
      `prompt length ${promptStr.length} exceeds PROMPT_MAX_LEN=${PROMPT_MAX_LEN}`
    );
  }

  // 无未配对 XML 标签
  errors.push(...checkXmlBalance(promptStr, agentName));

  // 无控制字符（逐字符检查，区分允许空白）
  let badCode = null;
  for (let i = 0; i < promptStr.length; i++) {
    const ch = promptStr[i];
    if (ALLOWED_CONTROLS.has(ch)) continue;
    const code = promptStr.charCodeAt(i);
    if (CONTROL_RE.test(ch) || C1_CONTROL_RE.test(ch)) {
      badCode = code;
      break;
    }
  }
  if (badCode !== null) {
    errors.push(`prompt contains control character U+${badCode.toString(16).padStart(4, '0').toUpperCase()}`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// zod schema（zod 可用时使用）
// ============================================================
const xmlChecksZod = (tag) => {
  const openRe = new RegExp(`<${tag}(\\s|>)`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  return (v) => {
    const opens = (v.match(openRe) || []).length;
    const closes = (v.match(closeRe) || []).length;
    if (opens !== closes) {
      return `unbalanced XML tag "<${tag}>": open=${opens} close=${closes}`;
    }
    return null;
  };
};

async function buildZodSchema() {
  const { z } = await import('zod');
  const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/;
  return z.string().min(1, 'prompt must be a non-empty string')
    .max(PROMPT_MAX_LEN, `prompt length exceeds PROMPT_MAX_LEN=${PROMPT_MAX_LEN}`)
    .refine((v) => !controlChars.test(v), 'prompt contains control characters')
    .refine(xmlChecksZod('tool'), 'prompt has unbalanced <tool> tag');
}

// ============================================================
// 顶层校验入口：读文件 -> 校验全部 agent.prompt
// ============================================================

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`validate-agent-prompt: config file not found: ${configPath}\n`);
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    process.stderr.write(`validate-agent-prompt: cannot read ${configPath}: ${e.message}\n`);
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`validate-agent-prompt: invalid JSON in ${configPath}: ${e.message}\n`);
    process.exit(2);
  }
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = args.length > 0
    ? path.resolve(process.cwd(), args[0])
    : path.join(ROOT, 'kilo.json');

  const data = readConfig(configPath);

  const agents = data && data.agent && typeof data.agent === 'object'
    ? data.agent
    : {};
  const names = Object.keys(agents);
  if (names.length === 0) {
    process.stderr.write('validate-agent-prompt: no agent entries found in config\n');
    process.exit(2);
  }

  // 尝试 zod；失败降级到纯 Node validatePrompt
  let useZod = null;
  try {
    const schema = await buildZodSchema();
    useZod = schema;
  } catch {
    useZod = null; // zod 未安装 -> 纯 Node fallback
  }

  let allValid = true;
  const failures = [];

  for (const name of names) {
    const entry = agents[name];
    const prompt = entry && typeof entry === 'object' ? entry.prompt : undefined;

    let result;
    if (useZod) {
      const parsed = useZod.safeParse(prompt);
      result = parsed.success
        ? { valid: true, errors: [] }
        : {
            valid: false,
            errors: parsed.error.issues.map(
              (iss) => iss.message || iss.path.join('.') || 'zod validation failed'
            ),
          };
    } else {
      result = validatePrompt(prompt, name);
    }

    if (!result.valid) {
      allValid = false;
      failures.push({ agent: name, errors: result.errors });
    }
  }

  if (!allValid) {
    process.stdout.write(JSON.stringify({ pass: false, failures }, null, 2) + '\n');
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({ pass: true, agentsValidated: names.length }, null, 2) + '\n');
  process.exit(0);
}

// ============================================================
// 脚本入口：仅当通过 node 直接运行时执行 main()，被 import 时不执行
// ============================================================
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}