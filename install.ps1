# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

$Exclude = @(".git", ".gitignore", ".git/", "install.ps1", "install.sh", "README.md", "LICENSE", "node_modules", "package.json", "package-lock.json")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

# ============================================================
# 全量更新策略：先清空目标目录所有内容，再从源目录全量同步
# 这样确保每次安装不留历史残留垃圾
# ============================================================
if (Test-Path $Target) {
    $ExistingItems = @(Get-ChildItem -Path $Target -Force -ErrorAction SilentlyContinue)
    if ($ExistingItems.Count -gt 0) {
        Write-Host "[CLEAN] Purging $($ExistingItems.Count) items from target..." -ForegroundColor Yellow
        $ExistingItems | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Write-Host "[CREATE] $Target" -ForegroundColor Green
}
Write-Host ""

foreach ($item in Get-ChildItem -Path $Source) {
    if ($Exclude -contains $item.Name) { continue }

    $dest = Join-Path $Target $item.Name

    if ($item.PSIsContainer) {
        if (Test-Path $dest) {
            Remove-Item -Path $dest -Recurse -Force
            Write-Host "[REMOVE] $($item.Name)" -ForegroundColor Yellow
        }
        Copy-Item -Path $item.FullName -Destination $Target -Recurse -Force
        Write-Host "[COPY]   $($item.Name)/" -ForegroundColor Green
    } else {
        Copy-Item -Path $item.FullName -Destination $Target -Force
        Write-Host "[COPY]   $($item.Name)" -ForegroundColor Green
    }
}

# 注意：不再创建 agents/ 兼容副本，避免 agent 被注册两次导致路由不稳定
# 详见 https://kilo.ai/docs/configure/agents

Write-Host ""
Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
Write-Host ""

# ============================================================
# UTF-8 编码配置（解决 Kilo 在 Windows PowerShell 上的中文乱码）
# ============================================================
# - 写入 $PROFILE：对未来的新 PowerShell 会话永久生效
# - 立即 set：对当前安装脚本会话内的后续操作生效
#   注意：立即 set 不会改变当前已运行交互式终端的输出编码，
#   仅对安装脚本后续调用的子进程（如 Kilo 启动的子进程）生效

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
