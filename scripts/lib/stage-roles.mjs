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