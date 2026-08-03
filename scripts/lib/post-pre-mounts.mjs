// post-pre-mounts.mjs
// 共享 helper：扫描 agent/*.md frontmatter mount 块，提取 post:<STAGE>/pre:<STAGE>
// 且无 when 声明的恒定挂载。
//
// 背景：transition-check.mjs 的 discoverPostPreConstantMounts 与 task-context.mjs 的
// discoverPostPreConstantMountsByAgent 曾各自重复实现同一 frontmatter 解析逻辑
// （仅返回形状不同）。本模块抽取为单一真相源，两个调用点 import 派生。
//
// 公开 API：
//   discoverPostPreConstantMounts()        -> [{ name, stage, kind: 'post'|'pre' }]
//   discoverPostPreConstantMountsByAgent() -> Map<agentName, Set<stageId>>
//
// 纯 Node 内置模块，无第三方依赖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 模块位于 scripts/lib/，agent/ 在仓库根——需回溯两层（../.. ）
const AGENT_DIR = path.resolve(__dirname, '..', '..', 'agent');

// ============================================================
// 内部：解析 agent/*.md frontmatter，返回 [{ name, stage, kind }]
//   扫描 mount 块的 at: 条目，匹配 post:<STAGE> / pre:<STAGE> 前缀，
//   且该条目无 when 声明（恒定挂载）才纳入。
//   解析规则与原 transition-check/task-context 实现完全一致：
//     - 顶层非注释键视为新块起点（落盘上一条并切换 inMount 状态）
//     - mount 块内 - at: <value> 为新条目（落盘上一条）
//     - when: <expr> 标记当前条目为条件挂载（不纳入）
// ============================================================
function parsePostPreConstantMounts() {
  const result = [];
  let files;
  try { files = fs.readdirSync(AGENT_DIR); } catch { return result; }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    const text = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const lines = fm[1].split(/\r?\n/);
    let inMount = false;
    let curAt = null;
    let curWhen = null;
    const flush = () => {
      if (!curAt) return;
      const pm = curAt.match(/^(post|pre):(\S+)$/);
      if (pm && !curWhen) {
        result.push({ name, stage: pm[2], kind: pm[1] });
      }
    };
    for (const line of lines) {
      if (/^[^\s#]/.test(line)) {
        if (inMount) flush();
        inMount = /^mount\s*:/.test(line);
        curAt = null;
        curWhen = null;
        continue;
      }
      if (!inMount) continue;
      const atM = line.match(/^\s*-\s*at\s*:\s*(\S+)\s*(?:#.*)?$/);
      if (atM) { flush(); curAt = atM[1]; curWhen = null; continue; }
      const whenM = line.match(/^\s+when\s*:\s*(.+)$/);
      if (whenM) curWhen = whenM[1].trim();
    }
    if (inMount) flush();
  }
  return result;
}

// ============================================================
// 公开 API 1：transition-check 用
//   返回 [{ name, stage, kind: 'post'|'pre' }]
//   provenance gate 据此校验 post:<FROM> / pre:<TO> 恒定挂载 agent 已派发。
// ============================================================
export function discoverPostPreConstantMounts() {
  return parsePostPreConstantMounts();
}

// ============================================================
// 公开 API 2：task-context log-dispatch 用
//   返回 Map<agentName, Set<stageId>>（agent 在哪些 stage 上有 post:/pre: 恒定挂载）。
//   log-dispatch 扩展：若 --agent 在 --stage 上有 post:/pre: 恒定挂载，
//   即使不在 required_roles 也允许记录（plan-reviewer 的 post:PLANNING 钩子不再被拒）。
// ============================================================
export function discoverPostPreConstantMountsByAgent() {
  const records = parsePostPreConstantMounts();
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.name)) map.set(r.name, new Set());
    map.get(r.name).add(r.stage);
  }
  return map;
}