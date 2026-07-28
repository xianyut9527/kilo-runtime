# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\
# IMPORTANT: EXCLUDE lists must be kept in sync with install.sh
#
# v6.1 architecture sync:
#   lifecycle/              - graph.yaml (DAG), config.yaml (tier defaults), multimodel-graph.yaml, stages/*.md
#   agent/                  - one .md per agent; frontmatter mount auto-registers into lifecycle
#   .kilo/instructions/     - cross-agent baseline rules
#   .kilo/memory/           - sqlite-backed memory module
#   .kilo/skills/           - capability extensions
# The installer recursively copies everything above (minus EXCLUDE lists) to the global config dir.

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

# Items excluded only at the repo root level (to avoid clobbering same-named legit
# files in subdirectories, e.g. .kilo/memory/README.md)
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
    "__pycache__"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

try {
    # ============================================================
    # Full overwrite strategy: purge the target directory first,
    # then sync from source. Ensures the target is identical to the
    # source after each install, leaving no stale artifacts behind.
    # ============================================================
    if (Test-Path $Target) {
        Write-Host "[CLEAN] Purging target directory: $Target" -ForegroundColor Yellow
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
                Write-Host "[COPY]   $($dest.Substring($Target.Length + 1))/" -ForegroundColor Green
                $script:CopiedDirs++
            } else {
                Copy-Item -Path $item.FullName -Destination $dest -Force -ErrorAction Stop
                Write-Host "[COPY]   $($dest.Substring($Target.Length + 1))" -ForegroundColor Green
                $script:CopiedFiles++
            }
        }
    }

    $CopiedFiles = 0
    $CopiedDirs = 0
    Copy-SourceTree $Source $Target 0

    # Note: agents/ compat copy intentionally removed.
    # Having both agent/ and agents/ causes duplicate agent registration,
    # which makes agent routing unstable.
    # See https://kilo.ai/docs/configure/agents

    Write-Host ""
    Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
    Write-Host ""

    # ============================================================
    # Critical file existence check
    # ============================================================
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
        "lifecycle/multimodel-graph.yaml",
        "lifecycle/stages/README.md"
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

    # ============================================================
    # UTF-8 encoding configuration (fixes CJK mojibake on Windows PowerShell)
    # ============================================================
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

    # Ensure profile directory exists
    if (-not (Test-Path $ProfileDir)) {
        New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
        Write-Host "[CREATE] $ProfileDir" -ForegroundColor Green
    }

    # Ensure profile file exists (handle first-run scenario, avoid Get-Content error)
    if (-not (Test-Path $ProfilePath)) {
        New-Item -ItemType File -Path $ProfilePath -Force | Out-Null
        Write-Host "[CREATE] $ProfilePath" -ForegroundColor Green
    }

    # Idempotency check: skip if already configured
    $ExistingContent = Get-Content -Path $ProfilePath -Raw -ErrorAction SilentlyContinue
    if ($ExistingContent -notmatch [regex]::Escape($ProfileMarker)) {
        $Utf8Block = @'

# Kilo: UTF-8 encoding configuration
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
'@
        Add-Content -Path $ProfilePath -Value $Utf8Block -Encoding UTF8
        Write-Host "[WRITE] UTF-8 encoding added to profile" -ForegroundColor Green
    } else {
        Write-Host "[SKIP] UTF-8 encoding already configured in profile" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | critical=$($CriticalFiles.Count)/$($CriticalFiles.Count) | target=$Target" -ForegroundColor Green

    # ============================================================
    # kilo.json path placeholder substitution (keeps skills.external_dirs portable)
    # ============================================================
    Write-Host ""
    Write-Host "Substituting kilo.json path placeholders..." -ForegroundColor Cyan
    $KiloJsonPath = Join-Path $Target "kilo.json"
    if (Test-Path $KiloJsonPath) {
        $JsonContent = Get-Content -Path $KiloJsonPath -Raw -Encoding UTF8
        $JsonContent = $JsonContent -replace '\$\{KILO_CONFIG_DIR\}', ($Target -replace '\\', '\\')
        $JsonContent = $JsonContent -replace '\$\{HOME\}', ($env:USERPROFILE -replace '\\', '\\')
        # Note: memory.db path uses ${HOME}/.config/kilo-data/memory.db, accessed directly
        # Primary channel = python scripts/memory.py (v2.6 main channel; Python stdlib sqlite3,
        # cross-platform, no extra install); sqlite3 CLI is optional fallback.
        # Not substituted at install time.
        # Note: memory-mcp (v3.0 standby channel) was removed in v2.6.2 cleanup along
        # with the api/ directory; kilo.json no longer references memory-mcp.js.
        # Write-back must be BOM-free: PS 5.1 Set-Content -Encoding UTF8 writes a BOM,
        # which breaks strict JSON.parse (AP-001)
        [System.IO.File]::WriteAllText($KiloJsonPath, $JsonContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[WRITE]  kilo.json path placeholders substituted (KILO_CONFIG_DIR=$Target)" -ForegroundColor Green
    } else {
        Write-Host "[WARN]   kilo.json not found at $KiloJsonPath, skip substitution" -ForegroundColor Yellow
    }

    # ============================================================
    # Memory layer setup (sqlite3 CLI + memory.db)
    # When missing, prompt the user; on consent, auto-install sqlite3 and init memory.db.
    # When sqlite3 is unavailable, the memory layer degrades silently
    # (no errors, no writes; the self-evolution loop is inactive).
    # ============================================================
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Memory Layer Setup (sqlite3 + memory.db)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    $DbDir = "$env:USERPROFILE\.config\kilo-data"
    $DbPath = Join-Path $DbDir "memory.db"
    # init.sql is taken from Target (the synced global config dir);
    # schema/init.sql contains 7 tables + indexes + views + project_context seed.
    $InitSql = Join-Path $Target ".kilo\memory\schema\init.sql"
    # v2.6.2 cleanup: the original api/migrate_skill_to_fact_store.sql and
    #   api/seed_project_context.sql were removed along with the api/ directory;
    #   AP/PAT bootstrap experience is retained in the existing DB. Fresh installs
    #   start from an empty DB (schema/init.sql contains the project_context seed).

    # --- Helper: refresh session PATH (read Machine+User from registry, fixes the
    #     issue where PATH is not updated in the current session after winget install) ---
    function Refresh-SessionPath {
        $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
        $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $env:PATH = "$machinePath;$userPath"
    }

    # --- Helper: detect winget-installed sqlite3 directory and prepend to session PATH ---
    function Find-WingetSqlite {
        $wingetRoot = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
        $sqliteDir = Get-ChildItem $wingetRoot -Filter "SQLite*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sqliteDir) {
            $env:PATH = "$($sqliteDir.FullName);$env:PATH"
            return (Get-Command sqlite3 -ErrorAction SilentlyContinue)
        }
        return $null
    }

    # --- Step 0: Refresh session PATH (fixes "installed but not in current PATH") ---
    Refresh-SessionPath

    # --- Step 1: Detect sqlite3 CLI ---
    $SqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
    if (-not $SqliteExe) {
        # Try probing the winget install dir (may be installed but PATH not refreshed)
        $SqliteExe = Find-WingetSqlite
    }

    if (-not $SqliteExe) {
        Write-Host "[CHECK]  sqlite3 CLI not detected" -ForegroundColor Yellow
        Write-Host "The memory layer (experience / error / model-calibration / skill-upgrade) depends on sqlite3." -ForegroundColor Gray
        Write-Host "When missing, the memory layer degrades silently: no errors, no writes; self-evolution loop is inactive." -ForegroundColor Gray
        Write-Host ""
        $Choice = Read-Host "Install sqlite3 now? (winget install SQLite.SQLite) [Y/n]"

        if ($Choice -eq "" -or $Choice -match "^[Yy]") {
            Write-Host "[INSTALL] winget install SQLite.SQLite ..." -ForegroundColor Cyan
            try {
                # winget install (may take a while)
                & winget install --id SQLite.SQLite --accept-source-agreements --accept-package-agreements --silent 2>&1 | ForEach-Object { Write-Host $_ }

                # Refresh PATH after install (re-read registry + probe winget install dir)
                Refresh-SessionPath
                $SqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
                if (-not $SqliteExe) {
                    $SqliteExe = Find-WingetSqlite
                }

                if ($SqliteExe) {
                    Write-Host "[OK]     sqlite3 installed successfully: $($SqliteExe.Source)" -ForegroundColor Green
                } else {
                    Write-Host "[WARN]   sqlite3 install finished but not found in PATH; restart your terminal and re-run install.ps1" -ForegroundColor Yellow
                    Write-Host "         or run manually: winget install SQLite.SQLite" -ForegroundColor Gray
                }
            } catch {
                Write-Host "[WARN]   sqlite3 install failed: $($_.Exception.Message)" -ForegroundColor Yellow
                Write-Host "         You can install manually: winget install SQLite.SQLite or choco install sqlite" -ForegroundColor Gray
            }
        } else {
            Write-Host "[SKIP]   User skipped sqlite3 install" -ForegroundColor Gray
            Write-Host "[WARN]   Memory layer will degrade silently (zero writes to experience/error/calibration; self-evolution inactive)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[CHECK]  sqlite3 CLI already installed: $($SqliteExe.Source)" -ForegroundColor Green
    }

    # --- Step 2: Initialize memory.db (when sqlite3 is available) ---
    if ($SqliteExe) {
        # Create data directory
        if (-not (Test-Path $DbDir)) {
            New-Item -ItemType Directory -Path $DbDir -Force | Out-Null
            Write-Host "[CREATE] $DbDir" -ForegroundColor Green
        }

        if (Test-Path $DbPath) {
            Write-Host "[SKIP]   memory.db already exists, skip init: $DbPath" -ForegroundColor Gray
        } else {
            # Execute init.sql to create tables
            if (Test-Path $InitSql) {
                Write-Host "[INIT]   Running schema/init.sql to create tables..." -ForegroundColor Cyan
                & sqlite3 $DbPath ".read `"$InitSql`"" 2>&1 | ForEach-Object { Write-Host $_ }
                Write-Host "[OK]     memory.db schema initialized: $DbPath" -ForegroundColor Green
            } else {
                Write-Host "[WARN]   schema/init.sql not found ($InitSql), skip table creation" -ForegroundColor Yellow
            }

            # schema/init.sql contains the project_context seed (since v2.6.2); no separate seed script needed.

            # Health verification
            $Tables = & sqlite3 $DbPath "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%';" 2>&1
            Write-Host "[VERIFY] Tables: $Tables" -ForegroundColor Gray
        }
    } else {
        Write-Host "[WARN]   sqlite3 CLI unavailable, memory.db not initialized" -ForegroundColor Yellow
        Write-Host "         Memory layer degrades silently. After installing sqlite3, re-run install.ps1 to init." -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "Memory layer setup done." -ForegroundColor Cyan

    Write-Host ""
    Write-Host "Please restart Kilo in your projects for changes to take effect." -ForegroundColor Green
    Write-Host ""

    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}