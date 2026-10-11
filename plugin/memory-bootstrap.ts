// 记忆自举：git 项目首次使用时自动启用原生记忆（kilo_memory_* 工具族 + 自动注入）。
// 背景（7.6.2 二进制实证）：原生记忆默认 enabled:false，工具按前缀 kilo_memory_ 过滤隐藏；
// 官方启用通道是 TUI /memory 或 HTTP POST /memory/enable，但都没有自动化入口——
// 本插件在 session.created 时直接按官方布局落盘 scaffold（算法已与 /memory/enable 产物逐字节比对）。
// 存储布局：<dataDir>/memory/<basename>-<sha1(realpath(canonical))[:12]>/，worktree 归并主仓共享记忆。
// 安全边界：只在 state.json 不存在时创建（create-if-missing），绝不修改/覆盖已有记忆状态；
// 仅对 git 仓库根生效，非 git 目录留给 /memory-setup 显式启用。
// 职责边界（2026-10-11 记忆核心闭环改造）：全局经验层（GLOBAL-NOTES.md）移交 memory-store
// 插件编译管理（无界 store + 评分编译快照）——本插件只管项目记忆封顶与自举，
// 双方都写 GLOBAL-NOTES.md 会互相覆盖打架，故此处的模板自愈/4KB 封顶已整体移除。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../lib/hx-client";

const TAG = "[memory-bootstrap]";

// 与官方 /memory/enable 写出的 state.json 逐字段一致（limits 缺省由 Kilo readState 补默认）
const STATE_ENABLED = `{
  "version": 1,
  "enabled": true,
  "scope": "project",
  "autoInject": true,
  "autoConsolidate": true,
  "verbose": false,
  "capture": {
    "mode": "selective",
    "turnClose": true,
    "explicit": true,
    "maxOpsPerRun": 16,
    "minIntervalMs": 300000,
    "timeoutMs": 30000
  },
  "stats": {
    "lastInjectedAt": null,
    "lastInjectedBytes": 0,
    "lastInjectedTokens": 0,
    "lastInjectedSessionID": null,
    "lastTypedConsolidationAt": null,
    "lastSessionSavedAt": null,
    "lastConsolidatedMessageID": null,
    "lastConsolidationCost": 0,
    "lastConsolidationTokens": 0,
    "lastOperationCount": 0,
    "lastRecallAt": null,
    "lastRecallCount": 0,
    "lastRecallSessionID": null
  }
}
`;

// 数据目录统一取 hx-client 共享常量 DATA_DIR（XDG_DATA_HOME 优先，与 kilo.db/auth.json 同根）

function safeName(name) {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "project";
}

// canonical 根解析：向上找 .git；.git 是文件（worktree/submodule）时经 gitdir 回主仓根。
// 与 Kilo 内置身份函数同构（实测 culture-applet 的 worktree 与主仓得到同一记忆根）。
function canonicalRoot(dir) {
  try {
    let cur = fs.realpathSync.native(dir);
    for (;;) {
      const gitPath = path.join(cur, ".git");
      if (fs.existsSync(gitPath)) {
        if (fs.statSync(gitPath).isFile()) {
          const line = (fs.readFileSync(gitPath, "utf8").split(/\r?\n/)[0] || "").trim();
          const m = line.match(/^gitdir:\s*(.+)$/);
          if (!m) return cur;
          const gitdir = path.resolve(cur, m[1].trim());
          // gitdir 形如 <mainRoot>/.git/worktrees/<name>
          const mainGitDir = path.dirname(path.dirname(gitdir));
          return fs.realpathSync.native(path.dirname(mainGitDir));
        }
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null; // 文件系统根兜底（盘符根/UNC 根），天然终止无层数上限
      cur = parent;
    }
  } catch {
    // 路径不可达等异常：静默跳过，绝不影响宿主进程
  }
  return null;
}

function writeIfAbsent(file, content) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, "utf8");
}

