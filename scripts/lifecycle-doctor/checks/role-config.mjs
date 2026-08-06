// checks/role-config.mjs
// C. 角色契约校验 + D. 配置校验
// 拆分自 scripts/lifecycle-doctor.mjs L1290-1503

import path from 'node:path';
import { extractFrontmatter, parseStageFrontmatter, parseTierEscalationCfg, globToRegexLocal, readText } from '../lib/parse.mjs';

export function run(ctx) {
  const { cf, graph, agents, cfg, cfgText, VERBOSE, STAGES_DIR, TIERS } = ctx;

  // 智能体角色：frontmatter role ?? 文件名
  function roleOf(name) {
    return agents.get(name)?.role ?? name;
  }

  // 智能体挂载 key：config.agents 键 = 文件名连字符转下划线
  function agentKeyOf(name) {
    return name.replace(/-/g, '_');
  }

  // ============================================================
  // C. 角色契约校验
  // ============================================================

  // C1/C2. 主图无 executor 的 stage 节点：stages frontmatter required_roles 非空且每角色有履行者
  for (const [id, n] of graph.nodes) {
    if (n.type !== 'stage' || n.executor) continue;
    const stagePath = path.join(STAGES_DIR, `${id.toLowerCase()}.md`);
    const stageText = readText(stagePath);
    if (!stageText) continue; // A5 已报
    const fm = extractFrontmatter(stageText);
    const roles = fm ? parseStageFrontmatter(fm) : [];
    if (roles.length === 0) {
      cf.fail(`stage.${id}.required_roles`, `非内建 stage 节点缺 frontmatter required_roles`);
      continue;
    }
    for (const role of roles) {
      const fulfillers = [...agents.keys()].filter(
        (name) => roleOf(name) === role && agents.get(name).mount.some((m) => m.at === id)
      );
      if (fulfillers.length > 0) {
        cf.pass(`stage.${id}.role.${role}`, `履行者: ${fulfillers.join(', ')}`);
      } else {
        cf.fail(`stage.${id}.role.${role}`, `无智能体履行（需 role=${role} 且 mount at: ${id}）`);
      }
    }
  }

  // C3. disabled_agents 不得禁用 required_roles 唯一履行者
  if (cfg && cfg.disabledAgents.length > 0) {
    for (const [id, n] of graph.nodes) {
      if (n.type !== 'stage' || n.executor) continue;
      const stageText = readText(path.join(STAGES_DIR, `${id.toLowerCase()}.md`));
      if (!stageText) continue;
      const fm = extractStageFrontmatterLocal(stageText);
      const roles = fm ? parseStageFrontmatter(fm) : [];
      for (const role of roles) {
        const fulfillers = [...agents.keys()].filter(
          (name) => roleOf(name) === role && agents.get(name).mount.some((m) => m.at === id)
        );
        const remaining = fulfillers.filter((f) => !cfg.disabledAgents.includes(f));
        if (fulfillers.length > 0 && remaining.length === 0) {
          cf.fail('config.disabled_agents', `禁用 ${cfg.disabledAgents.join(',')} 后 ${id}.required_roles.${role} 无履行者`);
        }
      }
    }
    cf.pass('config.disabled_agents', `已声明: ${cfg.disabledAgents.join(', ')}`);
  }

  // C4. 反向一致性：恒定挂载 agent 与 required_roles 契约
  {
    for (const [name, a] of agents) {
      for (const m of a.mount) {
        if (m.when || (Array.isArray(m.tiers) && m.tiers.length > 0)) continue;
        const node = graph.nodes.get(m.at);
        const isStageMount = node && node.type === 'stage';
        const postPreM = m.at.match(/^(post|pre):(\S+)$/);
        if (!isStageMount && !postPreM) continue;
        const stageId = isStageMount ? m.at : (postPreM ? postPreM[2] : null);
        if (!stageId) continue;
        const stageNode = graph.nodes.get(stageId);
        if (!stageNode) continue;
        if (stageNode.executor) continue;
        const stageText = readText(path.join(STAGES_DIR, `${stageId.toLowerCase()}.md`));
        if (!stageText) continue;
        const fm = extractFrontmatter(stageText);
        const roles = fm ? parseStageFrontmatter(fm) : [];
        if (roles.length === 0) continue;
        const agentRole = (roleOf(name) || name).replace(/-/g, '_');
        const rolesNorm = new Set(roles.map((r) => r.replace(/-/g, '_')));
        if (isStageMount) {
          if (rolesNorm.has(agentRole)) {
            if (VERBOSE) cf.pass(`stage.${m.at}.required_roles.reverse_mount`, `${name} 恒定挂载 ${m.at}（role=${agentRole}）∈ required_roles`);
          } else {
            cf.fail(`stage.${m.at}.required_roles.reverse_mount`, `${name} 恒定挂载 ${m.at} 但 role=${agentRole} ∉ required_roles=[${roles.join(', ')}]（log-dispatch 将机械拒绝）`);
          }
        } else {
          if (!rolesNorm.has(agentRole)) {
            cf.warn(`stage.${stageId}.required_roles.${postPreM[1]}-mount-outside-required-roles`,
              `${name} 恒定挂载 ${m.at}（role=${agentRole}）∉ ${stageId}.required_roles=[${roles.join(', ')}]——post/pre 生命周期钩子豁免 FAIL，但 log-dispatch 扩展后允许记录`);
          }
        }
      }
    }
  }

  // ============================================================
  // D. 配置校验
  // ============================================================
  if (cfg) {
    // D1. per_agent_s 每键有对应 agent 文件
    {
      const ghost = cfg.perAgentKeys.filter((k) => ![...agents.keys()].some((name) => agentKeyOf(name) === k));
      if (ghost.length === 0) cf.pass('config.timeouts.per_agent_s', `${cfg.perAgentKeys.length} 个键全部有对应 agent 文件`);
      for (const g of ghost) cf.fail('config.timeouts.per_agent_s', `幽灵键 "${g}"（无对应 agent/*.md）`);
    }
    // D2. per_tier_multiplier 键 ⊆ {T0..T3} 且值为正数
    {
      let bad = 0;
      for (const { key, value } of cfg.multiplierEntries) {
        if (!TIERS.has(key)) { cf.fail('config.timeouts.multiplier', `键 "${key}" ⊄ {T0,T1,T2,T3}`); bad++; }
        if (!(value > 0)) { cf.fail('config.timeouts.multiplier', `${key}=${value} 非正数`); bad++; }
      }
      if (!bad) cf.pass('config.timeouts.multiplier', `${cfg.multiplierEntries.length} 个条目合法`);
    }
    // D3. tier_defaults 键 ⊆ {T0..T2}
    {
      const bad1 = [...cfg.tierAgents.keys()].filter((t) => !TIERS.has(t));
      if (bad1.length === 0) cf.pass('config.tier.keys', 'tier 键全部合法（tier_defaults）');
      for (const t of bad1) cf.fail('config.tier.keys', `tier_defaults "${t}" ⊄ {T0,T1,T2}`);
    }
    // D4. tier 开关键应对应"带 when 的智能体"（防僵尸开关）
    {
      const whenKeys = new Set();
      for (const [, a] of agents) {
        for (const m of a.mount) {
          if (!m.when) continue;
          const wm = m.when.match(/config\.agents\.(\w+)/);
          if (wm) whenKeys.add(wm[1]);
        }
      }
      for (const [tier, keys] of cfg.tierAgents) {
        for (const k of keys) {
          if (!whenKeys.has(k)) {
            cf.warn(`config.tier.${tier}.${k}`, `无任何智能体 when 引用 config.agents.${k}（僵尸开关）`);
          }
        }
      }
    }
    // D5. tier_escalation 段合法性
    {
      const esc = parseTierEscalationCfg(cfgText);
      const REQUIRED_GROUPS = ['auth', 'payment', 'crypto', 'security', 'personal_data'];
      if (!esc.present) {
        cf.fail('config.tier_escalation.exists', 'lifecycle/config.yaml 缺 tier_escalation 顶层段');
      } else {
        cf.pass('config.tier_escalation.exists', 'tier_escalation 顶层段存在');
        if (esc.mode !== 'any' && esc.mode !== 'all') {
          cf.fail('config.tier_escalation.mode', `mode="${esc.mode}" ∉ {any, all}`);
        } else {
          cf.pass('config.tier_escalation.mode', `mode=${esc.mode}`);
        }
        const missing = REQUIRED_GROUPS.filter((g) => !Array.isArray(esc.keyword_groups[g]));
        if (missing.length > 0) {
          cf.fail('config.tier_escalation.keyword_groups', `缺必需组: ${missing.join(', ')}`);
        } else {
          cf.pass('config.tier_escalation.keyword_groups', `5 个必需组齐: ${REQUIRED_GROUPS.join('/')}`);
        }
        let thinGroup = null;
        for (const g of REQUIRED_GROUPS) {
          if (!esc.keyword_groups[g] || esc.keyword_groups[g].length < 3) {
            thinGroup = g; break;
          }
        }
        if (thinGroup) {
          cf.fail('config.tier_escalation.keyword_min', `组 "${thinGroup}" 关键词数 < 3`);
        } else {
          cf.pass('config.tier_escalation.keyword_min', '5 个组每组 ≥ 3 关键词');
        }
        if (esc.sensitive_path_globs.length < 5) {
          cf.fail('config.tier_escalation.globs_count', `sensitive_path_globs 数=${esc.sensitive_path_globs.length} < 5`);
        } else {
          cf.pass('config.tier_escalation.globs_count', `sensitive_path_globs=${esc.sensitive_path_globs.length} ≥ 5`);
        }
        let badGlob = null;
        for (const g of esc.sensitive_path_globs) {
          try { new RegExp(globToRegexLocal(g).source); } catch (e) { badGlob = `${g} (${e.message})`; break; }
        }
        if (badGlob) {
          cf.fail('config.tier_escalation.globs_compile', `glob 无法编译为 RegExp: ${badGlob}`);
        } else {
          cf.pass('config.tier_escalation.globs_compile', `${esc.sensitive_path_globs.length} 个 glob 全部编译通过`);
        }
      }
    }

    // D5. pre-dispatch 安全门阈值
    {
      for (const key of ['size_check_threshold', 'dispatch_prompt_threshold', 'max_files_per_task']) {
        const m = cfgText.match(new RegExp(key + ':\\s*(\\d+)'));
        if (m && parseInt(m[1], 10) > 0) {
          cf.pass('config.' + key, key + '=' + m[1]);
        } else {
          cf.fail('config.' + key, key + ' 缺失或非正整数（pre-dispatch 安全门将无法求值）');
        }
      }
    }
  }
}

// local alias to keep C3 self-contained without polluting imports
function extractStageFrontmatterLocal(text) {
  return extractFrontmatter(text);
}
