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
#   ./db-maintain.sh --ivac N      调整 incremental_vacuum 每次回收页数（默认 20000=80MB）
#
# 集成（2026-10-07，2026-10-08 补 session_share/snapshot）：DB 清理完成后自动跑
# storage-maintain（session_diff/log/tsc-cache 30 天窗 + session_share 60 天独立窗 +
# snapshot 目录级回收 + tool-output 失控看门狗 256MB/闲置 60min），失败只告警不中断 DB 清理。
# 本脚本不解决调度——建议空闲窗口每周跑一次（或接入 Kilo 定时任务）。
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
IVAC_PAGES=20000   # incremental_vacuum 每次回收页数（4096B×20000≈80MB/趟）

usage() { sed -n '/^# 用法：/,/^#   .\/db-maintain.sh --ivac/p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --days)      [ $# -ge 2 ] || { echo "FAIL: --days 需要参数（如 --days 14）" >&2; exit 2; }; shift; DAYS="$1" ;;
    --status) MODE=status ;;
    --no-vacuum) DO_VACUUM=0 ;;
    --force) FORCE=1 ;;
    --batch)     [ $# -ge 2 ] || { echo "FAIL: --batch 需要参数（如 --batch 20000）" >&2; exit 2; }; shift; BATCH_EVENT="$1" ;;
    --batch-msg) [ $# -ge 2 ] || { echo "FAIL: --batch-msg 需要参数（如 --batch-msg 1000）" >&2; exit 2; }; shift; BATCH_MSG="$1" ;;
    --ivac)      [ $# -ge 2 ] || { echo "FAIL: --ivac 需要参数（如 --ivac 10000）" >&2; exit 2; }; shift; IVAC_PAGES="$1" ;;
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
validate_int "$IVAC_PAGES" 1  || { echo "FAIL: --ivac 必须是 ≥1 的整数" >&2; exit 2; }

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

# sqlite3 直连（2026-10-08 专项）：kilo db CLI 每次调用是独立连接，且实测不持久化
# PRAGMA 写入——`kilo db "PRAGMA auto_vacuum=2"` 后再查仍为 0。而 auto_vacuum 转换
# 必须与 VACUUM 在**同一连接**才生效（auto_vacuum 仅在 VACUUM 重写文件时落地）。
# sqlite3.exe 直连单进程单连接，multi-statement 一次成型。缺失时功能降级（见使用点）。
# ⚠ `${KSQLITE3-…}`（无冒号）：显式传空串 = 「强制无 sqlite3」测试注入；`:-` 会把
# 空串当 unset 落回真 sqlite3，测试无法构造「缺失」场景。
SQLITE3_BIN="${KSQLITE3-$(command -v sqlite3 || true)}"
[ -z "$SQLITE3_BIN" ] || [ -x "$SQLITE3_BIN" ] || SQLITE3_BIN=""
qs() {
  if [ -z "$SQLITE3_BIN" ]; then
    echo "  FAIL: sqlite3 不可用: $1" >&2
    return 3
  fi
  local out rc=0
  out="$(timeout 600 "$SQLITE3_BIN" "$DB" "$1" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  FAIL(sqlite3): $1" >&2
    printf '%s\n' "$out" | head -3 >&2
    return "$rc"
  fi
  printf '%s\n' "$out"
}

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

# 可回收空间：--no-vacuum 只 DELETE 不缩文件，删除后的空闲页留在库里（freelist）。
# 不显示这一行，用户会以为「瘦身没生效」（文件还是 4.76GB）而漏掉 VACUUM 的触发时机（正常重跑即按阈值自动执行）。
# page_count*free 只读计算，无锁；VACUUM 才是需要独占锁的那一步（按阈值自动，见下方门控）。
# 注意 `|| true`：q() 失败 rc 非零，本脚本 set -euo pipefail —— 纯赋值语句的退出码就是
# 命令替换（管道）的退出码，q 挂会让整个 --status 半途死掉、run 模式在清理前 abort
# （体检是增强信息，不能反过来变成新的单点故障）。失败时 $(...) 产出**空串**而非 0：
# 空串进 `[ -gt 0 ]` 会打 integer expression expected 噪声，故 awk 前先兜底空输入，
# 保证 PAGE_COUNT 恒为数字（失败=0 → 整块静默跳过）。
read_pragma() { q "$1" | tail -n1 | tr -d '\r' | awk 'NF{print $1+0} END{if(NR==0)print 0}'; }
PAGE_COUNT=$(read_pragma 'PRAGMA page_count') || true
FREE_COUNT=$(read_pragma 'PRAGMA freelist_count') || true
PAGE_SIZE=$(read_pragma 'PRAGMA page_size') || true
# auto_vacuum 模式（2026-10-08 引导死锁自诊断）：0=none（空闲页进 freelist 后永不自动归还，
# 库只增不缩）/ 2=incremental（空闲页可被 incremental_vacuum 短锁增量回收，Kilo 在跑也安全）。
# 体检即读出，供下方 --status 与 run 模式 SKIP_VACUUM 段判断是否处于「引导死锁」态。
AV_MODE=$(read_pragma 'PRAGMA auto_vacuum') || true
if [ "$PAGE_COUNT" -gt 0 ] && [ "$PAGE_SIZE" -gt 0 ]; then
  FREE_GB=$(awk -v f="$FREE_COUNT" -v s="$PAGE_SIZE" 'BEGIN{printf "%.2f", f*s/1073741824}')
  USED_GB=$(awk -v c="$PAGE_COUNT" -v f="$FREE_COUNT" -v s="$PAGE_SIZE" 'BEGIN{printf "%.2f", (c-f)*s/1073741824}')
  FREE_PCT=$(awk -v f="$FREE_COUNT" -v c="$PAGE_COUNT" 'BEGIN{printf "%d", (c>0?100*f/c:0)}')
  echo "  可回收:     ${FREE_GB} GB 空闲页 / ${USED_GB} GB 有效页（空闲占比 ${FREE_PCT}%）"
fi
echo "  auto_vacuum: ${AV_MODE:-?}  $([ "${AV_MODE:-0}" = "2" ] && echo '(incremental：空闲页可短锁增量回收)' || echo '(none：空闲页永不自动归还，需一次性 VACUUM 引导为 2)')"

# VACUUM 门槛（2026-10-07）：维护自动化此前只跑 --no-vacuum，是「文件永不缩」的根因——
# 实测 7.34GB 文件里 5.4GB（74%）是历史 DELETE 留下的 freelist 空洞：扫描变慢且占盘。
# 空闲占比达阈值（默认 25%）且无 Kilo 写者时才值得付一次独占锁（实测 7.34GB→1.49GB
# 约 150s；期间并发 Kilo 写库会失败）；占比低时 VACUUM 收益小于风险，跳过。
# VACUUM_MIN_PCT=0 表示永不自动 VACUUM。
VACUUM_MIN_PCT="${VACUUM_MIN_PCT:-25}"

if [ "$MODE" = "status" ]; then
  echo "  integrity:  $(q 'PRAGMA integrity_check' | tail -n1 | tr -d '\r')"
  # 引导死锁自诊断（2026-10-08，附加告警，不替换下方维护建议）：auto_vacuum≠2 + 空闲占比达阈值
  # = 空闲页永远收不回。机理：增量回收(incremental_vacuum)需 auto_vacuum=2；0→2 转换只能靠
  # 一次独占 VACUUM；而 VACUUM 被「有 kilo 写者就跳过」门禁挡住，Kilo 常驻 → 引导永不发生
  # → 库单调膨胀、越用越慢。唯一出路是一次性离线 VACUUM（关闭全部 Kilo 后跑本脚本，无写者
  # 时自动回收 + 转 auto_vacuum=2，此后增量回收自动维持，无需再离线）。
  if [ "${AV_MODE:-0}" != "2" ] && [ "${FREE_PCT:-0}" -ge "$VACUUM_MIN_PCT" ]; then
    echo "  ⚠ 引导死锁:  auto_vacuum=${AV_MODE:-0}(none) 且空闲占比 ${FREE_PCT}%（${FREE_GB:-0} GB 空洞）——空闲页永不自动归还，库越用越大越慢。"
    echo "               一次性修复：关闭全部 Kilo 后跑 ./db-maintain.sh（自动 VACUUM 回收 + 转 auto_vacuum=2，此后增量回收自动维持）。"
  fi
  if [ "$DO_VACUUM" = "1" ] && [ "$IS_LIVE" = "1" ]; then
    if [ "$(writers)" -gt 0 ]; then
      echo "  维护建议:   Kilo 有写者 → VACUUM 自动跳过（关闭全部 Kilo 后跑 ./db-maintain.sh 即回收）"
    elif [ "${FREE_PCT:-0}" -ge "$VACUUM_MIN_PCT" ]; then
      echo "  维护建议:   空闲占比 ${FREE_PCT}% ≥ ${VACUUM_MIN_PCT}% 且无写者 → 现在跑 ./db-maintain.sh 可回收 ${FREE_GB} GB"
    else
      echo "  维护建议:   空闲占比 ${FREE_PCT}% < ${VACUUM_MIN_PCT}%，无需 VACUUM"
    fi
  fi
  exit 0
fi

# VACUUM 前门禁（2026-10-07 修正）：有 kilo 写者时不 *中止* 整个脚本，而是**降级跳过**
# VACUUM 继续做完 DELETE 清理 + WAL checkpoint。旧行为 exit 1 的后果是：只要 kilo.exe 常驻
# （后台进程 runner 会一直活着=writers 恒 >0），DELETE 清理与 WAL 回收**从未执行过**
# （实测 state.json lastDb 停在 2026-09-27，DB 从那时起只增不减）。
# 独占锁只有 VACUUM 需要；分批 DELETE 用短事务，Kilo 活着是安全的。
# --force：显式要求即使有写者也要 VACUUM。
SKIP_VACUUM=0
if [ "$DO_VACUUM" = "1" ] && [ "$FORCE" != "1" ] && [ "$IS_LIVE" = "1" ] && [ "$(writers)" -gt 0 ]; then
  echo "  跳过 VACUUM：检测到 $(writers) 个 kilo 进程在跑（独占锁会让在跑的会话写库失败）——"
  echo "  本轮只做 DELETE 清理 + WAL checkpoint；空闲页留在库里，等无写者时再回收。" >&2
  # 引导死锁告警（2026-10-08）：auto_vacuum≠2 时 incremental_vacuum 是 no-op，本轮 DELETE 释放的
  # 空闲页没有任何自动回收者 → 库单调膨胀。必须一次性离线 VACUUM 引导 auto_vacuum=2；已是 2
  # 则下方 incremental_vacuum 短锁增量回收，Kilo 开着也安全，无需离线。
  if [ "${AV_MODE:-0}" != "2" ]; then
    echo "  ⚠ 引导死锁：auto_vacuum=${AV_MODE:-0}(none) → 增量回收不生效，这些空闲页永远不会被自动归还，库会越用越大越慢。" >&2
    echo "     一次性修复：关闭全部 Kilo 后重跑本脚本（无写者时自动 VACUUM 回收 + 转 auto_vacuum=2，此后增量回收自动维持）。" >&2
  else
    echo "  auto_vacuum=2：空闲页将由下方 incremental_vacuum 短锁增量回收，Kilo 开着也安全，无需离线。" >&2
  fi
  echo "  想强制回收：关掉全部 Kilo 后重跑本脚本（或加 --force）。" >&2
  SKIP_VACUUM=1
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

VACUUM_DONE=0
if [ "$DO_VACUUM" = "1" ] && [ "$SKIP_VACUUM" = "0" ] && [ "${FREE_PCT:-0}" -ge "$VACUUM_MIN_PCT" ]; then
  echo ""
  echo "== VACUUM（空闲占比 ${FREE_PCT}% ≥ ${VACUUM_MIN_PCT}%，回收磁盘空间，可能需要几分钟）=="
  # 同连接原子转换（2026-10-08）：`PRAGMA auto_vacuum=2; VACUUM;` 一次成型 —— auto_vacuum
  # 只在 VACUUM 重写文件时落地，kilo db CLI 每调用一条语句即独立连接且 PRAGMA 写不持久化
  # （实测），故必须走 sqlite3 直连；转换一次性生效后，后续 DELETE 的空闲页可被
  # incremental_vacuum 增量回收，无需再等下一次全量 VACUUM（根治「文件只增不缩」）。
  # 逆转回滚：sqlite3 "$DB" "PRAGMA auto_vacuum=0; VACUUM;"（同样需同连接）。
  # av_now 读取失败按 0 处理（set -o pipefail 下命令替换内失败会冒泡，需 || true 兜底）。
  if [ -n "$SQLITE3_BIN" ]; then
    av_now="$(qs 'PRAGMA auto_vacuum;' | tail -n1 | tr -d '\r' | awk '{print $1+0}')" || av_now=0
    if [ "${av_now:-0}" = "2" ]; then
      q "VACUUM" >/dev/null || FAILED=1
      VACUUM_DONE=1
    elif qs "PRAGMA auto_vacuum=2; VACUUM; PRAGMA auto_vacuum;" >/dev/null 2>&1; then
      VACUUM_DONE=1
      echo "  auto_vacuum=2 已转换（此后空闲页走 incremental_vacuum 增量回收）"
    else
      # 转换失败不致命：退回 kilo-CLI VACUUM，维持旧回收能力
      echo "  ⚠ auto_vacuum 转换失败，降级为普通 VACUUM" >&2
      q "VACUUM" >/dev/null || FAILED=1
    fi
  else
    # sqlite3 缺失：旧行为照跑（kilo db 单条 VACUUM 仍可回收，只是 freelist 会再累积）
    echo "  ⚠ sqlite3 不可用，跳过 auto_vacuum 转换（普通 VACUUM 照常）" >&2
    q "VACUUM" >/dev/null || FAILED=1
  fi
  echo "  $([ "$VACUUM_DONE" = "1" ] && [ "$FAILED" = "0" ] && echo ok || echo 'FAILED')"
elif [ "$DO_VACUUM" = "1" ]; then
  echo ""
  if [ "$SKIP_VACUUM" = "1" ]; then
    echo "== VACUUM 跳过（有 kilo 写者）=="
  else
    echo "== VACUUM 跳过（空闲占比 ${FREE_PCT:-0}% < ${VACUUM_MIN_PCT}%，收益小于风险）=="
  fi
fi

# 增量回收闭环（2026-10-08）：DELETE 释放的页在 auto_vacuum=2 下靠 incremental_vacuum
# 归还磁盘——无独占锁（整库重写），Kilo 在跑也安全；free modes: 0=none 1=full(=VACUUM
# 语义) 2=incremental。仅在本轮没做全量 VACUUM（freelist 已被重写清零）时才值得跑；
# freelist<IVAC_PAGES 时收益太小，不白付锁。
if [ "$VACUUM_DONE" = "0" ]; then
  AV_MODE="$(q 'PRAGMA auto_vacuum' | tail -n1 | tr -d '\r' | awk '{print $1+0}')" || AV_MODE=0
  FL_NOW="$(q 'PRAGMA freelist_count' | tail -n1 | tr -d '\r' | awk '{print $1+0}')" || FL_NOW=0
  if [ "${AV_MODE:-0}" = "2" ] && [ "${FL_NOW:-0}" -ge "$IVAC_PAGES" ]; then
    echo ""
    echo "== incremental_vacuum（auto_vacuum=2，每趟回收 ${IVAC_PAGES} 页，短锁）=="
    if q "PRAGMA incremental_vacuum($IVAC_PAGES)" >/dev/null; then
      FL_AFTER="$(q 'PRAGMA freelist_count' | tail -n1 | tr -d '\r' | awk '{print $1+0}')"
      echo "  ok（freelist $FL_NOW -> $FL_AFTER 页）"
    else
      echo "  ⚠ incremental_vacuum 失败（下轮重试，不影响清理结果）" >&2
    fi
  fi
fi

# 3) 回收 WAL + 校验（旧版只写注释未实现 checkpoint，WAL 会一直挂在数据目录）
echo ""
echo "== WAL checkpoint + 校验 =="
q "PRAGMA wal_checkpoint(TRUNCATE)" >/dev/null && echo "  checkpoint ok" || FAILED=1
echo "  integrity: $(q 'PRAGMA integrity_check' | tail -n1 | tr -d '\r')"

# 4) 存储垃圾回收（session_diff/log/tsc-cache 30 天窗 + tool-output 失控看门狗）
#    独立工具：失败只告警，不影响本脚本的退出码（DB 清理状态仍以 FAILED 为准）
echo ""
echo "== storage-maintain（存储垃圾回收）=="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# MSYS 路径转换：git-bash 下 node 是原生 Windows 程序，收到 /d/work/... 会解析成
# D:\d\work\... → MODULE_NOT_FOUND（2026-10-07 实测：db-maintain 的自动回收步骤一直
# 静默失败，session_diff/log/snapshot 因而从未被回收）。cygpath -m 转成 D:/... 形式；
# 非 MSYS 环境（Linux/macOS）没有 cygpath，原样使用。
if command -v cygpath >/dev/null 2>&1; then
  STORAGE_SCRIPT="$(cygpath -m "$SCRIPT_DIR/scripts/storage-maintain.mjs")"
else
  STORAGE_SCRIPT="$SCRIPT_DIR/scripts/storage-maintain.mjs"
fi
if command -v node >/dev/null 2>&1; then
  if node "$STORAGE_SCRIPT" --run --days 30; then
    echo "  storage-maintain ok"
  else
    echo "  ⚠ storage-maintain 失败（不影响 DB 清理结果，可单独重跑）" >&2
  fi
else
  echo "  ⚠ node 不可用，跳过 storage-maintain" >&2
fi

echo ""
echo "== 完成 =="
echo "  文件: $(gb "$(size_bytes "$DB")") GB (WAL $(gb "$(size_bytes "$DB-wal")") GB)"
echo "  event:      $(cnt event) rows"
echo "  part:       $(cnt part) rows"
echo "  memory 目录未动: $(find "$HOME/.local/share/kilo/memory" -type f 2>/dev/null | wc -l | tr -d ' ') files"

[ "$FAILED" = "0" ] || { echo "有语句失败，退出码 1（数据未损坏，可重跑）" >&2; exit 1; }
