/**
 * mcp-sanity.mjs — lifecycle-doctor check
 *
 * MCP 配置与本机实况一致性门禁。三档判定，全部可机械验证：
 *
 *   1. enabled:true 但 command 首段在 PATH 里解析不到 → FAIL
 *      （立项根因：某代码图谱类 MCP 曾长期 `enabled: true` 而 CLI 从未安装，
 *        于是**每次会话启动都 spawn 失败**——不报错、纯白耗，属于最贵的一种静默劣化。）
 *   2. enabled:true 且 command 是机器专属绝对路径 → FAIL
 *      （立项根因：图谱类工具的 command 曾写成某台机器的 `E:/.../bin/xxx.cmd`，换机即失效。
 *        声明式配置必须只写 PATH 可解析的命令名，见 README §MCP 扩展。）
 *   3. enabled:false → 一律 PASS（占位配置是允许状态，不检查 PATH）
 *
 * remote 条目（只有 url）只校验 URL 格式，**不发网络请求**：doctor 是秒级装配自检，
 * 不能因为某个远端 MCP 下线或本机离线就整体卡住。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(__dirname, '..', '..', '..');

const checkName = 'mcp-sanity';

const IS_WIN = process.platform === 'win32';
// MCP 的 command 首段必须是**裸命令名**（由 PATH 解析）。
// 任何含路径分隔符/盘符的写法都是机器专属硬编码，换机即失效。
const BARE_COMMAND = /^[A-Za-z0-9_@.-]+$/;

/**
 * 纯字符串 PATH 解析（不 spawn `where`/`which`）：doctor 每次跑上百个检查，
 * 这里避免为每个 MCP 额外起子进程。
 */
function resolveOnPath(cmd) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const names = IS_WIN
    ? [cmd].concat((process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(e => cmd + e))
    : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) return true;
      } catch (e) {
        // 目录不存在 / 无权限：继续下一个
      }
    }
  }
  return false;
}

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

export function run(ctx) {
  const cf = ctx.cf;
  const root = (ctx && ctx.ROOT) || SELF_ROOT;
  const kiloPath = path.join(root, 'kilo.json');

  if (!fs.existsSync(kiloPath)) {
    if (cf) cf.fail(checkName + '.file', 'kilo.json not found at ' + root);
    return { name: checkName, status: 'FAIL', detail: 'kilo.json missing', issues: [] };
  }

  let kilo;
  try {
    kilo = JSON.parse(fs.readFileSync(kiloPath, 'utf8'));
  } catch (e) {
    if (cf) cf.fail(checkName + '.parse', 'kilo.json parse error: ' + e.message);
    return { name: checkName, status: 'FAIL', detail: 'parse error', issues: [] };
  }

  const mcp = (kilo && kilo.mcp) || {};
  const names = Object.keys(mcp);
  const issues = [];
  let enabled = 0;
  let disabled = 0;

  for (const name of names) {
    const entry = mcp[name] || {};
    if (entry.enabled !== true) { disabled++; continue; }
    enabled++;

    const cmd = Array.isArray(entry.command) ? entry.command[0] : entry.command;
    if (cmd) {
      const c = String(cmd);
      if (!BARE_COMMAND.test(c)) {
        issues.push({ kind: 'machine-specific-path', server: name, detail: c });
      } else if (!resolveOnPath(c)) {
        issues.push({ kind: 'unresolvable-command', server: name, detail: c });
      }
      continue;
    }
    if (entry.url) {
      if (!isValidUrl(String(entry.url))) {
        issues.push({ kind: 'invalid-url', server: name, detail: String(entry.url) });
      }
      continue;
    }
    issues.push({ kind: 'misconfigured', server: name, detail: 'enabled but has neither command nor url' });
  }

  const summary = 'servers=' + names.length + ' enabled=' + enabled + ' disabled=' + disabled;

  if (issues.length === 0) {
    if (cf) cf.pass(checkName + '.wiring', enabled === 0 ? summary + ' (no enabled server to probe)' : summary);
  } else {
    if (cf) cf.fail(checkName + '.wiring', summary + ' :: ' + issues.map(i => i.server + '=' + i.kind + '(' + i.detail + ')').join(' '));
  }

  return {
    name: checkName,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    detail: summary + ' issues=' + issues.length,
    issues
  };
}
