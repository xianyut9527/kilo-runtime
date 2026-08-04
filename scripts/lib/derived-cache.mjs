// derived-cache.mjs
// 静态派生数据 mtime 缓存层。
//
// 背景：agent/*.md、lifecycle/graph.yaml、lifecycle/stages/*.md 是运行期不变的静态
// 文件，但 task-context / transition-check / lifecycle-doctor 每次脚本调用都重新
// 解析它们（readdir + readFileSync + frontmatter/yaml 解析）。本模块提供进程间
// mtime 失效缓存：首次派生落盘，后续命中直接读缓存（<10ms），任一源文件 mtime
// 变化或增删 -> 自动失效重新派生。
//
// fail-safe 原则（不破坏既有 fail-closed 语义）：
//   - 缓存读/写任何异常 -> 降级为直接派生（不缓存），绝不阻断或返回空
//   - 派生函数抛异常 -> 不写缓存，异常自然上抛（保留原 fail-closed 行为）
//   - 缓存损坏/版本不匹配 -> 视为 miss 重新派生
//
// 缓存文件：os.tmpdir()/kilo/derived-cache.json（与 task_context_*.json 同目录，
//   属运行时派生数据，不入 git，机器本地）
// 进程内优化：readCache 只读一次文件（模块级 memo），miss 时标记 dirty，
//   exit 时原子落盘一次（tmp + rename），避免并发损坏。
//
// 纯 Node 内置模块，无第三方依赖。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.tmpdir(), 'kilo');
const CACHE_FILE = path.join(CACHE_DIR, 'derived-cache.json');
const CACHE_VERSION = 1;

let _cacheMem; // undefined=未读, null=读失败, object=已读
let _dirty = false;

function readCache() {
  if (_cacheMem !== undefined) return _cacheMem;
  try {
    _cacheMem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    _cacheMem = null;
  }
  return _cacheMem;
}

function flushCache() {
  if (!_dirty || !_cacheMem) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_cacheMem));
    fs.renameSync(tmp, CACHE_FILE); // 原子替换，防并发写损坏
  } catch {
    // 落盘失败不影响本次返回值（已在内存），下次重新派生
  }
  _dirty = false;
}

process.on('exit', flushCache);

// 计算源文件指纹：排序后 basename + mtimeMs，增删/修改任一均触发失效
function sourceSignature(files) {
  const sorted = [...files].sort();
  const parts = [];
  for (const f of sorted) {
    let key;
    try {
      const st = fs.statSync(f);
      key = `${path.basename(f)}@${st.mtimeMs}`;
    } catch {
      key = `${path.basename(f)}@MISSING`;
    }
    parts.push(key);
  }
  return parts.join('|');
}

// 核心 API：带 mtime 失效的派生缓存
//   key      缓存键（唯一标识「派生函数 + 参数」）
//   srcFiles 依赖的源文件绝对路径数组（增删/修改任一变化即失效）
//   derive   () => 派生值（须 JSON 可序列化：plain object/array/string/number/bool）
// 返回：派生值（命中缓存时为反序列化副本）
//
// 注意：派生值须为 JSON 可序列化结构。Map/Set/Function 不可缓存，调用方应返回
// plain object/array。deriveWriteMatrix 返回 {name:[fields]}、parsePostPreMounts
// 返回 [{...}]、getStageRequiredRoles 返回 [string] -- 均安全。
export function cachedDerive(key, srcFiles, derive) {
  const sig = sourceSignature(srcFiles);
  const cache = readCache();
  const entry = cache && cache.version === CACHE_VERSION ? cache.entries?.[key] : null;
  if (entry && entry.sig === sig) {
    return entry.value;
  }
  // miss：重新派生（异常自然上抛，不写缓存，保留原 fail-closed 行为）
  const value = derive();
  const entries = (cache && cache.entries) || {};
  entries[key] = { sig, value };
  _cacheMem = { version: CACHE_VERSION, entries };
  _dirty = true;
  return value;
}

// 便利：列出目录下所有 .md 文件绝对路径（供 srcFiles 声明，自动覆盖增删）
export function listMdFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
