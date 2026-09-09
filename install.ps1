# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\
# IMPORTANT: EXCLUDE lists must be kept in sync with install.sh
#
# v6.1 architecture sync:
#   lifecycle/              - graph.yaml (DAG), config.yaml (tier defaults), stages/*.md
#   agent/                  - one .md per agent; frontmatter mount auto-registers into lifecycle
#   .kilo/instructions/     - cross-agent baseline rules
#   .kilo/skills/           - capability extensions
# The installer recursively copies everything above (minus EXCLUDE lists) to the global config dir.

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = if ($env:KILO_INSTALL_TARGET) { $env:KILO_INSTALL_TARGET } else { "$env:USERPROFILE\.config\kilo" }
if (-not ([System.IO.Path]::IsPathRooted($Target))) {
    Write-Host "[SYNC] FAIL: KILO_INSTALL_TARGET must be an absolute path: $Target" -ForegroundColor Red
    exit 1
}
$Target = [System.IO.Path]::GetFullPath($Target)

# Items excluded only at the repo root level (to avoid clobbering same-named legit files)
# 'reports' = 仓库根的历史审计归档（交付物，归档在仓库即够），运行时零读取方；
# 用 RootOnly 而非 Recursive，是为了不误伤任意层级可能同名的目录。
$RootOnlyExclude = @("install.ps1", "install.sh", "README.md", "LICENSE", "reports")

# Items excluded at all levels (must stay in sync with install.sh)
$RecursiveExclude = @(
    ".git", ".gitignore",
    "node_modules",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "yarn.lock",
    "agent-manager.json",
    ".tmp",
    "worktrees",
    ".pytest_cache",
    "__pycache__",
    ".kilo_tmp",
    ".claude",
    ".playwright-mcp",
    "_test_target_orig",
    ".mcp-tmp"
)

# Runtime data owned by the DEPLOYED copy, not by the repo (must stay in sync with install.sh;
# scripts/deploy-drift-check.mjs parses these two arrays through scripts/lib/install-runtime-data.mjs
# instead of re-declaring them, so a path added here is auto-classified as [RUNTIME] not [EXTRA]).
#
# Why this exists: the installer purges $Target before copying. The cross-project knowledge base
# and the lessons log are written AT RUNTIME into $Target (kb.mjs add / lessons-recorder.mjs),
# so a purge silently destroyed accumulated experience on every install. These paths are backed up
# before the purge and restored afterwards for files the repo does not own; for files the repo does
# own, the repo wins (harvest runtime additions back into the repo to promote them).
$RuntimeDataDirs = @("knowledge-base", "docs\lessons")
$RuntimeDataFiles = @(".bash-permission-migrated", "kilo.jsonc")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

