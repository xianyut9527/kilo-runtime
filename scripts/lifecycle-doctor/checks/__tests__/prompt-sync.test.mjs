// checks/__tests__/prompt-sync.test.mjs — prompt 单源派生门禁分支夹具
//
// 立项事故：install 曾把 `prompt: "|"` 写进 kilo.json（extractDescription 把 YAML 块标量
// 指示符当成值），而 doctor 当时**没有 prompt 维度** → 全绿放行，坏 prompt 直达运行时。
// 这条门禁是那个事故的直接封口，5 类判据（块标量 / 过短 / 超长 / 控制字符 / 派生漂移）
// 必须有夹具，否则下次改 extractDescription 又是裸奔。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, makeSandbox, testAsync, flushAsyncTests } from '../../../lib/test-harness.mjs';
import { createCheckFn } from '../../lib/util.mjs';
import { run as runPromptSync } from '../prompt-sync.mjs';
import * as sanitize from '../../../sanitize-agent-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 把真实的 sanitize 模块源码复制进沙箱（它只 import node 内置，可安全搬移）：
// prompt-sync 是按 root 定位 scripts/sanitize-agent-description.mjs 的，缺它只能得到
// 「unloadable」这条分支，测不到真正的派生逻辑。
// __dirname = scripts/lifecycle-doctor/checks/__tests__ → 退 4 层才是仓库根
const SANITIZE_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'sanitize-agent-description.mjs'), 'utf8'
);

const DESC = '这是一个足够长的智能体描述，用来验证 prompt 与 description 的单源派生关系是否成立。';
const EXPECTED = sanitize.sanitizeDescription(DESC, 'tester').sanitized;

/** 造一个 agent/*.md + kilo.json 都齐备的沙箱；prompt 传 undefined 表示不写该键 */
function sandboxAgent(opts) {
  const o = opts || {};
  const kilo = { agent: { tester: {} } };
  if ('prompt' in o) kilo.agent.tester.prompt = o.prompt;
  const files = {
    'agent/tester.md': ['---', 'name: tester', 'description: ' + DESC, '---', '', '# tester', ''].join('\n'),
    'scripts/sanitize-agent-description.mjs': SANITIZE_SRC,
  };
  if (o.kiloText !== undefined) files['kilo.json'] = o.kiloText;
  else if (o.kilo === false) { /* 不放 kilo.json */ }
  else files['kilo.json'] = JSON.stringify(kilo, null, 2);
  if (o.skipSanitize) delete files['scripts/sanitize-agent-description.mjs'];
  return makeSandbox(files);
}

function probeCtx(root) {
  const cf = createCheckFn();
  // 字段名必须是 ROOT：写成 root 会被当成「未传 ROOT」，check 回落到真实仓库根——
  // 沙箱失效不报错，只会静默变成「在真仓库上跑了一遍不相干的断言」。
  const results = cf.getResults();
  return { ROOT: root, cf, get results() { return results; } };
}

function kindsOf(r) {
  return (r.problems || []).join(' | ');
}

testAsync('派生一致 → PASS（checked 计入）', async () => {
  const root = sandboxAgent({ prompt: EXPECTED });
  const ctx = probeCtx(root);
  const r = await runPromptSync(ctx);
  assert.equal(r.status, 'PASS', kindsOf(r));
  assert.equal(r.detail, 'checked=1');
});

testAsync('块标量指示符 "|" → 立项事故本体被拦下', async () => {
  const root = sandboxAgent({ prompt: '|' });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.ok(kindsOf(r).indexOf('块标量指示符') >= 0, kindsOf(r));
});

testAsync('prompt 过短 → 报最小长度', async () => {
  const root = sandboxAgent({ prompt: '太短了' });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.ok(kindsOf(r).indexOf('过短') >= 0, kindsOf(r));
});

testAsync('prompt 超长 → 报 PROMPT_MAX_LEN', async () => {
  const root = sandboxAgent({ prompt: 'x'.repeat(sanitize.PROMPT_MAX_LEN + 10) });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.ok(kindsOf(r).indexOf('超长') >= 0, kindsOf(r));
});

testAsync('prompt 含控制字符 → 报控制字符', async () => {
  const root = sandboxAgent({ prompt: EXPECTED.slice(0, -1) + '\u0007' });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.ok(kindsOf(r).indexOf('控制字符') >= 0, kindsOf(r));
});

testAsync('派生漂移（prompt 与 description 清洗结果不等）→ 报漂移并给两侧长度', async () => {
  const root = sandboxAgent({ prompt: EXPECTED + ' 被手改过的一段' });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.ok(kindsOf(r).indexOf('派生漂移') >= 0, kindsOf(r));
});

testAsync('kilo.json 缺该 agent 条目 → 跳过不报（双向一致归 G1）', async () => {
  const root = sandboxAgent({ kiloText: JSON.stringify({ agent: { other: { prompt: EXPECTED } } }) });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'PASS');
  assert.equal(r.detail, 'checked=0');
});

testAsync('agent/ 或 kilo.json 缺失 → WARN 跳过（不假 FAIL，也不假 PASS）', async () => {
  const root = sandboxAgent({ kilo: false });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'WARN');
  assert.equal(r.detail, 'input missing');
});

testAsync('sanitize 模块不在位 → FAIL（不能退化成"没检查"）', async () => {
  const root = sandboxAgent({ prompt: EXPECTED, skipSanitize: true });
  const ctx = probeCtx(root);
  const r = await runPromptSync(ctx);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'sanitizer unloadable');
  assert.equal(ctx.results[0].level, 'FAIL');
});

testAsync('kilo.json 语法坏 → FAIL parse error', async () => {
  const root = sandboxAgent({ kiloText: '{ "agent": ' });
  const r = await runPromptSync(probeCtx(root));
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'kilo.json parse error');
});

testAsync('缺 ctx.cf → FAIL（门禁被绕过时不留静默通道）', async () => {
  const root = sandboxAgent({ prompt: EXPECTED });
  const r = await runPromptSync({ ROOT: root });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'ctx.cf 缺失');
});

// 同步占位：本文件全部用例走 testAsync，此处放一条同步断言确保 harness 的 SUMMARY 正常输出
test('prompt-sync 夹具已注册异步用例（漏 flush 会被 harness 判失败）', () => {
  assert.ok(sanitize.PROMPT_MAX_LEN > 100);
});

await flushAsyncTests();
