#!/usr/bin/env node
// scripts/memory-sync.mjs 回归测试（零依赖、零联网，纯临时目录沙箱）
// 覆盖：kind→文件/段落映射（project/corrections/environment 三文件 8 kind）、子目录→git 根解析、
// worktree 归并主仓、同 key 原位更新、幂等零改动、追加路径、根缺失报错、kind 校验、
// 多行 text 单行化、孤儿根检测。
// 运行：node scripts/test-memory-sync.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "memory-sync.mjs");

const results = [];
const assert = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) process.exitCode = 1;
};

// 沙箱：伪造 XDG_DATA_HOME，隔离本机真实记忆目录。
// 双保险：测试前快照真实记忆目录（若存在），结束后断言零变化——证明脚本只认 XDG_DATA_HOME，
// 未混用 os.homedir() 路径（反向审查要求的隔离充分性实证）。
const tmp = mkdtempSync(path.join(os.tmpdir(), "kilo-memsync-test-"));
const dataHome = path.join(tmp, "data");
mkdirSync(path.join(dataHome, "kilo", "memory"), { recursive: true });
const realMemDir = path.join(os.homedir(), ".local", "share", "kilo", "memory");
const realMemSnapshot = (() => {
  try {
    return fs.readdirSync(realMemDir).sort().map((d) => {
      const root = path.join(realMemDir, d);
      let records = 0;
      try {
        records = (fs.readFileSync(path.join(root, "project.md"), "utf8").match(/^- /gm) || []).length;
      } catch {}
      return `${d}:${records}`;
    });
  } catch {
    return null; // 本机无真实记忆目录（干净机器）——结束时断言仍未被创建
  }
})();
process.env.XDG_DATA_HOME = dataHome;

// 造两个「项目」：A（主仓）+ B（带 .git 的普通目录，无真实 git 也能命中——canonicalRoot 向上找 .git）
const projA = path.join(tmp, "projA");
const projAsub = path.join(projA, "src", "deep");
mkdirSync(projAsub, { recursive: true });
mkdirSync(path.join(projA, ".git"), { recursive: true }); // 目录形态 .git 即 git 根

// 只给 A 建记忆根（manifest canonical 指向 projA 的 realpath）
const realA = fs.realpathSync.native(projA);
const folderA = "projA-" + "0".repeat(12);
const rootA = path.join(dataHome, "kilo", "memory", folderA);
mkdirSync(path.join(rootA, "sessions"), { recursive: true });
writeFileSync(path.join(rootA, "manifest.json"), JSON.stringify({ kind: "kilo-memory", version: 1, display: "projA", canonical: realA, folder: folderA }, null, 2));
writeFileSync(path.join(rootA, "project.md"), "# Project Memory\n\n## Facts\n\n## Decisions\n\n## Constraints\n\n## Open Questions\n");
writeFileSync(path.join(rootA, "corrections.md"), "# Corrective Memory\n\n## Corrections\n");
writeFileSync(path.join(rootA, "environment.md"), "# Environment Memory\n\n## Commands\n\n## Paths\n\n## Tooling\n");

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: process.env, ...opts });