// ── 项目记忆封顶（2026-10-08 根治：autoinject 静态内容无限膨胀）────────────────
// 背景：每会话 autoInject=true 把项目记忆 <root>/{project.md,corrections.md,environment.md,index.kmem}
// 全量塞进 system prompt。实测 14 天无封顶：project.md 涨到 277KB / corrections.md 47KB，
// 单会话静态注入总量 342KB（≈85k token），每步都全量重传上游网关，正反馈使越用越卡。
// 范本：旧 GLOBAL-NOTES 4KB 封顶 + parked 归档 + capbak-单次保留（2026-09-15 起；
// 该机制已于 2026-10-11 由 memory-store 编译取代，此处沿用其旁路裁剪策略）。
// 本节把同一套机制应用到项目记忆 4 个文件 —— 旁路访问路径（kilo 走 4 个文件本体，不是
// project.md 头部解析），故策略比 GLOBAL-NOTES 简单：按「文件大小」直接裁，超限全量进 parked。
const PROJECT_FILE_CAP_BYTES = 32 * 1024;       // 32KB/文件：远超正常项目记忆承载量
const PROJECT_TARGET_BYTES = 24 * 1024;        // 封顶时裁到 ≤24KB，给接下来几轮留余量
const PARKED_KEEP_BYTES = 256 * 1024;          // .parked 自身上限（append-only 防二次膨胀）
const SESSION_ARCHIVE_DAYS = 90;               // sessions/<会话>.md 保留窗（只增不减项）
const PROJECT_FILES = ["project.md", "corrections.md", "environment.md", "index.kmem"];

function projectRoot() {
  // 部署在 <configRoot>/plugin/ 下，配置根 = 上一级
  const configRoot = path.dirname(import.meta.dir);
  return path.join(configRoot);
}

function enforceProjectMemoryCap() {
  // 1) 列举所有项目记忆根（layout: <DATA_DIR>/memory/<basename>-<sha1[:12]>/）
  //    DATA_DIR 的同源取法：DATA_DIR 在文件顶部 const 定义（与 hx-client 同源）；
  //    此处只需"哪几个文件夹的 4 个 md/kn 文件超了"，遍历主工作目录的 4 个文件足够——
  //    每会话仅在 MemoryBootstrapImpl 初始化时被调用一次，开销可忽略。
  // 2) 任何异常静默（never-throw 约定：自愈/封顶失败绝不影响宿主与记忆自举主流程）。
  try {
    for (const folderName of fs.readdirSync(path.join(DATA_DIR, "memory"))) {
      const root = path.join(DATA_DIR, "memory", folderName);
      if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const fname of PROJECT_FILES) {
        const file = path.join(root, fname);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (st.size <= PROJECT_FILE_CAP_BYTES) continue;
        const { trimmed, parkedPath, bak } = capOneProjectFile(file, st.size);
        if (trimmed) {
          console.error(`${TAG} project-memory 超 ${PROJECT_FILE_CAP_BYTES}B 封顶：${file.replace(DATA_DIR + path.sep, "")} ${st.size}B→${fs.statSync(file).size}B，parked → ${parkedPath.replace(DATA_DIR + path.sep, "")}，备份 ${path.basename(bak)}`);
        }
      }
      // sessions/<时间戳>_<sessionID>_id_<hash>.md：每会话落一个（2026-10-08 二轮查漏：
      // 实测 92 文件/362KB 且只增不减）。按 mtime 保留窗回收——这是「会话存档」性质，
      // 与 project.md（活记忆）不同：过期即删，无 parked/备份（内容已进 project.md）。
      pruneSessionArchive(root);
    }
  } catch {
    // 静默 —— 封顶失败不影响主流程
  }
}

// sessions/ 存档回收（2026-10-08 二轮查漏）：每会话一个 .md，只增不减。
// 按文件 mtime 判保留窗（SESSION_ARCHIVE_DAYS），过期删除——会话存档的实质内容已由
// consolidate 汇总进 project.md，这里只是过程留痕，无需 parked/备份。
function pruneSessionArchive(root) {
  try {
    const dir = path.join(root, "sessions");
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
    const cutoff = Date.now() - SESSION_ARCHIVE_DAYS * 86400_000;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isFile()) continue;                          // symlink/目录跳过
      if (!/\.md$/.test(name)) continue;                    // 只回收 .md 存档
      if (st.mtimeMs >= cutoff) continue;                   // 保留窗内不动
      try { fs.rmSync(p, { force: true }); removed++; } catch { /* 删除失败跳过 */ }
    }
    if (removed > 0) {
      console.error(`${TAG} sessions/ 存档回收：${removed} 个超 ${SESSION_ARCHIVE_DAYS} 天文件已删（${root.replace(DATA_DIR + path.sep, "")}）`);
    }
  } catch { /* 回收失败不影响主流程 */ }
}

