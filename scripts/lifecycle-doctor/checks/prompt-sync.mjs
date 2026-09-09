/**
 * prompt-sync.mjs — lifecycle-doctor check
 *
 * 校验 kilo.json `agent.<name>.prompt` 与 `agent/<name>.md` frontmatter `description`
 * 的单源派生关系（description 是唯一真相，prompt 由 sync-agent-prompt.mjs 派生）。
 *
 * 存在动机（真实事故）：
 *   extractDescription 曾把 YAML 块标量指示符当成值，install 时派生出 `prompt: "|"`，
 *   部署副本 deep-analyzer 提示词被写坏；而当时 doctor 无任何 prompt 维度校验 → 全绿放行。
 *   本 check 把「prompt 是否可用」变成机械门禁，堵住同类回归。
 *
 * 检查项（仅 prompt 维度；agent 条目 ↔ agent/*.md 双向一致由 matrix-docs-kilojson-scripts.mjs G1 负责，不重复）：
 *   P1 block_indicator    prompt 不得是 YAML 块标量指示符（| > |- >- |+ >+）
 *   P2 min_length         prompt 长度 ≥ PROMPT_MIN_LEN（过短 = 无法稳定进入角色）
 *   P3 max_length         prompt 长度 ≤ PROMPT_MAX_LEN（与 sanitize 截断阈值一致）
 *   P4 derivation_drift   prompt 必须 == sanitizeDescription(extractDescription(frontmatter))
 *   P5 control_chars      prompt 不得含控制字符（\t \n \r 除外）
 *
 * 支持 --root：部署副本（占位符已替换）同样适用——description/prompt 不含 ${KILO_CONFIG_DIR}。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');

// prompt 最短可用长度：低于此值无法让模型稳定进入角色
const PROMPT_MIN_LEN = 20;

// YAML 块标量指示符（extractDescription 历史缺陷会把它们当成值）
const BLOCK_INDICATORS = new Set(['|', '>', '|-', '>-', '|+', '>+']);

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/;

/** 动态 import sanitize 工具（其 CLI 有 isMainModule 守卫，作为库 import 不会执行 cliMain） */
async function loadSanitizer(root) {
  const p = path.join(root, 'scripts', 'sanitize-agent-description.mjs');
  if (!fs.existsSync(p)) return null;
  try {
    return await import(pathToFileURL(p).href);
  } catch {
    return null;
  }
}

export async function run(ctx) {
  const root = (ctx && ctx.ROOT) || SELF_ROOT;
  const cf = ctx && ctx.cf;
  if (!cf) return { name: 'prompt-sync', status: 'FAIL', detail: 'ctx.cf 缺失' };

  const agentDir = path.join(root, 'agent');
  const kiloJsonPath = path.join(root, 'kilo.json');

  if (!fs.existsSync(agentDir) || !fs.existsSync(kiloJsonPath)) {
    cf.warn('prompt-sync.input', `agent/ 或 kilo.json 缺失，跳过（root=${root}）`);
    return { name: 'prompt-sync', status: 'WARN', detail: 'input missing' };
  }

  const mod = await loadSanitizer(root);
  if (!mod) {
    cf.fail('prompt-sync.sanitizer', `无法加载 ${path.join('scripts', 'sanitize-agent-description.mjs')}`);
    return { name: 'prompt-sync', status: 'FAIL', detail: 'sanitizer unloadable' };
  }

  let kj;
  try {
    kj = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
  } catch (e) {
    cf.fail('prompt-sync.kilojson', `kilo.json 解析失败: ${e.message}`);
    return { name: 'prompt-sync', status: 'FAIL', detail: 'kilo.json parse error' };
  }
  const agents = kj.agent || {};

  const files = fs.readdirSync(agentDir).filter((f) => f.endsWith('.md'));
  let checked = 0;
  const problems = [];

  for (const file of files) {
    const name = file.slice(0, -3);
    const entry = agents[name];
    if (!entry) continue; // 双向一致由 G1 负责
    const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';

    const text = fs.readFileSync(path.join(agentDir, file), 'utf8');
    const fm = mod.extractFrontmatter(text);
    const desc = fm ? mod.extractDescription(fm) : null;
    const expected = desc === null ? null : mod.sanitizeDescription(desc, name).sanitized;

    checked++;

    if (BLOCK_INDICATORS.has(prompt.trim())) {
      problems.push(`${name}: prompt 是 YAML 块标量指示符 "${prompt.trim()}"（extractDescription 解析缺陷）`);
    }
    if (prompt.length < PROMPT_MIN_LEN) {
      problems.push(`${name}: prompt 过短 len=${prompt.length} < ${PROMPT_MIN_LEN}`);
    }
    if (prompt.length > mod.PROMPT_MAX_LEN) {
      problems.push(`${name}: prompt 超长 len=${prompt.length} > ${mod.PROMPT_MAX_LEN}`);
    }
    if (CONTROL_RE.test(prompt)) {
      problems.push(`${name}: prompt 含控制字符`);
    }
    if (expected !== null && expected !== prompt) {
      problems.push(`${name}: 派生漂移 desc(${expected.length}) != prompt(${prompt.length})`);
    }
  }

  if (problems.length === 0) {
    cf.pass('prompt-sync', `${checked} 个 agent prompt 与 description 单源一致（min=${PROMPT_MIN_LEN} max=${mod.PROMPT_MAX_LEN}）`);
    return { name: 'prompt-sync', status: 'PASS', detail: `checked=${checked}` };
  }

  cf.fail('prompt-sync', `${problems.length} 项 prompt 缺陷: ${problems.slice(0, 6).join(' | ')}${problems.length > 6 ? ' …' : ''}`);
  return { name: 'prompt-sync', status: 'FAIL', detail: `checked=${checked} problems=${problems.length}`, problems };
}
