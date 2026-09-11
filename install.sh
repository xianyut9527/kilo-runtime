#!/usr/bin/env bash
# Kilo Global Config Installer (macOS / Linux)
# Syncs this repo to: ~/.config/kilo/
# IMPORTANT: EXCLUDE lists must be kept in sync with install.ps1
#
# v6.1 architecture sync:
#   lifecycle/              - graph.yaml (DAG), config.yaml (tier defaults), stages/*.md
#   agent/                  - one .md per agent; frontmatter mount auto-registers into lifecycle
#   .kilo/instructions/     - cross-agent baseline rules
#   .kilo/skills/           - capability extensions
# The installer recursively copies everything above (minus EXCLUDE lists) to the global config dir.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${KILO_INSTALL_TARGET:-${HOME}/.config/kilo}"
# IMPORTANT: KILO_INSTALL_TARGET must be an absolute path (aligns with install.ps1 L14-18)
case "${TARGET_DIR}" in
    /*) ;;
    *) echo "[SYNC] FAIL: KILO_INSTALL_TARGET must be absolute: ${TARGET_DIR}"; exit 1 ;;
esac

# Items excluded only at the repo root level (to avoid clobbering same-named legit files)
# 'reports' = 仓库根的历史审计归档（交付物，归档在仓库即够），运行时零读取方；
# 用 ROOT_ONLY 而非 RECURSIVE，是为了不误伤任意层级可能同名的目录。
ROOT_ONLY_EXCLUDE=(
    "install.ps1"
    "install.sh"
    "README.md"
    "LICENSE"
    "reports"
)

# Items excluded at all levels (must stay in sync with install.ps1)
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
    ".claude"
    ".playwright-mcp"
    "_test_target_orig"
    ".mcp-tmp"
)

# Runtime data owned by the global config dir, not by the repo. Keep in sync with install.ps1
# ($RuntimeDataDirs / $RuntimeDataFiles) and scripts/deploy-drift-check.mjs.
#
# Why this exists: the installer purges TARGET before copying, while kb.mjs add and
# lessons-recorder.mjs write into TARGET at runtime, so every install silently destroyed the
# accumulated cross-project experience. These paths are backed up before the purge and restored
# afterwards for files the repo does NOT own (repo wins for everything else; promote runtime
# additions into the repo so they survive a machine change).
RUNTIME_DATA_DIRS=("knowledge-base" "docs/lessons")
RUNTIME_DATA_FILES=(".bash-permission-migrated" "kilo.jsonc")
BACKUP_DIR=""

backup_runtime_data() {
    [ -d "${TARGET_DIR}" ] || return 0
    BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kilo_backup_XXXXXXXX")"
    local rd rf
    for rd in "${RUNTIME_DATA_DIRS[@]}"; do
        [ -d "${TARGET_DIR}/${rd}" ] || continue
        mkdir -p "${BACKUP_DIR}/${rd}"
        cp -R "${TARGET_DIR}/${rd}/." "${BACKUP_DIR}/${rd}/" 2>/dev/null || true
    done
    for rf in "${RUNTIME_DATA_FILES[@]}"; do
        [ -f "${TARGET_DIR}/${rf}" ] || continue
        cp "${TARGET_DIR}/${rf}" "${BACKUP_DIR}/" 2>/dev/null || true
    done
    echo "[BACKUP] runtime data (${RUNTIME_DATA_DIRS[*]}) -> ${BACKUP_DIR}"
    return 0
}

restore_runtime_data() {
    if [ -z "${BACKUP_DIR}" ] || [ ! -d "${BACKUP_DIR}" ]; then return 0; fi
    local restored=0 f rel dst
    while IFS= read -r f; do
        rel="${f#"${BACKUP_DIR}"/}"
        dst="${TARGET_DIR}/${rel}"
        if [ ! -e "${dst}" ]; then
            mkdir -p "$(dirname "${dst}")"
            cp "${f}" "${dst}"
            restored=$((restored + 1))
        fi
    done < <(find "${BACKUP_DIR}" -type f)
    if [ "${restored}" -gt 0 ]; then
        echo "[RESTORE] ${restored} runtime-only file(s) preserved (KB / lessons / markers)"
    fi
    return 0
}

COPIED_FILES=0
COPIED_DIRS=0

echo "========================================"
echo "  Kilo Global Config Installer"
echo "========================================"
echo ""
echo "Source : ${SOURCE_DIR}"
echo "Target : ${TARGET_DIR}"
echo ""

mkdir -p "${TARGET_DIR}"

# Full overwrite: purge target first, then sync.
purge_target() {
    echo "[CLEAN] Purging target directory: ${TARGET_DIR}"
    find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
}

# Fallback recursive copy when rsync is unavailable. Counts files/dirs for stats line.
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
                COPIED_DIRS=$((COPIED_DIRS + 1))
            else
                cp "$item" "${target_item}"
                COPIED_FILES=$((COPIED_FILES + 1))
            fi
        fi
    done
    shopt -u dotglob
}

# Parse rsync stats output (rsync 3.1+ emits "Number of regular files transferred:",
# while older rsync 2.x/3.0 emits "Number of files:"; the dirs line is identical).
# Usage: parse_rsync_stats <output> <files_line_prefix>
#   prints "<files> <dirs>" on a single line
parse_rsync_stats() {
    local output="$1"
    local file_pattern="$2"
    local files dirs
    files=$(printf '%s\n' "${output}" | awk -F': *' -v p="${file_pattern}:" '$0 ~ p { gsub(/[^0-9].*/, "", $2); print $2; exit }')
    dirs=$(printf  '%s\n' "${output}" | awk -F': *' '$0 ~ /^Number of created directories:/ { gsub(/[^0-9].*/, "", $2); print $2; exit }')
    echo "${files:-0} ${dirs:-0}"
}

