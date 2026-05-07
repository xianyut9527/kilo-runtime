# Kilo 全局配置安装脚本 (Windows)
# 将本仓库内容复制到全局配置目录：$env:USERPROFILE\.config\kilo\

$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetDir = Join-Path $env:USERPROFILE ".config\kilo"

# 需要排除的文件/目录
$ExcludeItems = @(
    ".git",
    ".gitignore",
    "install.ps1",
    "install.sh",
    "README.md",
    "node_modules",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "yarn.lock"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source : $SourceDir" -ForegroundColor Gray
Write-Host "Target : $TargetDir" -ForegroundColor Gray
Write-Host ""

# 创建目标目录
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "Created directory: $TargetDir" -ForegroundColor Green
}

# 获取源目录下的所有文件和目录（排除指定项）
$Items = Get-ChildItem -Path $SourceDir | Where-Object {
    $ExcludeItems -notcontains $_.Name
}

if ($Items.Count -eq 0) {
    Write-Host "No items to copy." -ForegroundColor Yellow
    exit 0
}

# 复制文件和目录
foreach ($Item in $Items) {
    $DestPath = Join-Path $TargetDir $Item.Name

    if ($Item.PSIsContainer) {
        # 目录：先删除旧目录再复制新目录
        if (Test-Path $DestPath) {
            Remove-Item -Path $DestPath -Recurse -Force
            Write-Host "Removed old directory: $($Item.Name)" -ForegroundColor Yellow
        }
        Copy-Item -Path $Item.FullName -Destination $TargetDir -Recurse -Force
        Write-Host "Copied directory : $($Item.Name)" -ForegroundColor Green
    } else {
        # 文件：直接复制
        Copy-Item -Path $Item.FullName -Destination $TargetDir -Force
        Write-Host "Copied file      : $($Item.Name)" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Please restart Kilo in your projects for changes to take effect." -ForegroundColor Yellow
Write-Host ""
