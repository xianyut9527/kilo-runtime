#!/usr/bin/env node
// agents-smoke-test.mjs
// 8 个 subagent 的端到端冒烟测试调度引擎。
//
// 用途：unit-2 写 CLI 入口串联所有 subagent；unit-1（当前）只暴露核心引擎。
// 前置：Node 18+（内置 fetch + AbortController），零 npm 依赖。
// 配置源：kilo.json  →  provider.hx.options.baseURL + agent.<name>.{model,prompt,mode}
//
// 对外契约（unit-2 import 使用）：
//   loadAgents()                  → [{ name, model, prompt, mode }]
//   dispatchOne(agentName, userPrompt, timeoutMs) → Promise<DispatchResult>
//
// DispatchResult 字段：
//   { agent, model, ok, httpStatus, contentLen, contentPreview, latencyMs, error }
//   error 细分：'timeout' | 'network' | 'http:<code>' | 'parse' | 'config' | null

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------- 运行时兼容垫片（仅当 Node < 18 时激活；Node 18+ 直接用全局 fetch + AbortController） ----------
// 目标：在不引入任何 npm 包的前提下，让本脚本在 Node 14/16/18+ 行为一致。
// 实现：检测 typeof fetch === 'undefined' 或 typeof AbortController === 'undefined'，用 node:http 自实现最小子集。

if (typeof fetch === 'undefined' || typeof AbortController === 'undefined') {
  const http = await import('node:http');
  const https = await import('node:https');
  const { URL } = await import('node:url');

  class _AbortController {
    constructor() {
      this.signal = { aborted: false, _listeners: [] };
      this._onAbort = null;
    }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      const ls = this.signal._listeners.slice();
      for (const fn of ls) {
        try { fn(reason); } catch { /* ignore */ }
      }
    }
  }
  // @ts-ignore
  globalThis.AbortController = _AbortController;

  function _nodeFetch(url, init) {
    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(url); } catch (e) { reject(new Error(`Invalid URL: ${url}`)); return; }
      const lib = parsed.protocol === 'https:' ? https : http;
      const method = (init && init.method) || 'GET';
      const headers = Object.assign({}, (init && init.headers) || {});
      const body = init && init.body != null ? (typeof init.body === 'string' ? init.body : String(init.body)) : null;
      if (body != null && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
        headers['content-length'] = Buffer.byteLength(body);
      }
      const req = lib.request(
        { method, protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, headers, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const text = buf.toString('utf8');
            const headersObj = res.headers;
            const resp = {
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage || '',
              headers: { get: (k) => headersObj[k && k.toLowerCase()] },
              url,
              text: async () => text,
              json: async () => JSON.parse(text),
            };
            resolve(resp);
          });
        }
      );
      req.on('error', (e) => { if (signal && signal.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; reject(err); } else { reject(e); } });
      const signal = init && init.signal;
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('aborted')); return; }
        signal._listeners.push(() => { try { req.destroy(new Error('aborted')); } catch { /* ignore */ } });
      }
      if (body != null) req.write(body);
      req.end();
    });
  }
  // @ts-ignore
  globalThis.fetch = _nodeFetch;
}

// ---------- 路径常量 ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO_JSON = path.join(ROOT, 'kilo.json');

// 期望的 8 个 subagent 清单（按字母序稳定；缺一 loadAgents 即 FAIL）
const EXPECTED_SUBAGENTS = [
  'planner',
  'coder',
  'verifier',
  'reviewer',
  'plan-reviewer',
  'reverse-auditor',
  'fixer',
  'delivery',
];

// ---------- loadAgents() ----------

/**
 * 同步读 kilo.json，过滤 mode==='subagent' 的智能体，校验 EXPECTED_SUBAGENTS 全部存在。
 * @returns {Array<{name:string, model:string, prompt:string, mode:string}>}
 * @throws {Error} 缺任一 EXPECTED_SUBAGENTS 时抛出，错误信息含 'FAIL loadAgents'。
 */
