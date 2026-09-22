// W3.2 compaction 锚点注入
// 契约（7.6.2 实测）：trigger("experimental.session.compacting", {sessionID}, {context: [], prompt: undefined})
//   -> 返回 { prompt: output.prompt ?? 默认摘要 }，故写 output.context 会被默认摘要生成器消费。
// 目标：压缩后仍保留「任务目标 / 关键文件 / 未决问题 / 工作区变更」四类锚点。

const MAX_FILES = 12;
const MAX_DIRTY = 15;
const MAX_MARKS = 10;

function safeTrim(s, n) {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function textOfParts(parts) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const p of parts) {
    if (p && p.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

function extractFiles(msg) {
  const hits = [];
  const files = msg?.info?.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      const p = typeof f === "string" ? f : f?.path ?? f?.file;
      if (typeof p === "string" && p) hits.push(p);
    }
  }
  const text = textOfParts(msg?.parts).join("\n");
  const re = /(?:^|[\s"'(`])([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|cs|cpp|c|h|json|jsonc|ya?ml|toml|sql|md|ps1|sh|vue|html|css|less))(?=[\s"'`),:;]|$)/gm;
  let m;
  while ((m = re.exec(text)) !== null) hits.push(m[1]);
  return hits;
}

function extractUserAsks(msg) {
  return textOfParts(msg?.parts)
    .map((t) => safeTrim(t, 160))
    .filter((t) => t.length > 0);
}

// 不得 export：Kilo vE2 加载器会把模块里每个导出的函数都当插件工厂调用一遍
// （与包装函数不同引用 → 钩子被重复注册两份）。实现保持模块私有，只导出包装后的工厂。
const CompactionAnchorImpl = async ({ client, directory, $ }) => {
  return {
    "experimental.session.compacting": async (_input, output) => {
      const out = output ?? {};
      const existing = Array.isArray(out.context) ? out.context : [];
      if (existing.length > 0) return;

      const lines = [
        "## 压缩锚点（必须保留）",
        "以下内容由 compaction-anchor 插件注入，用于在上下文压缩后保持任务连续性。",
      ];

      // 任务目标：最近两条用户原话
      let target = "";
      let files = [];
      const marks = [];
      try {
        const res = await client.session.messages({ path: { id: _input?.sessionID } });
        const msgs = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        const users = msgs.filter((m) => m?.info?.role === "user");
        const assistants = msgs.filter((m) => m?.info?.role === "assistant");

        const lastUsers = users.slice(-2).flatMap(extractUserAsks);
        if (lastUsers.length > 0) target = lastUsers.join(" / ");

        const fileCount = new Map();
        for (const m of msgs) {
          for (const f of extractFiles(m)) {
            fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
          }
        }
        files = [...fileCount.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_FILES)
          .map(([f]) => f);

        // 未决问题：最后一条 assistant 文本中的疑问句 / TODO 标记
        const lastAssistant = assistants.at(-1);
        const lastText = textOfParts(lastAssistant?.parts).join("\n");
        const qRe = /^.*(?:\?|？|待确认|TODO|未决|待定).*$/gm;
        let q;
        while ((q = qRe.exec(lastText)) !== null && marks.length < MAX_MARKS) {
          const line = safeTrim(q[0], 140);
          if (line) marks.push(line);
        }
      } catch {
        // 读取失败不阻断压缩，退化为仅注入 diff 锚点
      }

      lines.push("", `- 任务目标：${target ? safeTrim(target, 400) : "（未捕获到用户原话，见最近对话）"}`);
      lines.push(
        `- 已读/已改关键文件（按访问次数）：${files.length ? files.join(", ") : "（未捕获）"}`
      );
      lines.push(
        `- 未决问题：${marks.length ? marks.map((m) => `「${m}」`).join("；") : "（未捕获到显式未决项）"}`
      );

      // 工作区变更（git status --short）
      let dirty = [];
      try {
        if ($) {
          const raw = await $`git -C ${directory} status --short`.text();
          dirty = String(raw)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, MAX_DIRTY);
        }
      } catch {
        // 非 git 仓库或 Bun shell 不可用，跳过
      }
      lines.push(
        `- 工作区变更（git status --short）：\n${dirty.length ? dirty.map((d) => `  ${d}`).join("\n") : "  （干净或不可用）"}`
      );

      out.context = lines;
    },
  };
};

// never-throw 包装（爆炸半径收口，2026-09-22）：工厂抛错 → Kilo 插件注册表留洞 →
// config hook 级联 → provider 列表全挂 → 模型选择器空。工厂期异常只禁用本插件。
export const CompactionAnchor = async (ctx = {}) => {
  try {
    return await CompactionAnchorImpl(ctx);
  } catch (e) {
    console.error("[compaction-anchor] init failed (插件已降级禁用，provider 不受影响):", e?.message ?? e);
    return {};
  }
};
