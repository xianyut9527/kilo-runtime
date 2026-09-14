// W3.4 本地遥测（只写本地 JSONL，绝不上传）
// 契约（7.6.2 实测）：event hook 收到 { event: { type, properties } }。
// 补原生 `kilo stats` 未覆盖的维度：agent、降级尝试、MoA 调用、权限拒绝、压缩次数、工具分布。
// 输出：<project>/.kilo/metrics/telemetry-YYYY-MM-DD.jsonl

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const WATCHED = new Set([
  "session.created",
  "session.deleted",
  "session.error",
  "session.next.retried",
  "session.next.retry_error",
  "session.next.compaction.started",
  "session.next.compaction.ended",
  "session.idle",
]);

let dirCache = null;

async function metricsDir(directory) {
  if (dirCache) return dirCache;
  const d = join(directory, ".kilo", "metrics");
  await mkdir(d, { recursive: true });
  dirCache = d;
  return d;
}

function dayKey() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function summarize(props) {
  if (!props || typeof props !== "object") return undefined;
  const keys = [
    "agent",
    "model",
    "provider",
    "attempt",
    "reason",
    "messageID",
    "status",
    "name",
    "tool",
  ];
  const out = {};
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  if (props.error && typeof props.error === "object") {
    out.error = String(props.error.name ?? props.error.message ?? "error").slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

export const TelemetryLocal = async ({ directory, worktree }) => {
  const root = directory || worktree || process.cwd();

  const emit = async (record) => {
    try {
      const d = await metricsDir(root);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
      await appendFile(join(d, `telemetry-${dayKey()}.jsonl`), line, "utf8");
    } catch {
      // 遥测失败绝不影响主流程
    }
  };

  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (!WATCHED.has(type)) return;
      await emit({ kind: "event", type, data: summarize(event?.properties) });
    },

    // 权限守护拦截 / 工具失败：tool.execute.after 能拿到执行结果
    "tool.execute.before": async (input) => {
      await emit({ kind: "tool_call", tool: input?.tool, sessionID: input?.sessionID });
    },

    "tool.execute.after": async (input, output) => {
      const failed =
        output?.error !== undefined ||
        (typeof output?.output === "string" && /blocked by permission-guard/i.test(output.output));
      if (failed) {
        await emit({
          kind: "tool_blocked_or_failed",
          tool: input?.tool,
          detail: String(output?.error ?? output?.output ?? "").slice(0, 200),
        });
      }
    },
  };
};
