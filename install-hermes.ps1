# Hermes Config Installer (Windows)
# Syncs hermes_config/ directory to: $env:LOCALAPPDATA\hermes\ (Windows standard AppData path)
# IMPORTANT: EXCLUDE lists must be kept in sync with install-hermes.sh
# 本脚本采用合并式部署：保留 Hermes 运行时目录（sessions/cron/hooks/logs 等），
# 只覆盖配置产物（SOUL.md/config.yaml/.hermes.md）和 skills。
# memories/ 是可选个人模板，仅在不存在时初始化，避免覆盖设备本地记忆。
# Kilo 配置仍由 install.ps1 安装到 ~/.config/kilo/

$Source = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "hermes_config"

# Windows: Hermes 使用 LOCALAPPDATA\hermes（不是 ~/.hermes/）
# Linux/macOS: Hermes 使用 ~/.hermes/
if ($env:LOCALAPPDATA) {
    $Target = "$env:LOCALAPPDATA\hermes"
} else {
    $Target = "$env:USERPROFILE\.hermes"
}

if (-not (Test-Path $Source)) {
    Write-Host "[SYNC] FAIL: hermes_config/ directory not found at $Source" -ForegroundColor Red
    exit 1
}

# 仅在仓库根层级排除的项
$RootOnlyExclude = @("install-hermes.ps1", "install-hermes.sh")

# 所有层级都排除的项
$RecursiveExclude = @(
    ".git", ".gitignore",
    "node_modules",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "yarn.lock",
    "agent-manager.json"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Hermes Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

try {
    # 合并式更新：保留 Hermes 运行时目录（sessions/cron/hooks/logs/audio_cache/image_cache/pairing/scripts），
    # 只覆盖配置产物（SOUL.md/config.yaml/.hermes.md）和 skills。
    # 不清空目标目录，避免删除 Hermes 运行时数据

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

    # memories 模板：仅在目标不存在时复制，不覆盖
    $TemplatesDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "templates\memories"
    if (Test-Path $TemplatesDir) {
        $MemoriesTarget = Join-Path $Target "memories"
        if (-not (Test-Path $MemoriesTarget)) {
            New-Item -ItemType Directory -Path $MemoriesTarget -Force | Out-Null
        }
        foreach ($f in Get-ChildItem -Path $TemplatesDir -File) {
            $dest = Join-Path $MemoriesTarget $f.Name
            if (-not (Test-Path $dest)) {
                Copy-Item -Path $f.FullName -Destination $dest -Force
                Write-Host "[INIT]   copied template $($f.Name) -> $MemoriesTarget" -ForegroundColor Green
            } else {
                Write-Host "[SKIP]   $dest exists, not overwriting" -ForegroundColor Yellow
            }
        }
    }

    Write-Host ""
    Write-Host "Done! Restart Hermes to apply changes." -ForegroundColor Green
    Write-Host ""

    # ============================================================
    # 关键文件存在性校验
    # ============================================================
    $CriticalFiles = @(
        "SOUL.md",
        "config.yaml",
        ".hermes.md"
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

    Write-Host "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | critical=$($CriticalFiles.Count)/$($CriticalFiles.Count) | target=$Target" -ForegroundColor Green

    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Configure provider: hermes model (select custom endpoint)" -ForegroundColor Gray
    Write-Host "  2. Set API key in .env: HX_API_KEY=<your-key>" -ForegroundColor Gray
    Write-Host "  3. Start: hermes" -ForegroundColor Gray
    Write-Host "  4. Verify: hermes doctor" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Note: memories/ are optional personal templates and are NOT overwritten if they already exist." -ForegroundColor Gray
    Write-Host ""
    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}