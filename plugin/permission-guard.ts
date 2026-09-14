// W3.3 动态权限守护（静态 permission 之外的兜底）
// 契约（7.6.2 实测）：tool.execute.before 内 throw 会否决并中止该工具调用。
// 定位：即使静态规则漏配或配置被改坏，这几类不可逆命令仍然拦得住。

const DENY_BASH = [
  { re: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f(\s|$)|\s--force-with-lease\b)/i, why: "git push --force" },
  { re: /\bgit\s+clean\b[^\n]*\s-[a-z]*[fd]/i, why: "git clean -fd" },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: "rm -rf" },
  { re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b|\bRemove-Item\b[^\n]*-Force\b[^\n]*-Recurse\b/i, why: "Remove-Item -Recurse -Force" },
  { re: /\bnpm\s+publish\b/i, why: "npm publish" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "git reset --hard" },
  { re: /\bgit\s+checkout\s+--\s+\.|\bgit\s+restore\s+\.(?:\s|$)/i, why: "丢弃全部工作区改动" },
  { re: /\b(shutdown|Stop-Computer|Restart-Computer)\b/i, why: "关机/重启" },
  { re: /\bFormat-Volume\b|\bmkfs(\.\w+)?\b/i, why: "格式化磁盘" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)|\bchmod\s+777\s+\/(?:\s|$)/i, why: "chmod 777 /" },
];

const SECRET_PATH = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
];

function bashString(args) {
  if (!args) return "";
  if (typeof args === "string") return args;
  return String(args.command ?? args.cmd ?? args.script ?? "");
}

function pathsFrom(args) {
  if (!args || typeof args !== "object") return [];
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v) out.push(v);
    else if (Array.isArray(v)) v.forEach(push);
  };
  push(args.filePath);
  push(args.path);
  push(args.filePaths);
  push(args.paths);
  return out;
}

export const PermissionGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = input?.tool;
      const args = output?.args;

      if (tool === "bash" || tool === "shell") {
        const cmd = bashString(args);
        for (const rule of DENY_BASH) {
          if (rule.re.test(cmd)) {
            throw new Error(
              `blocked by permission-guard: ${rule.why} 属于不可逆高危命令（动态守护，非静态规则）。如确需执行，请人工在终端执行。`
            );
          }
        }
      }

      // 敏感凭证目录：只读亦不放开（避免被读取后写入上下文/外发）
      if (tool === "read" || tool === "edit" || tool === "write" || tool === "list") {
        for (const p of pathsFrom(args)) {
          for (const re of SECRET_PATH) {
            if (re.test(p)) {
              throw new Error(
                `blocked by permission-guard: 拒绝访问凭证/密钥路径 ${p}（动态守护）。`
              );
            }
          }
        }
      }
    },
  };
};
