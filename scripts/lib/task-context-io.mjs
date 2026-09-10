// task-context-io.mjs
// task_context 文件 IO 共享库：contextPath + readContextOptional 纯函数。
// 从 task-context-runtime.mjs 抽取（U10 pre-dispatch 文件 IO 共享缓存），消除
// 6 个独立脚本各自定义 contextPath 的重复。纯函数移动，零逻辑变更。
//
// 仅使用 Node 内置模块：node:fs / node:path / node:os / node:process
// 跨平台：Windows PowerShell + Linux bash 兼容

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// 文件位置：$env:TEMP/kilo/task_context_<task_id>.json（Windows）
//          /tmp/kilo/task_context_<task_id>.json（Unix）
// 白名单校验 taskId：仅允许字母数字下划线连字符，长度 1-64（与 task-context-runtime.mjs 一致）
function assertValidTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    throw new Error(`invalid task_id "${taskId}". Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-). Max length 64.`);
  }
}

export function contextPath(taskId) {
  assertValidTaskId(taskId);
  return path.join(os.tmpdir(), 'kilo', `task_context_${taskId}.json`);
}

// readContextOptional(taskId)：task_context 可选读（MMO 多模型路径 pre/post-dispatch --ephemeral 用）。
// 文件不存在 -> 返回 {ctx: null, path: null}（不 die）；文件存在但 JSON 损坏/读取失败 -> 维持
// readContext 严格校验语义（die 1）。readContext 原语义不动：普通 dispatch 在 ctx 缺失时仍 die 阻断。
export function readContextOptional(taskId) {
  const p = contextPath(taskId);
  if (!fs.existsSync(p)) {
    return { ctx: null, path: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    die(1, `Error: cannot read task_context for task_id=${taskId}: ${e.message}`);
  }
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  try {
    return { ctx: JSON.parse(raw), path: p };
  } catch (e) {
    die(1, `Error: invalid JSON in task_context for task_id=${taskId}: ${e.message}`);
  }
}