// 1. 基本同步：facts kind 落 project.md ## Facts 段
let out = run([projAsub, "facts", "build_cmd", "npm run build", "（产物在 dist/）"]);
assert("同步成功输出", out.includes("synced"));
const md1 = fs.readFileSync(path.join(rootA, "project.md"), "utf8");
assert("facts 写入 ## Facts 段", /## Facts\n- build_cmd :: |## Facts\n\n- build_cmd :: /.test(md1));
assert("写入含原 text", md1.includes("npm run build （产物在 dist/）"));
assert("写入带 synced 日期戳", /（synced \d{4}-\d{2}-\d{2}）/.test(md1));
assert("其他段落未被破坏", /## Decisions\n\n/.test(md1) && /## Open Questions\n/.test(md1));

// 2. 幂等：同 key 同内容再同步 → 零改动
const before = fs.statSync(path.join(rootA, "project.md")).mtimeMs;
out = run([projA, "facts", "build_cmd", "npm run build", "（产物在 dist/）"]);
assert("幂等输出零改动", out.includes("已是最新"));
const after = fs.statSync(path.join(rootA, "project.md")).mtimeMs;
assert("幂等未写盘（mtime 不变）", before === after);

// 3. 同 key 更新：内容变化 → 原位替换，行数不涨
run([projA, "facts", "build_cmd", "npm run build:prod"]);
const md2 = fs.readFileSync(path.join(rootA, "project.md"), "utf8");
const factLines = md2.split(/\r?\n/).filter((l) => l.startsWith("- build_cmd"));
assert("同 key 原位更新（仅 1 行）", factLines.length === 1);
assert("更新后的内容生效", factLines[0].includes("build:prod"));
assert("更新后旧内容已替换", !factLines[0].includes("（产物在 dist/）"));

// 4. 5 个 kind 的段落映射
for (const [kind, file, heading] of [
  ["decisions", "project.md", "## Decisions"],
  ["constraints", "project.md", "## Constraints"],
  ["open-questions", "project.md", "## Open Questions"],
]) {
  run([projA, kind, `k_${kind}`, `v_${kind}`]);
  const md = fs.readFileSync(path.join(rootA, "project.md"), "utf8");
  assert(`${kind} 落 ${heading} 段`, new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\n\n?)- k_${kind} :: `).test(md));
}
run([projA, "corrections", "k_corr", "v_corr"]);
const corr = fs.readFileSync(path.join(rootA, "corrections.md"), "utf8");
assert("corrections 落 corrections.md ## Corrections 段", /## Corrections(\n\n?)- k_corr :: /.test(corr));

// 5. 子目录解析：从 projA/src/deep 发起，命中 projA 记忆根（上面 1/4 已隐式验证，此处显式断言）
assert("子目录请求已写入主根 project.md", fs.readFileSync(path.join(rootA, "project.md"), "utf8").includes("k_decisions"));

// 6. 根缺失：无记忆根的项目报错退出（不静默创建）
const projB = path.join(tmp, "projB");
mkdirSync(projB, { recursive: true });
mkdirSync(path.join(projB, ".git"), { recursive: true });
let failed = false;
try {
  run([projB, "facts", "k", "v"]);
} catch (e) {
  failed = true;
  assert("根缺失退出码非 0", e.status !== 0);
  assert("根缺失报错信息指向 /memory-setup", String(e.stderr || e.message).includes("/memory-setup") || String(e.message).includes("/memory-setup"));
}
assert("根缺失确实抛错", failed);
assert("根缺失未创建任何目录", fs.readdirSync(path.join(dataHome, "kilo", "memory")).length === 1);

// 7. kind 校验：未知 kind 报错
failed = false;
try {
  run([projA, "nope", "k", "v"]);
} catch (e) {
  failed = true;
  assert("未知 kind 退出码非 0", e.status !== 0);
}
assert("未知 kind 确实抛错", failed);

// 8. 多行 text 单行化（多参数空格连接，语义同 oneline 的「；」合并）
run([projA, "facts", "multi_line", "第一行", "第二行", "第三行"]);
const md3 = fs.readFileSync(path.join(rootA, "project.md"), "utf8");
assert("多行参数单行化", /- multi_line :: 第一行 第二行 第三行/.test(md3));

// 9. environment.md 三类 kind：commands/paths/tooling 落对应段落（「B 的构建命令」旗舰场景）
for (const [kind, heading] of [
  ["commands", "## Commands"],
  ["paths", "## Paths"],
  ["tooling", "## Tooling"],
]) {
  run([projA, kind, `env_${kind}`, `值_${kind}`]);
  const env = fs.readFileSync(path.join(rootA, "environment.md"), "utf8");
  assert(`${kind} 落 environment.md ${heading} 段`, new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\n\n?)- env_${kind} :: `).test(env));
}
const envAll = fs.readFileSync(path.join(rootA, "environment.md"), "utf8");
assert("environment 三段结构未被破坏", /## Commands[\s\S]*## Paths[\s\S]*## Tooling/.test(envAll));
assert("environment 同 key 原位更新", (() => { run([projA, "commands", "env_commands", "新值"]); return (fs.readFileSync(path.join(rootA, "environment.md"), "utf8").match(/- env_commands :: /g) || []).length === 1; })());

// 10. worktree 归并：.git 文件（gitdir: 指向主仓）→ 命中主仓记忆根
const projW = path.join(tmp, "projW-tree");
mkdirSync(projW, { recursive: true });
writeFileSync(path.join(projW, ".git"), `gitdir: ${path.join(projA, ".git", "worktrees", "w1")}\n`);
mkdirSync(path.join(projA, ".git", "worktrees", "w1"), { recursive: true }); // 模拟主仓 gitdir 布局
out = run([projW, "facts", "wt_fact", "worktree 记录"]);
assert("worktree 同步归并主根", out.includes("synced") && fs.readFileSync(path.join(rootA, "project.md"), "utf8").includes("- wt_fact :: "));

// 11. 孤儿根检测：canonical 指向不存在路径 → status 报 ORPHANED
const folderO = "projOrphan-" + "1".repeat(12);
const rootO = path.join(dataHome, "kilo", "memory", folderO);
mkdirSync(rootO, { recursive: true });
writeFileSync(path.join(rootO, "manifest.json"), JSON.stringify({ kind: "kilo-memory", version: 1, display: "projOrphan", canonical: path.join(tmp, "projOrphan", "gone"), folder: folderO }, null, 2));
writeFileSync(path.join(rootO, "project.md"), "# Project Memory\n\n## Facts\n\n- orphan_fact :: 旧项目遗留\n");
out = run([]);
assert("体检表列出孤儿根", out.includes("projOrphan"));
assert("孤儿根打 ORPHANED 标记", out.includes("ORPHANED"));
assert("孤儿根触发 WARN 处置提示", out.includes("WARN") && out.includes("处置"));

// 12. 无参：体检表可运行（孤儿根测试已覆盖运行路径，此处断言正常根仍在列）
out = run([]);
assert("无参体检表列出正常记忆根", out.includes("projA"));

// 13. 沙箱隔离性：本机真实记忆目录零变化（防脚本混用 homedir 路径泄漏写盘）
const realMemAfter = (() => {
  try {
    return fs.readdirSync(realMemDir).sort().map((d) => {
      const root = path.join(realMemDir, d);
      let records = 0;
      try {
        records = (fs.readFileSync(path.join(root, "project.md"), "utf8").match(/^- /gm) || []).length;
      } catch {}
      return `${d}:${records}`;
    });
  } catch {
    return null;
  }
})();
assert("沙箱未触碰本机真实记忆目录", JSON.stringify(realMemAfter) === JSON.stringify(realMemSnapshot));

console.log(results.join("\n"));
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failedCount}/${results.length} 通过${failedCount ? `，${failedCount} 失败` : ""}`);
rmSync(tmp, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);