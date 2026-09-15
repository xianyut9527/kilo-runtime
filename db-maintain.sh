#!/usr/bin/env bash
# kilo.db 维护：清理事件溯源表 + 过期会话数据，保留记忆/凭证/近期会话
#
# 背景（2026-09-14 实测）：kilo.db 的构成 ——
#   event 表（message.part.updated / message.updated 等纯事件溯源流水，占大头）
#   part 表（消息内容） / message / session
#   真正有价值且极小：memory/（每项目几 KB）、credential、project
#
# 用法：
#   ./db-maintain.sh               清理（默认保留最近 30 天会话）
#   ./db-maintain.sh --days N      自定义保留天数
#   ./db-maintain.sh --status      只读体检，不动数据
#   ./db-maintain.sh --no-vacuum   只 DELETE 不做 VACUUM（短锁，适合 Kilo 仍在运行）
#   ./db-maintain.sh --force       检测到其它 kilo 写者时仍执行 VACUUM（默认拒绝）
#   ./db-maintain.sh --batch N     调整 event 每批删除行数（默认 50000）
#   ./db-maintain.sh --batch-msg N 调整 message 每批删除行数（默认 2000，级联 part 更重）
#
# 安全性：只 DELETE 事件流/过期消息；不触碰 memory、credential、project。
#
# 2026-09-15 复查（为什么会出现「Failed to execute statement / UnknownError」）：
#   1. Kilo 的 sqlite 连接固定 `PRAGMA busy_timeout = 5000`（二进制内实测），
#      任何一条写语句拿不到锁超过 5s 就直接失败，Drizzle 把底层 SqliteError 包装成
#      固定文案 "Failed to execute statement"，UI 只显示 UnknownError —— 真实原因被吞。
#      即：维护期间正在跑的会话写库失败，就是这个报错（不是模型/provider 故障）。
#   2. VACUUM 需要独占锁且整体重写文件，在 Kilo 活着时执行 = 长时间占锁，
#      必然打断并发会话。因此默认在检测到 kilo 写者时拒绝 VACUUM。
#   3. DELETE 改为分批提交，缩短单次持锁时间；每条语句单独判定退出码，
#      旧版 `q "..." >/dev/null && echo ok` 会把失败静默当成成功（实测 VACUUM 被中止仍打印 ok）。
set -euo pipefail

EXT="${KILO_EXE:-}"
if [ -z "$EXT" ] || [ ! -x "$EXT" ]; then
  # 自动发现最新扩展内嵌 CLI（不再硬编码版本号：扩展升级后旧路径失效）
  EXT="$(ls -d "$HOME"/.vscode/extensions/kilocode.kilo-code-*/bin/kilo.exe 2>/dev/null | sort -V | tail -1)"
fi
# KILO_DB 覆盖时视为「离线/副本」目标：不套用 VACUUM 写者门禁（便于演练与迁移）
DB="${KILO_DB:-$HOME/.local/share/kilo/kilo.db}"
IS_LIVE=1; [ -n "${KILO_DB:-}" ] && IS_LIVE=0
DAYS=30
MODE=run
DO_VACUUM=1
FORCE=0
BATCH_EVENT=50000  # 每批 DELETE 行数：控制单次写锁时长（Kilo busy_timeout 只有 5s）
BATCH_MSG=2000     # message 每行可能级联大量 part，批次要更小

