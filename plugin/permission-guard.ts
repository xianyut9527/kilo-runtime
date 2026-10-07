// W3.3 动态权限守护（静态 permission 之外的兜底）
// 契约（7.6.2 实测）：tool.execute.before 内 throw 会否决并中止该工具调用。
// 定位：即使静态规则漏配或配置被改坏，这几类不可逆命令仍然拦得住。

// 危险命令词（否定前瞻用）：wrapper 的参数值若恰是这些词，不得被当作参数值吞掉，
// 否则 `env -i format` / `sudo -n format` / `env -i shutdown` 会漏拦（r3 反向必修）。
const DANGER_WORDS = String.raw`format|mkfs|diskpart|Invoke-Expression|iex|Format-Volume|shutdown|Stop-Computer|Restart-Computer|Clear-Disk|Initialize-Disk`;
// 可重复 wrapper 链（r5 补 Start-Process 载体）：无副作用启动器 + shell 解释器
// （cmd/sh/pwsh 等的 `-c`/`/c`/`-Command` payload 落回命令位受检）+ 控制流关键字
// （then/do/else/elif，`if x; then format`）。Start-Process 的目标可执行名同样落回命令位。
const WRAPPERS = String.raw`sudo|command|exec|nohup|env|nice|doas|timeout|xargs|stdbuf|runas|setsid|time|cmd|sh|bash|dash|zsh|ksh|csh|pwsh|powershell|then|do|else|elif|Start-Process`;
// 命令位锚点：行首或 shell 分隔符（;/&/|/反引号/换行/括号/花括号）之后才算「一条命令的起头」，
// 再可选跳过 wrapper 链 / 旗标 / K=V 赋值 / 纯数字位置参数（`timeout 5`）。
// 2026-09-29 r5 ReDoS 修复：旗标「值」与赋值/数字/wrapper 三类 token 存在双重分解
// （`env -i A=1 ×150` 实测 >120s 指数回溯），值位加互斥排除——不得是危险词（r3 语义）、
// 不得是 wrapper 名、不得是纯数字、不得含 `=`——使每段输入只有唯一分解，回溯线性化。
// 引号开头的值依旧不吞（`-c "payload"` 落回命令位）。
const CMD_START = String.raw`(?:^|[;&|\x60\r\n(){}])\s*(?:(?:(?:` + WRAPPERS + String.raw`)\s+)|(?:[-/]\S+(?:\s+(?!` + DANGER_WORDS + String.raw`\b)(?!(?:` + WRAPPERS + String.raw`)\b)(?!\d+\b)[^"'\-=\s][^"'\=\s]*)?\s+)|(?:\w+=\S*\s+)|(?:\d+\s+))*`;
// git 全局旗标链（r5 补）：`git -C repo push --force` / `git --git-dir=x reset --hard` 这类
// 在 git 与子命令之间穿插全局旗标的形态，原 `\bgit\s+子命令` 锚不住。迭代用 (?=(X))\1
// 原子化模拟（防 `-C a ×100` 指数回溯）；值不得是受控子命令（防 `--git-dir=x push` 中
// push 被当值吞掉）；`--git-dir=x` 的 = 值并入旗标 token；带值旗标支持引号值。
const GIT_FLAGS = String.raw`(?:(?=(-{1,2}[A-Za-z][\w-]*(?:=[^\s"']*)?(?:(?:\s+"[^"]*"|\s+'[^']*'|\s+(?!push\b|reset\b|clean\b|restore\b|checkout\b)[^"'\-\s]\S*))?\s+))\1)*`;
// 锚定命令位的动机（2026-09-29 查漏补缺）：原规则用 \bxxx\b 裸词匹配，把只读检索/帮助
// 命令一并拦下——实测 `grep -n diskpart README.md`、`Get-Help diskpart`、`rg "iex " .`、
// `npm run format c:` 全被误伤（过度拦截同样破坏可用性，参照 2026-09-27 .env.example 专项）。
// 锚定后：`; iex $x`/`| iex`/`&& format C:`/`sudo -u root format` 仍拦，参数/检索词形态放行。
// 已知局限（未阻塞，根治需 正则 → shell token 化重构）：① 引号字面量内的分隔符
// （`rg "a|b"` 的 `|` 使后段落入命令位）；② 反引号命令替换、变量间接与编码 payload
// （`iex $x` 拦的是 iex 本身，`$x`/base64 内容不可见）；③ 复合短语规则（rm -rf/
// rd /s /q/vssadmin delete shadows 等）保持裸词匹配——锚定会打开 `find -exec rm`/
// `docker exec rm` 真实逃逸面，短语作 grep 检索词的误伤率远低于单词规则，两害相权保留裸词。
// 本层定位为防误伤兜底而非对抗性沙箱，对抗性绕过由静态规则与人工确认兜底。
// 可选「盘符 / 路径」前缀（`C:\Windows\System32\format.com`、`./format C:`、`C:format`）
const PATH_PREFIX = String.raw`(?:[A-Za-z]:)?(?:[^\s]*[\\/])?`;
// 命令名之后必须是空白/重定向/管道/斜杠/分隔符/右括号/行尾
// （`format>nul`、`format|more`、`format;rm`、`iex(...)` 等无空白直连同构形态），
// 用于把 format 与只读 Format-Table（后接 `-`）区分开。
const CMD_END = "(?=[\\s|<>&/;()`]|$)";
// 统一构造：命令位锚定 + 可选引号 + 可选路径前缀 + 命令名（+ 可选结束前瞻）。
// 引号前缀让 `sh -c "format C:"` 这类引号包裹的 payload（未被 flag 值吞掉的）落回命令位受检。
const winCmd = (name, end = "") => new RegExp(CMD_START + String.raw`["']?` + PATH_PREFIX + name + end, "i");

