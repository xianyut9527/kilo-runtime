#!/usr/bin/env bash
# Kilo 运行痕迹清理：临时目录 + 配置备份保留
#
# 背景（2026-09-15 实测）：Kilo 内置清理只管两处 ——
#   tool-output（保留 7 天、每小时跑）与 remote-attachments（会话关闭即删）。
#   子进程的 TMP/TMPDIR 被重定向到 Kilo 托管临时目录，agent 在里面写的脚本/测试库
#   无人回收；install 每次下发又各留一份配置备份。实测 %TEMP% 下 kilo* 累计 2.5GB。
#
# 用法：
#   ./cleanup.sh                   只预览（默认 dry-run，不删任何东西）
#   ./cleanup.sh --run             实际删除
#   ./cleanup.sh --days N          临时目录兄弟项保留天数（默认 3）
#   ./cleanup.sh --tmp-days N      Kilo 托管临时目录内部保留天数（默认 7）
#   ./cleanup.sh --keep-backups N  保留最近 N 个配置备份（默认 2）
#   ./cleanup.sh --status          只打印各处占用（不判定删除）
#   -h|--help
#
# 安全边界（硬编码，不接受参数覆盖）：
#   - 绝不删除 Kilo 托管临时目录本身（$TEMP/kilo），只清它内部的过期条目
#   - 绝不触碰 ~/.local/share/kilo（会话/记忆/凭证库）与 ~/.config/kilo（配置本体）
#   - 只匹配 $TEMP 下 kilo 前缀的兄弟项，以及 ~/.config 下的 kilo.backup-* 备份文件
#   - 判定只依据 mtime，逐条打印路径与体积；--run 之外一律不写盘
#
# 运行前提：GNU coreutils/findutils（stat -c / find -printf / du）—— Windows 上指 Git Bash；
# macOS/BSD 的 find/stat 语法不同，直接跑会误判（静默返回空），勿在未验证前使用。
set -euo pipefail

MODE=dry-run          # dry-run | run | status
DAYS=3
TMP_DAYS=7
KEEP_BACKUPS=2