function capOneProjectFile(file, currentSize) {
  // ① 备份原文件（.capbak-<yyyymmdd> 只留最近 1 份，独立于 .bak-<yyyymmdd> 命名，不覆盖）
  const dir = path.dirname(file);
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const bak = path.join(dir, `${path.basename(file)}.capbak-${ymd}`);
  fs.copyFileSync(file, bak);
  for (const b of fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(file) + ".capbak-")).sort().slice(0, -1)) {
    try { fs.rmSync(path.join(dir, b), { force: true }); } catch { /* 旧备份清理失败不阻断 */ }
  }
  // ② 裁到 ≤ PROJECT_TARGET_BYTES
  //    ⚠️ 2026-10-08 修正（本轮自查发现的自身缺陷）：初版按「第一个段头之前的算 header、
  //    其余整段 pop」实现——结果把 ## Decisions/## Constraints/## Open Questions 三个段
  //    **连同标题整段裁走**（实测 project.md 只剩 ## Facts；而 ## Open Questions 是
  //    quality-gate persistResidualFixup 的写入锚点，段没了会破坏后续写入）。
  //    正确语义：**段标题是结构、永不删**；只从「最旧」开始删条目行（'- ' 开头）。
  //    条目按追加序 = 时间序，故从文件顶部向下删 = 删最旧、保最新。
  let text2 = fs.readFileSync(file, "utf8");
  const nl2 = text2.includes("\r\n") ? "\r\n" : "\n";
  const lines2 = text2.split(/\r?\n/);
  const isEntry = (l) => /^\s*-\s/.test(l);                 // 条目行
  let bytes2 = Buffer.byteLength(text2, "utf8");
  const parked = [];
  // 从文件顶（最旧）向下扫，删条目行；标题行、空行、注释行一律保留
  for (let i = 0; i < lines2.length && bytes2 > PROJECT_TARGET_BYTES; i++) {
    if (!isEntry(lines2[i])) continue;
    const lb = Buffer.byteLength(lines2[i], "utf8") + nl2.length;
    bytes2 -= lb;
    parked.push(lines2[i]);
    lines2[i] = null; // 标记删除
  }
  const trimmedText = lines2.filter((l) => l !== null).join(nl2);
  // ③ 无 parked 视为不动（结构异常/无可删条目）—— 但有 capbak，原始内容已留底
  if (parked.length === 0) return { trimmed: false, parkedPath: "", bak };
  // ④ parked 归档（按 `<!-- parked ... -->` 块，与 GLOBAL-NOTES 风格一致）
  //    ⚠️ parked 自身也封顶（2026-10-08 二轮查漏）：append-only 会让它成为下一个无限增长源
  //    （实测已 640KB 累计）。保留最新 PARKED_KEEP_BYTES，旧的丢弃——capbak 才是完整兜底。
  const parkedPath = file + ".parked";
  const note = `<!-- parked ${new Date().toISOString().slice(0, 10)} —— 超 ${PROJECT_FILE_CAP_BYTES}B 封顶裁出（2026-10-08 根治：autoinject 静态膨胀），内容无损仅不再注入 -->`;
  const parkedBlock = nl2 + note + nl2 + parked.join(nl2) + nl2;
  try {
    const prev = fs.existsSync(parkedPath) ? fs.readFileSync(parkedPath, "utf8") : "";
    const combined = prev + parkedBlock;
    if (Buffer.byteLength(combined, "utf8") > PARKED_KEEP_BYTES) {
      // 保尾（最新裁出项）——按字节从尾部截，找行边界避免切碎一行
      let cut = combined.length - PARKED_KEEP_BYTES;
      const nlIdx = combined.indexOf(nl2, cut);
      if (nlIdx > 0) cut = nlIdx + nl2.length;
      fs.writeFileSync(parkedPath, `<!-- 已按 ${PARKED_KEEP_BYTES}B 封顶截断（旧项丢弃，完整原始见同目录 .capbak-<日期>） -->${nl2}${combined.slice(cut)}`, "utf8");
    } else {
      fs.writeFileSync(parkedPath, combined, "utf8");
    }
  } catch { /* parked 封顶失败不阻断主流程（capbak 已落） */ }
  // ⑤ 写回裁剪版（只动这一会话的 project memory 根，无并发读者）
  fs.writeFileSync(file, trimmedText.endsWith(nl2) ? trimmedText : trimmedText + nl2, "utf8");
  return { trimmed: true, parkedPath, bak };
}

