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
    kilo.json|INSTRUCTIONS.md) return 0 ;;
    *) return 1 ;;
  esac
}

# 把源文件渲染到目标（含占位符替换），并返回是否发生变化
render_file() { # $1=src $2=dst
  local src="$1" dst="$2" tmp
  tmp="$(mktemp)"
  if needs_subst "$1"; then
    sed "s|__KILO_HOME__|$HOME_SLASH|g" "$src" > "$tmp"
  else
    cp -f "$src" "$tmp"
  fi
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
  [ "$dst" = "$src" ] && dst="$src"

  if [ -d "$SCRIPT_DIR/$src" ] || [ "${src%/}" != "$src" ]; then
    root="${src%/}"
    [ -d "$SCRIPT_DIR/$root" ] || { echo "[INSTALL] WARN: 清单目录不存在，跳过 $root" >&2; continue; }
    while IFS= read -r f; do
      rel="${f#$SCRIPT_DIR/$root/}"
      printf '%s\t%s\n' "$f" "$dst/$rel" >> "$PAIRS"
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

# ---------- 校验：kilo.json 渲染后必须是合法 JSON ----------
if [ -n "$PY" ]; then
  if ! sed "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json" \
      | "$PY" -c "import json,sys; json.load(sys.stdin)" >/dev/null 2>&1; then
    echo "[INSTALL] FAIL: kilo.json 渲染后不是合法 JSON（占位符替换可能破坏了结构）" >&2
    exit 1
  fi
else
  echo "[INSTALL] WARN: 未找到 python，跳过 JSON 校验" >&2
fi

# ---------- 备份（仅真实写盘且首次写入前） ----------
if [ "$DRY_RUN" = "0" ] && [ "$CHECK" = "0" ] && [ -d "$TARGET_DIR" ]; then
  BK="$TARGET_DIR.backup-$(date +%Y%m%d-%H%M%S).tar"
  # 排除 node_modules：本机依赖动辄几十 MB，备份里没有价值
  ( cd "$(dirname "$TARGET_DIR")" && tar cf "$BK" --exclude='node_modules' "$(basename "$TARGET_DIR")" 2>/dev/null ) || true
  [ -f "$BK" ] && echo "[BACKUP] $BK"
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

# ---------- 摘要 ----------
MODE="install"; [ "$DRY_RUN" = "1" ] && MODE="dry-run"; [ "$CHECK" = "1" ] && MODE="check"
echo ""
echo "[$MODE] 目标: $TARGET_DIR"
echo "  清单条目 : $TOTAL"
echo "  未变化   : $SAME"
echo "  差异/写入: $CHANGED"
if [ -n "$PY" ]; then
  MODEL="$(sed "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('model','(none)'))")"
  SMALL="$(sed "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(c.get('small_model','(none)'))")"
  AGENTS="$(sed "s|__KILO_HOME__|$HOME_SLASH|g" "$SCRIPT_DIR/kilo.json" | "$PY" -c "import json,sys; c=json.load(sys.stdin); print(', '.join(c.get('agent',{}).keys()) or '(none)')")"
  echo "  model    : $MODEL"
  echo "  small    : $SMALL"
  echo "  agents   : $AGENTS"
fi

if [ "$CHECK" = "1" ] && [ "$CHANGED" -gt 0 ]; then
  echo ""
  echo "[check] 检测到漂移 $CHANGED 处 —— 执行 ./install.sh 同步。"
  exit 1
fi
exit 0