usage() { sed -n '/^# 用法：/,/^#   -h|--help/p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run) MODE=run ;;
    --dry-run) MODE=dry-run ;;
    --status) MODE=status ;;
    --days)      [ $# -ge 2 ] || { echo "FAIL: --days 需要参数（如 --days 7）" >&2; exit 2; }; shift; DAYS="$1" ;;
    --tmp-days)  [ $# -ge 2 ] || { echo "FAIL: --tmp-days 需要参数（如 --tmp-days 14）" >&2; exit 2; }; shift; TMP_DAYS="$1" ;;
    --keep-backups) [ $# -ge 2 ] || { echo "FAIL: --keep-backups 需要参数（如 --keep-backups 2）" >&2; exit 2; }; shift; KEEP_BACKUPS="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

validate_int() { echo "$1" | grep -qE '^[0-9]+$' && [ "$1" -ge "$2" ]; }
validate_int "$DAYS" 1         || { echo "FAIL: --days 必须是 ≥1 的整数" >&2; exit 2; }
validate_int "$TMP_DAYS" 1     || { echo "FAIL: --tmp-days 必须是 ≥1 的整数" >&2; exit 2; }
validate_int "$KEEP_BACKUPS" 1 || { echo "FAIL: --keep-backups 必须是 ≥1 的整数" >&2; exit 2; }

# ---------- 路径解析 ----------
to_msys() { # Windows 形式 -> MSYS 形式（原生程序与 coreutils 各自认一种）
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1" 2>/dev/null || echo "$1"; else echo "$1"; fi
}

WTMP="${TEMP:-${TMP:-${TMPDIR:-}}}"
[ -n "$WTMP" ] || { echo "FAIL: 环境里找不到 TEMP/TMP/TMPDIR" >&2; exit 1; }
TMPN="$(to_msys "$WTMP")"
[ -d "$TMPN" ] || { echo "FAIL: 临时目录不存在: $TMPN" >&2; exit 1; }

KILO_TMP="$TMPN/kilo"                       # Kilo 托管临时目录（$TEMP/kilo，来自 kilo debug paths）
CONFIG_PARENT="$HOME/.config"
DATA_DIR="$HOME/.local/share/kilo"
CACHE_DIR="$HOME/.cache/kilo"

cutoff_epoch() { echo $(( $(date +%s) - $1*86400 )); }
older_than() { # $1=路径 $2=天数
  local m
  m="$(stat -c %Y "$1" 2>/dev/null)" || return 1
  [ "$m" -lt "$(cutoff_epoch "$2")" ]
}
mb() { awk -v k="${1:-0}" 'BEGIN{printf "%.1f", k/1024}'; }
dir_kb() { du -sk "$1" 2>/dev/null | cut -f1 || echo 0; }
file_kb() { echo $(( $(stat -c %s "$1" 2>/dev/null || echo 0) / 1024 )); }

# ---------- 删除执行器（dry-run 只打印） ----------
PLANNED_KB=0
DELETED=0
plan_remove() { # $1=路径 $2=KB
  local p="$1" k="$2"
  PLANNED_KB=$(( PLANNED_KB + k ))
  if [ "$MODE" = "run" ]; then
    rm -rf -- "$p" && { DELETED=$(( DELETED + 1 )); echo "  [DEL]  $(mb "$k") MB  $p"; }
  else
    echo "  [PLAN] $(mb "$k") MB  $p"
  fi
}

# ---------- 体检输出 ----------
echo "== 路径 =="
echo "  Kilo 托管临时: $KILO_TMP"
echo "  Kilo 数据目录: $DATA_DIR"
echo "  配置备份目录: $CONFIG_PARENT"
echo ""
echo "== 当前占用 =="
total_kb=0
if [ -d "$KILO_TMP" ]; then
  k="$(dir_kb "$KILO_TMP")"; total_kb=$(( total_kb + k )); echo "  $(mb "$k") MB  $KILO_TMP"
fi
sib_kb=0; sib_n=0
while IFS= read -r d; do
  k="$(dir_kb "$d")"; sib_kb=$(( sib_kb + k )); sib_n=$(( sib_n + 1 ))
done < <(find "$TMPN" -maxdepth 1 \( -name 'kilo-*' -o -name 'kilo_*' \) 2>/dev/null)
[ "$sib_n" -gt 0 ] && { total_kb=$(( total_kb + sib_kb )); echo "  $(mb "$sib_kb") MB  $TMPN/kilo-*  与  kilo_*  （$sib_n 个）"; }
for d in "log" "tool-output" "snapshot" "storage" "repos"; do
  [ -d "$DATA_DIR/$d" ] && { k="$(dir_kb "$DATA_DIR/$d")"; total_kb=$(( total_kb + k )); echo "  $(mb "$k") MB  $DATA_DIR/$d   （Kilo 自管）"; }
done
[ -f "$DATA_DIR/kilo.db" ] && { k="$(file_kb "$DATA_DIR/kilo.db")"; total_kb=$(( total_kb + k )); echo "  $(mb "$k") MB  $DATA_DIR/kilo.db   （用 db-maintain.sh 瘦身）"; }
[ -d "$CACHE_DIR" ] && { k="$(dir_kb "$CACHE_DIR")"; total_kb=$(( total_kb + k )); echo "  $(mb "$k") MB  $CACHE_DIR"; }
bk_kb=0; bk_n=0
while IFS= read -r f; do bk_kb=$(( bk_kb + $(file_kb "$f") )); bk_n=$(( bk_n + 1 )); done < <(find "$CONFIG_PARENT" -maxdepth 1 -name 'kilo.backup-*' -type f 2>/dev/null)
[ "$bk_n" -gt 0 ] && { total_kb=$(( total_kb + bk_kb )); echo "  $(mb "$bk_kb") MB  $CONFIG_PARENT/kilo.backup-*  （$bk_n 个）"; }
echo "  ----"
echo "  $(mb "$total_kb") MB  合计（kilo 相关可清理范围）"

[ "$MODE" = "status" ] && exit 0

# ---------- 1) 临时目录兄弟项（agent 自己建的沙箱/测试库/旧备份） ----------
echo ""
echo "== 1) 临时目录兄弟项：保留最近 $DAYS 天 =="
sib_found=0
while IFS= read -r d; do
  sib_found=1
  if older_than "$d" "$DAYS"; then plan_remove "$d" "$(dir_kb "$d")"; else echo "  [KEEP] $(mb "$(dir_kb "$d")") MB  $d"; fi
done < <(find "$TMPN" -maxdepth 1 \( -name 'kilo-*' -o -name 'kilo_*' \) 2>/dev/null | sort)
[ "$sib_found" = "0" ] && echo "  (无)"

# ---------- 2) Kilo 托管临时目录内部过期条目 ----------
# 注意：只清内部条目，绝不删除 $KILO_TMP 本身（Kilo 随时可能往里写 remote-attachments 等）
echo ""
echo "== 2) $KILO_TMP 内部条目：保留最近 $TMP_DAYS 天 =="
tmp_found=0
while IFS= read -r e; do
  tmp_found=1
  if older_than "$e" "$TMP_DAYS"; then plan_remove "$e" "$(if [ -d "$e" ]; then dir_kb "$e"; else file_kb "$e"; fi)"; else echo "  [KEEP] $e"; fi
done < <(find "$KILO_TMP" -maxdepth 1 -mindepth 1 2>/dev/null | sort)
[ "$tmp_found" = "0" ] && echo "  (无)"

# ---------- 3) 配置备份：只留最近 N 个 ----------
echo ""
echo "== 3) 配置备份：保留最近 $KEEP_BACKUPS 个 =="
bk_list="$(find "$CONFIG_PARENT" -maxdepth 1 -name 'kilo.backup-*' -type f -printf '%T@\t%p\n' 2>/dev/null | sort -rn | cut -f2- || true)"
if [ -z "$bk_list" ]; then
  echo "  (无)"
else
  i=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    i=$(( i + 1 ))
    if [ "$i" -le "$KEEP_BACKUPS" ]; then echo "  [KEEP] $(mb "$(file_kb "$f")") MB  $f"; else plan_remove "$f" "$(file_kb "$f")"; fi
  done <<< "$bk_list"
fi

# ---------- 摘要 ----------
echo ""
if [ "$MODE" = "run" ]; then
  echo "== 完成：删除 $DELETED 项，释放约 $(mb "$PLANNED_KB") MB =="
else
  echo "== 预览：可删除 $(mb "$PLANNED_KB") MB ==（加 --run 实际执行）"
fi
