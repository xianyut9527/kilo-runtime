import fs from 'node:fs';
import path from 'node:path';

const agentDir = 'agent';
const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.md'));

console.log('=== Agent Frontmatter Audit ===\n');

for (const f of files) {
  const content = fs.readFileSync(path.join(agentDir, f), 'utf8');
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  
  console.log(`--- ${f} ---`);
  
  if (!frontmatter) {
    console.log('  NO FRONTMATTER');
    continue;
  }
  
  const fm = frontmatter[1];
  
  // Check key fields
  const hasDesc = /description:/.test(fm);
  const hasMode = /mode:/.test(fm);
  const hasHidden = /hidden:/.test(fm);
  const isPrimary = /mode:\s*primary/.test(fm) || /mode:\s*lifecycle_provider/.test(fm);
  const hasSubagentType = isPrimary ? 'N/A' : (/subagent_type:/.test(fm) ? 'OK' : 'MISSING');
  const hasMount = isPrimary ? 'N/A' : (/mount:/.test(fm) ? 'OK' : 'MISSING');
  const hasTaskContext = /task_context:/.test(fm);
  const hasPermission = /permission:/.test(fm);
  
  console.log(`  description: ${hasDesc ? 'OK' : 'MISSING'}`);
  console.log(`  mode: ${hasMode ? 'OK' : 'MISSING'}`);
  console.log(`  hidden: ${hasHidden ? 'OK' : 'MISSING'}`);
  console.log(`  subagent_type: ${hasSubagentType}`);
  console.log(`  mount: ${hasMount}`);
  console.log(`  task_context: ${hasTaskContext ? 'OK' : 'MISSING'}`);
  console.log(`  permission: ${hasPermission ? 'OK' : 'MISSING'}`);
  
  // Check for frontmatter in kilo.json - key is filename without .md (kebab-case)
  const agentName = f.replace('.md', '');
  const kilo = JSON.parse(fs.readFileSync('kilo.json', 'utf8'));
  const cfg = kilo.agent[agentName];
  
  if (!cfg) {
    console.log(`  kilo.json: MISSING config for ${agentName}`);
  } else {
    console.log(`  kilo.json: model=${cfg.model} mode=${cfg.mode}`);
  }
  
  console.log();
}
