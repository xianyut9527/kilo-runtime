<#
  kilo_config 全量下发器（PowerShell 原生版，与 install.sh 行为一致）

  用法：
    .\install.ps1              下发（改动前对目标做一次性备份）
    .\install.ps1 -DryRun      只打印将发生的变更，不写盘
    .\install.ps1 -Check       只检测漂移，有漂移则退出码 1
    .\install.ps1 -Target D:\x 覆盖目标目录（默认 $HOME\.config\kilo）

  设计要点：与 install.sh 相同 —— 清单驱动、__KILO_HOME__ 占位符替换、
  幂等（内容一致跳过）、可回滚（首次写入前打包备份，只保留最近 N 个）。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Check,
    [string]$Target
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Manifest  = Join-Path $ScriptDir 'install.manifest'
$TargetDir = if ($Target) { $Target } else { Join-Path $HOME '.config\kilo' }
$HomeSlash = ($HOME -replace '\\', '/').TrimEnd('/')
# 部署目录的原生正斜杠路径（供 provider.npm 的 file:// URL 使用）。
# Kilo 是原生程序：file:///C:/... 有效，file:///c/... 与 ~ 均无效（实测）。
$TargetNative = ($TargetDir -replace '\\', '/').TrimEnd('/')

if (-not (Test-Path $Manifest)) { Write-Error "[INSTALL] FAIL: 清单缺失 $Manifest"; exit 1 }

