<#
  kilo 离线 VACUUM 自愈脚本（双通道常备：boot 任务 / 登录快捷方式）
  ================================================
  背景：auto_vacuum≠2 的引导死锁只能靠一次独占 VACUUM 转换；而 Kilo 常驻时
  （含后台进程 runner 自身就是 kilo.exe）永远检测到写者。db-maintain.sh 写下
  vacuum-needed.flag 后，kilo-maintenance.ps1 装两路自愈通道：
    · 登录通道（Startup lnk，免管理员，保底常备）
    · 开机通道（SYSTEM AtStartup 计划任务，管理员注册后升格；未登录窗口即可跑）
  设计红线：绝不做常驻 watcher（历史教训：后台 kilo.exe 自计数，12h watcher 永远等不到
  空窗）；即查即走，写者>0 就静默退出，下次再试。

  裁决吸收的硬约束（2026-11-04 dual_review + MoA）：
    - 无 flag 秒退：lnk 永久保留作兜底通道（MoA 修正：不再成功后自删），健康态开机
      开销 <2s；-Trigger manual（-VacuumNow 手动路径）不受此门。
    - 全局互斥 Global\kilo-vacuum：-VacuumNow（用户态）与 SYSTEM 开机任务并发开跑时
      只放一个实例；AbandonedMutexException = 持有者已崩溃，按获得锁处理。
    - 双采样写者检查（间隔 2s 均为 0 才继续），压窄 TOCTOU 窗口；VACUUM 期间恰有 Kilo
      启动写库仍会撞独占锁（Kilo busy_timeout=5s），残余风险：一次写失败——由
      busy_timeout=60000 + 10 分钟硬超时兜底。
    - 磁盘空间门禁：临时空间 ≥ 2.5×dbBytes（VACUUM 整库重写约需 2×），不足则留 flag
      静默退出，下次再试（不视为失败）。
    - EFS 检测：SYSTEM 账户读不了 EFS 加密文件——boot 通道遇 EFS 直接让位（登录通道
      在用户上下文可读自己的 EFS 文件，照常执行）。
    - 成功标准 = 退出码 0 **且实测 auto_vacuum=2**（不信任盲跑）。
    - sqlite3 优先用 -SqlitePath 注入的安装期固化绝对路径（防 PATH 劫持/差异）。

  用法：powershell -File vacuum-boot.ps1 [-SqlitePath <绝对路径>] [-Trigger boot|login|manual]
  退出码：0=完成或安全跳过（下次重试）；1=不可自愈（sqlite3/db 缺失、VACUUM 失败/超时）
  日志：$HOME\.local\state\kilo\maintenance\vacuum-boot.log（追加，>256KB 由维护入口滚动）
#>
[CmdletBinding()]
param(
    [string]$SqlitePath = '',
    [ValidateSet('boot', 'login', 'manual')]
    [string]$Trigger = 'login'
)

$ErrorActionPreference = 'Continue'

$Home_   = $env:USERPROFILE
if (-not $Home_) { $Home_ = $HOME }
$MaintDir = Join-Path $Home_ '.local\state\kilo\maintenance'
$Log      = Join-Path $MaintDir 'vacuum-boot.log'
$FlagFile = Join-Path $MaintDir 'vacuum-needed.flag'
$DbFile   = Join-Path $Home_ '.local\share\kilo\kilo.db'

function Write-Log([string]$msg) {
    try {
        $null = New-Item -ItemType Directory -Force -Path $MaintDir
        "[{0}] {1}" -f (Get-Date).ToString('o'), $msg | Out-File -LiteralPath $Log -Append -Encoding utf8
    } catch { }
}

# 全局互斥（MoA P0-2）：-VacuumNow（用户态）与 SYSTEM 开机任务可能并发开跑同库 VACUUM；
# Global\ 跨会话命名空间保证同一时刻只有一个实例。等不到锁 = 另一实例在跑 = 本次直接退出。
# AbandonedMutexException = 持有者崩溃后内核已回收、本实例获得所有权——按获得处理。
$Mutex = $null
$HaveMutex = $false
try {
    $Mutex = New-Object System.Threading.Mutex($false, 'Global\kilo-vacuum')
    $null = $Mutex.WaitOne([timespan]::Zero)
    $HaveMutex = $true
} catch [System.Threading.AbandonedMutexException] {
    $HaveMutex = $true
} catch {
    $HaveMutex = $false
}
if (-not $HaveMutex) {
    # Write-Log 依赖的目录可能还没建——尽力落盘后退出
    Write-Log "SKIP mutex busy（另一 vacuum 实例在跑，Trigger=$Trigger）"
    exit 0
}

# 无 flag 秒退（MoA：lnk 永久保留作兜底通道，本脚本不再「一次性」）：引导死锁不存在时
# 常备开销 <2s；-Trigger manual（-VacuumNow 手动路径）不受此门——手动兜底可能要在无
# flag 时主动做全量 VACUUM。
if ($Trigger -ne 'manual' -and -not (Test-Path -LiteralPath $FlagFile)) {
    Write-Log "SKIP no flag（健康态快速退出，Trigger=$Trigger）"
    exit 0
}

Write-Log "START vacuum-boot (Trigger=$Trigger)"

function Resolve-Sqlite3 {
    param([string]$Injected)
    foreach ($p in @($Injected)) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    $c = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\SQLite\sqlite3.exe",
                     "${env:ProgramFiles(x86)}\SQLite\sqlite3.exe",
                     "$env:LOCALAPPDATA\Programs\SQLite\sqlite3.exe")) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