function bootstrap(dir) {
  const canonical = canonicalRoot(dir);
  if (!canonical) return false;
  const display = safeName(path.basename(canonical));
  const folder = `${display}-${createHash("sha1").update(canonical).digest("hex").slice(0, 12)}`;
  const root = path.join(DATA_DIR, "memory", folder);
  if (fs.existsSync(path.join(root, "state.json"))) return false;
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  writeIfAbsent(path.join(root, ".gitignore"), "*\n!.gitignore\n");
  writeIfAbsent(
    path.join(root, "manifest.json"),
    JSON.stringify(
      { kind: "kilo-memory", version: 1, display, canonical, folder, createdAt: new Date().toISOString() },
      null,
      2
    ) + "\n"
  );
  writeIfAbsent(
    path.join(root, "project.md"),
    "# Project Memory\n\n## Facts\n\n## Decisions\n\n## Constraints\n\n## Open Questions\n"
  );
  writeIfAbsent(path.join(root, "environment.md"), "# Environment Memory\n\n## Commands\n\n## Paths\n\n## Tooling\n");
  writeIfAbsent(path.join(root, "corrections.md"), "# Corrective Memory\n\n## Corrections\n");
  writeIfAbsent(path.join(root, "index.kmem"), "");
  fs.writeFileSync(path.join(root, "state.json"), STATE_ENABLED, "utf8");
  console.error(`${TAG} native memory enabled: ${canonical} -> ${root}`);
  return true;
}

const MemoryBootstrapImpl = async ({ directory }) => {
  // 进程启动时覆盖主工作区；其余目录（Agent Manager worktree 等）由 session.created 事件覆盖
  try {
    enforceProjectMemoryCap(); // 项目记忆封顶（防 system prompt 无限膨胀）
    if (directory) bootstrap(directory);
  } catch (e) {
    console.error(TAG, "init failed:", e);
  }
  return {
    event: async (input) => {
      try {
        const ev = input?.event;
        if (!ev || ev.type !== "session.created") return;
        enforceProjectMemoryCap(); // 复检（项目记忆封顶与上面同管 line）
        const dir = ev.properties?.info?.directory;
        if (dir) bootstrap(dir);
      } catch {
        // 自举失败不影响会话；下次 session.created 会重试（幂等）
      }
    },
  };
};

// never-throw 包装（爆炸半径收口，2026-09-22）：工厂抛错 → Kilo 插件注册表留洞 →
// config hook 级联 → provider 列表全挂 → 模型选择器空。工厂期异常只禁用本插件。
export const MemoryBootstrap = async (ctx = {}) => {
  try {
    return await MemoryBootstrapImpl(ctx);
  } catch (e) {
    console.error(TAG, "init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};

// Kilo vE2 契约同 quality-gate/dual-review：工具函数经 _export 命名空间暴露给离线测试
// （scripts/test-memory-bootstrap.mjs）——对象无 server 属性，kE2 跳过，绝不会被当工厂调用。
export const _export = {
  // 2026-10-08 增：项目记忆封顶（离线测试要断言）
  capOneProjectFile, PROJECT_FILE_CAP_BYTES, PROJECT_TARGET_BYTES, PROJECT_FILES,
  // 2026-10-08 二轮查漏：.parked 自身封顶 + sessions/ 存档回收
  pruneSessionArchive, PARKED_KEEP_BYTES, SESSION_ARCHIVE_DAYS,
};
