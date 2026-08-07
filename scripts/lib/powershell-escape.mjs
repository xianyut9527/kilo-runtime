// scripts/lib/powershell-escape.mjs
// PowerShell 命令行转义 helper：把 Node.js 字符串安全嵌入到 PowerShell 命令中。
// 解决 subagent 在 Windows + pwsh 环境拼接含特殊字符路径时的反复转义问题。
//
// 转义规则（PowerShell 双引号字符串内）：
//   ` (反引号) → `` (双反引号)
//   " (双引号) → `" (反引号双引号) 或 `""` (双引号转义)
//   $ (美元符) → `$ (反引号美元符)
//   \r\n → 保留为字面字符（PS 字符串内 `\n` 是换行）
//
// 单引号字符串更简单：' 不需转义，但 ' ' → ' + escape + '（拆字符串）

/**
 * 把字符串转义为可在 PowerShell 双引号字符串内安全嵌入的形式。
 * 仅转义 `、"、$ 三个 PowerShell 双引号串内的特殊字符。
 * 其它字符（反斜杠、换行、Unicode 等）保持原样。
 * @param {string} str - 原始字符串
 * @returns {string} 转义后字符串（不含外层引号）
 */
export function escapeForPSDoubleQuoted(str) {
  if (str == null) return '';
  return String(str)
    .replace(/`/g, '``')      // 反引号
    .replace(/"/g, '`"')      // 双引号
    .replace(/\$/g, '`$');    // 美元符
}

/**
 * 把字符串包装为 PowerShell 双引号字符串字面量。
 * @param {string} str
 * @returns {string} 如 "abc`$def`"ghi"
 */
export function psDoubleQuoted(str) {
  return '"' + escapeForPSDoubleQuoted(str) + '"';
}

/**
 * 把字符串包装为 PowerShell 单引号字符串字面量（更安全，仅 ' 需转义）。
 * PowerShell 单引号串内唯一需要转义的字符就是单引号本身（' → ''）。
 * @param {string} str
 * @returns {string} 如 'abc''def'
 */
export function psSingleQuoted(str) {
  if (str == null) return "''";
  return "'" + String(str).replace(/'/g, "''") + "'";
}
