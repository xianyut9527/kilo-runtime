#!/usr/bin/env bash
# Kilo Runtime 全量下发器（SSOT：仓库 -> ~/.config/kilo；原仓库名 kilo_config）
#
# 用法：
#   ./install.sh              下发（改动前对目标做一次性备份）
#   ./install.sh --dry-run    只打印将发生的变更，不写盘
#   ./install.sh --check      只检测漂移（仓库 vs 部署），有漂移则退出码 1
#   ./install.sh --target DIR 覆盖目标目录（默认 ~/.config/kilo）
#
# 设计要点：
#   - 清单驱动（install.manifest），不在脚本里硬编码文件列表
#   - __KILO_HOME__ 占位符替换为本机家目录（正斜杠），保证仓库可移植
#   - 幂等：内容一致则跳过；逐文件 sha 比对
#   - 可回滚：首次写入前把整个目标目录打包为 <target>.backup-<ts>.tar（只保留最近 N 个，见下）
#   - 不下发 node_modules / package-lock.json（本机依赖，不入库）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/install.manifest"
TARGET_DIR="${KILO_SYNC_TARGET:-$HOME/.config/kilo}"
DRY_RUN=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --check)   CHECK=1 ;;
    --target)  shift; TARGET_DIR="$1" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[INSTALL] FAIL: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

TARGET_DIR="${TARGET_DIR//\\//}"
# 家目录必须转成 **原生** 正斜杠形式（C:/Users/x），不能是 MSYS 的 /c/Users/x：
# Kilo 是原生程序，不认 MSYS 路径。有 cygpath 时优先用它。
if command -v cygpath >/dev/null 2>&1; then
  HOME_SLASH="$(cygpath -m "$HOME")"
else
  HOME_SLASH="${HOME//\\//}"
