// 记忆自举：git 项目首次使用时自动启用原生记忆（kilo_memory_* 工具族 + 自动注入）。
// 背景（7.6.2 二进制实证）：原生记忆默认 enabled:false，工具按前缀 kilo_memory_ 过滤隐藏；
// 官方启用通道是 TUI /memory 或 HTTP POST /memory/enable，但都没有自动化入口——
// 本插件在 session.created 时直接按官方布局落盘 scaffold（算法已与 /memory/enable 产物逐字节比对）。
// 存储布局：<dataDir>/memory/<basename>-<sha1(realpath(canonical))[:12]>/，worktree 归并主仓共享记忆。
// 安全边界：只在 state.json 不存在时创建（create-if-missing），绝不修改/覆盖已有记忆状态；
// 仅对 git 仓库根生效，非 git 目录留给 /memory-setup 显式启用。

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

// 全局经验层自愈：GLOBAL-NOTES.md 是运行时状态不进下发清单，新机器首次启动时由本插件
// 按模板创建（配置根从插件自身部署位置推导，零猜测）。已有文件绝不动。
const GLOBAL_NOTES_TEMPLATE = `# Global Notes（全自动全局经验层）

<!-- 机制：跨项目通用教训由 agent 直接追加到下方 Notes 列表（一行一条，格式：- YYYY-MM-DD 教训内容）。
     不需要用户确认；总量上限约 1KB，/evolve 定期修剪：去重、删过时、成熟条目升格进 INSTRUCTIONS.md（需确认）。
     本文件是运行时状态，不进下发清单，install 不会覆盖它。 -->

## Notes
`;

function ensureGlobalNotes() {
  try {
    // 插件部署在 <configRoot>/plugin/ 下，配置根 = 上一级（实测 import.meta.dir = .../kilo/plugin）
    const configRoot = path.dirname(import.meta.dir);
    writeIfAbsent(path.join(configRoot, "GLOBAL-NOTES.md"), GLOBAL_NOTES_TEMPLATE);
  } catch {
    // 自愈失败不影响主流程
  }
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
    ensureGlobalNotes();
    if (directory) bootstrap(directory);
  } catch (e) {
    console.error(TAG, "init failed:", e);
  }
  return {
    event: async (input) => {
      try {
        const ev = input?.event;
        if (!ev || ev.type !== "session.created") return;
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
