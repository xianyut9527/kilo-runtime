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
  /(^|[\\/])\.env(\.[\w.-]+)?$/i, // .env / .env.local / .env.production
];

// 模板型 .env 变体不算机密：.env.example/.sample/.template/.tmpl/.dist 按惯例只含占位符，
// 是仓库里正常且需要编辑的文件。2026-09-27 实测：原规则把 `.env.example` 一并拦下，
// 连 grep/read 都被动态守护拒绝（本会话亲历）——过度拦截同样破坏可用性。
// 只精确豁免这五个后缀（不做宽泛后缀放行），避免把 .env.production.local 这类真实机密放进来。
const ENV_TEMPLATE = /(^|[\\/])\.env\.(example|sample|template|tmpl|dist)$/i;

// 受保护文件：静态 permission.edit 的 deny 只拦 edit 工具，模型改走 bash 就绕过了
// （实测：--auto 下 `permission.edit: {"*":"deny"}` 仍被 sed -i / node 脚本改写成功）。
// 因此在 hook 层按「路径 × 写操作」双重判定，两条通道一起堵。
const PROTECTED_PATH = [
  /(^|[\\/])package-lock\.json$/i,
  /(^|[\\/])npm-shrinkwrap\.json$/i,
  /(^|[\\/])pnpm-lock\.ya?ml$/i,
  /(^|[\\/])yarn\.lock$/i,
  /(^|[\\/])bun\.lockb?$/i,
  /(^|[\\/])Cargo\.lock$/i,
  /(^|[\\/])composer\.lock$/i,
  /(^|[\\/])poetry\.lock$/i,
  /(^|[\\/])Gemfile\.lock$/i,
  /(^|[\\/])Pipfile\.lock$/i,
  /(^|[\\/])uv\.lock$/i,
  /\.lock$/i, // 兜底：任意 .lock 后缀
  /(^|[\\/])\.kilo[\\/]agent-manager\.json$/i,
];

// bash 写操作的判定（含 shell 重定向与常见写入器）
const WRITE_CMD = [
  /\bsed\b[^\n]*\s-i(\s|$)/i,
  /\b(tee|truncate|dd)\b/i,
  /\b(node|deno|bun|python3?|pwsh|powershell)\b[^\n]*(writeFileSyn?c?|writeFile|appendFile|open\s*\(|Set-Content|Out-File|Add-Content|>)/i,
  /\b(rm|mv|cp|del|erase|chmod|attrib|icacls)\b/i,
  />>?\s*\S/,
];

function isProtected(p) {
  return PROTECTED_PATH.some((re) => re.test(p));
}

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

// 从 shell 命令行里抽取可能的文件路径（引号包裹、含盘符/斜杠/点的 token）。
// 2026-09-27 二轮审查补：外层是双引号的 token 内部可能再嵌单引号路径——
// `node -e "require('fs').readFileSync('proj/.env')"` 实测漏过：整个 JS 表达式
// 被当成一个 token，以 `.env')` 结尾，SECRET_PATH 的 $ 锚点对不上。修法：
// 双引号 token 之外，再扫一遍其中的单引号片段与含分隔符的子串作候选（去重）。
function pathsInCommand(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t) return;
    // 裸密钥文件名（无目录分隔符的 .env / auth.json / id_rsa…）也算候选：
    // `readFileSync('.env')` 类形态无分隔符，靠「路径样子」过滤会整个漏掉
    // （2026-09-27 二轮审查实测）。SECRET_PATH 本身带 ^ 锚点，裸名也能命中。
    const bareSecret = /^(?:\.env(?:\.[\w.-]+)?|auth\.json|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.netrc)$/i.test(t);
    if (bareSecret || /[\\/]/.test(t) || /^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(t)) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  };
  const re = /"([^"]+)"|'([^']+)'|([^\s"'|;&<>()]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const t = m[1] ?? m[2] ?? m[3];
    if (!t) continue;
    push(t);
    // 双引号 token 内部再挖一层：单引号片段（'…'）与路径样子子串（非贪婪扫到空白/引号）
    if (m[1]) {
      const inner = /'([^']+)'|([^\s'"]+)/g;
      let im;
      while ((im = inner.exec(m[1])) !== null) {
        const it = im[1] ?? im[2];
        if (it && it !== m[1]) push(it);
      }
    }
  }
  return out;
}

// 不得 export：Kilo vE2 加载器会把模块里每个导出的函数都当插件工厂调用一遍
// （与包装函数不同引用 → 钩子被重复注册两份）。实现保持模块私有，只导出包装后的工厂。
const PermissionGuardImpl = async () => {
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
        // 受保护文件 × 写操作：堵住「edit deny 被 bash 绕过」的通道
        const writes = WRITE_CMD.some((re) => re.test(cmd));
        if (writes) {
          for (const p of pathsInCommand(cmd)) {
            if (isProtected(p)) {
              throw new Error(
                `blocked by permission-guard: 受保护文件 ${p} 不允许通过 shell 改写（锁文件/agent 状态应由包管理器维护）。`
              );
            }
          }
        }
      }

      // 敏感凭证目录：只读亦不放开（避免被读取后写入上下文/外发）
      // 路径匹配同时覆盖工具参数与 bash 命令行（cp ~/.ssh/id_rsa 这类）
      if (tool === "read" || tool === "edit" || tool === "write" || tool === "list" || tool === "bash" || tool === "shell") {
        const cands = tool === "bash" || tool === "shell" ? pathsInCommand(bashString(args)) : pathsFrom(args);
        for (const p of cands) {
          if (ENV_TEMPLATE.test(p)) continue; // 模板型 .env 变体放行（只含占位符，非机密）
          for (const re of SECRET_PATH) {
            if (re.test(p)) {
              throw new Error(
                `blocked by permission-guard: 拒绝访问凭证/密钥路径 ${p}（动态守护）。`
              );
            }
          }
        }
        // 受保护文件的 read 不禁（允许查看），但 edit/write 一律拒绝
        if (tool === "edit" || tool === "write") {
          for (const p of pathsFrom(args)) {
            if (isProtected(p)) {
              throw new Error(
                `blocked by permission-guard: 受保护文件 ${p} 不允许直接改写（锁文件/agent 状态）。`
              );
            }
          }
        }
      }
    },
  };
};

// never-throw 包装（爆炸半径收口，2026-09-22）：工厂抛错 → Kilo 插件注册表留洞 →
// config hook 级联 → provider 列表全挂 → 模型选择器空。工厂期异常只禁用本插件。
export const PermissionGuard = async (ctx = {}) => {
  try {
    return await PermissionGuardImpl(ctx);
  } catch (e) {
    console.error("[permission-guard] init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};
