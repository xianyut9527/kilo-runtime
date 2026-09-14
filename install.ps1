$ErrorActionPreference = "Stop"

$Source = Join-Path $PSScriptRoot "kilo.json"
$TargetDir = if ($env:KILO_SYNC_TARGET) { $env:KILO_SYNC_TARGET } else { Join-Path $env:USERPROFILE ".config\kilo" }
$Target = Join-Path $TargetDir "kilo.json"

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "[INSTALL] FAIL: source not found: $Source" -ForegroundColor Red
    exit 1
}

try {
    $Config = Get-Content -LiteralPath $Source -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "[INSTALL] FAIL: kilo.json is not valid JSON: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "[CREATE] $TargetDir" -ForegroundColor Green
}

if (Test-Path -LiteralPath $Target) {
    $Backup = "$Target.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item -LiteralPath $Target -Destination $Backup -Force
    Write-Host "[BACKUP] $Backup" -ForegroundColor Cyan
}

Copy-Item -LiteralPath $Source -Destination $Target -Force

if ((Get-FileHash -LiteralPath $Source).Hash -ne (Get-FileHash -LiteralPath $Target).Hash) {
    Write-Host "[INSTALL] FAIL: hash mismatch after copy" -ForegroundColor Red
    exit 1
}

$Model = if ($Config.model) { $Config.model } else { "(none)" }
$Small = if ($Config.small_model) { $Config.small_model } else { "(none)" }
$Providers = if ($Config.provider) { ($Config.provider.PSObject.Properties.Name -join ", ") } else { "(none)" }
$Agents = if ($Config.agent) { ($Config.agent.PSObject.Properties.Name -join ", ") } else { "(none)" }

Write-Host ""
Write-Host "[INSTALL] OK: $Source -> $Target" -ForegroundColor Green
Write-Host "  model        : $Model"
Write-Host "  small_model  : $Small"
Write-Host "  providers    : $Providers"
Write-Host "  agents       : $Agents"
exit 0