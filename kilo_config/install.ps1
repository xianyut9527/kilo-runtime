# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\
# IMPORTANT: EXCLUDE lists must be kept in sync with install.sh

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

# 仅在仓库根层级排除的项（防止误伤子目录中同名合法文件，如 .kilo/memory/README.md）
$RootOnlyExclude = @("install.ps1", "install.sh", "README.md", "LICENSE")

# 所有层级都排除的项
$RecursiveExclude = @(
    ".git", ".gitignore",
    "node_modules",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "yarn.lock",
    "agent-manager.json",
    "skill-usage.log"
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
    # 全量覆盖式更新策略：先彻底清空目标目录，再从源目录全量同步
    # 这样确保每次安装后目标目录与源目录完全一致，不留历史残留垃圾
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

    # 注意：不再创建 agents/ 兼容副本，避免 agent 被注册两次导致路由不稳定
    # 详见 https://kilo.ai/docs/configure/agents

    Write-Host ""
    Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
    Write-Host ""

    # ============================================================
    # 关键文件存在性校验
    # ============================================================
    $CriticalFiles = @(
        "kilo.json",
        "AGENTS.md",
        ".kilo/instructions/core.md",
        ".kilo/instructions/workflow-core.md",
        ".kilo/instructions/reflection.md",
        "agent/coderAgent.md"
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
    # UTF-8 编码配置（解决 Kilo 在 Windows PowerShell 上的中文乱码）
    # ============================================================
    Write-Host "Configuring UTF-8 encoding..." -ForegroundColor Cyan

    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $ProfileMarker = "# Kilo: UTF-8 encoding configuration"

    # 1. 立即生效（当前安装脚本会话内）
    $OutputEncoding = $Utf8NoBom
    [Console]::OutputEncoding = $Utf8NoBom
    [Console]::InputEncoding = $Utf8NoBom

    # 2. 写入 profile（未来新会话永久生效）
    $ProfilePath = $PROFILE.CurrentUserAllHosts
    $ProfileDir = Split-Path -Parent $ProfilePath

    # 确保 profile 目录存在
    if (-not (Test-Path $ProfileDir)) {
        New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
        Write-Host "[CREATE] $ProfileDir" -ForegroundColor Green
    }

    # 确保 profile 文件存在（处理首次使用场景，避免 Get-Content 报错）
    if (-not (Test-Path $ProfilePath)) {
        New-Item -ItemType File -Path $ProfilePath -Force | Out-Null
        Write-Host "[CREATE] $ProfilePath" -ForegroundColor Green
    }

    # 幂等检测：已配置则跳过
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
    # kilo.json 路径占位符替换（保证 skills.external_dirs 跨平台可移植）
    # ============================================================
    Write-Host ""
    Write-Host "Substituting kilo.json path placeholders..." -ForegroundColor Cyan
    $KiloJsonPath = Join-Path $Target "kilo.json"
    if (Test-Path $KiloJsonPath) {
        $JsonContent = Get-Content -Path $KiloJsonPath -Raw -Encoding UTF8
        $JsonContent = $JsonContent -replace '\$\{KILO_CONFIG_DIR\}', ($Target -replace '\\', '\\')
        # 注意：memory.db 路径使用 ${HOME}/.config/kilo-data/memory.db，由 bash + sqlite3 CLI 直接访问（v2.5-过渡版主通道），install 阶段不替换
        # 写回必须无 BOM：PS 5.1 Set-Content -Encoding UTF8 会写入 BOM，导致严格 JSON.parse 失败（AP-001）
        [System.IO.File]::WriteAllText($KiloJsonPath, $JsonContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[WRITE]  kilo.json path placeholders substituted (KILO_CONFIG_DIR=$Target)" -ForegroundColor Green
    } else {
        Write-Host "[WARN]   kilo.json not found at $KiloJsonPath, skip substitution" -ForegroundColor Yellow
    }

    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
