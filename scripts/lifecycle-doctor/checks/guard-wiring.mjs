// checks/guard-wiring.mjs
// E. timeouts 守卫接线校验：agent-timeout-guard.mjs 存在 + config.yaml timeouts 段已接线
// 目的：防止 config.timeouts 成为"死配置"（无消费方 / 无守卫脚本接线）

import fs from 'node:fs';
import path from 'node:path';

export function run(ctx) {
  const { cf, cfgText, SCRIPTS_DIR } = ctx;
  const checkName = 'config.timeouts.guard_wired';

  // E1. scripts/agent-timeout-guard.mjs 存在
  const guardPath = path.join(SCRIPTS_DIR, 'agent-timeout-guard.mjs');
  const guardExists = fs.existsSync(guardPath);
  if (guardExists) {
    cf.pass(`${checkName}.guard_script`, 'scripts/agent-timeout-guard.mjs 存在');
  } else {
    cf.fail(`${checkName}.guard_script`, 'scripts/agent-timeout-guard.mjs 缺失（timeouts 段消费方不存在）');
  }

  // E2. config.yaml timeouts 段关键键已接线
  const text = cfgText || '';
  const required = [
    'agent_startup_s',
    'stage_default_s',
    'per_agent_s',
    'per_tier_multiplier',
  ];
  const hasTimeoutsSection = /^timeouts\s*:/m.test(text);
  if (!hasTimeoutsSection) {
    cf.fail(`${checkName}.section`, 'lifecycle/config.yaml 缺 timeouts 顶层段');
  } else {
    cf.pass(`${checkName}.section`, 'lifecycle/config.yaml timeouts 顶层段存在');
  }

  // per_agent_s 至少含 coder/verifier 等键（非空）
  const perAgentBlock = text.match(/per_agent_s\s*:[\s\S]*?(?=\n\S|\n\s{2}\S*\s*:)/);
  const perAgentKeys = perAgentBlock ? [...perAgentBlock[0].matchAll(/^\s{4}(\w+)\s*:\s*\d+/gm)].map((m) => m[1]) : [];
  if (perAgentKeys.length > 0) {
    cf.pass(`${checkName}.per_agent_s`, `per_agent_s 键: ${perAgentKeys.join(', ')}`);
  } else {
    cf.fail(`${checkName}.per_agent_s`, 'timeouts.per_agent_s 缺失或无键');
  }

  // per_tier_multiplier 非空
  const multBlock = text.match(/per_tier_multiplier\s*:[\s\S]*?(?=\n\S|\n\s{2}\S*\s*:)/);
  const multKeys = multBlock ? [...multBlock[0].matchAll(/^\s{4}(\w+)\s*:\s*([\d.]+)/gm)].map((m) => m[1]) : [];
  if (multKeys.length > 0) {
    cf.pass(`${checkName}.per_tier_multiplier`, `per_tier_multiplier 键: ${multKeys.join(', ')}`);
  } else {
    cf.fail(`${checkName}.per_tier_multiplier`, 'timeouts.per_tier_multiplier 缺失或无键');
  }

  // retry.agent_timeout_max_retries 存在
  if (/agent_timeout_max_retries\s*:\s*\d+/.test(text)) {
    cf.pass(`${checkName}.retry_max_retries`, 'timeouts.retry.agent_timeout_max_retries 存在');
  } else {
    cf.fail(`${checkName}.retry_max_retries`, 'timeouts.retry.agent_timeout_max_retries 缺失');
  }

  for (const key of required) {
    if (!new RegExp(`${key}\\s*:`).test(text)) {
      cf.fail(`${checkName}.key.${key}`, `timeouts 缺键 "${key}"`);
    }
  }
}
