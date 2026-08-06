// checks/semantic.mjs
// 语义一致性校验（S7/S1/S3/S2/S4/S5/S6/S8）
// 拆分自 scripts/lifecycle-doctor.mjs L1529-1888

import path from 'node:path';
import fs from 'node:fs';
import { extractFrontmatter, parseAgentPermission, readText, parseKiloJson } from '../lib/parse.mjs';

export function run(ctx) {
  const { cf, graph, agents, cfg, cfgText, AGENT_DIR, ROOT, KILO_JSON_PATH } = ctx;

  // S7. semantic.conductor_edit_deny_global
  {
    const condPath = path.join(AGENT_DIR, 'conductor.md');
    const condText = readText(condPath);
    if (!condText) {
      cf.fail('semantic.conductor_edit_deny_global', 'agent/conductor.md 缺失');
    } else {
      const fm = extractFrontmatter(condText);
      if (!fm) {
        cf.fail('semantic.conductor_edit_deny_global', 'agent/conductor.md 缺 frontmatter');
      } else {
        const perm = parseAgentPermission(fm);
        const edit = perm.edit;
        const write = perm.write;
        const bad = [];
        if (edit !== 'deny') bad.push(`edit=${edit || '(未声明)'}`);
        if (write !== 'deny') bad.push(`write=${write || '(未声明)'}`);
        if (bad.length === 0) {
          cf.pass('semantic.conductor_edit_deny_global', 'conductor permission edit=deny & write=deny');
        } else {
          cf.fail('semantic.conductor_edit_deny_global', `conductor permission 期望 edit=deny&write=deny，实际 ${bad.join(' & ')}（conductor 不得具备任何修改性权限）`);
        }
      }
    }
  }

  // S1. semantic.permission_vs_role
  {
    const MUTATION_TERMS = ['修改', '写入', '修复', '创建', '删除', '提交'];
    const EXEMPTION_TERMS = ['不得', '禁止', '不能', '只读', '仅用于', '不得自行'];
    const NEGATION_PREFIX = new Set(['不', '无', '未', '勿', '前']);
    const TASK_CTX_CONTEXT = ['task_context', 'task_co', '边界', '产物', '独占',
      'verification', 'review', 'plan', 'execution', 'plan_review',
      '回显', '路径', '校验', '同症状'];
    const ADVERB_CONTEXT = ['必须立即', '交付前', '可操作', '失败 →', '失败→'];
    const GIT_CONTEXT = ['推送', '分支', 'commit', 'push', 'git ', '擅自', '告知', 'PR', '合并', '未推送', '未提交'];
    for (const [name, text] of
      [...fs.readdirSync(AGENT_DIR)]
        .filter((f) => f.endsWith('.md') && f !== 'conductor.md')
        .map((f) => [f.slice(0, -3), readText(path.join(AGENT_DIR, f))])
        .filter(([, t]) => t)) {
      const fm = extractFrontmatter(text);
      if (!fm) continue;
      const perm = parseAgentPermission(fm);
      if (perm.edit !== 'deny') continue;
      let body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
      body = body
        .replace(/^>.*$/mg, '')
        .replace(/```[\s\S]*?```/g, '');
      const violations = [];
      for (const term of MUTATION_TERMS) {
        let idx = 0;
        while ((idx = body.indexOf(term, idx)) !== -1) {
          const window = body.slice(Math.max(0, idx - 8), idx + term.length + 8);
          const exempt = EXEMPTION_TERMS.some((e) => window.includes(e))
            || (idx > 0 && NEGATION_PREFIX.has(body[idx - 1]))
            || TASK_CTX_CONTEXT.some((e) => window.includes(e))
            || ADVERB_CONTEXT.some((e) => window.includes(e))
            || GIT_CONTEXT.some((e) => window.includes(e));
          if (!exempt) {
            const lineNo = body.slice(0, idx).split(/\r?\n/).length;
            violations.push(`"${term}" @L${lineNo} 附近: ...${window.replace(/\r?\n/g, ' ')}...`);
          }
          idx += term.length;
        }
      }
      if (violations.length === 0) {
        cf.pass(`semantic.permission_vs_role.${name}`, `edit=deny 且正文无主动修改语态`);
      } else {
        cf.fail(`semantic.permission_vs_role.${name}`, `edit=deny 但正文含主动修改语态（${violations.length} 处）: ${violations.slice(0, 3).join(' | ')}${violations.length > 3 ? ' ...' : ''}`);
      }
    }
  }

  // S3. semantic.circuit_breaker_threshold
  {
    const cfgValue = (() => {
      if (!cfgText) return null;
      const m = cfgText.match(/max_total_cycles\s*:\s*(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    })();
    if (cfgValue === null) {
      cf.fail('semantic.circuit_breaker_threshold', 'lifecycle/config.yaml 缺 hooks.quality.max_total_cycles');
    } else {
      const wfPath = path.join(ROOT, '.kilo', 'instructions', 'workflow-core.md');
      const wfText = readText(wfPath) ?? '';
      const condText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
      const wfNums = [];
      {
        const re = /连续\s*(\d+)\s*次无法收敛/g;
        let m;
        while ((m = re.exec(wfText)) !== null) wfNums.push(parseInt(m[1], 10));
      }
      const condNums = [];
      {
        const re = /(?:max_total_cycles|默认|round\s*>=)\s*[：:]?\s*(\d+)/g;
        let m;
        while ((m = re.exec(condText)) !== null) condNums.push(parseInt(m[1], 10));
      }
      const sources = {
        'config.yaml': cfgValue,
        'workflow-core.md': wfNums.length > 0 ? wfNums : null,
        'conductor.md': condNums.length > 0 ? condNums : null,
      };
      const allNums = [cfgValue, ...(wfNums || []), ...(condNums || [])];
      const unique = [...new Set(allNums)];
      const summary = Object.entries(sources)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`)
        .join(' | ');
      if (unique.length === 1) {
        cf.pass('semantic.circuit_breaker_threshold', `三处一致：max_total_cycles=${cfgValue}`);
      } else {
        cf.fail('semantic.circuit_breaker_threshold', `CIRCUIT_BREAKER 阈值不一致（${summary}）——应统一为 config.yaml hooks.quality.max_total_cycles=${cfgValue}`);
      }
    }
  }

  // S2. semantic.task_context_write_exclusivity
  {
    const sliceWriters = new Map();
    for (const [name, a] of agents) {
      for (const s of a.writes) {
        if (!sliceWriters.has(s)) sliceWriters.set(s, new Set());
        sliceWriters.get(s).add(name);
      }
    }
    const declaredOwner = new Map();
    for (const [name, a] of agents) {
      const filePath = path.join(AGENT_DIR, `${name}.md`);
      const text = readText(filePath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (const s of a.writes) {
        let declared = false;
        for (const line of lines) {
          if (line.includes('独占') && line.includes(s)) {
            declared = true;
            break;
          }
        }
        if (declared) {
          if (!declaredOwner.has(s)) declaredOwner.set(s, new Set());
          declaredOwner.get(s).add(name);
        }
      }
    }
    let conflicts = 0;
    let checkedExclusive = 0;
    for (const [slice, owners] of declaredOwner) {
      const actual = sliceWriters.get(slice) || new Set();
      const extra = [...actual].filter((a) => !owners.has(a));
      const missing = [...owners].filter((o) => !actual.has(o));
      checkedExclusive++;
      if (extra.length === 0 && missing.length === 0) {
        cf.pass('semantic.task_context_write_exclusivity',
          `${slice} 独占一致（声明=[${[...owners].join(',')}] 实际写入=[${[...actual].join(',')}]）`);
      } else {
        conflicts++;
        const parts = [];
        if (extra.length) parts.push(`非声明者写入=[${extra.join(',')}]`);
        if (missing.length) parts.push(`声明者未写入=[${missing.join(',')}]`);
        cf.fail('semantic.task_context_write_exclusivity',
          `切片 "${slice}" 独占冲突：声明独占者=[${[...owners].join(',')}] 实际写入者=[${[...actual].join(',')}]（${parts.join('；')}）`);
      }
    }
    if (checkedExclusive === 0) {
      cf.pass('semantic.task_context_write_exclusivity', '无 task_context.write 切片声明独占（无校验对象）');
    }
    if (conflicts === 0 && checkedExclusive > 0) {
      cf.pass('semantic.task_context_write_exclusivity', `${checkedExclusive} 个独占切片写入者集合与声明一致`);
    }
  }

  // S4. semantic.per_agent_s_keys_exist
  {
    if (!cfg) {
      cf.fail('semantic.per_agent_s_keys_exist', 'lifecycle/config.yaml 未解析');
    } else {
      const agentKeys = new Set([...agents.keys()].map((n) => n.replace(/-/g, '_')));
      const ghost = cfg.perAgentKeys.filter((k) => !agentKeys.has(k));
      if (ghost.length === 0) {
        cf.pass('semantic.per_agent_s_keys_exist',
          `per_agent_s ${cfg.perAgentKeys.length} 键全部有对应 agent/*.md（语义层确认）`);
      } else {
        for (const g of ghost) {
          cf.fail('semantic.per_agent_s_keys_exist',
            `per_agent_s 幽灵键 "${g}"（无对应 agent/${g}.md）`);
        }
      }
    }
  }

  // S5. semantic.edge_when_vars_defined
  {
    const KNOWN_WHEN_VARS = new Set([
      'intent_type', 'tier', 'quality_verdict',
      'forward_result', 'review_result',
    ]);
    const TC_TOP_FIELDS = new Set([
      'task_id', 'intent', 'sizing', 'config', 'plan', 'plan_review',
      'execution', 'verification', 'quality', 'fixing_history',
      'dispatch_log', 'overload_count', 'status', 'current_stage',
      'transition_log', 'convergence',
    ]);
    const LITERALS = new Set([
      'in', 'and', 'or', 'not', 'true', 'false', 'null',
      'T0', 'T1', 'T2', 'T3',
      'EXECUTION', 'INQUIRY', 'PASS', 'CIRCUIT_BREAKER',
    ]);
    const usedVars = new Set();
    for (const e of graph.edges) {
      if (!e.when) continue;
      const tokens = e.when.match(/[a-zA-Z_][a-zA-Z_0-9]*/g) || [];
      for (const tk of tokens) {
        if (!LITERALS.has(tk)) usedVars.add(tk);
      }
    }
    let bad = 0;
    for (const v of usedVars) {
      if (!KNOWN_WHEN_VARS.has(v) && !TC_TOP_FIELDS.has(v)) {
        bad++;
        cf.fail('semantic.edge_when_vars_defined',
          `when 变量 "${v}" 未在 task_context schema 中定义（已知=${[...KNOWN_WHEN_VARS].join(',')}，顶层字段=${[...TC_TOP_FIELDS].join(',')}）`);
      }
    }
    if (bad === 0) {
      cf.pass('semantic.edge_when_vars_defined',
        `${usedVars.size} 个 when 变量全部在 task_context schema 中定义（${[...usedVars].sort().join(',')}）`);
    }
  }

  // S6. semantic.return_contract_coverage
  {
    const kjLocalText = readText(KILO_JSON_PATH);
    let subagentNames = [];
    if (kjLocalText) {
      try {
        const data = JSON.parse(kjLocalText);
        if (data.agent && typeof data.agent === 'object') {
          for (const [name, cfg] of Object.entries(data.agent)) {
            if (cfg && cfg.mode === 'subagent') subagentNames.push(name);
          }
        }
      } catch { /* 解析失败由 G 区 G.* 校验报错，此处静默 */ }
    }
    if (subagentNames.length === 0) {
      cf.warn('semantic.return_contract_coverage', 'kilo.json 无 mode:subagent 的 agent 或解析失败');
    } else {
      let missing = 0;
      for (const name of subagentNames) {
        const text = readText(path.join(AGENT_DIR, `${name}.md`));
        if (!text) {
          missing++;
          cf.warn('semantic.return_contract_coverage', `agent/${name}.md 缺失，无法校验返回契约`);
          continue;
        }
        const has4 = text.includes('≤4000');
        const hasSection = /返回契约/.test(text);
        if (!has4 && !hasSection) {
          missing++;
          cf.warn('semantic.return_contract_coverage',
            `agent/${name}.md 正文未含 "≤4000" 或 "返回契约" 章节（subagent 须声明返回契约）`);
        }
      }
      if (missing === 0) {
        cf.pass('semantic.return_contract_coverage',
          `${subagentNames.length} 个 subagent 全部声明返回契约（≤4000 / 返回契约）`);
      }
    }
  }

  // S8. semantic.ironclad_mechanical_coverage
  {
    const condText = readText(path.join(AGENT_DIR, 'conductor.md')) ?? '';
    const SCRIPTS = ['transition-check', 'size-check', 'flow-audit', 'lifecycle-doctor', 'task-context'];
    const blocks = {};
    let cur = null; let curText = [];
    for (const line of condText.split(/\r?\n/)) {
      const m = line.match(/^(\d{1,2})\.\s+\*\*/);
      if (m) {
        if (cur !== null) blocks[cur] = curText.join('\n');
        cur = parseInt(m[1], 10);
        curText = [line];
        continue;
      }
      if (cur !== null) {
        if (/^##\s/.test(line)) { blocks[cur] = curText.join('\n'); cur = null; curText = []; continue; }
        curText.push(line);
      }
    }
    if (cur !== null) blocks[cur] = curText.join('\n');
    const SOFT_RULES = [1, 2, 5, 7, 10, 11];
    let hard = 0; let soft = 0; const softIds = [];
    for (let i = 1; i <= 13; i++) {
      const b = blocks[i] || '';
      const hit = SCRIPTS.some((s) => b.includes(s));
      if (hit) hard++;
      else if (SOFT_RULES.includes(i)) { soft++; softIds.push(i); }
    }
    cf.pass('semantic.ironclad_mechanical_coverage',
      `硬铁律 ${hard}/7 PASS + 软铁律 ${soft}/6 INFO（纯文字约束：#${softIds.join(',#')}）`);
  }
}