try {
    # Full overwrite strategy: purge the target directory first,
    # then sync from source. Ensures the target is identical to the
    # source after each install, leaving no stale artifacts behind.

    # MCP 工具已默认禁用(kilo.json mcp.*.enabled: false),无需 PATH 预检
    # 用户按需启用时,框架不绑定任何特定 MCP,运行时由 IDE MCP 注入决定

    $HasBackup = $false
    $BackupDir = Join-Path $env:TEMP "kilo_backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
    if (Test-Path $Target) {
        Write-Host "[CLEAN] Purging target directory: $Target" -ForegroundColor Yellow
        # Backup package.json + package-lock.json (protect @kilocode/plugin deps before purge)
        # RecursiveExclude 已排除 node_modules,本不拷过去,故无需备份/还原整目录(GB 级 IO 浪费)
        $PkgJson = Join-Path $Target "package.json"
        $PkgLock = Join-Path $Target "package-lock.json"
        if ((Test-Path $PkgJson) -or (Test-Path $PkgLock)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
            if (Test-Path $PkgJson)  { Copy-Item $PkgJson  $BackupDir -Force -ErrorAction Stop }
            if (Test-Path $PkgLock)  { Copy-Item $PkgLock  $BackupDir -Force -ErrorAction Stop }
            $HasBackup = $true
            Write-Host "[BACKUP] package.json + package-lock.json -> $BackupDir" -ForegroundColor Cyan
        }
        # Backup runtime data (KB entries / lessons / runtime markers) before purge
        foreach ($rd in $RuntimeDataDirs) {
            $rdSrc = Join-Path $Target $rd
            if (-not (Test-Path $rdSrc)) { continue }
            $rdDst = Join-Path $BackupDir $rd
            New-Item -ItemType Directory -Path $rdDst -Force | Out-Null
            Copy-Item -Path (Join-Path $rdSrc "*") -Destination $rdDst -Recurse -Force -ErrorAction SilentlyContinue
            $HasBackup = $true
        }
        foreach ($rf in $RuntimeDataFiles) {
            $rfSrc = Join-Path $Target $rf
            if (-not (Test-Path $rfSrc)) { continue }
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
            Copy-Item -Path $rfSrc -Destination $BackupDir -Force -ErrorAction SilentlyContinue
            $HasBackup = $true
        }
        if ($HasBackup) {
            Write-Host "[BACKUP] runtime data ($($RuntimeDataDirs -join ', ') + markers) -> $BackupDir" -ForegroundColor Cyan
        }
        Remove-Item -Path "$Target\*" -Recurse -Force -ErrorAction Stop
    }

    if (-not (Test-Path $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        Write-Host "[CREATE] $Target" -ForegroundColor Green
    }
    Write-Host ""

    function Should-Exclude($name, $depth) {
        if ($depth -eq 0 -and $RootOnlyExclude -contains $name) { return $true }
        if ($RecursiveExclude -contains $name) { return $true }
        return $false
    }

    function Copy-SourceTree($srcDir, $dstDir, $depth) {
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }

        foreach ($item in Get-ChildItem -Path $srcDir -Force) {
            if (Should-Exclude $item.Name $depth) { continue }

            $dest = Join-Path $dstDir $item.Name

            if ($item.PSIsContainer) {
                Copy-SourceTree $item.FullName $dest ($depth + 1)
                $script:CopiedDirs++
            } else {
                Copy-Item -Path $item.FullName -Destination $dest -Force -ErrorAction Stop
                $script:CopiedFiles++
            }
        }
    }

    $CopiedFiles = 0
    $CopiedDirs = 0
    Copy-SourceTree $Source $Target 0
    # Restore package.json + package-lock.json (re-apply @kilocode/plugin deps after sync)
    if ($HasBackup) {
        if (Test-Path (Join-Path $BackupDir "package.json"))  { Copy-Item (Join-Path $BackupDir "package.json")  $PkgJson -Force -ErrorAction Stop }
        if (Test-Path (Join-Path $BackupDir "package-lock.json")) { Copy-Item (Join-Path $BackupDir "package-lock.json") $PkgLock -Force -ErrorAction Stop }
        Write-Host "[RESTORE] @kilocode/plugin deps restored from backup" -ForegroundColor Green
    }

    # Restore runtime data: only files the repo does NOT own (repo wins for everything else).
    # Promote runtime additions into the repo (see knowledge-base/index.md §如何新增一条经验 step 4)
    # so they survive a machine change.
    if ($HasBackup) {
        $Restored = 0
        foreach ($rd in $RuntimeDataDirs) {
            $rdBak = Join-Path $BackupDir $rd
            if (-not (Test-Path $rdBak)) { continue }
            $rdBakFull = (Resolve-Path $rdBak).Path
            Get-ChildItem -Path $rdBakFull -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($rdBakFull.Length).TrimStart('\', '/')
                $dst = Join-Path (Join-Path $Target $rd) $rel
                if (-not (Test-Path $dst)) {
                    $dstDir = Split-Path $dst -Parent
                    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
                    Copy-Item -Path $_.FullName -Destination $dst -Force
                    $script:Restored++
                }
            }
        }
        foreach ($rf in $RuntimeDataFiles) {
            $rfBak = Join-Path $BackupDir $rf
            $rfDst = Join-Path $Target $rf
            if ((Test-Path $rfBak) -and (-not (Test-Path $rfDst))) {
                Copy-Item -Path $rfBak -Destination $rfDst -Force
                $Restored++
            }
        }
        if ($Restored -gt 0) {
            Write-Host "[RESTORE] $Restored runtime-only file(s) preserved (KB / lessons / markers)" -ForegroundColor Green
        }
    }

    # Post-sync 框架健康度自检（仓库侧；部署副本侧见本脚本末尾 --root $Target 门禁）
    & node "$Source\scripts\lifecycle-doctor\index.mjs" 2>&1 | Tee-Object -FilePath "$Target\.sync-doctor.log" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[SYNC] FAIL: post-sync lifecycle-doctor exited $LASTEXITCODE. See $Target\.sync-doctor.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "[SYNC] OK: post-sync lifecycle-doctor passed (repo)" -ForegroundColor Green

    # Note: agents/ compat copy intentionally removed.
    # Having both agent/ and agents/ causes duplicate agent registration,
    # which makes agent routing unstable.
    # See https://kilo.ai/docs/configure/agents

    # Critical file existence check 已删除：手维护的 $CriticalFiles 清单会漏项
    # （.kilo/instructions/conductor-dispatch-sop.md 从未被列进去，缺失时无人发现）。
    # 由本脚本末尾的 scripts/deploy-drift-check.mjs 全量逐文件比对取代（严格更强）。

    # UTF-8 encoding configuration (fixes CJK mojibake on Windows PowerShell)
    Write-Host ""
    Write-Host "Configuring UTF-8 encoding..." -ForegroundColor Cyan

    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $ProfileMarker = "# Kilo: UTF-8 encoding configuration"

    # 1. Apply immediately (current install session)
    $OutputEncoding = $Utf8NoBom
    [Console]::OutputEncoding = $Utf8NoBom
    [Console]::InputEncoding = $Utf8NoBom

    # 2. Persist to profile (future sessions)
    $ProfilePath = $PROFILE.CurrentUserAllHosts
    $ProfileDir = Split-Path -Parent $ProfilePath

    if (-not (Test-Path $ProfileDir)) {
        New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
        Write-Host "[CREATE] $ProfileDir" -ForegroundColor Green
    }

    if (-not (Test-Path $ProfilePath)) {
        New-Item -ItemType File -Path $ProfilePath -Force | Out-Null
        Write-Host "[CREATE] $ProfilePath" -ForegroundColor Green
    }

    $ExistingContent = Get-Content -Path $ProfilePath -Raw -ErrorAction SilentlyContinue
    if ($ExistingContent -notmatch [regex]::Escape($ProfileMarker)) {
        $Utf8Block = @"

# Kilo: UTF-8 encoding configuration
`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
"@
        Add-Content -Path $ProfilePath -Value $Utf8Block -Encoding UTF8
        Write-Host "[WRITE] UTF-8 encoding added to profile" -ForegroundColor Green
    } else {
        Write-Host "[SKIP] UTF-8 encoding already configured in profile" -ForegroundColor Gray
    }

    # .md file path placeholder substitution
    # agent/*.md, .kilo/instructions/*.md and lifecycle/stages/*.md contain ${KILO_CONFIG_DIR}
    # placeholders in command examples (e.g. node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs").
    # These must be replaced with the actual global config directory path so that
    # conductor and other agents can execute lifecycle scripts from any project.
    # ${HOME} in .md files is left as-is because bash/PowerShell resolve it at runtime.
    # 注意：本清单是「哪些文档里的命令会被替换」的事实源，新增运行时文档必须同步这里，
    #       否则占位符会原样残留到运行时（lifecycle-doctor checks/command-path-hygiene.mjs 会 FAIL）。
    Write-Host ""
    Write-Host "Substituting .md file path placeholders..." -ForegroundColor Cyan
    $MdFilePatterns = @(
        (Join-Path $Target "agent\*.md"),
        (Join-Path $Target ".kilo\instructions\*.md"),
        (Join-Path $Target "lifecycle\stages\*.md")
    )
    $MdReplaced = 0
    foreach ($pattern in $MdFilePatterns) {
        $mdFiles = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue
        foreach ($mdFile in $mdFiles) {
            $mdContent = Get-Content -Path $mdFile.FullName -Raw -Encoding UTF8
            if ($mdContent -and $mdContent.Contains('${KILO_CONFIG_DIR}')) {
                $mdContent = $mdContent -replace '\$\{KILO_CONFIG_DIR\}', $Target
                [System.IO.File]::WriteAllText($mdFile.FullName, $mdContent, (New-Object System.Text.UTF8Encoding($false)))
                $MdReplaced++
                Write-Host "[WRITE]  $($mdFile.Name): KILO_CONFIG_DIR placeholders substituted" -ForegroundColor Green
            }
        }
    }
    if ($MdReplaced -eq 0) {
        Write-Host "[OK]     no .md files needed placeholder substitution" -ForegroundColor Gray
    } else {
        Write-Host "[WRITE]  $MdReplaced .md file(s) had KILO_CONFIG_DIR placeholders substituted" -ForegroundColor Green
    }


    # Rebuild derivations.json on target: install 占位符替换改写了 agent/*.md 内容，
    # repo 构建的内容指纹与 target 实际不符；在 target 侧重建使 fingerprint 匹配
    Write-Host ""
    Write-Host "Rebuilding derivations.json on target..." -ForegroundColor Cyan
    $BuildDeriv = Join-Path $Target "scripts\build-derivations.mjs"
    if (Test-Path $BuildDeriv) {
        & node $BuildDeriv 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[WARN]   build-derivations.mjs exited $LASTEXITCODE; derivations.json may be stale. Run manually: node `"$BuildDeriv`"" -ForegroundColor Yellow
        } else {
            Write-Host "[BUILD_DERIVATIONS] derivations.json rebuilt on target" -ForegroundColor Green
        }
    } else {
        Write-Host "[WARN]   build-derivations.mjs not found at $BuildDeriv; derivations.json may be stale. Run manually: node `"$BuildDeriv`"" -ForegroundColor Yellow
    }
    # Ensure skill directories exist
    Write-Host ""
    Write-Host "Ensuring skill directories exist..." -ForegroundColor Cyan
    $SkillDirs = @(
        (Join-Path $Target ".kilo\skills"),
        (Join-Path $env:USERPROFILE ".agents\skills")
    )
    foreach ($dir in $SkillDirs) {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Write-Host "[CREATE] $dir" -ForegroundColor Green
        } else {
            Write-Host "[OK]     $dir already exists" -ForegroundColor Gray
        }
    }

    # Agent prompt auto-sync (single source: agent/*.md description -> kilo.json prompt)
    # Eliminates manual prompt maintenance: description is the single source of truth,
    # install auto-generates prompt to ensure stable agent triggering.
    Write-Host ""
    Write-Host "Syncing agent prompts from descriptions..." -ForegroundColor Cyan
    $SyncScript = Join-Path $Target "scripts\sync-agent-prompt.mjs"
    if (Test-Path $SyncScript) {
        & node $SyncScript 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[WARN]   agent prompt sync had issues (exit $LASTEXITCODE), continuing..." -ForegroundColor Yellow
        }
    } else {
        Write-Host "[WARN]   sync-agent-prompt.mjs not found at $SyncScript, skip" -ForegroundColor Yellow
    }

    # ---- 部署副本侧门禁（必须在占位符替换 + prompt 同步之后跑，二者会改写 target 内容）----
    # 历史缺陷：此前只有 L180 的 $Source（仓库）自检，且 lifecycle-doctor 的 ROOT 硬编码为
    # 脚本自身位置，部署副本从不被校验 → 漂移全绿假象（运行时长期跑拆分前的旧 conductor.md）。
    Write-Host ""
    Write-Host "Validating deployed copy (doctor --root target)..." -ForegroundColor Cyan
    & node "$Target\scripts\lifecycle-doctor\index.mjs" --root $Target 2>&1 | Tee-Object -FilePath "$Target\.deploy-doctor.log" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[SYNC] FAIL: deployed-copy lifecycle-doctor exited $LASTEXITCODE. See $Target\.deploy-doctor.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "[SYNC] OK: deployed-copy lifecycle-doctor passed" -ForegroundColor Green

    # 部署漂移门禁：逐文件比对 repo vs target，取代手维护的 CriticalFiles 清单
    Write-Host ""
    Write-Host "Checking deploy drift (repo vs target)..." -ForegroundColor Cyan
    & node (Join-Path $Target "scripts\deploy-drift-check.mjs") --repo $Source --target $Target 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[SYNC] FAIL: deploy-drift-check exited $LASTEXITCODE (see [MISSING]/[DIFF] above)" -ForegroundColor Red
        exit 1
    }
    Write-Host "[SYNC] OK: no deploy drift" -ForegroundColor Green

    Write-Host ""
    Write-Host "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | drift=0 | target=$Target" -ForegroundColor Green
    Write-Host ""
    Write-Host "Please restart Kilo in your projects for changes to take effect." -ForegroundColor Green

    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
