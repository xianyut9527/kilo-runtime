#!/usr/bin/env node
// config-validate.mjs
// 统一配置校验入口：JSON Schema + lifecycle-doctor + agent prompt drift + meta-audit摘要

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`[CONFIG_SCHEMA_FAIL] ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[CONFIG_SCHEMA_WARN] ${msg}`);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = e.stdout ? String(e.stdout) : '';
    const err = e.stderr ? String(e.stderr) : '';
    return `${msg}\n${err}\nexit=${e.status}`;
  }
}

async function validateJsonSchema() {
  let Ajv;
  try {
    const mod = await import('ajv');
    Ajv = mod.default;
  } catch {
    warn('ajv not installed; JSON Schema validation skipped. Run `npm install ajv` to enable.');
    return true;
  }
  const schemaPath = path.join(ROOT, 'kilo.schema.json');
  const configPath = path.join(ROOT, 'kilo.json');
  if (!fs.existsSync(schemaPath)) {
    warn('kilo.schema.json not found');
    return true;
  }
  if (!fs.existsSync(configPath)) fail('kilo.json not found');

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(config);
  if (!ok) {
    for (const err of validate.errors) {
      const p = err.instancePath || '/';
      fail(`schema validation error at ${p}: ${err.message}`);
    }
  }
  console.log('[OK] kilo.json 通过 JSON Schema 校验');
  return true;
}

async function validateLifecycleDoctor() {
  try {
    const out = run('node scripts/lifecycle-doctor.mjs');
    console.log(out);
    const summary = out.match(/SUMMARY:\s*(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/);
    if (!summary) {
      console.error(out);
      fail('lifecycle-doctor 输出异常');
    }
    const failCount = parseInt(summary[2], 10);
    if (failCount > 0) {
      fail(`lifecycle-doctor 装配校验失败：${failCount} FAIL`);
    }
  } catch (e) {
    fail(`lifecycle-doctor 执行异常: ${e.message}`);
  }
  console.log('[OK] lifecycle-doctor 通过');
}

function validatePromptDrift() {
  const out = run('node scripts/sync-agent-prompt.mjs --check');
  if (out.includes('drift=') && !out.includes('drift=0')) {
    console.error(out);
    fail('检测到 agent prompt drift');
  }
  console.log('[OK] agent prompt 无 drift');
}

function validateOrchestrationGuard() {
  const out = run('node scripts/orchestration-guard.mjs --strict');
  const combined = (out || '');
  if (combined.includes('[ORCHESTRATION_BYPASS]')) {
    console.error(combined.trim());
    fail('检测到编排绕过：governance 文件变更未经 conductor 调度');
  }
  // 非零退出码（非 [ORCHESTRATION_BYPASS] 场景，如 git 异常）
  const exitMatch = combined.match(/^exit=(\d+)$/m);
  if (exitMatch && parseInt(exitMatch[1], 10) !== 0) {
    console.error(combined.trim());
    fail('orchestration-guard 执行异常');
  }
  console.log('[OK] orchestration guard 通过');
}

async function main() {
  console.log('========================================');
  console.log('  Kilo Config Validation');
  console.log('========================================\n');

  await validateJsonSchema();
  validateLifecycleDoctor();
  validatePromptDrift();
  validateOrchestrationGuard();

  console.log('\n[ALL OK] 配置校验全部通过');
}

main();
