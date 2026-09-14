#!/usr/bin/env bash
# kilo.db 维护：清理事件溯源表 + 过期会话数据，保留记忆/凭证/近期会话
#
# 背景（2026-09-14 实测）：kilo.db 14.2GB 的构成 ——
#   event 表 202 万行（message.part.updated 144万 + message.updated 38万 + …，纯事件溯源日志）
#   part 表 106 万行（消息内容，98.3 万行早于 2026-09）
#   message 24.7 万行 / session 1 万行（2026-04-29 起累积）
#   真正有价值且极小：memory/（每项目几 KB）、credential 20 行、project 27 行
#
# 用法：
#   ./db-maintain.sh            清理（默认保留最近 30 天会话，event 全清后重建基线）
#   ./db-maintain.sh --days N   自定义保留天数
#   ./db-maintain.sh --status   只读体检，不动数据
#
# 安全性：只 DELETE 事件流/过期消息；不触碰 memory、credential、project。
#         kilo.db 被 Kilo 进程独占锁，运行中执行会失败 —— 先关 VS Code/Kilo。
set -euo pipefail

EXT="${KILO_EXE:-}"
if [ -z "$EXT" ] || [ ! -x "$EXT" ]; then
  # 自动发现最新扩展内嵌 CLI（不再硬编码版本号：扩展升级后旧路径失效）
  EXT="$(ls -d "$HOME"/.vscode/extensions/kilocode.kilo-code-*/bin/kilo.exe 2>/dev/null | sort -V | tail -1)"
fi
DB="$HOME/.local/share/kilo/kilo.db"
DAYS=30
MODE=run

while [ $# -gt 0 ]; do
  case "$1" in
    --days) shift; DAYS="$1" ;;
    --status) MODE=status ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -x "$EXT" ] || { echo "FAIL: kilo.exe not found at $EXT" >&2; exit 1; }
[ -f "$DB" ] || { echo "FAIL: $DB not found" >&2; exit 1; }

q() { timeout 600 "$EXT" db "$1" --format json 2>/dev/null; }

size_gb() { du -m "$DB" | cut -f1 | awk '{printf "%.1f", $1/1024}'; }
cnt() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=s.indexOf('[');console.log(JSON.parse(s.slice(i))[0].c.toLocaleString())})"; }

echo "== kilo.db 体检 =="
echo "  文件: $DB  ($(size_gb) GB)"
echo "  event:      $(q "SELECT COUNT(*) c FROM event"      | cnt) rows"
echo "  part:       $(q "SELECT COUNT(*) c FROM part"       | cnt) rows"
echo "  message:    $(q "SELECT COUNT(*) c FROM message"    | cnt) rows"
echo "  session:    $(q "SELECT COUNT(*) c FROM session"    | cnt) rows"
echo "  credential: $(q "SELECT COUNT(*) c FROM credential" | cnt) rows (protected)"

if [ "$MODE" = "status" ]; then exit 0; fi

CUTOFF=$(node -e "console.log(Date.now() - $DAYS*86400000)")

echo ""
echo "== 清理（保留最近 $DAYS 天） =="
# 1) 事件溯源日志：全部清空（纯审计流水，无业务价值，占大头）
echo "  DELETE event (all) ..."
q "DELETE FROM event" >/dev/null && echo "    ok"
q "DELETE FROM event_sequence" >/dev/null && echo "    ok (event_sequence)"

# 2) 过期消息内容（级联清 part；session 保留行以免历史会话列表损坏）
echo "  DELETE messages older than $DAYS days ..."
q "DELETE FROM message WHERE time_created < $CUTOFF" >/dev/null && echo "    ok"
q "DELETE FROM session WHERE time_created < $CUTOFF AND id NOT IN (SELECT DISTINCT session_id FROM message)" >/dev/null && echo "    ok (empty old sessions)"
q "DELETE FROM todo WHERE session_id NOT IN (SELECT id FROM session)" >/dev/null && echo "    ok (orphan todos)"

echo ""
echo "== VACUUM（回收磁盘空间，可能需要几分钟）=="
q "VACUUM" >/dev/null && echo "  ok"
echo ""
echo "== 完成 =="
echo "  文件: $(size_gb) GB"
echo "  event:      $(q "SELECT COUNT(*) c FROM event"   | cnt) rows"
echo "  part:       $(q "SELECT COUNT(*) c FROM part"    | cnt) rows"
echo "  memory 目录未动: $(find "$HOME/.local/share/kilo/memory" -type f 2>/dev/null | wc -l) files"