usage() { sed -n '/^# 用法：/,/^#   .\/db-maintain.sh --batch-msg/p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --days)      [ $# -ge 2 ] || { echo "FAIL: --days 需要参数（如 --days 14）" >&2; exit 2; }; shift; DAYS="$1" ;;
    --status) MODE=status ;;
    --no-vacuum) DO_VACUUM=0 ;;
    --force) FORCE=1 ;;
    --batch)     [ $# -ge 2 ] || { echo "FAIL: --batch 需要参数（如 --batch 20000）" >&2; exit 2; }; shift; BATCH_EVENT="$1" ;;
    --batch-msg) [ $# -ge 2 ] || { echo "FAIL: --batch-msg 需要参数（如 --batch-msg 1000）" >&2; exit 2; }; shift; BATCH_MSG="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# 参数校验：--days 0 会把 cutoff=now 导致删光含当日的全部 message；
# --batch 0 会让 DELETE ... LIMIT 0 删零行却进入死循环（before>0, after==before）。
validate_int() { echo "$1" | grep -qE '^[0-9]+$' && [ "$1" -ge "$2" ]; }
validate_int "$DAYS" 1       || { echo "FAIL: --days 必须是 ≥1 的整数（0 会删光所有消息）" >&2; exit 2; }
validate_int "$BATCH_EVENT" 1 || { echo "FAIL: --batch 必须是 ≥1 的整数" >&2; exit 2; }
validate_int "$BATCH_MSG" 1   || { echo "FAIL: --batch-msg 必须是 ≥1 的整数" >&2; exit 2; }

[ -x "$EXT" ] || { echo "FAIL: kilo.exe not found at $EXT" >&2; exit 1; }
[ -f "$DB" ] || { echo "FAIL: $DB not found" >&2; exit 1; }

# 预检：能打开且结构完好才继续（否则每条语句都会各报一次同样的底层错误）
if ! timeout 600 "$EXT" db "SELECT COUNT(*) FROM sqlite_master" --format tsv --pure >/dev/null 2>&1; then
  echo "FAIL: 无法读取 $DB（文件损坏/非 sqlite/被占用）。" >&2
  timeout 600 "$EXT" db "SELECT COUNT(*) FROM sqlite_master" --format tsv --pure 2>&1 \
    | grep -iE 'sqlite|not a database|locked|unable|Error' | sed 's/\x1b\[[0-9;]*m//g' | head -2 >&2
  exit 1
fi

# 单条语句：退出码即真相（失败时把 CLI 的真实错误写到 stderr，去掉 ANSI 与 Bun 栈帧噪声）
q() {
  local out rc=0
  out="$(timeout 600 "$EXT" db "$1" --format tsv --pure 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  FAIL: $1" >&2
    printf '%s\n' "$out" \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | grep -v '^[[:space:]]*at ' \
      | grep -v '^[[:space:]]*[0-9]*[[:space:]]*|' \
      | grep -v '^[[:space:]]*[|^]' \
      | grep -v '^[[:space:]]*$' \
      | head -3 >&2 || true
    return "$rc"
  fi
  printf '%s\n' "$out"
}

# 标量计数（--format tsv 的第一行是列名，取最后一行为值）
cnt() { q "SELECT COUNT(*) c FROM $1" | tail -n1 | tr -d '\r' | awk '{print $1+0}'; }
cnt_where() { q "SELECT COUNT(*) c FROM $1 WHERE $2" | tail -n1 | tr -d '\r' | awk '{print $1+0}'; }

size_bytes() { stat -c %s "$1" 2>/dev/null || echo 0; }
gb() { awk -v b="$1" 'BEGIN{printf "%.2f", b/1073741824}'; }

# 写者检测：VACUUM 在 Kilo 存活时执行会长时间占锁、打断并发会话
writers() {
  if command -v pgrep >/dev/null 2>&1 && pgrep -x -c kilo >/dev/null 2>&1; then
    pgrep -x -c kilo || true
  elif command -v tasklist >/dev/null 2>&1; then
    tasklist 2>/dev/null | grep -ic 'kilo\.exe' || true
  else
    echo 0
  fi
}

echo "== kilo.db 体检 =="
echo "  文件: $DB  ($(gb "$(size_bytes "$DB")") GB, WAL $(gb "$(size_bytes "$DB-wal")") GB)"
echo "  event:      $(cnt event) rows"
echo "  part:       $(cnt part) rows"
echo "  message:    $(cnt message) rows"
echo "  session:    $(cnt session) rows"
echo "  credential: $(cnt credential) rows (protected)"
echo "  kilo 写者:  $(writers) 个进程"

if [ "$MODE" = "status" ]; then
  echo "  integrity:  $(q 'PRAGMA integrity_check' | tail -n1 | tr -d '\r')"
  exit 0
fi

if [ "$DO_VACUUM" = "1" ] && [ "$FORCE" != "1" ] && [ "$IS_LIVE" = "1" ] && [ "$(writers)" -gt 0 ]; then
  echo "" >&2
  echo "拒绝执行 VACUUM：检测到 $(writers) 个 kilo 进程在跑。" >&2
  echo "  VACUUM 需独占锁，会让正在进行的会话写库失败（busy_timeout=5s → 「Failed to execute statement」）。" >&2
  echo "  选择：关掉其它 Kilo 窗口后重跑；或加 --no-vacuum（只清理不回收空间）；或 --force 强制。" >&2
  exit 1
fi

CUTOFF=$(node -e "console.log(Date.now() - $DAYS*86400000)")
FAILED=0

# 单批耗时观测：Kilo 侧 busy_timeout 只有 5s，任一批次超过该值就会打断并发会话。
# 注意：`kilo db` 每次调用约 2s 是 CLI 冷启动开销（Bun + 迁移检查），不是持锁时间，
# 因此这里只统计「本批剩余待删行数」的收敛情况，阈值放宽以吸收启动开销。
# 超阈值只告警不中断（已提交的批次是有效进展，可重跑收敛）。
elapsed_ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
report_batch() {
  local before="$1" after="$2" t0="$3" what="$4"
  local ms; ms=$(elapsed_ms "$t0")
  printf '    %s: %s -> %s (%sms)\n' "$what" "$before" "$after" "$ms"
  [ "$ms" -gt "${BATCH_WARN_MS:-6000}" ] && echo "    ⚠ 单批 ${ms}ms 偏长，建议减小批次行数" >&2
  return 0
}

# 分批删除：把长事务拆成短事务，避免长时间独占写锁
# $1=目标表 $2=WHERE 子句 $3=每批行数 $4=标签
# 终止条件用「待删行数」而非全表计数 —— 过滤条件（如 age < cutoff）本身匹配 0 行时
# 全表计数不为 0，旧写法会误判为「未下降」而报假失败。
delete_batched() {
  local table="$1" where="$2" size="$3" label="$4" before after t0
  while :; do
    before=$(cnt_where "$table" "$where")
    [ "$before" -eq 0 ] && return 0
    t0=$(date +%s%N)
    q "DELETE FROM $table WHERE id IN (SELECT id FROM $table WHERE $where LIMIT $size)" >/dev/null || return 1
    after=$(cnt_where "$table" "$where")
    report_batch "$before" "$after" "$t0" "$label"
    # 并发写入可能抵消删除；待删行数不降即退出，避免死循环
    [ "$after" -ge "$before" ] && { echo "    stop: 待删行数未下降（并发写入中）" >&2; return 1; }
  done
}

echo ""
echo "== 清理（保留最近 $DAYS 天） =="
# 1) 事件溯源日志（纯审计流水，无业务价值，占大头）
echo "  DELETE event (batched $BATCH_EVENT) ..."
delete_batched event "1=1" "$BATCH_EVENT" "event" || FAILED=1
if [ "$FAILED" = "0" ]; then
  q "DELETE FROM event_sequence" >/dev/null || FAILED=1
  [ "$FAILED" = "0" ] && echo "    ok (event_sequence)"
fi

# 2) 过期消息：按 id 分批，避免「一条 DELETE 级联清空几十万 part」的长事务
echo "  DELETE messages older than $DAYS days (batched $BATCH_MSG) ..."
delete_batched message "time_created < $CUTOFF" "$BATCH_MSG" "message" || FAILED=1
q "DELETE FROM session WHERE time_created < $CUTOFF AND id NOT IN (SELECT DISTINCT session_id FROM message)" >/dev/null || FAILED=1
q "DELETE FROM todo WHERE session_id NOT IN (SELECT id FROM session)" >/dev/null || FAILED=1
echo "    done ($([ "$FAILED" = "0" ] && echo ok || echo '有失败，见上'))"

if [ "$DO_VACUUM" = "1" ]; then
  echo ""
  echo "== VACUUM（回收磁盘空间，可能需要几分钟）=="
  q "VACUUM" >/dev/null || FAILED=1
  echo "  $([ "$FAILED" = "0" ] && echo ok || echo 'FAILED')"
fi

# 3) 回收 WAL + 校验（旧版只写注释未实现 checkpoint，WAL 会一直挂在数据目录）
echo ""
echo "== WAL checkpoint + 校验 =="
q "PRAGMA wal_checkpoint(TRUNCATE)" >/dev/null && echo "  checkpoint ok" || FAILED=1
echo "  integrity: $(q 'PRAGMA integrity_check' | tail -n1 | tr -d '\r')"

echo ""
echo "== 完成 =="
echo "  文件: $(gb "$(size_bytes "$DB")") GB (WAL $(gb "$(size_bytes "$DB-wal")") GB)"
echo "  event:      $(cnt event) rows"
echo "  part:       $(cnt part) rows"
echo "  memory 目录未动: $(find "$HOME/.local/share/kilo/memory" -type f 2>/dev/null | wc -l | tr -d ' ') files"

[ "$FAILED" = "0" ] || { echo "有语句失败，退出码 1（数据未损坏，可重跑）" >&2; exit 1; }