const DENY_BASH = [
  // git 家族（r5 补旗标链）：`git -C repo push --force`/`git --git-dir=x reset --hard` 这类
  // 全局旗标穿插形态，原 `\bgit\s+子命令` 锚不住；`\s\+\S` 拦 +refspec 强推（`git push origin +master`）。
  { re: new RegExp(String.raw`\bgit\s+` + GIT_FLAGS + String.raw`push\b[^\n]*(\s--force\b|\s-f(\s|$)|\s--force-with-lease\b|\s\+\S)`, "i"), why: "git push 强推" },
  { re: new RegExp(String.raw`\bgit\s+` + GIT_FLAGS + String.raw`clean\b[^\n]*\s-[a-z]*[fd]`, "i"), why: "git clean -fd" },
  { re: new RegExp(String.raw`\bgit\s+` + GIT_FLAGS + String.raw`reset\s+--hard\b`, "i"), why: "git reset --hard" },
  { re: new RegExp(String.raw`\bgit\s+` + GIT_FLAGS + String.raw`checkout\s+--\s+\.`, "i"), why: "丢弃全部工作区改动" },
  { re: new RegExp(String.raw`\bgit\s+` + GIT_FLAGS + String.raw`restore\s+\.(?:\s|$)`, "i"), why: "丢弃全部工作区改动" },
  // rm（r5 补拆分旗标）：`rm -r -f`/`rm --recursive --force` 等非合并形态；单 r 或单 f 不拦（正常删除）
  { re: /\brm\s+(?:(?:-[a-z]*r[a-z]*|--recursive)\s+(?:-[a-z]*f|--force)|(?:-[a-z]*f[a-z]*|--force)\s+(?:-[a-z]*r|--recursive)|-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: "rm -rf" },
  // rd/rmdir /s /q：cmd.exe 递归强删（Windows 版 rm -rf，r5 补；短语裸词，与 rm -rf 同取舍）
  { re: /\b(?:rd|rmdir)\s[^\n]*\/s\b[^\n]*\/q\b|\b(?:rd|rmdir)\s[^\n]*\/q\b[^\n]*\/s\b/i, why: "rd /s /q 递归强删" },
  { re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b|\bRemove-Item\b[^\n]*-Force\b[^\n]*-Recurse\b/i, why: "Remove-Item -Recurse -Force" },
  // --dry-run 是打包验证而非真实发布（r5 误伤修复）
  { re: /\bnpm\s+publish\b(?![^\n]*\s--dry-run)/i, why: "npm publish" },
  // 删除卷影副本/系统备份：勒索软件标志性破坏命令（r5 补，短语裸词）
  { re: /\bvssadmin\s+delete\s+shadows\b/i, why: "删除卷影副本" },
  { re: /\bwbadmin\s+delete\b/i, why: "wbadmin 删除备份" },
  // 关机/重启：命令位锚定（r4——裸词会把 `npm run shutdown`/`grep -n shutdown README.md`
  // /`Get-Help shutdown`/`cat shutdown.log` 全拦，与本轮已修的 diskpart/format 同类误伤，实测）。
  // shutdown 另在 DANGER_WORDS 中（防 wrapper 参数值吞掉它）。
  { re: winCmd(String.raw`(?:shutdown|Stop-Computer|Restart-Computer)(?:\.(?:exe|com|cmd|bat))?`, CMD_END), why: "关机/重启" },
  // 只读 Format-* cmdlet（Format-Table/Format-List/Format-Hex/Format-Wide…）必须放行：
  // 它们与 format 同前缀，裸词/短锚会误伤（`Get-ChildItem | Format-Table` 实测）。故只拦
  // 「写盘」命令名本身：Format-Volume/mkfs 命令位锚定。
  // 2026-09-29 查漏补缺：原规则把 `Get-Help Format-Volume` / `grep mkfs README` 等
  // 帮助查询与检索一并拦下（同类误伤），与 format 规则口径统一。
  { re: winCmd(String.raw`Format-Volume`, CMD_END), why: "格式化磁盘" },
  // mke2fs 是 ext2/3/4 格式化后端（r5 补）；Clear-Disk 清空磁盘、Initialize-Disk 抹分区表
  // （r5 补；均命令位锚定，且在 DANGER_WORDS 中防 shell 载体旗标值吞噬）
  { re: winCmd(String.raw`mk(?:fs|e2fs)(?:\.\w+)?`, CMD_END), why: "格式化磁盘" },
  { re: winCmd(String.raw`Clear-Disk`, CMD_END), why: "Clear-Disk 清空磁盘" },
  { re: winCmd(String.raw`Initialize-Disk`, CMD_END), why: "Initialize-Disk 抹除分区表" },
  // Windows 破坏性命令（2026-09-29 补）：命令位锚定，避免 `npm run format c:`、
  // `grep -n diskpart README.md` 这类把危险词当参数/检索词的命令被误伤（实测）。
  // format 不锁盘符（原 `[a-z]:` 限制漏掉裸 `format`、`echo c:|format`、`format \\.\PhysicalDrive0`
  // 等形态——r1 反向高严重度项）；结束前瞻而非 \b（\b 会命中 Format-Table 前缀）。
  // 扩展名只认可执行后缀（com/exe/cmd/bat），不用 `\.\w+`——否则 `env -i node format.js`
  // 这类 wrapper 把解释器吞进参数值后，脚本名落到命令位会被误伤（2026-09-29 r3 实测）。
  { re: winCmd(String.raw`format(?:\.(?:com|exe|cmd|bat))?`, CMD_END), why: "format 磁盘格式化" },
  { re: winCmd(String.raw`diskpart(?:\.(?:exe|com|cmd|bat))?`, CMD_END), why: "diskpart 磁盘分区" },
  // 动态执行任意字符串（2026-09-29 dual-review 建议项）：Invoke-Expression 的别名/缩写形态。
  // 静态 deny 的前缀式模式（"iex *"）拦不住 `iex(...)`、大小写变形，命令位锚定后
  // `; iex`/`| iex`/`& iex` 链式调用仍拦，而 `rg "iex " .`/`Get-Help iex`/`node iex.mjs` 等放行。
  { re: winCmd(String.raw`(?:Invoke-Expression|iex)(?:\.(?:exe|com|cmd|bat))?`, CMD_END), why: "Invoke-Expression/iex 动态执行任意代码" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)|\bchmod\s+777\s+\/(?:\s|$)/i, why: "chmod 777 /" },
];

