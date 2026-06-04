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
    "agent-manager.json"
    "memory.md"
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

# 清理曾被误同步到全局配置的本地依赖产物；保留 Kilo 自己维护的会话与记忆文件。
GENERATED_ITEMS=(
    ".kilo/node_modules"
    ".kilo/package.json"
    ".kilo/package-lock.json"
    ".kilo/pnpm-lock.yaml"
    ".kilo/bun.lock"
    ".kilo/yarn.lock"
)

for item in "${GENERATED_ITEMS[@]}"; do
    if [ -e "${TARGET_DIR}/${item}" ]; then
        rm -rf "${TARGET_DIR:?}/${item}"
        echo "Cleaned generated artifact: ${item}"
    fi
done

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

    is_excluded() {
        local name="$1"
        for exclude in "${EXCLUDE_ITEMS[@]}"; do
            if [ "$name" = "$exclude" ]; then
                return 0
            fi
        done
        return 1
    }

    copy_config_tree() {
        local src_dir="$1"
        local dst_dir="$2"
        mkdir -p "$dst_dir"

        shopt -s nullglob dotglob
        for child in "$src_dir"/*; do
            local basename_item
            basename_item=$(basename "$child")
            if is_excluded "$basename_item"; then
                continue
            fi

            if [ -d "$child" ]; then
                copy_config_tree "$child" "${dst_dir}/${basename_item}"
            else
                cp "$child" "${dst_dir}/"
            fi
        done

        for child in "$dst_dir"/*; do
            local basename_item
            basename_item=$(basename "$child")
            if is_excluded "$basename_item"; then
                continue
            fi
            if [ ! -e "${src_dir}/${basename_item}" ]; then
                rm -rf "$child"
                echo "Removed stale: ${child#${TARGET_DIR}/}"
            fi
        done
        shopt -u nullglob dotglob
    }
    
    # 清理目标目录中的旧顶层文件；保留 .kilo 以免删除 Kilo 自己维护的会话与记忆文件。
    for item in "${TARGET_DIR}"/*; do
        if [ -e "$item" ]; then
            basename_item=$(basename "$item")
            if [ "$basename_item" = ".kilo" ]; then
                continue
            fi
            if ! is_excluded "$basename_item"; then
                rm -rf "$item"
                echo "Removed old: ${basename_item}"
            fi
        fi
    done
    
    # 复制新文件
    for item in "${SOURCE_DIR}"/*; do
        if [ -e "$item" ]; then
            basename_item=$(basename "$item")
            if ! is_excluded "$basename_item"; then
                if [ -d "$item" ]; then
                    copy_config_tree "$item" "${TARGET_DIR}/${basename_item}"
                else
                    cp "$item" "${TARGET_DIR}/"
                fi
                echo "Copied: ${basename_item}"
            fi
        fi
    done
fi

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "Please restart Kilo in your projects for changes to take effect."
echo ""
