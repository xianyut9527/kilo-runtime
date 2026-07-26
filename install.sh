#!/usr/bin/env bash
# Kilo 全局配置安装脚本 (macOS / Linux)
# 将本仓库内容复制到全局配置目录：~/.config/kilo/
# IMPORTANT: EXCLUDE lists must be kept in sync with install.ps1

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.config/kilo"

# 仅在仓库根层级排除的项（防止误伤子目录中同名合法文件，如 .kilo/memory/README.md）
ROOT_ONLY_EXCLUDE=(
    "install.ps1"
    "install.sh"
    "README.md"
    "LICENSE"
)

# 所有层级都排除的项（必须与 install.ps1 保持完全一致）
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

COPIED_FILES=0
COPIED_DIRS=0

echo "========================================"
echo "  Kilo Global Config Installer"
echo "========================================"
echo ""
echo "Source : ${SOURCE_DIR}"
echo "Target : ${TARGET_DIR}"
echo ""

# 创建目标目录
mkdir -p "${TARGET_DIR}"

# 全量覆盖式更新：先清空目标目录，再同步（保留目标目录本身）
purge_target() {
    echo "[CLEAN] Purging target directory: ${TARGET_DIR}"
    find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
}

# 递归复制源目录到目标目录，同时按层级排除
# depth=0 表示仓库根层级
copy_source_tree() {
    local src_dir="$1"
    local dst_dir="$2"
    local depth="$3"

    shopt -s dotglob
    mkdir -p "${dst_dir}"

    for item in "${src_dir}"/*; do
        if [ -e "$item" ]; then
            local basename_item
            basename_item=$(basename "$item")
            local skip=false

            for exclude in "${RECURSIVE_EXCLUDE[@]}"; do
                if [ "$basename_item" = "$exclude" ]; then
                    skip=true
                    break
                fi
            done

            if [ "$skip" = false ] && [ "$depth" -eq 0 ]; then
                for exclude in "${ROOT_ONLY_EXCLUDE[@]}"; do
                    if [ "$basename_item" = "$exclude" ]; then
                        skip=true
                        break
                    fi
                done
            fi

            if [ "$skip" = true ]; then
                continue
            fi

            local target_item="${dst_dir}/${basename_item}"
            if [ -d "$item" ]; then
                copy_source_tree "$item" "${target_item}" $((depth + 1))
                echo "Copied: ${target_item#$TARGET_DIR/}/"
                COPIED_DIRS=$((COPIED_DIRS + 1))
            else
                cp "$item" "${target_item}"
                echo "Copied: ${target_item#$TARGET_DIR/}"
                COPIED_FILES=$((COPIED_FILES + 1))
            fi
        fi
    done
    shopt -u dotglob
}

# 构建 rsync 排除参数：根层级项用前导 / 锚定，递归项不加 /
EXCLUDE_ARGS=()
for item in "${ROOT_ONLY_EXCLUDE[@]}"; do
    EXCLUDE_ARGS+=("--exclude=/${item}")
done
for item in "${RECURSIVE_EXCLUDE[@]}"; do
    EXCLUDE_ARGS+=("--exclude=${item}")
done

# 使用 rsync 复制（先清空目标目录再同步）
if command -v rsync &> /dev/null; then
    purge_target
    rsync -av --delete "${EXCLUDE_ARGS[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/"

    # 统计 rsync 同步结果
    for item in "${SOURCE_DIR}"/*; do
        if [ -e "$item" ]; then
            basename_item=$(basename "$item")
            skip=false
            for exclude in "${ROOT_ONLY_EXCLUDE[@]}" "${RECURSIVE_EXCLUDE[@]}"; do
                if [ "$basename_item" = "$exclude" ]; then
                    skip=true
                    break
                fi
            done
            if [ "$skip" = false ]; then
                if [ -d "$item" ]; then
                    COPIED_DIRS=$((COPIED_DIRS + 1))
                else
                    COPIED_FILES=$((COPIED_FILES + 1))
                fi
            fi
        fi
    done
else
    # 如果没有 rsync，使用递归 cp（先清空再复制）
    echo "rsync not found, using cp -r instead..."

    purge_target
    copy_source_tree "${SOURCE_DIR}" "${TARGET_DIR}" 0
fi

# Note: agents/ compat copy intentionally removed.
# Having both agent/ and agents/ causes duplicate agent registration,
# which makes agent routing unstable.
# See https://kilo.ai/docs/configure/agents

# ============================================================
# 关键文件存在性校验
# ============================================================
CRITICAL_FILES=(
    "kilo.json"
    "AGENTS.md"
    ".kilo/instructions/core.md"
    ".kilo/instructions/workflow-core.md"
    ".kilo/instructions/reflection.md"
    "agent/orchestrator.md"
)

MISSING=()
for f in "${CRITICAL_FILES[@]}"; do
    if [ ! -e "${TARGET_DIR}/${f}" ]; then
        MISSING+=("$f")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "[SYNC] FAIL: missing critical files: ${MISSING[*]}"
    exit 1
fi

echo ""
echo "[SYNC] OK | files=${COPIED_FILES} dirs=${COPIED_DIRS} | critical=${#CRITICAL_FILES[@]}/${#CRITICAL_FILES[@]} | target=${TARGET_DIR}"
echo ""

# ============================================================
# kilo.json 路径占位符替换（保证 skills.external_dirs 跨平台可移植）
# ============================================================
echo "Substituting kilo.json path placeholders..."
# 注意：memory.db 路径使用 ${HOME}/.config/kilo-data/memory.db，由 bash + sqlite3 CLI 直接访问（v2.5-过渡版主通道），install 阶段不替换
# 注意：memory-mcp（v3.0 备用通道）已在 v2.6.2 精简中随 api/ 目录删除，kilo.json 不再引用 memory-mcp.js，此处无需替换 mcp 路径
KILO_JSON_PATH="${TARGET_DIR}/kilo.json"
if [ -f "${KILO_JSON_PATH}" ]; then
    sed -i.bak \
        -e "s|\${KILO_CONFIG_DIR}|${TARGET_DIR}|g" \
        "${KILO_JSON_PATH}" \
        && rm -f "${KILO_JSON_PATH}.bak"
    echo "[WRITE] kilo.json path placeholders substituted (KILO_CONFIG_DIR=${TARGET_DIR})"
else
    echo "[WARN] kilo.json not found at ${KILO_JSON_PATH}, skip substitution"
fi

# ============================================================
# Memory 层初始化（sqlite3 CLI + memory.db）
# 检测到缺失时提示用户，同意则自动安装 sqlite3 + 初始化 memory.db
# 缺失时记忆层静默降级（不报错但不写入，自我进化闭环不生效）
# ============================================================
echo ""
echo "========================================"
echo "  Memory Layer Setup (sqlite3 + memory.db)"
echo "========================================"

DB_DIR="${HOME}/.config/kilo-data"
DB_PATH="${DB_DIR}/memory.db"
# init.sql 从 TARGET_DIR（已同步的全局配置目录）取；schema/init.sql 内含 7 表 + 索引 + 视图 + project_context 种子
INIT_SQL="${TARGET_DIR}/.kilo/memory/schema/init.sql"
# v2.6.2 精简：原 api/migrate_skill_to_fact_store.sql + api/seed_project_context.sql 已随 api/ 目录删除；
#   AP/PAT bootstrap 经验由既有 DB 保留，全新安装从空 DB 开始（schema/init.sql 内含 project_context 种子）

# --- Step 1: 检测 sqlite3 CLI ---
if ! command -v sqlite3 &> /dev/null; then
    echo "[CHECK]  sqlite3 CLI 未检测到"
    echo "记忆层（经验沉淀/错误总结/模型校准/skill 升级）依赖 sqlite3。"
    echo "缺失时记忆层静默降级：不报错但不写入，自我进化闭环不生效。"
    echo ""
    # 检测可用的包管理器并推荐安装命令
    INSTALL_CMD=""
    PKG_MGR=""
    if command -v apt-get &> /dev/null; then
        INSTALL_CMD="sudo apt-get update && sudo apt-get install -y sqlite3"
        PKG_MGR="apt"
    elif command -v brew &> /dev/null; then
        INSTALL_CMD="brew install sqlite"
        PKG_MGR="brew"
    elif command -v dnf &> /dev/null; then
        INSTALL_CMD="sudo dnf install -y sqlite"
        PKG_MGR="dnf"
    elif command -v yum &> /dev/null; then
        INSTALL_CMD="sudo yum install -y sqlite"
        PKG_MGR="yum"
    elif command -v pacman &> /dev/null; then
        INSTALL_CMD="sudo pacman -S --noconfirm sqlite"
        PKG_MGR="pacman"
    elif command -v apk &> /dev/null; then
        INSTALL_CMD="apk add --no-cache sqlite"
        PKG_MGR="apk"
    else
        echo "[WARN]   未检测到已知包管理器（apt/brew/dnf/yum/pacman/apk）"
        echo "         请手动安装 sqlite3：https://www.sqlite.org/download.html"
    fi

    if [ -n "$INSTALL_CMD" ]; then
        read -p "是否现在自动安装 sqlite3？（${INSTALL_CMD}）[Y/n] " CHOICE
        if [ "$CHOICE" = "" ] || [ "$CHOICE" = "Y" ] || [ "$CHOICE" = "y" ]; then
            echo "[INSTALL] ${INSTALL_CMD}"
            if $INSTALL_CMD; then
                # 刷新 bash 命令缓存（安装后立即可用，无需重启终端）
                hash -r
                if command -v sqlite3 &> /dev/null; then
                    echo "[OK]     sqlite3 安装成功: $(command -v sqlite3)"
                else
                    echo "[WARN]   sqlite3 安装完成但 PATH 未刷新，请重启终端后重新运行 install.sh"
                fi
            else
                echo "[WARN]   sqlite3 安装失败（exit code $?）"
                echo "         可手动安装: ${INSTALL_CMD}"
            fi
        else
            echo "[SKIP]   用户跳过 sqlite3 安装"
            echo "[WARN]   记忆层将静默降级（经验/错误/校准零写入，自我进化闭环不生效）"
        fi
    fi
else
    echo "[CHECK]  sqlite3 CLI 已安装: $(command -v sqlite3)"
fi

# --- Step 2: 初始化 memory.db（sqlite3 可用时）---
if command -v sqlite3 &> /dev/null; then
    # 建数据目录
    mkdir -p "${DB_DIR}"

    if [ -f "${DB_PATH}" ]; then
        echo "[SKIP]   memory.db 已存在，跳过初始化: ${DB_PATH}"
    else
        # 执行 init.sql 建表
        if [ -f "${INIT_SQL}" ]; then
            echo "[INIT]   执行 schema/init.sql 建表..."
            sqlite3 "${DB_PATH}" < "${INIT_SQL}"
            echo "[OK]     memory.db 表结构初始化完成: ${DB_PATH}"
        else
            echo "[WARN]   schema/init.sql 未找到（${INIT_SQL}），跳过建表"
        fi

        # schema/init.sql 内含 project_context 种子（v2.6.2 起），无需单独 seed 脚本

        # 健康度验证
        TABLES=$(sqlite3 "${DB_PATH}" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%';")
        echo "[VERIFY] 表清单: ${TABLES}"
    fi
else
    echo "[WARN]   sqlite3 CLI 不可用，memory.db 未初始化"
    echo "         记忆层静默降级。安装 sqlite3 后重新运行 install.sh 即可补初始化。"
fi

echo ""
echo "Memory layer setup done."

echo ""
echo "Please restart Kilo in your projects for changes to take effect."
echo ""
exit 0