export function loadAgents() {
  if (!fs.existsSync(KILO_JSON)) {
    throw new Error(`FAIL loadAgents: kilo.json not found at ${KILO_JSON}`);
  }
  const raw = fs.readFileSync(KILO_JSON, 'utf8');
  const cfg = JSON.parse(raw);
  const agentMap = cfg.agent || {};
  const subagents = Object.entries(agentMap)
    .filter(([, v]) => v && v.mode === 'subagent')
    .map(([name, v]) => ({
      name,
      model: String(v.model || ''),
      prompt: String(v.prompt || ''),
      mode: 'subagent',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const names = new Set(subagents.map((a) => a.name));
  const missing = EXPECTED_SUBAGENTS.filter((n) => !names.has(n));
  if (missing.length > 0) {
    throw new Error(
      `FAIL loadAgents: missing ${missing.length}/${EXPECTED_SUBAGENTS.length} subagent(s): ${missing.join(', ')}`,
    );
  }
  return subagents;
}

// ---------- 内部工具 ----------

/**
 * 从 agent.model 字符串（如 "hx/glm-5.2"）抽取实际 API model id。
 * 当前实现：去掉 <provider>/ 前缀（provider 维度由 baseURL 决定，模型 id 自身不再含 provider 前缀）。
 */
function resolveApiModelId(modelField) {
  if (!modelField) throw new Error('FAIL dispatchOne: agent.model is empty');
  const idx = modelField.indexOf('/');
  return idx >= 0 ? modelField.slice(idx + 1) : modelField;
}

function getProviderConfig() {
  const raw = fs.readFileSync(KILO_JSON, 'utf8');
  const cfg = JSON.parse(raw);
  const hx = cfg.provider && cfg.provider.hx;
  if (!hx || !hx.options || !hx.options.baseURL) {
    throw new Error('FAIL dispatchOne: kilo.json provider.hx.options.baseURL missing');
  }
  return { baseURL: hx.options.baseURL, timeout: hx.options.timeout };
}

/**
 * 安全截断字符串用于预览（避免单行超长污染控制台/报告）。
 */
function preview(s, max = 200) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

// ---------- dispatchOne() ----------

/**
 * 向指定 subagent 发送单条 user prompt（system = agent.prompt），等待响应或超时。
 *
 * @param {string} agentName  subagent 名称（必须在 loadAgents 结果中）
 * @param {string} userPrompt 用户消息
 * @param {number} timeoutMs  超时毫秒
 * @returns {Promise<{
 *   agent:string, model:string, ok:boolean, httpStatus:number|null,
 *   contentLen:number, contentPreview:string, latencyMs:number, error:string|null
 * }>}
 */
export async function dispatchOne(agentName, userPrompt, timeoutMs) {
  const t0 = Date.now();
  const baseResult = {
    agent: agentName,
    model: '',
    ok: false,
    httpStatus: null,
    contentLen: 0,
    contentPreview: '',
    latencyMs: 0,
    error: null,
  };

  // 1) 校验入参
  if (typeof agentName !== 'string' || !agentName) {
    return { ...baseResult, error: 'invalid-agent-name', latencyMs: Date.now() - t0 };
  }
  if (typeof userPrompt !== 'string') {
    return { ...baseResult, error: 'invalid-user-prompt', latencyMs: Date.now() - t0 };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ...baseResult, error: 'invalid-timeout', latencyMs: Date.now() - t0 };
  }

  // 2) 解析 agent 配置
  const agents = loadAgents();
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    return {
      ...baseResult,
      error: `unknown-agent:${agentName}`,
      latencyMs: Date.now() - t0,
    };
  }
  const apiModel = resolveApiModelId(agent.model);

  // 3) 解析 provider baseURL
  let baseURL;
  try {
    ({ baseURL } = getProviderConfig());
  } catch {
    return { ...baseResult, model: apiModel, error: 'config', latencyMs: Date.now() - t0 };
  }
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';

  // 4) 构造请求 + AbortController 超时
  const body = {
    model: apiModel,
    messages: [
      { role: 'system', content: agent.prompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const name = e && e.name;
    if (name === 'AbortError') {
      return { ...baseResult, model: apiModel, error: 'timeout', latencyMs };
    }
    return {
      ...baseResult,
      model: apiModel,
      error: 'network',
      latencyMs,
    };
  }
  clearTimeout(timer);

  // 5) 状态码分支
  if (!res.ok) {
    let snippet = '';
    try {
      snippet = preview(await res.text(), 200);
    } catch {
      /* ignore */
    }
    return {
      ...baseResult,
      model: apiModel,
      httpStatus: res.status,
      contentPreview: snippet,
      error: `http:${res.status}`,
      latencyMs: Date.now() - t0,
    };
  }

  // 6) 解析 JSON
  let data;
  try {
    data = await res.json();
  } catch {
    return {
      ...baseResult,
      model: apiModel,
      httpStatus: res.status,
      error: 'parse',
      latencyMs: Date.now() - t0,
    };
  }

  // 7) 提取 content
  const content =
    (data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    '';

  return {
    agent: agentName,
    model: apiModel,
    ok: true,
    httpStatus: res.status,
    contentLen: typeof content === 'string' ? content.length : 0,
    contentPreview: preview(content, 200),
    latencyMs: Date.now() - t0,
    error: null,
  };
}


// ---------- CLI 入口 ----------
// unit-2 实现：参数解析 + 单跑/--full 顺序循环 + 人类可读表格/JSON 输出 + 退出码。
// 退出码契约：
//   0 = ok=true（单跑）/ --full 全 pass
//   1 = ok=false（单跑）/ --full 至少 1 个 fail
//   2 = 用法错误（未知 flag、缺值、未知 agent、--agent 与 --full 互斥等）
// 人类可读模式列：agent | model | ok | http | len | ms | err，最后 1 行 Total: N pass / M fail。
// JSON 模式：单跑输出 [result] 1 元素；--full 输出 8 元素 + 1 summary 元素（共 9）。
// 进度信息走 stderr，结构化输出走 stdout，避免污染 JSON 解析。

function usage() {
  const text = [
    'Usage:',
    '  node scripts/agents-smoke-test.mjs [options]',
    '',
    'Options:',
    '  --agent <name>            Run a single subagent and print the result',
    '  --full                    Run all 8 subagents sequentially (planner to delivery)',
    '  --prompt <text>           User prompt (default: "ping")',
    '  --timeout <duration>      Per-call timeout, e.g. 30s / 500ms / 1m (default: 60000ms)',
    '  --json                    Emit JSON array to stdout (single=1 elem, full=8+summary)',
    '  --help, -h                Show this help and exit 0',
    '',
    'Exit codes:',
    '  0 = dispatch ok (single) / all 8 passed (--full)',
    '  1 = dispatch failed (single) / >=1 failed (--full)',
    '  2 = usage error (unknown flag, missing value, unknown agent, --agent+--full conflict)',
  ].join('\n');
  process.stdout.write(text + '\n');
  process.exit(0);
}

// 解析 --timeout 值：支持 30s / 500ms / 1m / 纯数字(ms)
function parseDurationMs(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('invalid --timeout value (empty)');
  }
  const m = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!m) throw new Error('invalid --timeout value: ' + raw + ' (expect 30s / 500ms / 1m)');
  const n = parseInt(m[1], 10);
  const unit = m[2] || 'ms';
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  throw new Error('invalid --timeout unit: ' + unit);
}

function parseArgs(argv) {
  const out = {
    help: false,
    agent: null,
    full: false,
    prompt: 'ping',
    timeoutMs: 60000,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--full') {
      out.full = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--agent') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--agent requires a value');
      if (v === '') throw new Error('--agent value must be non-empty');
      out.agent = v;
    } else if (a === '--prompt') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--prompt requires a value');
      out.prompt = v;
    } else if (a === '--timeout') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--timeout requires a value');
      out.timeoutMs = parseDurationMs(v);
    } else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error('unknown option: ' + a);
    } else {
      throw new Error('unexpected positional argument: ' + a);
    }
  }
  return out;
}

