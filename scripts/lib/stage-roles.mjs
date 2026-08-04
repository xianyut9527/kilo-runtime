// stage-roles.mjs
// 共享 helper：从 lifecycle/stages/<id>.md frontmatter 读取 required_roles，
// 并判定 agent/<role>.md 是否为 onFail 条件角色（mount 含 trigger: onFail）。
//
// 背景：flow-audit.mjs / transition-check.mjs / task-context.mjs 曾各自重复实现
// 同一 frontmatter 解析逻辑（三副本 getStageRequiredRoles + isConditionalRole）。
// 本模块抽取为单一真相源，三个调用点 import 派生。
//
// 语义对齐说明：
//   - getStageRequiredRoles() 返回数组；无 frontmatter / 无 required_roles 声明 → []。
//     （原 task-context 的 readStageRequiredRoles 无声明时返回 null，但其调用方
//      fail-open 分支对 null 与 [] 行为一致，统一为 [] 不改变行为。）
//   - isConditionalRole() 文件不存在 → false；仅扫描 mount: 声明段（剔除注释行）。
//
// 纯 Node 内置模块，无第三方依赖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 模块位于 scripts/lib/，lifecycle/ 与 agent/ 在仓库根——需回溯两层（../..）
const ROOT = path.resolve(__dirname, '..', '..');
const STAGES_DIR = path.join(ROOT, 'lifecycle', 'stages');

// 读 stage frontmatter required_roles（agent-stage 匹配 / provenance gate 依据）
// 无 frontmatter 或无 required_roles 声明 → []（fail-open 兼容）
export function getStageRequiredRoles(stageName) {
  const stageLower = stageName.toLowerCase();
  const stagePath = path.join(STAGES_DIR, `${stageLower}.md`);
  if (!fs.existsSync(stagePath)) return [];
  const text = fs.readFileSync(stagePath, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const rm = fm[1].match(/^required_roles\s*:\s*\[(.*)\]\s*(?:#.*)?$/m);
  if (!rm) return [];
  return rm[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// onFail 条件角色判定：agent/<roleName>.md 的 mount 条目含 `trigger: onFail`
// （如 fixer——仅 QUALITY 任一视角 FAIL 时才派发）。文件不存在 → false。
// 仅扫描 mount: 声明段（剔除注释行），避免误匹配 description 等文本。
export function isConditionalRole(roleName) {
  const agentPath = path.join(ROOT, 'agent', `${roleName}.md`);
  if (!fs.existsSync(agentPath)) return false;
  const text = fs.readFileSync(agentPath, 'utf8');
  const mountBlock = text.match(/^mount:[\s\S]*?^[a-z_]+:/m);
  const scopeLines = (mountBlock ? mountBlock[0] : '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
  return /trigger\s*:\s*onFail/.test(scopeLines.join('\n'));
}


// =============================================================================
// requirement_spread 校验（来源 task_diffusion_pack U6）
// 供 transition-check.mjs / flow-audit.mjs 共享。
// 字段对齐 agent/planner.md requirement_spread 5 子字段：
//   business_invariants / impact_surface / scan_evidence /
//   coverage_matrix / acceptance_criteria
// 纯函数，无副作用，不修改入参；纯 Node 内置，无第三方依赖。
// =============================================================================

// unit 是否含 requirement_spread 字段（存在且为非 null 对象）→ boolean
export function hasRequirementSpread(unit) {
  return typeof unit?.requirement_spread === 'object' && unit.requirement_spread !== null;
}

// 校验 5 子字段非空；字段缺失或为空数组/空串 → 收集错误
// 前置：hasRequirementSpread(unit) 为 true 才校验，否则返回 []
export function validateRequirementSpread(unit) {
  if (!hasRequirementSpread(unit)) return [];
  const rs = unit.requirement_spread;
  const fields = ['business_invariants', 'impact_surface', 'scan_evidence', 'coverage_matrix', 'acceptance_criteria'];
  const errors = [];
  for (const field of fields) {
    const v = rs[field];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
      errors.push(`requirement_spread.${field} 缺失或为空`);
    }
  }
  return errors;
}

// unit.requirement_spread.coverage_matrix 是否存在且为非空数组 → boolean
export function hasCoverageMatrix(unit) {
  return Array.isArray(unit?.requirement_spread?.coverage_matrix)
    && unit.requirement_spread.coverage_matrix.length > 0;
}

// 校验 coverage_matrix 每条项：
//   1. conclusion 非空（空/undefined → 错误）
//   2. conclusion 不在危险标记集合 {UNVERIFIED, PARTIAL_IMPLEMENTATION, REGRESSION}
//      （命中 → 错误，不得标 ✅ 不得交付）
// 前置：hasCoverageMatrix(unit) 为 true 才校验，否则返回 []
export function validateCoverageMatrix(unit) {
  if (!hasCoverageMatrix(unit)) return [];
  const errors = [];
  const dangerous = new Set(['UNVERIFIED', 'PARTIAL_IMPLEMENTATION', 'REGRESSION']);
  unit.requirement_spread.coverage_matrix.forEach((item, i) => {
    const conclusion = item?.conclusion;
    if (conclusion === undefined || conclusion === null || conclusion === '') {
      errors.push(`coverage_matrix[${i}].conclusion 为空`);
    } else if (dangerous.has(conclusion)) {
      errors.push(`coverage_matrix[${i}].conclusion=${conclusion} 不得标 ✅ 不得交付`);
    }
  });
  return errors;
}

// =============================================================================
// SPREAD_TRIGGERS / hasSpreadTrigger（来源 task_diffusion_pack U6）
// T2 需求扩散触发词机械判定，供 transition-check.mjs / flow-audit.mjs 共享。
// 触发词清单与 .kilo/instructions/workflow-core.md「T2 扩散触发词清单」
// 对齐——workflow-core.md 为人类可读单一真相源，本常量为机械执行副本，
// 修改触发词时须两边同步。
// 纯函数，无副作用；纯 Node 内置，无第三方依赖。
// =============================================================================

// 触发词数组：命中任一条即判定该需求需进入需求扩散流程（T2）。
// fail-open：入参空/undefined/null 返回 false，不误判扩散。
export const SPREAD_TRIGGERS = [
  // 范围词
  '所有', '任何', '全部', '同类', '模块', '互斥', '唯一', '全局', '统一', '联动',
  // 约束词
  '禁用', '权限', '菜单', '角色', '状态一致', '选择范围',
  // 业务规则 / 多入口多状态多配置多校验多回显 / 历史数据
  '改变业务规则', '多入口', '多状态', '多配置', '多校验', '多回显', '历史数据',
  // 用户反馈类
  '半吊子', '不干净', '另一处也能选',
  // 跨层实现
  '同规则多层实现',
];

// 判定 requestText 是否命中 T2 扩散触发词。
//   - 入参空/undefined/null → false（fail-open，避免误触发扩散流程）
//   - 入参转 String 后遍历 SPREAD_TRIGGERS，任一 includes 命中 → true
//   - 全不命中 → false
// 中文无大小写，无需 toLowerCase。
export function hasSpreadTrigger(requestText) {
  if (requestText === undefined || requestText === null || requestText === '') return false;
  const text = String(requestText);
  return SPREAD_TRIGGERS.some((trigger) => text.includes(trigger));
}
