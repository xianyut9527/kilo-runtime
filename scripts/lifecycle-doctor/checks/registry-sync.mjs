/**
 * registry-sync.mjs — lifecycle-doctor check (DEPRECATED)
 *
 * 已从 doctor 移除：模型 SSOT 已收敛到 kilo.json，docs/model-registry.md 降级为纯人类参考，
 * 不再机械校验。run() 直接返回 PASS，仅供历史引用不悬空；即使用户手动 import 也不会 FAIL。
 */
export function run(ctx) {
  if (ctx.cf) ctx.cf.pass('registry-sync.wiring', 'deprecated: removed from doctor; model SSOT = kilo.json');
}