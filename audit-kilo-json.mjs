import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync('kilo.json', 'utf8'));

console.log('=== Schema & Structure ===');
console.log('$schema:', j.$schema ? 'OK' : 'MISSING');
console.log('default_agent:', j.default_agent);
console.log('snapshot:', j.snapshot);

console.log('\n=== Compaction ===');
console.log(JSON.stringify(j.compaction, null, 2));

console.log('\n=== Agents ===');
for (const [name, cfg] of Object.entries(j.agent || {})) {
  const promptLen = cfg.prompt ? cfg.prompt.length : 0;
  console.log(`${name.padEnd(20)} mode=${cfg.mode} model=${cfg.model} prompt=${promptLen}`);
  if (cfg.permission) console.log(`  permission: ${JSON.stringify(cfg.permission)}`);
}

console.log('\n=== Skills Paths ===');
console.log(JSON.stringify(j.skills?.paths || [], null, 2));

console.log('\n=== MCP ===');
for (const [k, v] of Object.entries(j.mcp || {})) {
  console.log(`${k}: enabled=${v.enabled} type=${v.type}`);
}

console.log('\n=== Provider Models ===');
const hx = j.provider?.hx?.models || {};
for (const [k, v] of Object.entries(hx)) {
  console.log(`${k}: context=${v.limit?.context} output=${v.limit?.output}`);
}

console.log('\n=== Missing Top-Level Keys ===');
const required = ['model','small_model','default_agent','snapshot','compaction','agent','skills','permission','mcp','provider'];
for (const r of required) {
  if (!j[r]) console.log('MISSING:', r);
}

console.log('\n=== Potential Issues ===');
// Check for agents without prompts
for (const [name, cfg] of Object.entries(j.agent || {})) {
  if (!cfg.prompt) console.log(`ISSUE: ${name} has no prompt`);
}
// Check prompt lengths
for (const [name, cfg] of Object.entries(j.agent || {})) {
  const len = cfg.prompt?.length || 0;
  if (len < 50) console.log(`WARN: ${name} prompt very short (${len})`);
  if (len > 2000) console.log(`WARN: ${name} prompt very long (${len})`);
}
// Check for KILO_CONFIG_DIR placeholder in prompts
for (const [name, cfg] of Object.entries(j.agent || {})) {
  if (cfg.prompt?.includes('${KILO_CONFIG_DIR}')) {
    console.log(`OK: ${name} prompt has KILO_CONFIG_DIR placeholder`);
  }
}
// Check for duplicate model bindings
const modelCounts = {};
for (const cfg of Object.values(j.agent || {})) {
  modelCounts[cfg.model] = (modelCounts[cfg.model] || 0) + 1;
}
for (const [m, c] of Object.entries(modelCounts)) {
  if (c > 1) console.log(`INFO: ${c} agents use model ${m}`);
}

console.log('\n=== Done ===');