$sqlite = Resolve-Sqlite3 $SqlitePath
if (-not $sqlite) {
    Write-Log 'ABORT sqlite3 not found（留 flag；安装 sqlite3 或 PATH 后下次重试）'
    exit 1
}

if (-not (Test-Path -LiteralPath $DbFile)) {
    Write-Log "ABORT db not found: $DbFile"
    exit 1
}

# EFS 检测（MoA P0-2）：SYSTEM 账户读不了 EFS 加密文件——boot 通道对 EFS 库必然失败，
# 直接让位（登录通道在用户上下文可读自己的 EFS 文件，kilo-maintenance 侧已据此跳过 boot 注册）。
if ($Trigger -eq 'boot') {
    try {
        if ((Get-Item -LiteralPath $DbFile).Attributes -band [IO.FileAttributes]::Encrypted) {
            Write-Log 'ABORT_EFS db 被 EFS 加密，SYSTEM boot 通道不可用（登录通道会自动处理；或解除加密后重试）'
            exit 1
        }
    } catch { }
}

# 双采样写者检查：登录瞬间 Kilo/VS Code 可能并行启动，单次采样误判率高
$kilo1 = @(Get-Process -Name kilo -ErrorAction SilentlyContinue).Count
if ($kilo1 -gt 0) {
    Write-Log "SKIP kilo writers=$kilo1（留 flag 与快捷方式，下次登录重试）"
    exit 0
}
Start-Sleep -Seconds 2
$kilo2 = @(Get-Process -Name kilo -ErrorAction SilentlyContinue).Count
if ($kilo2 -gt 0) {
    Write-Log "SKIP kilo writers=$kilo2（二次采样，留 flag 与快捷方式，下次登录重试）"
    exit 0
}

# 磁盘空间门禁：VACUUM 整库重写约需 2×dbBytes 临时空间，保守取 2.5×
$dbBytes   = (Get-Item -LiteralPath $DbFile).Length
$dbDrive    = (Get-PSDrive -Name ($DbFile.Substring(0, 1)) -ErrorAction SilentlyContinue)
if (-not $dbDrive) { Write-Log "ABORT 无法读取盘符剩余空间: $DbFile"; exit 1 }
$needBytes  = [int64]($dbBytes * 2.5)
if ($dbDrive.Free -lt $needBytes) {
    Write-Log ("SKIP_SPACE 剩余 {0:N1}GB < 需要 {1:N1}GB（2.5×{2:N1}GB，留 flag 下次登录重试）" -f `
        ($dbDrive.Free / 1GB), ($needBytes / 1GB), ($dbBytes / 1GB))
    exit 0
}

# 离线 VACUUM + auto_vacuum=2 同连接转换（auto_vacuum 仅在 VACUUM 重写时落地）
# 10 分钟硬超时：超时杀进程留 flag，绝不让登录路径无限占用磁盘
$before = $dbBytes
$outTmp = Join-Path $MaintDir ("vacuum-boot-out-" + [guid]::NewGuid().ToString('N') + ".txt")
Write-Log ("SIZE before={0} bytes (drive free {1:N1}GB)" -f $before, ($dbDrive.Free / 1GB))
$p = Start-Process -FilePath $sqlite -ArgumentList @($DbFile, 'PRAGMA busy_timeout=60000; PRAGMA auto_vacuum=2; VACUUM; PRAGMA auto_vacuum;') `
    -NoNewWindow -PassThru -RedirectStandardOutput $outTmp -RedirectStandardError "$outTmp.err"
if (-not $p.WaitForExit(600000)) {
    try { $p.Kill() } catch { }
    Write-Log 'FAIL_TIMEOUT VACUUM 超 10 分钟被终止（留 flag，下次登录重试）'
    Remove-Item -LiteralPath $outTmp, "$outTmp.err" -Force -ErrorAction SilentlyContinue
    exit 1
}
$rc = $p.ExitCode
$out = @(Get-Content -LiteralPath $outTmp -ErrorAction SilentlyContinue) + `
       @(Get-Content -LiteralPath "$outTmp.err" -ErrorAction SilentlyContinue)
Remove-Item -LiteralPath $outTmp, "$outTmp.err" -Force -ErrorAction SilentlyContinue
$out | ForEach-Object { Write-Log ([string]$_) }

# 成功标准（裁决硬约束）：退出码 0 且实测 auto_vacuum=2
$av = ($out | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -eq '2' } | Select-Object -Last 1)
$after = (Get-Item -LiteralPath $DbFile).Length
Write-Log ("SIZE after={0} bytes, rc={1}, auto_vacuum={2}" -f $after, $rc, $av)
if ($rc -eq 0 -and $av -eq '2') {
    if (Test-Path -LiteralPath $FlagFile) { Remove-Item -LiteralPath $FlagFile -Force -ErrorAction SilentlyContinue; Write-Log 'DONE flag removed' }
    # MoA 裁决修正：不再自删快捷方式——lnk 永久保留作非提权兜底通道（boot 任务被组策略
    # 禁用/损坏时的唯一退路）；无 flag 时下次触发秒退（<2s），常备开销可忽略。
    Write-Log 'DONE vacuum boot 完成（auto_vacuum=2，此后增量回收自动维持；自愈通道保留兜底）'
    exit 0
}
Write-Log "FAILED rc=$rc auto_vacuum=$av（留 flag，下次登录重试；多次失败请人工 -VacuumNow）"
exit 1