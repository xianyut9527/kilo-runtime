// checks/graph-mount.mjs
// A. 图结构校验 + B. 挂载点校验
// 拆分自 scripts/lifecycle-doctor.mjs L1121-1289

import path from 'node:path';
import fs from 'node:fs';

export function run(ctx) {
  const { cf, graph, agents, VERBOSE, STAGES_DIR, NODE_ON_FAIL, MOUNT_ON_FAIL, TIERS, cfg } = ctx;

  // ============================================================
  // A. 图结构校验
  // ============================================================

  // A1. edges 引用已声明节点（主图）
  for (const [label, g] of [['graph', graph]]) {
    if (!g) continue;
    let bad = 0;
    for (const e of g.edges) {
      if (!e.from || !g.nodes.has(e.from)) { cf.fail(`${label}.edges`, `from "${e.from}" 未声明`); bad++; }
      if (!e.to || !g.nodes.has(e.to)) { cf.fail(`${label}.edges`, `to "${e.to}" 未声明`); bad++; }
    }
    if (!bad) cf.pass(`${label}.edges.resolve`, `${g.edges.length} 条边全部引用已声明节点`);
  }

  // A3. 主图节点 on_fail 取值集
  {
    let bad = 0;
    for (const [id, n] of graph.nodes) {
      if (n.on_fail && !NODE_ON_FAIL.has(n.on_fail)) {
        cf.fail('graph.node.on_fail', `${id}: "${n.on_fail}" ∉ {${[...NODE_ON_FAIL].join(',')}}`); bad++;
      }
    }
    if (!bad) cf.pass('graph.node.on_fail', '节点 on_fail 取值全部合法');
  }

  // A4. 纯拓扑守护：主图节点不得出现 required 字段（契约在 stages frontmatter）
  {
    const bad = [...graph.nodes.entries()].filter(([, n]) => n.required);
    if (bad.length === 0) cf.pass('graph.pure_topology', '主图零 required 字段（角色契约在 stages frontmatter）');
    for (const [id] of bad) cf.fail('graph.pure_topology', `${id} 仍声明 required（应移到 stages/${id.toLowerCase()}.md frontmatter required_roles）`);
  }

  // A5. type: stage 节点的 stages/<id-lower>.md 存在
  {
    let bad = 0;
    for (const [id, n] of graph.nodes) {
      if (n.type !== 'stage') continue;
      const p = path.join(STAGES_DIR, `${id.toLowerCase()}.md`);
      if (!fs.existsSync(p)) { cf.fail('graph.stage.file', `${id} → stages/${id.toLowerCase()}.md 缺失`); bad++; }
    }
    if (!bad) cf.pass('graph.stage.file', '全部 stage 节点执行逻辑文件存在');
  }

  // ============================================================
  // B. 挂载点校验
  // ============================================================

  // 派生挂载点全集：on:bootstrap / on:done ∪ 主图节点 × {pre:N, N, post:N}
  const mountPoints = new Set(['on:bootstrap', 'on:done']);
  for (const id of graph.nodes.keys()) {
    mountPoints.add(id);
    mountPoints.add(`pre:${id}`);
    mountPoints.add(`post:${id}`);
  }

  for (const [name, a] of agents) {
    for (const m of a.mount) {
      // B1. at 命中派生挂载点
      if (mountPoints.has(m.at)) {
        if (VERBOSE) cf.pass(`agent.${name}.mount.at`, m.at);
      } else {
        cf.fail(`agent.${name}.mount.at`, `"${m.at}" 未命中派生挂载点`);
      }
      // B2. on_fail 取值集
      if (m.on_fail && !MOUNT_ON_FAIL.has(m.on_fail)) {
        cf.fail(`agent.${name}.mount.on_fail`, `"${m.on_fail}" ∉ {abort,warn,skip,degrade}`);
      }
      // B3a. after 引用的 agent 必须已注册（防引用不存在的 agent）
      if (m.after) {
        const deps = Array.isArray(m.after) ? m.after : [m.after];
        for (const dep of deps) {
          if (!agents.has(dep)) {
            cf.fail(`agent.${name}.mount.after`, `"${dep}" 未注册为 agent（after 只能引用已存在的 agent 名）`);
          }
        }
      }
      // B3b. 旧 order 字段已废弃——忽略不报错（v2.1 迁移兼容）
      // B3c. hook 取值集（QUALITY 阶段内部 hooks）
      if (m.hook && !['verify', 'fix', 'review'].includes(m.hook)) {
        cf.fail(`agent.${name}.mount.hook`, `"${m.hook}" ∉ {verify,fix,review}`);
      }
    }
    if (a.mount.length > 0) {
      const bad = a.mount.filter((m) => !mountPoints.has(m.at) || (m.on_fail && !MOUNT_ON_FAIL.has(m.on_fail)));
      if (bad.length === 0) cf.pass(`agent.${name}.mount`, `${a.mount.length} 个挂载条目合法`);
    }
  }

  // B3d. after 依赖环检测（按挂载点 + hook 分组做拓扑排序）
  {
    // 收集每个 (at, hook) 分组的 agent → after 映射
    const groups = new Map(); // key: "at|hook" → Map(agentName → [after deps])
    for (const [name, a] of agents) {
      for (const m of a.mount) {
        if (m.after && m.after.length > 0) {
          const key = m.hook ? `${m.at}|${m.hook}` : m.at;
          if (!groups.has(key)) groups.set(key, new Map());
          groups.get(key).set(name, Array.isArray(m.after) ? m.after : [m.after]);
        }
      }
    }
    // 每组做环检测（DFS）
    for (const [key, depMap] of groups) {
      const visited = new Set();
      const stack = new Set();
      function dfs(node) {
        if (stack.has(node)) {
          cf.fail(`agent.${key}.after.cycle`, `${node} → ... → ${node} 存在 after 环依赖（拓扑排序无法收敛）`);
          return true;
        }
        if (visited.has(node)) return false;
        visited.add(node);
        stack.add(node);
        const deps = depMap.get(node) || [];
        for (const d of deps) {
          if (dfs(d)) return true;
        }
        stack.delete(node);
        return false;
      }
      let hasCycle = false;
      for (const [agent] of depMap) {
        if (dfs(agent)) { hasCycle = true; break; }
      }
      if (!hasCycle) cf.pass(`agent.${key}.after.topo`, `after 依赖无环（${depMap.size} 个有 after 声明的 agent）`);
    }
    if (groups.size === 0) cf.pass('agent.after.topo', '无 after 声明（全部串行组，按 agent 文件名字典序逐个启动，遵守零输出硬门）');
  }

  // B4. when/tiers 挂载校验（tiers 字段替代 config.agents.<key> 开关挂载）：
  //   - when 与 tiers 互斥（同时存在 → FAIL，二选一）
  //   - tiers 值非空且每项 ⊆ {T0,T1,T2}（定级挂载合法性）
  //   - when 引用的 config.agents.<key> 至少在任一 tier_defaults / inquiry_tier_defaults 声明（防孤儿开关）
  {
    const allTierKeys = new Set();
    if (cfg) {
      for (const keys of cfg.tierAgents.values()) for (const k of keys) allTierKeys.add(k);
      for (const keys of cfg.inquiryTierAgents.values()) for (const k of keys) allTierKeys.add(k);
    }
    let tieredMounts = 0;
    for (const [name, a] of agents) {
      for (const m of a.mount) {
        // 互斥：when 与 tiers 同时存在 → FAIL
        if (m.when && Array.isArray(m.tiers) && m.tiers.length > 0) {
          cf.fail(`agent.${name}.mount.when_tiers`, `when 与 tiers 同时存在（互斥：二选一，tiers 优先）`);
        }
        // tiers 合法性：非空数组且每项 ⊆ {T0,T1,T2}
        if (Array.isArray(m.tiers)) {
          tieredMounts++;
          if (m.tiers.length === 0) {
            cf.fail(`agent.${name}.mount.tiers`, `tiers 为空数组（至少声明一个 tier，如 [T2] / [T1, T2]）`);
          }
          for (const t of m.tiers) {
            if (!TIERS.has(t)) {
              cf.fail(`agent.${name}.mount.tiers`, `tiers 元素 "${t}" ⊄ {T0,T1,T2}`);
            }
          }
        }
        if (!m.when) continue;
        const wm = m.when.match(/config\.agents\.(\w+)/);
        if (wm && !allTierKeys.has(wm[1])) {
          cf.warn(`agent.${name}.mount.when`, `config.agents.${wm[1]} 未在任何 tier_defaults 声明（恒为 false，永不加载）`);
        }
      }
    }
    cf.pass('config.tier.coverage', `tier 开关键: ${[...allTierKeys].join(', ') || '(无)'}${tieredMounts > 0 ? `; tiers 定级挂载: ${tieredMounts} 条` : ''}`);
  }
}
