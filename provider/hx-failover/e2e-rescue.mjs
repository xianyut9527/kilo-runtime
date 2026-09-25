// E2E 验收：真实上游死亡 → reasoningGate 自动扩预算重试 → 救活
// 路径 = 部署同款 dist（install.ps1 已校验新鲜度并下发）；网络 = 真实 new-api:9527
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'kilo', 'auth.json'), 'utf8')).hx.key;

const { createHxFailover } = await import(new URL('./dist/index.js', import.meta.url).href);

const calls = [];
const countingFetch = async (url, init) => {
  const mt = JSON.parse(init.body).max_tokens;
  calls.push(mt);
  console.error(`[e2e] call#${calls.length} max_tokens=${mt} -> ${String(url)}`);
  return globalThis.fetch(url, init);
};

const provider = createHxFailover({
  name: 'hx',
  baseURL: 'http://127.0.0.1:9527/v1',
  apiKey: KEY,
  fetch: countingFetch,
  failover: { chain: { models: [] } }, // 隔离：只测门控，不混入降级链
  reasoningEcho: true,
  reasoningGate: true,
});

const t0 = Date.now();
try {
  const result = await Promise.race([
    provider.languageModel('kimi-k2.6').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: '用一句话说明什么是二分查找' }] }],
      maxOutputTokens: 2048, // kilo 死亡形态预算（探针实证：kimi 此预算必死）
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('E2E 超时 300s')), 300_000)),
  ]);
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const fr = typeof result.finishReason === 'object' ? result.finishReason?.type : result.finishReason; // v3 spec: {type:'stop'}
  console.error(`\n[e2e] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，调用 ${calls.length} 次（预算序列: ${calls.join(' -> ')}）`);
  console.error(`[e2e] finishReason=${fr} 正文=${JSON.stringify(text.slice(0, 120))}`);
  // 注意：2048 预算死亡是概率事件（思考短则幸存）——单发未死不算失败，等价于门控无需介入
  if (calls.length === 1 && text.length > 0) {
    console.log('E2E-SKIP: 本次思考未超预算（无死亡），门控正确地未介入；重试路径见 test-reasoning-gate.mjs 单测');
  } else {
    const rescued = calls.length === 2 && calls[1] >= 32768 && text.length > 0 && fr === 'stop';
    console.log(rescued ? 'E2E-PASS: 死亡被门控救活（重试扩预算后拿到正文）' : 'E2E-FAIL: 未达验收条件');
    process.exitCode = rescued ? 0 : 1;
  }
} catch (e) {
  console.error(`[e2e] 异常: ${e?.message ?? e}`);
  console.log('E2E-FAIL: 异常路径');
  process.exitCode = 1;
}
