// checks/matrix-docs-kilojson-scripts.mjs
// E. 权限矩阵校验 + F. stages 正文硬编码检测 + G. kilo.json 自检 + H. 脚本完整性门禁
// 拆分自 scripts/lifecycle-doctor.mjs L1890-2109

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { extractFrontmatter, parseStageFrontmatter, parseKiloJson, readText } from '../lib/parse.mjs';

export function run(ctx) {
  const { cf, agents, ROOT, STAGES_DIR, AGENT_DIR, KILO_JSON_PATH } = ctx;

  // ============================================================
  // E. 权限矩阵校验
  // ============================================================
  // E1. conductor.md 人类速查矩阵表与 frontmatter 派生一致
  {
    const conductorText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
    const rows = conductorText.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\|[^|]+\|[^|]*\|[^|]*\|[^|]*\|$/.test(l) && !/^\|[\s:-]+\|/.test(l));
    let checked = 0;
    let drift = 0;
    for (const row of rows) {
      const parts = row.split('|').slice(1, -1).map((s) => s.trim());
      if (parts.length < 3) continue;
      const name = parts[0];
      if (!agents.has(name)) continue;
      const writeCell = parts[2];
      if (!writeCell || writeCell === '—' || writeCell === '全部') continue;
      const tableWrites = writeCell.split(',').map((s) => s.trim()).filter(Boolean);
      const fmWrites = (agents.get(name)?.writes ?? []).slice().sort();
      const tableSorted = tableWrites.slice().sort();
      checked++;
      if (JSON.stringify(tableSorted) !== JSON.stringify(fmWrites)) {
        drift++;
        cf.fail('matrix.drift', `${name}: 表=[${tableSorted.join(', ')}] vs frontmatter=[${fmWrites.join(', ')}]`);
      }
    }
    if (drift === 0 && checked > 0) cf.pass('matrix.drift', `${checked} 个智能体矩阵表与 frontmatter 一致`);
    if (checked === 0) {
      if (/matrix-table:\s*none/.test(conductorText)) {
        cf.pass('matrix.drift', '矩阵表经声明显式省略（matrix-table: none），frontmatter 为单一真相');
      } else {
        cf.warn('matrix.drift', 'conductor.md 未找到可校验的矩阵表行（格式应为 | name | read | w1, w2 | forbid |）');
      }
    }
  }

  // ============================================================
  // F. stages 正文硬编码智能体名检测
  // ============================================================
  const FRAMEWORK_NAMES = new Set(['conductor']);
  {
    const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
    let driftFound = 0;
    for (const file of stageFiles) {
      const filePath = path.join(STAGES_DIR, file);
      const text = readText(filePath) ?? '';
      const fm = extractFrontmatter(text);
      const roles = fm ? parseStageFrontmatter(fm) : [];
      const allowedInBody = new Set([...roles, ...FRAMEWORK_NAMES]);
      let cleaned = text.replace(/^---[\s\S]*?---/, '');
      cleaned = cleaned
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '');
      for (const [name] of agents) {
        if (allowedInBody.has(name)) continue;
        const regex = new RegExp(`(?<!\/)\\b${name.replace(/-/g, '[-_]')}\\b`, 'g');
        const hits = [...cleaned.matchAll(regex)];
        if (hits.length > 0) {
          driftFound++;
          cf.fail('doc.drift', `${file}: 正文硬编码智能体名 "${name}"（应改用角色语义）`);
        }
      }
    }
    if (driftFound === 0) cf.pass('doc.drift', `${stageFiles.length} 个 stage 文件正文无硬编码可选智能体名`);
  }

  // ============================================================
  // G. kilo.json 智能体配置自检
  // ============================================================
  const kjText = readText(KILO_JSON_PATH);
  let kj = null;
  if (kjText) {
    try {
      kj = parseKiloJson(kjText);
      cf.pass('kilojson.parse', 'kilo.json 可解析');
    } catch (e) {
      cf.fail('kilojson.parse', `kilo.json 解析失败: ${e.message}`);
    }
  } else {
    cf.fail('kilojson.parse', `kilo.json 缺失: ${KILO_JSON_PATH}`);
  }

  if (kj) {
    const KJ_MODES = new Set(['primary', 'subagent', 'standby']);
    // G1. agent 条目 ↔ agent/*.md 双向一致
    {
      const mdNames = new Set(agents.keys());
      const kjNames = new Set(kj.agents.keys());
      let orphanKj = 0, orphanMd = 0;
      for (const name of kjNames) {
        if (!mdNames.has(name)) {
          orphanKj++;
          cf.fail('kilojson.agent.md', `kilo.json agent.${name} 无对应 agent/${name}.md 文件`);
        }
      }
      for (const name of mdNames) {
        if (!kjNames.has(name)) {
          orphanMd++;
          cf.fail('kilojson.agent.md', `agent/${name}.md 存在但 kilo.json agent.${name} 未声明`);
        }
      }
      if (orphanKj === 0 && orphanMd === 0) cf.pass('kilojson.agent.md', `${kjNames.size} 个 agent 双向一致`);
    }
    // G2. model 合法性
    {
      let bad = 0;
      for (const [name, cfg] of kj.agents) {
        if (cfg.model && !kj.models.has(cfg.model)) {
          bad++;
          cf.fail('kilojson.agent.model', `agent.${name}.model="${cfg.model}" 不在 provider.models 中`);
        }
      }
      if (bad === 0) cf.pass('kilojson.agent.model', `全部 agent model 合法（${kj.agents.size} 个）`);
    }
    // G3. mode 取值集
    {
      let bad = 0;
      for (const [name, cfg] of kj.agents) {
        if (cfg.mode && !KJ_MODES.has(cfg.mode)) {
          bad++;
          cf.fail('kilojson.agent.mode', `agent.${name}.mode="${cfg.mode}" ∉ {${[...KJ_MODES].join(',')}}`);
        }
      }
      if (!bad) cf.pass('kilojson.agent.mode', '全部 agent mode 合法');
    }
    // G4. default_agent 指向存在性
    if (kj.defaultAgent) {
      if (kj.agents.has(kj.defaultAgent)) {
        cf.pass('kilojson.default_agent', `default_agent="${kj.defaultAgent}" 存在`);
      } else {
        cf.fail('kilojson.default_agent', `default_agent="${kj.defaultAgent}" 未在 agent 中声明`);
      }
    } else {
      cf.warn('kilojson.default_agent', 'default_agent 未设置');
    }
  }

  // ============================================================
  // H. 脚本完整性门禁
  // ============================================================

  // H1. scripts/*.mjs + scripts/lib/*.mjs 全部通过 node --check
  {
    const scriptFiles = [];
    for (const dir of ['scripts', 'scripts/lib']) {
      const abs = path.join(ROOT, dir);
      let names = [];
      try { names = fs.readdirSync(abs); } catch { continue; }
      for (const n of names) {
        if (n.endsWith('.mjs')) scriptFiles.push(path.join(abs, n));
      }
    }
    let bad = 0;
    for (const f of scriptFiles) {
      const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) { bad++; cf.fail('scripts.syntax', `${path.relative(ROOT, f)}: ${(r.stderr || r.stdout || 'check failed').trim().split('\n')[0]}`); }
    }
    if (bad === 0) cf.pass('scripts.syntax', `${scriptFiles.length} 个脚本全部通过 node --check`);
  }

  // H2. 库脚本动态 import 冒烟
  {
    const libFiles = [];
    try { for (const n of fs.readdirSync(path.join(ROOT, 'scripts/lib'))) { if (n.endsWith('.mjs')) libFiles.push(path.join(ROOT, 'scripts/lib', n)); } } catch {}
    let bad = 0;
    for (const f of libFiles) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('file:///${f.replace(/\\/g, '/')}')`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) { bad++; cf.fail('scripts.modules', `${path.relative(ROOT, f)}: ${(r.stderr || r.stdout || 'load failed').trim().split('\n')[0]}`); }
    }
    if (bad === 0) cf.pass('scripts.modules', `${libFiles.length} 个 lib 模块动态加载冒烟 PASS`);
  }

  // H3. 搜索纪律机械门完整性
  {
    const sdcPath = path.join(ROOT, 'scripts', 'search-discipline-check.mjs');
    const qmPath  = path.join(ROOT, 'lifecycle', 'stages', 'quality.md');
    if (!fs.existsSync(sdcPath)) {
      cf.fail('search-discipline.script', 'scripts/search-discipline-check.mjs 不存在');
    } else {
      const rc = spawnSync(process.execPath, ['--check', sdcPath], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
      if (rc.status !== 0) {
        cf.fail('search-discipline.syntax', `search-discipline-check.mjs: ${(rc.stderr || rc.stdout || 'check failed').trim().split('\n')[0]}`);
      } else {
        const src = fs.readFileSync(sdcPath, 'utf8');
        const fnHits = (src.match(/^function detect/gm) || []).length;
        if (fnHits < 4) {
          cf.fail('search-discipline.detectors', `detect 函数注册数=${fnHits}，期望 >=4`);
        } else if (!fs.existsSync(qmPath)) {
          cf.fail('search-discipline.wiring', 'lifecycle/stages/quality.md 不存在，无法校验机械前置门引用');
        } else {
          const qm = fs.readFileSync(qmPath, 'utf8');
          if (!/search-discipline-check\.mjs/.test(qm)) {
            cf.fail('search-discipline.wiring', 'lifecycle/stages/quality.md 机械前置门段未引用 search-discipline-check.mjs');
          } else {
            cf.pass('search-discipline.script', `search-discipline-check.mjs 存在 + 语法 OK + ${fnHits} 个 detect 函数齐 + quality.md 已接线`);
          }
        }
      }
    }
  }
}
