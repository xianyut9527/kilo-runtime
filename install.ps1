# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

$Exclude = @(
    ".git",
    ".gitignore",
    ".git/",
    "install.ps1",
    "install.sh",
    "README.md",
    "LICENSE",
    "node_modules",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "yarn.lock",
    "agent-manager.json",
    "memory.md"
)

function Test-Excluded {
    param([string]$Name)
    return $Exclude -contains $Name
}

function Copy-ConfigTree {
    param(
        [string]$SourceDir,
        [string]$TargetDir
    )

    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    }

    foreach ($item in Get-ChildItem -Path $SourceDir -Force) {
        if (Test-Excluded $item.Name) { continue }

        $dest = Join-Path $TargetDir $item.Name
        if ($item.PSIsContainer) {
            Copy-ConfigTree -SourceDir $item.FullName -TargetDir $dest
            Write-Host "[SYNC]   $($item.FullName.Replace($Source, '').TrimStart('\'))/" -ForegroundColor Green
        } else {
            Copy-Item -Path $item.FullName -Destination $dest -Force
            Write-Host "[COPY]   $($item.FullName.Replace($Source, '').TrimStart('\'))" -ForegroundColor Green
        }
    }

    foreach ($item in Get-ChildItem -Path $TargetDir -Force) {
        if (Test-Excluded $item.Name) { continue }

        $sourcePeer = Join-Path $SourceDir $item.Name
        if (-not (Test-Path $sourcePeer)) {
            Remove-Item -Path $item.FullName -Recurse -Force
            Write-Host "[REMOVE] $($item.FullName.Replace($Target, '').TrimStart('\'))" -ForegroundColor Yellow
        }
    }
}

function Remove-GeneratedArtifacts {
    $generated = @(
        ".kilo\node_modules",
        ".kilo\package.json",
        ".kilo\package-lock.json",
        ".kilo\pnpm-lock.yaml",
        ".kilo\bun.lock",
        ".kilo\yarn.lock"
    )

    foreach ($relativePath in $generated) {
        $path = Join-Path $Target $relativePath
        if (Test-Path $path) {
            Remove-Item -Path $path -Recurse -Force
            Write-Host "[CLEAN]  $relativePath" -ForegroundColor Yellow
        }
    }
}

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

Remove-GeneratedArtifacts
Copy-ConfigTree -SourceDir $Source -TargetDir $Target

Write-Host ""
Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
Write-Host ""