# Build rsync exclude args: root-only items anchored with leading /, recursive items bare.
EXCLUDE_ARGS=()
for item in "${ROOT_ONLY_EXCLUDE[@]}"; do
    EXCLUDE_ARGS+=("--exclude=/${item}")
done
for item in "${RECURSIVE_EXCLUDE[@]}"; do
    EXCLUDE_ARGS+=("--exclude=${item}")
done

# Use rsync for the main path; fall back to cp loop if rsync is missing.
backup_runtime_data
if command -v rsync &> /dev/null; then
    purge_target
    # --info=stats2 prints a summary block including
    #   "Number of regular files transferred: N"
    #   "Number of created directories: N"
    # Detect rsync version: --info=stats2 is rsync 3.1.0+ (macOS ships 2.6.9, which only supports --stats)
    RSYNC_VERSION=$(rsync --version 2>/dev/null | head -n1 | awk '{print $3}')
    RSYNC_MAJOR=$(echo "${RSYNC_VERSION}" | cut -d. -f1)
    RSYNC_MINOR=$(echo "${RSYNC_VERSION}" | cut -d. -f2)
    if [ "${RSYNC_MAJOR}" -gt 3 ] || { [ "${RSYNC_MAJOR}" -eq 3 ] && [ "${RSYNC_MINOR}" -ge 1 ]; }; then
        # rsync 3.1.0+: --info=stats2 outputs 'Number of regular files transferred: N'
        RSYNC_OUTPUT=$(rsync -a --delete --info=stats2 "${EXCLUDE_ARGS[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/" 2>&1 || true)
        read -r COPIED_FILES COPIED_DIRS < <(parse_rsync_stats "${RSYNC_OUTPUT}" "Number of regular files transferred")
    else
        # rsync < 3.1.0 (incl. macOS 2.6.9): --stats outputs 'Number of files: N'
        RSYNC_OUTPUT=$(rsync -a --delete --stats "${EXCLUDE_ARGS[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/" 2>&1 || true)
        read -r COPIED_FILES COPIED_DIRS < <(parse_rsync_stats "${RSYNC_OUTPUT}" "Number of files")
    fi
    COPIED_FILES=${COPIED_FILES:-0}
    COPIED_DIRS=${COPIED_DIRS:-0}
else
    echo "rsync not found, using cp -r instead..."
    purge_target
    copy_source_tree "${SOURCE_DIR}" "${TARGET_DIR}" 0
fi
restore_runtime_data
# Rebuild deployed knowledge-base index: backup/restore keeps runtime-only FX files that the repo
# does not own, but install overwrites the deployed index.md from repo, leaving "file without index
# row" → deploy-doctor kb.health FAIL. Rebuild on the deployed side to keep index/files consistent.
KB_REBUILD_SCRIPT="${TARGET_DIR}/scripts/kb.mjs"
KB_ROOT="${TARGET_DIR}/knowledge-base"
if [ -f "${KB_REBUILD_SCRIPT}" ] && [ -d "${KB_ROOT}" ]; then
    echo "[KB] Rebuilding knowledge-base index on target..."
    if node "${KB_REBUILD_SCRIPT}" rebuild --root "${KB_ROOT}" 2>&1; then
        echo "[KB] knowledge-base index rebuilt on target"
    else
        echo "[KB] WARN: kb.mjs rebuild exited $? (non-blocking)" >&2
    fi
fi

# Post-sync 框架健康度自检（本仓库侧；全局配置目录侧见本脚本末尾 --root ${TARGET_DIR} 门禁）
if command -v node >/dev/null 2>&1; then
  if ! node "${SOURCE_DIR}/scripts/lifecycle-doctor/index.mjs" > "${TARGET_DIR}/.sync-doctor.log" 2>&1; then
    echo "[SYNC] FAIL: post-sync lifecycle-doctor (repo) exited. 错误明细如下（完整日志: ${TARGET_DIR}/.sync-doctor.log）:" >&2
    grep -E "FAIL|SUMMARY|ASSEMBLY" "${TARGET_DIR}/.sync-doctor.log" 2>/dev/null | sed "s/^/  /" >&2 || true
    exit 1
  fi
  echo "[SYNC] OK: post-sync lifecycle-doctor passed (repo)"
