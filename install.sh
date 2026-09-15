#!/usr/bin/env bash
# kilo_config 全量下发器（SSOT：仓库 -> ~/.config/kilo）
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
#   - 可回滚：首次写入前把整个目标目录打包为 <target>.backup-<ts>.tar
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
        | sed -e '/^[[:space:]]*\/\//d' > "$tmp" ;;
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
RENDERED_JSON="$(sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json.tmpl" | sed -e '/^[[:space:]]*\/\//d')"
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
  # 排除 node_modules：本机依赖动辄几十 MB，备份里没有价值
  if ( cd "$BK_PARENT" && tar cf "$BK" --exclude='node_modules' "$(basename "$TARGET_DIR")" 2>/dev/null ); then
    echo "[BACKUP] $BK"
  else
    echo "[BACKUP] WARN: 备份失败（继续下发）" >&2
  fi
fi

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
# 白名单：Kilo 运行时自建（package.json/plugin 编译依赖、.gitignore、迁移标记、旧备份）
WHITELIST='^(\.gitignore|\.bash-permission-migrated|package(-lock)?\.json|kilo\.json\.bak\..*)$|^(\.kilo|node_modules)(/|$)|^provider/hx-failover/node_modules(/|$)'
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
  MODEL="$(sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json.tmpl" | sed -e '/^[[:space:]]*\/\//d' | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('model','(none)'))")"
  SMALL="$(sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json.tmpl" | sed -e '/^[[:space:]]*\/\//d' | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('small_model','(none)'))")"
  AGENTS="$(sed -e "s|__KILO_CONFIG__|$TARGET_NATIVE|g" -e "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json.tmpl" | sed -e '/^[[:space:]]*\/\//d' | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(', '.join(c.get('agent',{}).keys()) or '(none)')")"
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