// 人类可读表格：按列宽对齐
function formatTable(results) {
  const header = ['agent', 'model', 'ok', 'http', 'len', 'ms', 'err'];
  const rows = results.map((r) => [
    r.agent,
    r.model || '-',
    r.ok ? 'PASS' : 'FAIL',
    r.httpStatus == null ? '-' : String(r.httpStatus),
    String(r.contentLen),
    String(r.latencyMs),
    r.error || '',
  ]);
  const widths = header.map((h, i) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[i] || '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const fmt = (cells) => cells.map((c, i) => (c || '').padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

async function runSingle(agentName, opts) {
  let agents;
  try {
    agents = loadAgents();
  } catch (e) {
    process.stderr.write('[agents-smoke-test] ' + e.message + '\n');
    process.exit(2);
  }
  if (!agents.find((a) => a.name === agentName)) {
    const known = agents.map((a) => a.name).join(', ');
    process.stderr.write('[agents-smoke-test] unknown agent: ' + agentName + ' (available: ' + known + ')\n');
    process.exit(2);
  }
  // 硬截止：最多等 opts.timeoutMs + 1s 宽限期，防止 polyfill 偶发挂死
  const t0 = Date.now();
  const r = await Promise.race([
    dispatchOne(agentName, opts.prompt, opts.timeoutMs),
    new Promise((resolve) => setTimeout(() => resolve({
      agent: agentName,
      model: '-',
      ok: false,
      httpStatus: null,
      contentLen: 0,
      contentPreview: '',
      latencyMs: Date.now() - t0,
      error: 'cli-hard-timeout',
    }), opts.timeoutMs + 1000)),
  ]);
  return { results: [r], exitCode: r.ok ? 0 : 1 };
}

async function runFull(opts) {
  let agents;
  try {
    agents = loadAgents();
  } catch (e) {
    process.stderr.write('[agents-smoke-test] ' + e.message + '\n');
    process.exit(2);
  }
  const results = [];
  // 硬截止：每个 agent 最多等 opts.timeoutMs + 1s 宽限期，防止 polyfill 偶发挂死导致 --full 卡住
  const hardDeadlineMs = opts.timeoutMs + 1000;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    process.stderr.write('[agents-smoke-test] (' + (i + 1) + '/' + agents.length + ') dispatching ' + a.name + '...\n');
    const t0 = Date.now();
    const r = await Promise.race([
      dispatchOne(a.name, opts.prompt, opts.timeoutMs),
      new Promise((resolve) => setTimeout(() => resolve({
        agent: a.name,
        model: '-',
        ok: false,
        httpStatus: null,
        contentLen: 0,
        contentPreview: '',
        latencyMs: Date.now() - t0,
        error: 'cli-hard-timeout',
      }), hardDeadlineMs)),
    ]);
    results.push(r);
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const summary = { type: 'summary', total: results.length, pass, fail, exitCode: fail === 0 ? 0 : 1 };
  return { results, summary, exitCode: summary.exitCode };
}

function printHuman(results, summary) {
  process.stdout.write(formatTable(results) + '\n');
  if (summary) {
    process.stdout.write('\nTotal: ' + summary.pass + ' pass / ' + summary.fail + ' fail\n');
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write('[agents-smoke-test] ' + e.message + '\n');
    process.exit(2);
  }
  if (opts.help) usage();
  if (!opts.full && !opts.agent) {
    process.stderr.write('[agents-smoke-test] missing --agent <name> or --full\n');
    process.exit(2);
  }
  if (opts.full && opts.agent) {
    process.stderr.write('[agents-smoke-test] --agent and --full are mutually exclusive\n');
    process.exit(2);
  }

  let out;
  if (opts.agent) {
    out = await runSingle(opts.agent, opts);
  } else {
    out = await runFull(opts);
  }

  if (opts.json) {
    const arr = out.results.slice();
    if (out.summary) arr.push(out.summary);
    process.stdout.write(JSON.stringify(arr, null, 2) + '\n');
  } else {
    printHuman(out.results, out.summary);
  }
  process.exit(out.exitCode);
}

// 入口守卫：仅当作为主进程运行时才跑 CLI；被 import 时不触发副作用
const _invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_invokedDirectly) {
  main().catch((e) => {
    const msg = e && e.stack ? e.stack : String(e);
    process.stderr.write('[agents-smoke-test] fatal: ' + msg + '\n');
    process.exit(2);
  });
}
