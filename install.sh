#!/usr/bin/env bash
# Kilo 全局配置安装脚本 (macOS / Linux)
# 将本仓库内容复制到全局配置目录：~/.config/kilo/
# IMPORTANT: EXCLUDE lists must be kept in sync with install.ps1
#
# v6.1 架构同步说明：
#   lifecycle/              - graph.yaml（DAG）、config.yaml（定级组合）、stages/*.md
#   agent/                  - 一智能体一文件；frontmatter mount 自注册到生命周期
#   .kilo/instructions/     - 跨智能体通用基线规则
#   .kilo/skills/           - 能力扩展 skill
# 本脚本递归复制以上目录（除去 EXCLUDE 列表）到全局配置目录。

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.config/kilo"

# 仅在仓库根层级排除的项（防止误伤子目录中同名合法文件）
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
    ".tmp"
    "worktrees"
    ".pytest_cache"
    "__pycache__"
    ".kilo_tmp"
    ".playwright-mcp"
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
    "agent/conductor.md"
    "agent/verifier.md"
    "lifecycle/graph.yaml"
    "lifecycle/config.yaml"
    "lifecycle/stages/README.md"
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
# .md 文件路径占位符替换
# agent/*.md 和 .kilo/instructions/*.md 中包含 ${KILO_CONFIG_DIR} 占位符
# 在命令示例中（如 node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs"）。
# 必须替换为实际全局配置目录路径，确保 conductor 和其他智能体
# 在任何项目中都能执行 lifecycle 脚本。
# ${HOME} 在 .md 文件中保留不替换——bash/PowerShell 运行时自动解析。
# ============================================================
echo ""
echo "Substituting .md file path placeholders..."
MD_REPLACED=0
for md_dir in "${TARGET_DIR}/agent" "${TARGET_DIR}/.kilo/instructions"; do
    if [ -d "${md_dir}" ]; then
        for md_file in "${md_dir}"/*.md; do
            [ -f "${md_file}" ] || continue
            if grep -q '\${KILO_CONFIG_DIR}' "${md_file}" 2>/dev/null; then
                sed -i.bak \
                    -e "s|\${KILO_CONFIG_DIR}|${TARGET_DIR}|g" \
                    "${md_file}" \
                    && rm -f "${md_file}.bak"
                MD_REPLACED=$((MD_REPLACED + 1))
                echo "[WRITE] $(basename "${md_file}"): KILO_CONFIG_DIR placeholders substituted"
            fi
        done
    fi
done
if [ "${MD_REPLACED}" -eq 0 ]; then
    echo "[OK]     no .md files needed placeholder substitution"
else
    echo "[WRITE] ${MD_REPLACED} .md file(s) had KILO_CONFIG_DIR placeholders substituted"
fi


# ============================================================
# Ensure skill directories exist
# ============================================================
echo ""
echo "Ensuring skill directories exist..."
SKILL_DIRS=(
    "${TARGET_DIR}/.kilo/skills"
    "${HOME}/.agents/skills"
)
for dir in "${SKILL_DIRS[@]}"; do
    if [ ! -d "${dir}" ]; then
        mkdir -p "${dir}"
        echo "[CREATE] ${dir}"
    else
        echo "[OK]     ${dir} already exists"
    fi
done
# ============================================================
# Agent prompt auto-sync (single source: agent/*.md description -> kilo.json prompt)
# Eliminates manual prompt maintenance: description is the single source of truth,
# install auto-generates prompt to ensure stable agent triggering.
# ============================================================
echo ""
echo "Syncing agent prompts from descriptions..."
SYNC_SCRIPT="${TARGET_DIR}/scripts/sync-agent-prompt.mjs"
if [ -f "${SYNC_SCRIPT}" ]; then
    node "${SYNC_SCRIPT}" 2>&1 || echo "[WARN] agent prompt sync had issues (exit $?), continuing..."
else
    echo "[WARN] sync-agent-prompt.mjs not found at ${SYNC_SCRIPT}, skip"
fi

echo ""
echo "Please restart Kilo in your projects for changes to take effect."
echo ""
exit 0
