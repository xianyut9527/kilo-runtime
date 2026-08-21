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
$RootOnlyExclude = @("install.ps1", "install.sh", "README.md", "LICENSE")

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
    if (Test-Path $Target) {
        Write-Host "[CLEAN] Purging target directory: $Target" -ForegroundColor Yellow
        # Backup package.json + package-lock.json (protect @kilocode/plugin deps before purge)
        # RecursiveExclude 已排除 node_modules,本不拷过去,故无需备份/还原整目录(GB 级 IO 浪费)
        $BackupDir = Join-Path $env:TEMP "kilo_backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
        $PkgJson = Join-Path $Target "package.json"
        $PkgLock = Join-Path $Target "package-lock.json"
        if ((Test-Path $PkgJson) -or (Test-Path $PkgLock)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
            if (Test-Path $PkgJson)  { Copy-Item $PkgJson  $BackupDir -Force -ErrorAction Stop }
            if (Test-Path $PkgLock)  { Copy-Item $PkgLock  $BackupDir -Force -ErrorAction Stop }
            $HasBackup = $true
            Write-Host "[BACKUP] package.json + package-lock.json -> $BackupDir" -ForegroundColor Cyan
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

    # Post-sync 框架健康度自检
    & node "$Source\scripts\lifecycle-doctor\index.mjs" 2>&1 | Tee-Object -FilePath "$Target\.sync-doctor.log" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[SYNC] FAIL: post-sync lifecycle-doctor exited $LASTEXITCODE. See $Target\.sync-doctor.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "[SYNC] OK: post-sync lifecycle-doctor passed" -ForegroundColor Green

    # Note: agents/ compat copy intentionally removed.
    # Having both agent/ and agents/ causes duplicate agent registration,
    # which makes agent routing unstable.
    # See https://kilo.ai/docs/configure/agents

    # Critical file existence check
    $CriticalFiles = @(
        "kilo.json",
        "AGENTS.md",
        ".kilo/instructions/core.md",
        ".kilo/instructions/workflow-core.md",
        ".kilo/instructions/reflection.md",
        "agent/conductor.md",
        "agent/verifier.md",
        "lifecycle/graph.yaml",
        "lifecycle/config.yaml",
        "lifecycle/stages/README.md",
        "scripts/lifecycle-doctor/checks/encoding-safety.mjs",
        "scripts/scan-encoding.mjs",
        "scripts/bash-guard.mjs",
        "scripts/sanitize-agent-description.mjs",
        "scripts/sync-agent-prompt.mjs",
        "scripts/validate-agent-prompt.mjs"
    )

    $Missing = @()
    foreach ($f in $CriticalFiles) {
        $path = Join-Path $Target $f
        if (-not (Test-Path $path)) {
            $Missing += $f
        }
    }

    if ($Missing.Count -gt 0) {
        Write-Host "[SYNC] FAIL: missing critical files: $($Missing -join ', ')" -ForegroundColor Red
        exit 1
    }

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
    # agent/*.md and .kilo/instructions/*.md contain ${KILO_CONFIG_DIR} placeholders
    # in command examples (e.g. node "${KILO_CONFIG_DIR}/scripts/transition-check.mjs").
    # These must be replaced with the actual global config directory path so that
    # conductor and other agents can execute lifecycle scripts from any project.
    # ${HOME} in .md files is left as-is because bash/PowerShell resolve it at runtime.
    Write-Host ""
    Write-Host "Substituting .md file path placeholders..." -ForegroundColor Cyan
    $MdFilePatterns = @(
        (Join-Path $Target "agent\*.md"),
        (Join-Path $Target ".kilo\instructions\*.md")
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

    Write-Host ""
    Write-Host "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | critical=$($CriticalFiles.Count)/$($CriticalFiles.Count) | target=$Target" -ForegroundColor Green
    Write-Host ""
    Write-Host "Please restart Kilo in your projects for changes to take effect." -ForegroundColor Green

    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}