fi

# Note: agents/ compat copy intentionally removed.
# Having both agent/ and agents/ causes duplicate agent registration,
# which makes agent routing unstable.
# See https://kilo.ai/docs/configure/agents

# Critical file existence check removed: the hand-maintained CRITICAL_FILES list silently missed
# entries (.kilo/instructions/conductor-dispatch-sop.md was never listed, so its absence in the
# global config copy went unnoticed). Superseded by scripts/deploy-drift-check.mjs at the end of this
# script, which compares every file (strictly stronger).

# UTF-8 note: bash inherits locale from the environment; if you see CJK mojibake,
# add `export LANG=en_US.UTF-8` (or your locale) to your shell profile.

# .md file path placeholder substitution
# agent/*.md, .kilo/instructions/*.md and lifecycle/stages/*.md contain ${KILO_CONFIG_DIR}
# placeholders in command examples (e.g. node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs").
# These must be replaced with the actual global config directory path so that
# conductor and other agents can execute lifecycle scripts from any project.
# ${HOME} in .md files is left as-is because bash/PowerShell resolve it at runtime.
# 注意：本清单与 install.ps1 的 $MdFilePatterns 必须保持一致（事实源双处声明）；
#       新增运行时文档不同步这里，占位符会原样残留到运行时，
#       lifecycle-doctor checks/command-path-hygiene.mjs 会 FAIL。
echo ""
echo "Substituting .md file path placeholders..."
MD_REPLACED=0
for md_dir in "${TARGET_DIR}/agent" "${TARGET_DIR}/.kilo/instructions" "${TARGET_DIR}/lifecycle/stages"; do
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


# Rebuild derivations.json on target: install 占位符替换改写了 agent/*.md 内容，
# repo 构建的内容指纹与 target 实际不符；在 target 侧重建使 fingerprint 匹配
echo ""
echo "Rebuilding derivations.json on target..."
BUILD_DERIV="${TARGET_DIR}/scripts/build-derivations.mjs"
if [ -f "${BUILD_DERIV}" ]; then
    if node "${BUILD_DERIV}" 2>&1; then
        echo "[BUILD_DERIVATIONS] derivations.json rebuilt on target"
    else
        echo "[WARN] build-derivations.mjs exited $?; derivations.json may be stale. Run manually: node \"${BUILD_DERIV}\""
    fi
else
    echo "[WARN] build-derivations.mjs not found at ${BUILD_DERIV}; derivations.json may be stale. Run manually: node \"${BUILD_DERIV}\""
fi
# Ensure skill directories exist
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

# Agent prompt auto-sync (single source: agent/*.md description -> kilo.json prompt)
# Eliminates manual prompt maintenance: description is the single source of truth,
# install auto-generates prompt to ensure stable agent triggering.
echo ""
echo "Syncing agent prompts from descriptions..."
SYNC_SCRIPT="${TARGET_DIR}/scripts/sync-agent-prompt.mjs"
if [ -f "${SYNC_SCRIPT}" ]; then
    node "${SYNC_SCRIPT}" 2>&1 || echo "[WARN] agent prompt sync had issues (exit $?), continuing..."
else
    echo "[WARN] sync-agent-prompt.mjs not found at ${SYNC_SCRIPT}, skip"
fi

# ---- Global config copy gates: must run after placeholder substitution + prompt sync (both rewrite
# target content). Mirrors install.ps1.
if command -v node >/dev/null 2>&1; then
    echo ""
    echo "Validating global config copy (doctor --root target)..."
    if ! node "${TARGET_DIR}/scripts/lifecycle-doctor/index.mjs" --root "${TARGET_DIR}" > "${TARGET_DIR}/.deploy-doctor.log" 2>&1; then
        echo "[SYNC] FAIL: global-config-copy lifecycle-doctor failed. 错误明细如下（完整日志: ${TARGET_DIR}/.deploy-doctor.log）:" >&2
        grep -E "FAIL|SUMMARY|ASSEMBLY" "${TARGET_DIR}/.deploy-doctor.log" 2>/dev/null | sed "s/^/  /" >&2 || true
        exit 1
    fi
    echo "[SYNC] OK: global-config-copy lifecycle-doctor passed"

    echo ""
    echo "Checking config drift (repo vs target)..."
    if ! node "${TARGET_DIR}/scripts/deploy-drift-check.mjs" --repo "${SOURCE_DIR}" --target "${TARGET_DIR}"; then
        echo "[SYNC] FAIL: config drift detected. 漂移明细([MISSING]=target 缺失 repo 文件 / [DIFF]=内容不一致)已列于上方失败输出。" >&2
        exit 1
    fi
    echo "[SYNC] OK: 全局配置目录与本仓库一致（无漂移）"
fi

echo ""
echo "[SYNC] OK | files=${COPIED_FILES} dirs=${COPIED_DIRS} | drift=0 | target=${TARGET_DIR}"
echo ""
echo "Please restart Kilo in your projects for changes to take effect."
exit 0