fi
case "$HOME_SLASH" in
  /[a-zA-Z]/*) HOME_SLASH="$(echo "$HOME_SLASH" | sed 's|^/\([a-zA-Z]\)/|\1:/|')" ;;
esac
# 目标目录的「原生」形式（C:/...）：只有它才能写进 provider.npm（native 程序不认 MSYS 的 /c/...）
if command -v cygpath >/dev/null 2>&1; then
  TARGET_NATIVE="$(cygpath -m "$TARGET_DIR")"
else
  TARGET_NATIVE="$TARGET_DIR"
fi
case "$TARGET_NATIVE" in
  /[a-zA-Z]/*) TARGET_NATIVE="$(echo "$TARGET_NATIVE" | sed 's|^/\([a-zA-Z]\)/|\1:/|')" ;;
esac

[ -f "$MANIFEST" ] || { echo "[INSTALL] FAIL: 清单缺失 $MANIFEST" >&2; exit 1; }

# ---------- 工具探测 ----------
PY=""
if command -v python >/dev/null 2>&1 && python -c "import json" >/dev/null 2>&1; then PY="python"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import json" >/dev/null 2>&1; then PY="python3"; fi

# ---------- 尾随逗号剥离工具探测 ----------
# kilo.json.tmpl 自 ad2e312 起允许尾随逗号风格，部署副本必须回归纯 JSON
# （python json.load / bun JSON.parse / PS5.1 ConvertFrom-Json 均拒绝尾随逗号）。
# 剥离必须走字符级状态机：正则 ,\s*[}\]] 会误伤字符串字面量内的 ",}"（commit_message
# prompt 实证，lib/hx-client.ts stripTrailingCommas / install.ps1 Remove-TrailingCommas 同款语义）。
# 解释器全缺时原样透传（Kilo 主程序 JSONC 宽松解析可接受的降级，但严格解析工具会拒）。
STRIP_TC=""
if [ -n "$PY" ]; then STRIP_TC="$PY"
elif command -v bun >/dev/null 2>&1; then STRIP_TC="bun"
elif command -v node >/dev/null 2>&1; then STRIP_TC="node"
else
  echo "[INSTALL] WARN: 无 python/bun/node 可用，尾随逗号不剥离，部署副本将带尾随逗号" >&2
fi

# 单引号包裹的 python/bash 载荷内不得再出现单引号 → 用 chr(34)/chr(92) 表示引号与反斜杠。
STRIP_TC_PY='
import sys
try: sys.stdout.reconfigure(newline="")  # Windows python 文本模式会把 \n 写回 \r\n，禁译保 LF
except Exception: pass
DQ = chr(34); BS = chr(92)
s = sys.stdin.read()
out = []; instr = False; esc = False; i = 0; n = len(s)
while i < n:
    c = s[i]
    if instr:
        out.append(c)
        if esc: esc = False
        elif c == BS: esc = True
        elif c == DQ: instr = False
    elif c == DQ:
        instr = True; out.append(c)
    elif c == ",":
        j = i + 1
        while j < n and s[j] in " \t\r\n": j += 1
        if j >= n or s[j] not in "}]": out.append(c)
    else:
        out.append(c)
    i += 1
sys.stdout.write("".join(out))
'
STRIP_TC_JS='
const DQ = String.fromCharCode(34), BS = String.fromCharCode(92);
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  let out = ""; let instr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (instr) {
      out += c;
      if (esc) esc = false;
      else if (c === BS) esc = true;
      else if (c === DQ) instr = false;
      continue;
    }
    if (c === DQ) { instr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && " \t\r\n".includes(s[j])) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) continue;
    }
    out += c;
  }
  process.stdout.write(out);
});
'
strip_tc() { # stdin -> stdout
  case "$STRIP_TC" in
    python|python3) "$PY" -c "$STRIP_TC_PY" ;;
    bun)            bun -e "$STRIP_TC_JS" ;;
    node)           node -e "$STRIP_TC_JS" ;;
    *)              cat ;;
  esac
}

hash_of() { # $1 = file
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

# 判断某文件是否需要占位符替换（按 basename 判断，不能用完整路径）
needs_subst() {
  case "$(basename "$1")" in
    kilo.json.tmpl|INSTRUCTIONS.md) return 0 ;;
    *) return 1 ;;
  esac
}

# 把源文件渲染到目标（含占位符替换 + 模板注释剥离），并返回是否发生变化
# 注释约定：仅 *.tmpl 里「行首 //」是给人看的注释，部署时剥离成纯 JSON
# （Kilo 拒绝 JSON 注释键；行内 // 不动，防误伤 URL）
render_file() { # $1=src $2=dst
  local src="$1" dst="$2" tmp
  tmp="$(mktemp)"
  case "$src" in
    *.tmpl)
      sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$src" \
        | sed -e '/^[[:space:]]*\/\//d' | strip_tc > "$tmp" ;;
    *)
      if needs_subst "$1"; then
        sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$src" > "$tmp"
      else
        cp -f "$src" "$tmp"
      fi ;;
  esac
  local h_src h_dst
  h_src="$(hash_of "$tmp")"
  h_dst=""
  [ -f "$dst" ] && h_dst="$(hash_of "$dst")"
  if [ -n "$h_src" ] && [ "$h_src" = "$h_dst" ]; then
    rm -f "$tmp"; echo "same"; return 0
  fi
  if [ "$DRY_RUN" = "1" ] || [ "$CHECK" = "1" ]; then
    rm -f "$tmp"; echo "diff"; return 0
  fi
  mkdir -p "$(dirname "$dst")"
  mv -f "$tmp" "$dst"
  echo "write"
}

# ---------- 展开清单 -> 文件对列表 ----------
PAIRS="$(mktemp)"
trap 'rm -f "$PAIRS"' EXIT

while IFS= read -r raw; do
  line="${raw%%#*}"
  line="$(echo "$line" | sed 's/[[:space:]]*$//')"
  [ -z "$line" ] && continue
  src="${line%%->*}"
  dst="${line##*->}"
  src="$(echo "$src" | sed 's/[[:space:]]*$//')"
  dst="$(echo "$dst" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  if [ -d "$SCRIPT_DIR/$src" ] || [ "${src%/}" != "$src" ]; then
    root="${src%/}"
    [ -d "$SCRIPT_DIR/$root" ] || { echo "[INSTALL] WARN: 清单目录不存在，跳过 $root" >&2; continue; }
    dstbase="${dst%/}"
    while IFS= read -r f; do
      rel="${f#$SCRIPT_DIR/$root/}"
      printf '%s\t%s\n' "$f" "$dstbase/$rel" >> "$PAIRS"
    done < <(find "$SCRIPT_DIR/$root" -type f | sort)
  else
    if [ -f "$SCRIPT_DIR/$src" ]; then
      printf '%s\t%s\n' "$SCRIPT_DIR/$src" "$dst" >> "$PAIRS"
    else
      echo "[INSTALL] WARN: 清单文件不存在，跳过 $src" >&2
    fi
  fi
done < "$MANIFEST"

TOTAL="$(wc -l < "$PAIRS" | tr -d ' ')"

# ---------- provider dist 新鲜度：src 比 dist 新说明忘跑 build，部署的会是旧行为 ----------
SRC_JS="$SCRIPT_DIR/provider/hx-failover/src/index.js"
DIST_JS="$SCRIPT_DIR/provider/hx-failover/dist/index.js"
if [ -f "$SRC_JS" ] && [ -f "$DIST_JS" ] && [ "$SRC_JS" -nt "$DIST_JS" ]; then
  echo "[INSTALL] WARN: provider src/index.js 比 dist/index.js 新 —— 先在 provider/hx-failover 跑 npm run build 再下发" >&2
  if [ "$CHECK" = "1" ]; then
    echo "[check] 漂移：provider dist 过期（src 已改未重建）" >&2
    exit 1
  fi
fi

# ---------- 校验：kilo.json.tmpl 渲染后必须是合法 JSON，且不得残留占位符 ----------
# （strip_tc 已剥尾随逗号，这里严格校验的正是将要落盘的内容）
RENDERED_JSON="$(sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json.tmpl" | sed -e '/^[[:space:]]*\/\//d' | strip_tc)"
if printf '%s' "$RENDERED_JSON" | grep -q '__KILO_\(HOME\|CONFIG\)__'; then
  echo "[INSTALL] FAIL: kilo.json.tmpl 渲染后仍残留占位符（provider 将初始化失败）" >&2
  exit 1
fi
if [ -n "$PY" ]; then
  if ! printf '%s' "$RENDERED_JSON" | "$PY" -c "import json,sys; json.load(sys.stdin)" >/dev/null 2>&1; then
    echo "[INSTALL] FAIL: kilo.json.tmpl 渲染后不是合法 JSON（占位符替换可能破坏了结构）" >&2
    exit 1
  fi
else
  echo "[INSTALL] WARN: 未找到 python，跳过 JSON 校验" >&2
fi

# ---------- 备份（仅真实写盘且首次写入前） ----------
if [ "$DRY_RUN" = "0" ] && [ "$CHECK" = "0" ] && [ -d "$TARGET_DIR" ]; then
  # 备份路径必须转成 MSYS 形式（/c/...）：tar 是原生程序，收到 "C:/..." 会把它当远程主机而静默失败。
  BK_PARENT="$(dirname "$TARGET_DIR")"
  if command -v cygpath >/dev/null 2>&1; then
    BK_PARENT="$(cygpath -u "$BK_PARENT" 2>/dev/null || echo "$BK_PARENT")"
  fi
  BK="$BK_PARENT/$(basename "$TARGET_DIR").backup-$(date +%Y%m%d-%H%M%S).tar"
  # 顺序与 install.ps1 保持一致：**先裁剪、后创建**。先创建的话，新备份会参与排序，
  # 而它与已有备份的 mtime 可能同秒并列，靠排序排除不可靠（会把自己删掉）。
  # 排除 node_modules：本机依赖动辄几十 MB，备份里没有价值
  KEEP_BACKUPS="${KILO_KEEP_BACKUPS:-2}"
  case "$KEEP_BACKUPS" in
    ''|*[!0-9]*) echo "[BACKUP] WARN: KILO_KEEP_BACKUPS 非法（$KEEP_BACKUPS，需 ≥1 整数），按默认 2 处理" >&2; KEEP_BACKUPS=2 ;;
  esac
  if [ "$KEEP_BACKUPS" -lt 1 ]; then
    echo "[BACKUP] WARN: KILO_KEEP_BACKUPS 非法（$KEEP_BACKUPS，需 ≥1 整数），按默认 2 处理" >&2
    KEEP_BACKUPS=2
  fi
  find "$BK_PARENT" -maxdepth 1 -name "$(basename "$TARGET_DIR").backup-*" -type f -printf '%T@\t%p\n' 2>/dev/null \
    | sort -rn | cut -f2- | tail -n +"$KEEP_BACKUPS" \
    | while IFS= read -r old; do
        [ -n "$old" ] || continue
        rm -f -- "$old" && echo "[BACKUP] prune $old（保留最近 $KEEP_BACKUPS 个）"
      done || true

  if ( cd "$BK_PARENT" && tar cf "$BK" --exclude='node_modules' "$(basename "$TARGET_DIR")" 2>/dev/null ); then
    echo "[BACKUP] $BK"
  else
    echo "[BACKUP] WARN: 备份失败（继续下发）" >&2
  fi
fi

# ---------- 插件加载冒烟闸门（与 install.ps1 对等，2026-09-22 启动崩溃的教训） ----------
# 事故：把编辑中的中间态 plugin/*.ts 下发 → Kilo 7.7.6 插件加载失败 →
# config hook 级联崩溃 → provider 列表全挂 → 无法选择模型。
# 真根因（2026-09-22 逆向 kilo.exe vE2/iE2/kE2 确认）：Kilo 把 plugin 模块里**每个导出函数**
# 都当插件工厂用 (ctx, options) 调一遍——非工厂导出函数收到 (ctx,undefined) 即抛错 →
# "failed to load plugin"；返回 undefined 的 → "plugin config hook failed"(N.config)。
# 因此 plugin/*.ts 做两级检查：① import 不抛；② vE2 模拟——每个导出函数用 (ctx, options)
# 调一遍，抛错或返回非对象即中止。lib/*.ts 只做 ①（库文件不被 Kilo 当插件加载）。
# 注意：Kilo 会把 plugin/ 下每个 .ts 当插件模块求值（库文件放这里会加载失败）——
# lib/ 只作共享依赖目录，plugin/ 只放真正的插件入口。
# 路径 → file:// URL。bun/node 是原生程序，不认 MSYS 路径（/e/... 或 /tmp/...），
# 必须先用 cygpath 转成 Windows 形式（E:/...），否则 import 一律失败 →
# 冒烟闸门会误判所有文件「加载即崩」。无 cygpath（Linux/WSL）时原样使用。
to_file_url() { # $1 = 文件路径
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -m "$p" 2>/dev/null || echo "$p")"
  fi
  echo "file:///$p"
}

# 返回 0 = 通过；非 0 = 该文件加载即崩 / vE2 工厂模拟失败。
smoke_ts() { # $1 = 源文件
  local f="$1"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[INSTALL] WARN: bun 不可用，跳过插件冒烟检查（$f 未经验证即下发）" >&2
    return 0
  fi
  local url; url="$(to_file_url "$f")"
  bun -e "import('$url').then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })" >/dev/null 2>&1
}

# vE2 工厂模拟（仅 plugin/*.ts）：模拟 kilo.exe vE2/iE2/kE2——把每个导出函数（引用去重）
# 当插件工厂用 (ctx, options) 调用。契约：恰好 1 个不同函数导出（工厂）不抛且返回对象、
# 对象导出无 server 函数；违反 = 启动崩溃级缺陷（"failed to load plugin" /
# "plugin config hook failed"），必须拦下。
# 写临时 .mjs 再跑：bun --eval 的 argv 传参/顶层 await 语义不可靠（2026-09-22 实测），
# 文件形式与 install.ps1 同款、已验证。Map 迭代解构是 [fn, name]（键=函数引用，值=名字）。
smoke_ts_ve2() { # $1 = 源文件
  local f="$1"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[INSTALL] WARN: bun 不可用，跳过 vE2 工厂模拟（$f）" >&2
    return 0
  fi
  local url tmpmjs rc
  url="$(to_file_url "$f")"
  tmpmjs="$(mktemp /tmp/kilo-ve2-smoke-XXXXXX.mjs)"
  cat > "$tmpmjs" <<'VE2JS'
const target = process.argv[2];
const mod = await import(target);
const fnByRef = new Map();
for (const [k, v] of Object.entries(mod)) {
  if (typeof v !== "function") {
    if (v && typeof v === "object" && typeof v.server === "function") {
      console.error("object export \"" + k + "\" contains a server function - kE2 would call it as a factory -> startup crash");
      process.exit(1);
    }
    continue;
  }
  if (!fnByRef.has(v)) fnByRef.set(v, k);
}
if (fnByRef.size !== 1) {
  console.error("expected exactly 1 distinct function export (the factory), got " + fnByRef.size + ": " + [...fnByRef.values()].join(", ") + " - vE2 registers/calls each as a plugin -> startup crash");
  process.exit(1);
}
for (const [fn, name] of fnByRef) {
  const r = await fn({ directory: "/kilo-smoke-nonexistent", client: {}, $: undefined }, undefined);
  if (r === null || r === undefined || typeof r !== "object") {
    console.error("factory \"" + name + "\" called with (ctx,options) returned " + String(r) + " (non-object) - pollutes hook registry -> startup crash");
    process.exit(1);
  }
}
VE2JS
  bun "$tmpmjs" "$url" >/dev/null 2>&1
  rc=$?
  rm -f "$tmpmjs"
  return $rc
}

# provider dist 冒烟：dist/index.js 是 server 启动时加载的模块，语法错/半写同样让 provider 注册失败。
smoke_provider_js() { # $1 = 源文件
  local f="$1"
  if ! command -v node >/dev/null 2>&1; then
    echo "[INSTALL] WARN: node 不可用，跳过 provider dist 冒烟检查（$f）" >&2
    return 0
  fi
  local url; url="$(to_file_url "$f")"
  node --input-type=module -e "import('$url').then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })" >/dev/null 2>&1
}

# 预检：任何写入之前完成全量冒烟，否则第 N 个失败时前 N-1 个已落盘 → 半套部署。
# 只对将发生变化的文件检查（same 的文件已是部署态，无需重复验）。
# 三种模式都跑：-Check 是预飞检查，仓库里若有「加载即崩」的插件必须在此暴露。
while IFS=$'\t' read -r src dst; do
  [ -z "$src" ] && continue
  dstf="$TARGET_DIR/$dst"
  # 用与 render_file 相同的 hash 判定是否需要写；有差异才需要冒烟
  tmpchk="$(mktemp)"
  case "$src" in
    *.tmpl)
      sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$src" \
        | sed -e '/^[[:space:]]*\/\//d' > "$tmpchk" ;;
    *)
      if needs_subst "$src"; then
        sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$src" > "$tmpchk"
      else
        cp -f "$src" "$tmpchk"
      fi ;;
  esac
  hs="$(hash_of "$tmpchk")"; hd=""
  [ -f "$dstf" ] && hd="$(hash_of "$dstf")"
  rm -f "$tmpchk"
  [ -n "$hs" ] && [ "$hs" = "$hd" ] && continue

  case "$src" in
    */plugin/*.ts|*/lib/*.ts)
      # 注意 set -e：smoke_ts 失败会退出 subshell 之外的当前 shell，故用 if 显式接住
      if ! smoke_ts "$src"; then
        echo "[INSTALL] FAIL: 插件冒烟加载失败，已中止下发（未写入任何文件）：$src" >&2
        exit 1
      fi ;;
  esac
  case "$src" in
    */plugin/*.ts)
      # vE2 工厂模拟（真根因防线）：每个导出函数都会被 Kilo 当工厂调用，
      # 抛错/返回非对象 = 启动崩溃级缺陷，必须在此拦下
      if ! smoke_ts_ve2 "$src"; then
        echo "[INSTALL] FAIL: vE2 工厂模拟失败（存在裸导出工具函数或工厂返回非对象），已中止下发：$src" >&2
        exit 1
      fi ;;
  esac
  case "$src" in
    */provider/hx-failover/dist/*.js|*/provider/hx-failover/dist/*.mjs)
      if ! smoke_provider_js "$src"; then
        echo "[INSTALL] FAIL: provider dist 冒烟加载失败，已中止下发（未写入任何文件）：$src" >&2
        exit 1
      fi ;;
  esac
done < "$PAIRS"

# ---------- 下发 ----------
CHANGED=0; SAME=0; WROTE=0
while IFS=$'\t' read -r src dst; do
  [ -z "$src" ] && continue
  case "$(render_file "$src" "$TARGET_DIR/$dst")" in
    diff)  CHANGED=$((CHANGED+1)) ;;
    write) CHANGED=$((CHANGED+1)); WROTE=$((WROTE+1)) ;;
    same)  SAME=$((SAME+1)) ;;
  esac
done < "$PAIRS"

# ---------- 多余文件检测（漂移的另一面：部署目录里清单管不到的文件） ----------
# 白名单：Kilo 运行时自建（package.json/plugin 编译依赖、.gitignore、迁移标记、旧备份、全局经验层运行时状态）
WHITELIST='^(\.gitignore|\.bash-permission-migrated|GLOBAL-NOTES\.md|package(-lock)?\.json|kilo\.json\.bak\..*)$|^(\.kilo|node_modules)(/|$)|^provider/hx-failover/node_modules(/|$)'
STRAYS=0
STRAY_LIST=""
if [ -d "$TARGET_DIR" ]; then
  TMPD="$(mktemp -d)"
  # 从 PAIRS 生成期望文件集合（dst 列）
  cut -f2 "$PAIRS" | sort > "$TMPD/expected.txt"
  ( cd "$TARGET_DIR" && find . -type f -not -path './node_modules/*' -not -path './.kilo/*' -not -path './provider/hx-failover/node_modules/*' ) | sed 's|^\./||' | sort > "$TMPD/present.txt"
  STRAY_LIST="$(comm -23 "$TMPD/present.txt" "$TMPD/expected.txt" | grep -Ev "$WHITELIST" || true)"
  [ -n "$STRAY_LIST" ] && STRAYS=$(printf '%s\n' "$STRAY_LIST" | wc -l | tr -d ' ')
  rm -rf "$TMPD"
fi

# ---------- 摘要 ----------
MODE="install"; [ "$DRY_RUN" = "1" ] && MODE="dry-run"; [ "$CHECK" = "1" ] && MODE="check"
echo ""
echo "[$MODE] 目标: $TARGET_DIR"
echo "  清单条目 : $TOTAL"
echo "  未变化   : $SAME"
echo "  差异/写入: $CHANGED"
if [ "$STRAYS" -gt 0 ]; then
  echo "  多余文件 : $STRAYS（清单外，白名单外）"
  printf '%s\n' "$STRAY_LIST" | sed 's/^/    /'
fi
if [ -n "$PY" ]; then
  # 复用已剥离尾随逗号的 RENDERED_JSON（与落盘内容一致），不再重复渲染
  MODEL="$(printf '%s' "$RENDERED_JSON" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('model','(none)'))")"
  SMALL="$(printf '%s' "$RENDERED_JSON" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('small_model','(none)'))")"
  AGENTS="$(printf '%s' "$RENDERED_JSON" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(', '.join(c.get('agent',{}).keys()) or '(none)')")"
  echo "  model    : $MODEL"
  echo "  small    : $SMALL"
  echo "  agents   : $AGENTS"
fi

if [ "$CHECK" = "1" ]; then
  if [ "$CHANGED" -gt 0 ] || [ "$STRAYS" -gt 0 ]; then
    echo ""
    echo "[check] 漂移：内容差异 $CHANGED 处 + 多余文件 $STRAYS 个 —— 执行 ./install.sh 同步（多余文件需人工确认后删除）。"
    exit 1
  fi
fi
exit 0