const SECRET_PATH = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.git-credentials$/i, // git credential store 明文令牌（r5 补）
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
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
    const bareSecret = /^(?:\.env(?:\.[\w.-]+)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|\.netrc|\.git-credentials)$/i.test(t);
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
      // 长时 task 子代理硬约束（2026-10-01 反向审查必修项）：父会话 180s 内未见工具回执
      // 会触发 turn hard-limit（kilocode#12706）把子代理整条标 interrupted。提示词层保不住
      // LLM 估时，只有权限层能兜——未显式 background:true 的 task 拒绝，强制走 background
      // 由完成通知交付，父会话不挂等待遇窗。与 INSTRUCTIONS.md「>2min 必须 background」纪律同源。
      if (tool === "task") {
        const bg = args?.background;
        // 严格白名单（层3审查必修②）：仅 true 或 trim+lower 后恰为 "true" 视为背景。
        // 黑名单（"false"/"0" 之外全 truthy 放行）会把 "yes"/1 等也当背景——虽然方向
        // 无害，但守卫语义应只认规范形态；其余一切形态 → 未声明背景（拒绝路径，
        // 多一次显式重试的成本换掉判定歧义）。
        const isBackground = bg === true
          || (typeof bg === "string" && bg.trim().toLowerCase() === "true");
        if (!isBackground) {
          const text = `${args?.description ?? ""} ${args?.prompt ?? ""}`.toLowerCase();
          // 短任务豁免（r2 修正 + 层3复审必修①）：
          //   - 中文分支不得带 \b（CJK 之间 \b 恒不成立，「秒级检查」原样误拦）；
          //   - 分钟类只认显式短时长枚举（半/一/两/[12]），带前置非数字守卫——
          //     「30分钟以内」「12分钟以内」不得借「2分钟以内」子串假放行；
          //     守卫用 (?:^|[^0-9]) 而非 lookbehind（层3复审：兼容旧 V8 无 (?<!) 语法）；
          //   - 英文分支带边界且防子串假放行（quickly/fast-forward/short-circuit/mapping
          //     都是不相干描述词），只留 quick(?!ly)/trivial 两个低碰撞词。
          const explicitlyShort = /秒级|秒内|半分钟|(?:^|[^0-9])(?:一|两|[12])分钟(?:内|以内)|<[=\s]*[12]\s*分钟|\bquick(?!ly)\b|\btrivial\b/.test(text);
          if (!explicitlyShort) {
            throw new Error(
              `blocked by permission-guard: task 未显式声明 background:true 且未明确说明任务极短（秒级/两分钟以内）——` +
              `父会话 180s 硬上限（kilocode#12706）会掐死未在窗口内交付的子代理。请加 background:true 重试，由完成通知交付结果。`
            );
          }
        }
      }
      const bashLike = tool === "bash" || tool === "shell";
      const fileLike = tool === "read" || tool === "edit" || tool === "write" || tool === "list";
      if (!bashLike && !fileLike) return;

      // 命令行/路径只解析一次（r5 性能：原实现在 bash 分支对同一命令行重复解析两遍）
      const cmd = bashLike ? bashString(args) : "";
      const cands = bashLike ? pathsInCommand(cmd) : pathsFrom(args);

      if (bashLike) {
        for (const rule of DENY_BASH) {
          if (rule.re.test(cmd)) {
            throw new Error(
              `blocked by permission-guard: ${rule.why} 属于不可逆高危命令（动态守护，非静态规则）。如确需执行，请人工在终端执行。`
            );
          }
        }
        // 受保护文件 × 写操作：堵住「edit deny 被 bash 绕过」的通道
        if (WRITE_CMD.some((re) => re.test(cmd))) {
          for (const p of cands) {
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
        for (const p of cands) {
          if (isProtected(p)) {
            throw new Error(
              `blocked by permission-guard: 受保护文件 ${p} 不允许直接改写（锁文件/agent 状态）。`
            );
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