function Get-Sha256([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash
}

function Test-NeedsSubst([string]$Path) {
    $n = Split-Path -Leaf $Path
    return ($n -eq 'kilo.json' -or $n -eq 'kilo.json.tmpl' -or $n -eq 'INSTRUCTIONS.md')
}

# 展开清单 -> @{ Src; Dst }
$pairs = @()
foreach ($raw in Get-Content $Manifest) {
    $line = ($raw -split '#')[0].Trim()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $parts = $line -split '->'
    $src = $parts[0].Trim()
    $dst = if ($parts.Count -gt 1) { $parts[1].Trim() } else { $src }

    $srcPath = Join-Path $ScriptDir $src
    if ($src.EndsWith('/')) {
        $root = $src.TrimEnd('/')
        $rootPath = Join-Path $ScriptDir $root
        if (-not (Test-Path $rootPath)) { Write-Warning "[INSTALL] WARN: 清单目录不存在，跳过 $root"; continue }
        foreach ($f in Get-ChildItem -Recurse -File -Path $rootPath | Sort-Object FullName) {
            $rel = $f.FullName.Substring($rootPath.Length).TrimStart('\', '/')
            $pairs += [pscustomobject]@{ Src = $f.FullName; Dst = ((Join-Path $dst $rel) -replace '\\', '/') }
        }
    }
    else {
        if (-not (Test-Path $srcPath)) { Write-Warning "[INSTALL] WARN: 清单文件不存在，跳过 $src"; continue }
        $pairs += [pscustomobject]@{ Src = $srcPath; Dst = $dst }
    }
}

# ---------- provider dist 新鲜度：src 比 dist 新说明忘跑 build，部署的会是旧行为 ----------
$srcJs  = Join-Path $ScriptDir 'provider/hx-failover/src/index.js'
$distJs = Join-Path $ScriptDir 'provider/hx-failover/dist/index.js'
if ((Test-Path $srcJs) -and (Test-Path $distJs) -and ((Get-Item $srcJs).LastWriteTime -gt (Get-Item $distJs).LastWriteTime)) {
    Write-Warning "[INSTALL] WARN: provider src/index.js 比 dist/index.js 新 —— 先在 provider/hx-failover 跑 npm run build 再下发"
    if ($Check) { Write-Error "[check] 漂移：provider dist 过期（src 已改未重建）"; exit 1 }
}

# 渲染内容（含占位符替换 + 模板注释剥离）
# 注释约定：仅 *.tmpl 里「行首 //」是给人看的注释，部署时剥离成纯 JSON
# （Kilo 拒绝 JSON 注释键；行内 // 不动，防误伤 URL）
function Render-Content([string]$SrcPath) {
    $text = [System.IO.File]::ReadAllText($SrcPath, [System.Text.UTF8Encoding]::new($false))
    if ($SrcPath -like '*.tmpl') {
        $text = ($text -split "`r?`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
        $text = $text.Replace('__KILO_CONFIG__', $TargetNative)
        $text = $text.Replace('__KILO_HOME__', $HomeSlash)
    }
    elseif (Test-NeedsSubst $SrcPath) {
        $text = $text.Replace('__KILO_CONFIG__', $TargetNative)
        $text = $text.Replace('__KILO_HOME__', $HomeSlash)
    }
    return $text
}

# 校验：渲染后的 kilo.json 必须是合法 JSON，且不得残留未替换的占位符
try {
    $rendered = Render-Content (Join-Path $ScriptDir 'kilo.json.tmpl')
    $null = $rendered | ConvertFrom-Json
}
catch {
    Write-Error "[INSTALL] FAIL: kilo.json 渲染后不是合法 JSON（占位符替换可能破坏结构）：$($_.Exception.Message)"
    exit 1
}
if ($rendered -match '__KILO_(HOME|CONFIG)__') {
    Write-Error "[INSTALL] FAIL: kilo.json 渲染后仍残留占位符（provider 将初始化失败）。"
    exit 1
}

# 备份保留上限：只留最近 N 个（KILO_KEEP_BACKUPS 可覆盖）
# 历史教训：每次下发各留一份、无人回收，单个备份含 plugin 依赖时可达数十 MB。
# 顺序很关键：**先裁剪、后创建**。若先创建再裁剪，刚建的那份会参与排序，
# 而同秒产生的备份 LastWriteTime 并列 + $env:TEMP 返回 8.3 短路径（ADMINI~1）
# 与 Get-ChildItem 的长路径不相等，字符串排除失效 → 新备份会被自己删掉（实测踩过）。
# 裁剪只发生在真实写盘模式：--DryRun / -Check 一律不得删除任何文件。
if (-not $DryRun -and -not $Check -and (Test-Path $TargetDir)) {
    # KILO_KEEP_BACKUPS 解析：非整数/小于 1 一律回退默认 2 并告警，绝不能因环境变量写错而炸掉下发
    #（[int]'abc' 直接抛 RuntimeException，实测会中断整个安装流程）
    $keepBackups = 2
    if ($env:KILO_KEEP_BACKUPS) {
        $parsed = 0
        if ([int]::TryParse($env:KILO_KEEP_BACKUPS, [ref]$parsed) -and $parsed -ge 1) { $keepBackups = $parsed }
        else { Write-Warning "[INSTALL] WARN: KILO_KEEP_BACKUPS='$($env:KILO_KEEP_BACKUPS)' 非法（需 ≥1 整数），按默认 2 处理" }
    }
    $bkBase = Split-Path -Leaf $TargetDir
    Get-ChildItem -LiteralPath (Split-Path -Parent $TargetDir) -File -Filter "$bkBase.backup-*" |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip ([Math]::Max($keepBackups - 1, 0)) |
        ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force
            Write-Host "[BACKUP] prune $($_.FullName)（保留最近 $keepBackups 个）"
        }

    # 备份：目标目录整体打包（失败不阻断下发，只是失去这次回滚点）
    # 坑：目标为空目录时 Compress-Archive **既不报错也不产出文件**（实测），
    # 只能显式检查产物，否则会打印一个并不存在、看起来成功的备份路径。
    $bk = "$TargetDir.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"
    try {
        Compress-Archive -Path (Join-Path $TargetDir '*') -DestinationPath $bk -Force
        if (Test-Path -LiteralPath $bk) { Write-Host "[BACKUP] $bk" }
        else { Write-Warning "[INSTALL] WARN: 备份未产出（目标目录为空或无可打包内容），跳过：[BACKUP] $bk" }
    }
    catch { Write-Warning "[INSTALL] WARN: 备份失败（继续下发）：$($_.Exception.Message)" }
}

$changed = 0; $same = 0; $wrote = 0
foreach ($p in $pairs) {
    $dstPath = Join-Path $TargetDir $p.Dst
    $newText = Render-Content $p.Src

    $oldText = ''
    if (Test-Path $dstPath) { $oldText = [System.IO.File]::ReadAllText($dstPath, [System.Text.UTF8Encoding]::new($false)) }

    if ($oldText -eq $newText) { $same++; continue }

    $changed++
    if ($DryRun -or $Check) { continue }

    $dstDir = Split-Path -Parent $dstPath
    if (-not (Test-Path $dstDir)) { $null = New-Item -ItemType Directory -Path $dstDir -Force }
    [System.IO.File]::WriteAllText($dstPath, $newText, [System.Text.UTF8Encoding]::new($false))
    $wrote++
}

# ---------- 多余文件检测（漂移的另一面：部署目录里清单管不到的文件） ----------
# 白名单：Kilo 运行时自建（package.json/plugin 编译依赖、.gitignore、迁移标记、旧备份、全局经验层运行时状态）
$whitelist = '^(\.gitignore|\.bash-permission-migrated|GLOBAL-NOTES\.md|package(-lock)?\.json|kilo\.json\.bak\..*)$|^(\.kilo|node_modules)(/|$)|^provider/hx-failover/node_modules(/|$)'
$strayList = @()
if (Test-Path $TargetDir) {
    $expected = @($pairs | ForEach-Object { ($_.Dst -replace '\\', '/') } | Sort-Object)
    # 空目录时管道产出 $null，Compare-Object 的 -DifferenceObject 不接受 null（实测崩溃），必须显式套 @()
    $present = @(Get-ChildItem -Recurse -File -Path $TargetDir |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.FullName -notmatch '[\\/]\.kilo[\\/]' } |
        ForEach-Object { $_.FullName.Substring($TargetDir.Length).TrimStart('\', '/') -replace '\\', '/' } | Sort-Object)
    $strayList = @(Compare-Object -ReferenceObject $expected -DifferenceObject $present |
        Where-Object { $_.SideIndicator -eq '=>' -and $_.InputObject -notmatch $whitelist } |
        ForEach-Object { $_.InputObject })
}

$cfg = (Render-Content (Join-Path $ScriptDir 'kilo.json.tmpl')) | ConvertFrom-Json
$mode = if ($Check) { 'check' } elseif ($DryRun) { 'dry-run' } else { 'install' }

Write-Host ''
Write-Host "[$mode] 目标: $TargetDir"
Write-Host "  清单条目 : $($pairs.Count)"
Write-Host "  未变化   : $same"
Write-Host "  差异/写入: $changed"
if ($strayList.Count -gt 0) {
    Write-Host "  多余文件 : $($strayList.Count)（清单外，白名单外）"
    $strayList | ForEach-Object { Write-Host "    $_" }
}
Write-Host "  model    : $($cfg.model)"
Write-Host "  small    : $($cfg.small_model)"
Write-Host "  agents   : $(($cfg.agent.PSObject.Properties.Name) -join ', ')"

if ($Check -and ($changed -gt 0 -or $strayList.Count -gt 0)) {
    Write-Host ''
    Write-Host "[check] 漂移：内容差异 $changed 处 + 多余文件 $($strayList.Count) 个 —— 执行 .\install.ps1 同步（多余文件需人工确认后删除）。"
    exit 1
}
exit 0
