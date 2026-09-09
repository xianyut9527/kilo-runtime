// checks/__tests__/mcp-sanity.test.mjs — MCP 接线门禁分支夹具
//
// 立项事故：`enabled:true` 的 MCP 命令在 PATH 解析不到 → 每次会话启动静默 spawn 失败，
// 全仓无一条检查；另有机器专属绝对路径（换机即失效）。判据只有三类，但**误报会把门禁
// 变成噪声**（`enabled:false` 一律不检、remote 不发网络），故逐类钉住。
import path from 'node:path';
import process from 'node:process';
import { test, assert, makeSandbox } from '../../../lib/test-harness.mjs';
import { createCheckFn } from '../../lib/util.mjs';
import { run as runMcp } from '../mcp-sanity.mjs';

// 让「可解析命令」这一断言在任何机器上都成立：把当前 node 所在目录注入本进程 PATH，
// 否则 CI 用绝对路径调用 node 时，夹具会因为 PATH 里没有 node 而假红。
const NODE_DIR = path.dirname(process.execPath);
const RESOLVABLE = path.basename(process.execPath).replace(/\.exe$/i, '');
const DELIM = path.delimiter;
// 只改 PATH：resolveOnPath 读的是 `PATH || Path`，而在 Windows 上两者是同一个环境变量，
// 再补一个赋值只会把 NODE_DIR 插进去两次。
process.env.PATH = NODE_DIR + DELIM + (process.env.PATH || process.env.Path || '');

const MISSING = 'zz-definitely-not-a-real-bin-9x7';
// 机器专属绝对路径的两副面孔。盘符形态用拼接构造：直写会命中 path-normalize 的
// 「引号内路径串夹反斜杠」规则（它不读 JS 转义语义）。
const BS = '\\';
const WIN_ABS = 'C:' + BS + 'Users' + BS + 'someone' + BS + 'node.exe';
const POSIX_ABS = '/usr/local/bin/node';

function probe(mcp) {
  const files = mcp === null ? {} : { 'kilo.json': JSON.stringify({ mcp }) };
  const root = makeSandbox(files);
  const cf = createCheckFn();
  const r = runMcp({ ROOT: root, cf });
  return { r, results: cf.getResults() };
}

test('enabled + 裸命令可解析 → PASS', () => {
  const { r, results } = probe({ good: { enabled: true, command: RESOLVABLE } });
  assert.equal(r.status, 'PASS', r.detail);
  assert.ok(results[0].detail.indexOf('enabled=1') >= 0, results[0].detail);
});

test('enabled + 命令数组取首段判定', () => {
  const { r } = probe({ arr: { enabled: true, command: [RESOLVABLE, '-y', 'pkg'] } });
  assert.equal(r.status, 'PASS', r.detail);
});

test('enabled + PATH 解析不到 → unresolvable-command（立项事故本体）', () => {
  const { r } = probe({ ghost: { enabled: true, command: MISSING } });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.issues[0].kind, 'unresolvable-command');
  assert.equal(r.issues[0].server, 'ghost');
});

test('enabled + 绝对路径（盘符 / POSIX 两种）→ machine-specific-path', () => {
  const a = probe({ win: { enabled: true, command: WIN_ABS } });
  assert.equal(a.r.status, 'FAIL');
  assert.equal(a.r.issues[0].kind, 'machine-specific-path');
  const b = probe({ posix: { enabled: true, command: POSIX_ABS } });
  assert.equal(b.r.status, 'FAIL');
  assert.equal(b.r.issues[0].kind, 'machine-specific-path');
});

test('绝对路径优先于 PATH 判定报出（同一命令两种缺陷只报硬编码）', () => {
  // 这个路径既不是裸命令、在本机也解析不到；若顺序反了会报成 unresolvable-command，
  // 把真正的机器专属问题降级成「装个命令就好」的错误结论。
  const { r } = probe({ mix: { enabled: true, command: 'D:' + BS + 'tools' + BS + 'srv.exe' } });
  assert.equal(r.issues[0].kind, 'machine-specific-path');
});

test('enabled:false 一律不检（即使命令是绝对路径/不存在）', () => {
  const { r, results } = probe({
    off1: { enabled: false, command: WIN_ABS },
    off2: { enabled: false, command: MISSING },
    off3: { enabled: false },
  });
  assert.equal(r.status, 'PASS', r.detail);
  assert.ok(results[0].detail.indexOf('disabled=3') >= 0, results[0].detail);
});

test('remote 只校 URL 形态，不发网络', () => {
  const ok = probe({ web: { enabled: true, url: 'https://example.com/mcp' } });
  assert.equal(ok.r.status, 'PASS', ok.r.detail);
  const bad = probe({ web: { enabled: true, url: 'not-a-url' } });
  assert.equal(bad.r.status, 'FAIL');
  assert.equal(bad.r.issues[0].kind, 'invalid-url');
  const scheme = probe({ web: { enabled: true, url: 'ftp://example.com' } });
  assert.equal(scheme.r.issues[0].kind, 'invalid-url');
});

test('enabled 但既无 command 也无 url → misconfigured', () => {
  const { r } = probe({ hollow: { enabled: true } });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.issues[0].kind, 'misconfigured');
});

test('无 enabled:true 服务器 → PASS 且 detail 说明未探测', () => {
  const { r, results } = probe({ off: { enabled: false, command: MISSING } });
  assert.equal(r.status, 'PASS');
  assert.ok(results[0].detail.indexOf('no enabled server to probe') >= 0, results[0].detail);
});

test('kilo.json 缺失 → FAIL .file（配置根不对时不能静默绿）', () => {
  const { r, results } = probe(null);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'kilo.json missing');
  assert.equal(results[0].name, 'mcp-sanity.file');
});

test('kilo.json 语法坏 → FAIL .parse', () => {
  const root = makeSandbox({ 'kilo.json': '{ "mcp": ' });
  const cf = createCheckFn();
  const r = runMcp({ ROOT: root, cf });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'parse error');
  assert.equal(cf.getResults()[0].name, 'mcp-sanity.parse');
});
