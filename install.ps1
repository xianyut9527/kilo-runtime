# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

$Exclude = @(".git", ".gitignore", "install.ps1", "install.sh", "README.md", "node_modules")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Write-Host "[CREATE] $Target" -ForegroundColor Green
}

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

Write-Host ""
Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
Write-Host ""
