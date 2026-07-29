import fs from 'node:fs';
import path from 'node:path';

const issues = [];

// === 1. kilo.json 结构完整性 ===
const kilo = JSON.parse(fs.readFileSync('kilo.json', 'utf8'));

if (!kilo.$schema) issues.push({file:'kilo.json',issue:'缺少 $schema 字段'});
if (!kilo.model) issues.push({file:'kilo.json',issue:'缺少 model 字段（default model）'});
if (!kilo.small_model) issues.push({file:'kilo.json',issue:'缺少 small_model 字段'});
if (!kilo.default_agent) issues.push({file:'kilo.json',issue:'缺少 default_agent 字段'});
if (!kilo.snapshot) issues.push({file:'kilo.json',issue:'缺少 snapshot 字段'});
if (!kilo.compaction) issues.push({file:'kilo.json',issue:'缺少 compaction 字段'});
if (!kilo.agent) issues.push({file:'kilo.json',issue:'缺少 agent 字段'});
if (!kilo.skills) issues.push({file:'kilo.json',issue:'缺少 skills 字段'});
if (!kilo.permission) issues.push({file:'kilo.json',issue:'缺少 permission 字段'});
if (!kilo.mcp) issues.push({file:'kilo.json',issue:'缺少 mcp 字段'});
if (!kilo.provider) issues.push({file:'kilo.json',issue:'缺少 provider 字段'});

// Check agent.prompt lengths - too short means pointer style (bad)
for (const [name, cfg] of Object.entries(kilo.agent || {})) {
  const len = cfg.prompt?.length || 0;
  if (len < 200) issues.push({file:'kilo.json',issue:`agent.${name}.prompt 过短(${len})，可能是指针式风格，容易在compaction后丢失规则`});
}

// Check for KILO_CONFIG_DIR in primary agent prompts
for (const [name, cfg] of Object.entries(kilo.agent || {})) {
  if (cfg.mode === 'primary' && !cfg.prompt?.includes('${KILO_CONFIG_DIR}')) {
    issues.push({file:'kilo.json',issue:`primary agent ${name} prompt 缺少 \${KILO_CONFIG_DIR} 占位符，脚本路径在其他项目会失效`});
  }
}

// Check provider.hx key existence
if (!kilo.provider?.hx) issues.push({file:'kilo.json',issue:'缺少 provider.hx 配置'});

// === 2. agent/*.md 一致性 ===
const agentDir = 'agent';
const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.md'));

for (const f of files) {
  const name = f.replace('.md', '');
  const content = fs.readFileSync(path.join(agentDir, f), 'utf8');
  
  // Check frontmatter exists
  if (!content.startsWith('---')) {
    issues.push({file:`agent/${f}`,issue:'缺少 YAML frontmatter'});
    continue;
  }
  
  // Check kilo.json binding
  if (!kilo.agent[name]) {
    issues.push({file:`agent/${f}`,issue:`未在 kilo.json agent.${name} 绑定模型`});
  }
  
  // Check description
  if (!/description:/.test(content)) {
    issues.push({file:`agent/${f}`,issue:'缺少 description 字段'});
  }
  
  // Check mode
  if (!/mode:/.test(content)) {
    issues.push({file:`agent/${f}`,issue:'缺少 mode 字段'});
  }
  
  // Check permission
  if (!/permission:/.test(content)) {
    issues.push({file:`agent/${f}`,issue:'缺少 permission 字段'});
  }
  
  // Primary agents should NOT have subagent_type or mount
  const modeMatch = content.match(/mode:\s*(\S+)/);
  if (modeMatch) {
    const mode = modeMatch[1];
    if (mode === 'primary' || mode === 'lifecycle_provider') {
      if (/subagent_type:/.test(content)) issues.push({file:`agent/${f}`,issue:'primary agent 不应声明 subagent_type'});
      if (/mount:/.test(content)) issues.push({file:`agent/${f}`,issue:'primary agent 不应声明 mount'});
    } else {
      // subagent should have subagent_type
      if (!/subagent_type:/.test(content)) issues.push({file:`agent/${f}`,issue:'subagent 缺少 subagent_type 字段'});
      // subagent should have mount
      if (!/mount:/.test(content)) issues.push({file:`agent/${f}`,issue:'subagent 缺少 mount 字段'});
    }
  }
  
  // Check for hardcoded model IDs (anti-pattern per single-source-of-truth)
  const modelMatches = content.match(/hx\/(MiniMax|kimi|glm|deepseek)[\w.-]+/g);
  if (modelMatches) {
    issues.push({file:`agent/${f}`,issue:`硬编码模型ID: ${[...new Set(modelMatches)].join(', ')} —— 应仅在 kilo.json 声明`});
  }
}

// === 3. lifecycle/ 结构 ===
const requiredLifecycle = ['graph.yaml', 'config.yaml', 'multimodel-graph.yaml', 'stages/intent.md', 'stages/sizing.md', 'stages/planning.md', 'stages/executing.md', 'stages/quality.md', 'stages/delivering.md'];
for (const f of requiredLifecycle) {
  if (!fs.existsSync(path.join('lifecycle', f))) {
    issues.push({file:`lifecycle/${f}`,issue:'文件缺失'});
  }
}

// === 4. scripts/ 结构 ===
const requiredScripts = ['lifecycle-doctor.mjs', 'task-context.mjs', 'transition-check.mjs', 'memory.py'];
for (const f of requiredScripts) {
  if (!fs.existsSync(path.join('scripts', f))) {
    issues.push({file:`scripts/${f}`,issue:'脚本缺失'});
  }
}

// === 5. AGENTS.md 存在 ===
if (!fs.existsSync('AGENTS.md')) {
  issues.push({file:'AGENTS.md',issue:'全局指令入口文件缺失'});
}

// === 6. docs/ 关键文档 ===
if (!fs.existsSync('docs/model-registry.md')) {
  issues.push({file:'docs/model-registry.md',issue:'模型能力参考文档缺失'});
}

// === Output ===
console.log(`=== 通用 KiloCode 配置审计结果 (${issues.length} 个问题) ===\n`);

const critical = issues.filter(i => i.issue.includes('缺失') || i.issue.includes('primary agent') || i.issue.includes('脚本路径'));
const warnings = issues.filter(i => !i.issue.includes('缺失') && !i.issue.includes('primary agent') && !i.issue.includes('脚本路径'));

if (critical.length) {
  console.log('【严重问题】');
  for (const i of critical) console.log(`  ${i.file}: ${i.issue}`);
  console.log();
}

if (warnings.length) {
  console.log('【警告/建议】');
  for (const i of warnings) console.log(`  ${i.file}: ${i.issue}`);
  console.log();
}

if (!issues.length) {
  console.log('✅ 未发现配置问题');
} else {
  console.log(`总计: ${critical.length} 严重 / ${warnings.length} 警告`);
}
