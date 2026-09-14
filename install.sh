#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/kilo.json"
TARGET_DIR="${KILO_SYNC_TARGET:-$HOME/.config/kilo}"
TARGET_DIR="${TARGET_DIR//\\//}"
TARGET="$TARGET_DIR/kilo.json"

if [ ! -f "$SOURCE" ]; then
    echo "[INSTALL] FAIL: source not found: $SOURCE" >&2
    exit 1
fi

PY=""
if command -v python >/dev/null 2>&1 && python -c "import json" >/dev/null 2>&1; then
    PY="python"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import json" >/dev/null 2>&1; then
    PY="python3"
fi

if [ -n "$PY" ]; then
    if ! "$PY" -c "import json,sys; json.load(open(sys.argv[1]))" "$SOURCE" >/dev/null 2>&1; then
        echo "[INSTALL] FAIL: kilo.json is not valid JSON" >&2
        exit 1
    fi
else
    echo "[INSTALL] WARN: python not found, JSON validation skipped" >&2
fi

if [ ! -d "$TARGET_DIR" ]; then
    mkdir -p "$TARGET_DIR"
    echo "[CREATE] $TARGET_DIR"
fi

if [ -f "$TARGET" ]; then
    BACKUP="$TARGET.bak.$(date +%Y%m%d-%H%M%S)"
    cp -f "$TARGET" "$BACKUP"
    echo "[BACKUP] $BACKUP"
fi

cp -f "$SOURCE" "$TARGET"

if command -v sha256sum >/dev/null 2>&1; then
    H1="$(sha256sum "$SOURCE" | cut -d" " -f1)"
    H2="$(sha256sum "$TARGET" | cut -d" " -f1)"
elif command -v shasum >/dev/null 2>&1; then
    H1="$(shasum -a 256 "$SOURCE" | cut -d" " -f1)"
    H2="$(shasum -a 256 "$TARGET" | cut -d" " -f1)"
else
    H1=""; H2=""
fi

if [ -n "$H1" ] && [ "$H1" != "$H2" ]; then
    echo "[INSTALL] FAIL: hash mismatch after copy" >&2
    exit 1
fi

if [ -n "$PY" ]; then
    MODEL="$("$PY" -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('model','(none)'))" "$SOURCE" 2>/dev/null || echo "(none)")"
    SMALL="$("$PY" -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('small_model','(none)'))" "$SOURCE" 2>/dev/null || echo "(none)")"
    PROVIDERS="$("$PY" -c "import json,sys; c=json.load(open(sys.argv[1])); print(', '.join(c.get('provider',{}).keys()) or '(none)')" "$SOURCE" 2>/dev/null || echo "(none)")"
    AGENTS="$("$PY" -c "import json,sys; c=json.load(open(sys.argv[1])); print(', '.join(c.get('agent',{}).keys()) or '(none)')" "$SOURCE" 2>/dev/null || echo "(none)")"
else
    MODEL="(unknown)"; SMALL="(unknown)"; PROVIDERS="(unknown)"; AGENTS="(unknown)"
fi

echo ""
echo "[INSTALL] OK: $SOURCE -> $TARGET"
echo "  model        : $MODEL"
echo "  small_model  : $SMALL"
echo "  providers    : $PROVIDERS"
echo "  agents       : $AGENTS"
exit 0