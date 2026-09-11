// scripts/lib/frontmatter.mjs
// frontmatter 解析单一 canonical 来源（U1a）。
//
// 收编前 3 处重复实现：
//   - scripts/build-derivations.mjs        extractFrontmatter + extractTaskContextWrite
//   - scripts/task-context-runtime.mjs     extractFrontmatter
//   - scripts/recover-write-missing.mjs    extractFrontmatter + extractTaskContextWrite
//
// 正则与返回结构保持与收编前完全一致：首个 --- ... --- 之间的 YAML 子集文本。
// 仅使用 Node 内置模块；Windows PowerShell + Linux bash 兼容。

// 从 .md 全文提取 frontmatter 块（首个 --- ... --- 之间）。
// 命中返回块内文本，未命中返回 null。
export function extractFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// 在 frontmatter 块内提取 task_context.write 列表。
// 支持行内数组（write: [a, b]）与多行列表（write:\n  - a\n  - b）两种 YAML 子集。
// task_context 段结束于下一个顶层键（无缩进的非注释行）或块尾。
export function extractTaskContextWrite(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  let inTaskContext = false;
  let inWrite = false;
  const items = [];
  for (const line of lines) {
    // 顶层键（无缩进、非空、非注释）：task_context: 开始，或其他顶层键（段结束）
    if (/^[^\s#]/.test(line)) {
      if (inTaskContext) break;
      inTaskContext = /^task_context\s*:/.test(line);
      continue;
    }
    if (!inTaskContext) continue;
    // write 字段（缩进）：行内数组形式
    const inline = line.match(/^\s+write\s*:\s*\[(.*)\]\s*(?:#.*)?$/);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const v = part.trim().replace(/^["']|["']$/g, '');
        if (v) items.push(v);
      }
      inWrite = false;
      continue;
    }
    // write 字段：多行列表形式起始
    if (/^\s+write\s*:\s*$/.test(line)) {
      inWrite = true;
      continue;
    }
    if (inWrite) {
      const li = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
      if (li) {
        items.push(li[1]);
        continue;
      }
      inWrite = false; // write 列表结束（task_context 段内其他键）
    }
  }
  return items;
}
