#!/usr/bin/env bash
# Kilo 全局配置安装脚本 (macOS / Linux)
# 将本仓库内容复制到全局配置目录：~/.config/kilo/

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.config/kilo"

# 需要排除的文件/目录
EXCLUDE_ITEMS=(
    ".git"
    ".gitignore"
    "install.ps1"
    "install.sh"
    "README.md"
    "node_modules"
    "package.json"
    "package-lock.json"
    "pnpm-lock.yaml"
    "bun.lock"
    "yarn.lock"
)

echo "========================================"
echo "  Kilo Global Config Installer"
echo "========================================"
echo ""
echo "Source : ${SOURCE_DIR}"
echo "Target : ${TARGET_DIR}"
echo ""

# 创建目标目录
mkdir -p "${TARGET_DIR}"
echo "Created directory: ${TARGET_DIR}"

# 构建 rsync 排除参数
EXCLUDE_ARGS=()
for item in "${EXCLUDE_ITEMS[@]}"; do
    EXCLUDE_ARGS+=("--exclude=${item}")
done

# 使用 rsync 复制（先删除旧文件再同步）
if command -v rsync &> /dev/null; then
    rsync -av --delete "${EXCLUDE_ARGS[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/"
else
    # 如果没有 rsync，使用 cp -r（先清理再复制）
    echo "rsync not found, using cp -r instead..."
    
    # 清理目标目录中的旧文件（排除 install.* 和 README.md）
    for item in "${TARGET_DIR}"/*; do
        if [ -e "$item" ]; then
            basename_item=$(basename "$item")
            skip=false
            for exclude in "${EXCLUDE_ITEMS[@]}"; do
                if [ "$basename_item" = "$exclude" ]; then
                    skip=true
                    break
                fi
            done
            if [ "$skip" = false ]; then
                rm -rf "$item"
                echo "Removed old: ${basename_item}"
            fi
        fi
    done
    
    # 复制新文件
    for item in "${SOURCE_DIR}"/*; do
        if [ -e "$item" ]; then
            basename_item=$(basename "$item")
            skip=false
            for exclude in "${EXCLUDE_ITEMS[@]}"; do
                if [ "$basename_item" = "$exclude" ]; then
                    skip=true
                    break
                fi
            done
            if [ "$skip" = false ]; then
                cp -r "$item" "${TARGET_DIR}/"
                echo "Copied: ${basename_item}"
            fi
        fi
    done
fi

# Kilo's current documentation uses an "agents/" directory for agent markdown.
# This repo keeps "agent/" as the source-of-truth directory name, so install a
# compatibility copy without duplicating maintenance in the repository.
if [ -d "${SOURCE_DIR}/agent" ]; then
    rm -rf "${TARGET_DIR}/agents"
    cp -r "${SOURCE_DIR}/agent" "${TARGET_DIR}/agents"
    echo "Copied compatibility directory: agents/"
fi

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "Please restart Kilo in your projects for changes to take effect."
echo ""
