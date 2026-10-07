// 渲染 kilo.json.tmpl → 部署副本（严格复刻 install.sh 的渲染管线：占位符替换 → 去 // 行 → 剥尾随逗号），
// 校验为合法 JSON、无残留占位符；先备份再原子写。dry=1 时只打印 diff，不写盘。
import fs from "node:fs";
import path from "node:path";

const REPO = "D:/work/kilo-runtime";
const CFG = "C:/Users/Administrator/.config/kilo";
const TMPL = path.join(REPO, "kilo.json.tmpl");
const DEPLOYED = path.join(CFG, "kilo.json");
const HOME = "C:/Users/Administrator";
const DRY = process.argv.includes("--dry");

// 1) 渲染
const raw = fs.readFileSync(TMPL, "utf8");
const substituted = raw
  .replace(/__KILO_CONFIG__/g, CFG)
  .replace(/__KILO_HOME__/g, HOME);
// 去整行注释（与 install.sh 的 sed '/^[[:space:]]*\/\//d' 同义）
let lines = substituted.split(/\r?\n/).filter((l) => !/^[ \t]*\/\//.test(l));
let text = lines.join("\n");
// 剥尾随逗号（字符级状态机，字符串内的 ",}" 不动）
function stripTrailingCommas(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && " \t\r\n".includes(s[j])) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) continue;
    }
    out += c;
  }
  return out;
}
text = stripTrailingCommas(text);

// 2) 校验
if (/__KILO_[A-Z_]+__/.test(text)) {
  console.error("[FAIL] 渲染后仍残留占位符");
  process.exit(1);
}
let rendered;
try {
  rendered = JSON.parse(text);
} catch (e) {
  console.error("[FAIL] 渲染后不是合法 JSON:", e.message);
  process.exit(1);
}

// 3) 语义 diff（只比有效字段）
function walk(a, b, p = "") {
  const out = [];
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push(`ONLY-DEPLOY ${p}.${k} = ${JSON.stringify(b[k])}`);
    else if (!(k in b)) out.push(`ONLY-TMPL ${p}.${k} = ${JSON.stringify(a[k])}`);
    else out.push(...walk(a[k], b[k], `${p}.${k}`));
  }
  return out;
}
const deployed = fs.existsSync(DEPLOYED) ? JSON.parse(fs.readFileSync(DEPLOYED, "utf8")) : null;
const diffs = deployed ? walk(rendered, deployed) : [];
console.log(`== 渲染成功：${Buffer.byteLength(text, "utf8")} bytes / 顶层键 ${Object.keys(rendered).length} 个 ==`);
console.log(`== 与当前部署副本的语义差异 ${diffs.length} 处 ==`);
for (const d of diffs) console.log("   " + d);

if (DRY) { console.log("[DRY] 未写盘"); process.exit(0); }

// 4) 备份 + 原子写
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const bak = `${DEPLOYED}.bak-${stamp}`;
fs.copyFileSync(DEPLOYED, bak);
const tmp = `${DEPLOYED}.tmp-${process.pid}`;
fs.writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n", "utf8");
fs.renameSync(tmp, DEPLOYED);
console.log(`== 已下发：${DEPLOYED}（备份 ${path.basename(bak)}）==`);
