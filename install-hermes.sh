#!/usr/bin/env bash
# Hermes Config Installer (Linux / macOS / WSL2)
# Syncs hermes_config/ directory to: ~/.hermes/
# IMPORTANT: EXCLUDE lists must be kept in sync with install-hermes.ps1
# 本脚本只安装 Hermes 配置产物（SOUL.md + config.yaml + .hermes.md + skills）。
# 本地记忆（~/.hermes/memories/）属于个人/设备资产，不纳入仓库同步。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/hermes_config"
TARGET="$HOME/.hermes"

if [ ! -d "$SOURCE" ]; then
    echo "[SYNC] FAIL: hermes_config/ directory not found at $SOURCE"
    exit 1
fi

# 仅在仓库根层级排除的项
ROOT_ONLY_EXCLUDE=(
    "install-hermes.ps1"
    "install-hermes.sh"
)

# 所有层级都排除的项
RECURSIVE_EXCLUDE=(
    ".git"
    ".gitignore"
    "node_modules"
    "package.json"
    "package-lock.json"
    "pnpm-lock.yaml"
    "bun.lock"
    "yarn.lock"
    "agent-manager.json"
)

echo "========================================"
echo "  Hermes Config Installer"
echo "========================================"
echo ""
echo "Source: $SOURCE"
echo "Target: $TARGET"
echo ""
echo "Mode: merge update — preserve Hermes runtime dirs (sessions/cron/logs/...)"
echo "Scope: SOUL.md + config.yaml + .hermes.md + skills"
echo ""

# 合并式更新：只删除/覆盖要同步的配置产物，保留运行时目录
if [ -d "$TARGET" ]; then
    echo "[CLEAN] Removing old config files in $TARGET"
    rm -rf "$TARGET/SOUL.md"
    rm -rf "$TARGET/config.yaml"
    rm -rf "$TARGET/.hermes.md"
    rm -rf "$TARGET/skills"
fi

mkdir -p "$TARGET"

CopiedFiles=0
CopiedDirs=0

# 使用 rsync 同步（如果可用），否则用 cp
if command -v rsync &> /dev/null; then
    exclude_args=()
    for e in "${ROOT_ONLY_EXCLUDE[@]}"; do
        exclude_args+=("--exclude=$e")
    done
    for e in "${RECURSIVE_EXCLUDE[@]}"; do
        exclude_args+=("--exclude=$e")
    done
    rsync -a "${exclude_args[@]}" "$SOURCE/" "$TARGET/"
    CopiedFiles=$(find "$TARGET" -type f | wc -l | tr -d ' ')
    CopiedDirs=$(find "$TARGET" -type d | wc -l | tr -d ' ')
    echo "[COPY] Synced $CopiedFiles files, $CopiedDirs dirs via rsync"
else
    # Fallback: cp + manual exclude
    for item in "$SOURCE"/*; do
        name=$(basename "$item")
        skip=false
        for e in "${ROOT_ONLY_EXCLUDE[@]}"; do
            [ "$name" = "$e" ] && skip=true && break
        done
        for e in "${RECURSIVE_EXCLUDE[@]}"; do
            [ "$name" = "$e" ] && skip=true && break
        done
        if [ "$skip" = "false" ]; then
            cp -r "$item" "$TARGET/"
            if [ -d "$item" ]; then
                CopiedDirs=$((CopiedDirs + 1))
            else
                CopiedFiles=$((CopiedFiles + 1))
            fi
        fi
    done
    echo "[COPY] Synced $CopiedFiles files, $CopiedDirs dirs via cp"
fi

echo ""

# ============================================================
# 关键文件存在性校验
# ============================================================
CriticalFiles=("SOUL.md" "config.yaml" ".hermes.md")
Missing=()
for f in "${CriticalFiles[@]}"; do
    if [ ! -f "$TARGET/$f" ]; then
        Missing+=("$f")
    fi
done

if [ ${#Missing[@]} -gt 0 ]; then
    echo "[SYNC] FAIL: missing critical files: ${Missing[*]}"
    exit 1
fi

echo "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | critical=${#CriticalFiles[@]}/${#CriticalFiles[@]} | target=$TARGET"

echo ""
echo "Next steps:"
echo "  1. Install Hermes Agent: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
echo "  2. Configure provider: hermes model (select custom endpoint)"
echo "  3. Start: hermes"
echo "  4. Verify: hermes doctor"
echo ""
echo "Note: local memories/ are personal/device assets and are NOT synced by this script."
echo ""
exit 0
