<#
  Kilo 周期性维护（Windows 计划任务入口）
  =====================================
  背景：Kilo 内置清理只管 tool-output（7 天）与 remote-attachments（会话关闭即删）。
  agent 在 Kilo 托管临时目录里写的脚本/测试库、install 产生的配置备份、以及
  kilo.db 的事件溯源流水，都没有回收者 —— 本脚本是这三者的统一维护入口。

  组成：
    1) cleanup.sh --run           临时目录 + 配置备份保留（无 DB 锁）
    2) db-maintain.sh --no-vacuum kilo.db 事件/过期会话瘦身（分批短锁，Kilo 活着也安全）
       · VACUUM（回收文件空间）保持人工执行 —— 需独占锁，会打断并发会话

  用法：
    .\kilo-maintenance.ps1 -RunOnce       立即执行一次（清理 + DB 瘦身）
    .\kilo-maintenance.ps1 -CleanupOnly   只清理，不碰 DB
    .\kilo-maintenance.ps1 -DbStatus      只打印 kilo.db 体检（只读）
    .\kilo-maintenance.ps1 -AutoIfDue     按到期规则执行（登录自启用；清理 >1 天、DB >7 天）
    .\kilo-maintenance.ps1 -InstallStartup    安装登录自启（免管理员）
    .\kilo-maintenance.ps1 -UninstallStartup  移除登录自启
    .\kilo-maintenance.ps1 -Register      注册系统计划任务（每日 04:00 清理；每周日 04:30 清理+DB，需管理员）
    .\kilo-maintenance.ps1 -Unregister    删除系统计划任务
    .\kilo-maintenance.ps1 -Status        查看计划任务/自启与最近日志

  日志：$HOME\.local\state\kilo\maintenance\*.log（只保留最近 14 份，自身不产生垃圾）
  状态：$HOME\.local\state\kilo\maintenance\state.json（记录上次清理/瘦身时间，供 -AutoIfDue 判定）
#>
[CmdletBinding()]
param(
    [switch]$RunOnce,
    [switch]$CleanupOnly,
    [switch]$DbStatus,
    [switch]$AutoIfDue,
    [switch]$InstallStartup,
    [switch]$UninstallStartup,
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [int]$KeepLogs = 14
)

$ErrorActionPreference = 'Stop'

# -KeepLogs 非法值回退默认（Select-Object -Skip 负数会直接抛参数绑定异常）
if ($KeepLogs -lt 1) { Write-Warning "[MAINT] WARN: -KeepLogs $KeepLogs 非法（需 ≥1），按默认 14 处理"; $KeepLogs = 14 }

# 脚本自身路径：必须用 $PSCommandPath 在**脚本作用域**取。
# $MyInvocation.MyCommand.Path 在函数体内指向该函数的调用，取到空串 ——
# 曾导致自启快捷方式生成 `-File ""`（命令必然失败，却打印「已安装」）。
$SelfPath = $PSCommandPath
if (-not $SelfPath) { $SelfPath = $MyInvocation.MyCommand.Path }
if (-not $SelfPath) { throw 'FAIL: 无法确定脚本自身路径（请用 -File 方式调用本脚本）' }

$RepoDir  = Split-Path -Parent (Split-Path -Parent $SelfPath)   # <repo>/scripts -> <repo>
$StateRoot = Join-Path $HOME '.local\state\kilo'
$LogDir   = Join-Path $StateRoot 'maintenance'
$StateFile = Join-Path $LogDir 'state.json'
$StartupDir = [Environment]::GetFolderPath('Startup')
$StartupLnk = Join-Path $StartupDir 'kilo-maintenance.lnk'
$TaskDaily   = 'kilo-maintenance-daily'
$TaskWeekly  = 'kilo-maintenance-weekly'
$TaskDesc    = 'Kilo 维护：临时文件/配置备份清理 + kilo.db 瘦身（VACUUM 保持人工）'
$CleanupEveryDays = 1
$DbEveryDays      = 7

# 全局兜底：登录自启是 -WindowStyle Hidden 的隐藏进程，任何未捕获异常都会**静默消失**。
# trap 把错误落盘到 error.log，保证自动化可观测（下次 -Status / 人工都能看到失败原因）。
trap {
    $msg = "[ERROR] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $($_.Exception.GetType().Name): $($_.Exception.Message)"
    if ($_.ScriptStackTrace) { $msg += "`n" + (($_.ScriptStackTrace -split "`n") | Select-Object -First 3) }
    try {
        $null = New-Item -ItemType Directory -Force -Path $LogDir
        $msg | Out-File -LiteralPath (Join-Path $LogDir 'error.log') -Append -Encoding utf8
    } catch { $msg += "`n[ERROR] (error.log 写入也失败：$($_.Exception.Message))" }
    Write-Host $msg
    exit 1
}

function Resolve-Bash {
    foreach ($p in @('C:\Program Files\Git\bin\bash.exe', 'C:\Program Files (x86)\Git\bin\bash.exe')) {
        if (Test-Path $p) { return $p }
    }
    $cmd = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'FAIL: 找不到 bash.exe（清理/维护脚本需要 Git Bash）'
}

# 跑一个仓库内脚本：传原生正斜杠路径，避免 Git Bash 对反斜杠/盘符的歧义
function Invoke-RepoScript {
    param([string]$Script, [string[]]$ScriptArgs = @(), [string]$Label)
    $bash = Resolve-Bash
    $scriptPath = Join-Path $RepoDir $Script
    if (-not (Test-Path $scriptPath)) { throw "FAIL: 仓库脚本缺失 $Script" }
    $scriptNative = $scriptPath -replace '\\', '/'

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    $log = Join-Path $LogDir "$stamp-$Label.log"

    $header = "== $stamp  $Script $($ScriptArgs -join ' ') =="
    Write-Host $header
    $header | Out-File -LiteralPath $log -Append -Encoding utf8

    # 不用 Tee-Object：PowerShell 5.1 下 -LiteralPath 与 -Append 属不同参数集，会报
    # 「Parameter set cannot be resolved」。改为先收集再落盘。
    #
    # ⚠ 2026-09-27 维护中断专项（真实事故）：PS 5.1 在本脚本全局 $ErrorActionPreference='Stop'
    # 下，原生进程往 stderr 写一行就会构造 ErrorRecord 并**抛终止异常**——db-maintain.sh 的
    # 单批耗时告警（>6000ms，仅诊断用）走 stderr，被当成致命错误，整个 RunOnce 在第一批
    # 删除提交后立刻 abort（实测 RemoteException，error.log 有据），DB 瘦身从未跑完。
    # 修法：native 调用期间临时把偏好降为 Continue，只用 $LASTEXITCODE 判成败——
    # 退出码才是真相，stderr 只是诊断文本；调用后立即还原，不影响后续 cmdlet。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $bash $scriptNative @ScriptArgs 2>&1
        $rc = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    $output | ForEach-Object { Write-Host $_ }
    $output | Out-File -LiteralPath $log -Append -Encoding utf8
    "exit=$rc" | Out-File -LiteralPath $log -Append -Encoding utf8
    Write-Host "  -> exit=$rc  log=$log"

    # 日志自身也要封顶：只留最近 N 份
    Get-ChildItem -LiteralPath $LogDir -File -Filter '*.log' |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepLogs |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    return $rc
}

function Invoke-Cleanup {
    # 临时目录兄弟项留 3 天；Kilo 托管临时目录内部留 7 天；配置备份留最近 2 个
    return Invoke-RepoScript -Script 'cleanup.sh' -ScriptArgs @('--run', '--days', '3', '--tmp-days', '7', '--keep-backups', '2') -Label 'cleanup'
}

function Invoke-DbMaintain {
    param([switch]$StatusOnly)
    $a = @('--no-vacuum', '--days', '30')
    if ($StatusOnly) { $a = @('--status') }
    return Invoke-RepoScript -Script 'db-maintain.sh' -ScriptArgs $a -Label 'db'
}

function Get-MaintenanceTask {
    param([string]$Name)
    Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Read-MaintState {
    $st = [pscustomobject]@{ lastCleanup = $null; lastDb = $null }
    if (Test-Path $StateFile) {
        try {
            $j = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.lastCleanup) { $st.lastCleanup = [datetime]$j.lastCleanup }
            if ($j.lastDb) { $st.lastDb = [datetime]$j.lastDb }
        } catch { Write-Warning "state.json 解析失败，按「从未执行」处理：$($_.Exception.Message)" }
    }
    return $st
}

function Write-MaintState {
    param($State)
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    [pscustomobject]@{
        lastCleanup = if ($State.lastCleanup) { $State.lastCleanup.ToString('o') } else { $null }
        lastDb      = if ($State.lastDb) { $State.lastDb.ToString('o') } else { $null }
        updatedAt   = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Test-Due {
    param($Last, [int]$EveryDays)
    if (-not $Last) { return $true }
    return ((Get-Date) - $Last).TotalDays -ge $EveryDays
}

# 登录自启：免管理员（写用户 Startup 目录）。带 -AutoIfDue，所以每次登录只补做真正过期的部分。
function Install-StartupShortcut {
    $ps = (Get-Command powershell.exe).Source
    $args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -AutoIfDue' -f $SelfPath
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($StartupLnk)
    $lnk.TargetPath = $ps
    $lnk.Arguments = $args
    $lnk.WorkingDirectory = $RepoDir
    $lnk.Description = 'Kilo 维护（登录时补做：临时文件清理 + kilo.db 瘦身）'
    $lnk.Save()

    # 立即回读校验：避免快捷方式指向不存在的路径却报「已安装」
    $check = $shell.CreateShortcut($StartupLnk)
    if (-not (Test-Path $StartupLnk) -or $check.Arguments -notmatch [regex]::Escape($SelfPath)) {
        throw "FAIL: 自启快捷方式校验失败（Arguments=$($check.Arguments)）"
    }
    Write-Host "[STARTUP] 已安装登录自启：$StartupLnk"
    Write-Host "[STARTUP] 目标脚本：$SelfPath"
    Write-Host "[STARTUP] 触发条件：清理间隔 > $CleanupEveryDays 天、DB 瘦身间隔 > $DbEveryDays 天（VACUUM 仍需人工）"
}

if ($Status) {
    foreach ($t in @($TaskDaily, $TaskWeekly)) {
        $task = Get-MaintenanceTask $t
        if ($task) {
            $info = $task | Get-ScheduledTaskInfo
            Write-Host "[TASK] $t  状态=$($task.State)  上次=$($info.LastRunTime)  结果=$($info.LastTaskResult)  下次=$($info.NextRunTime)"
        } else {
            Write-Host "[TASK] $t  未注册"
        }
    }
    # ⚠ 2026-09-27 事故：仓库目录改名（kilo_config → kilo-runtime）后，登录自启快捷方式仍
    # 指向旧路径，快捷方式**文件存在但目标脚本已不存在**——-Status 只看文件在不在，照报
    # 「已安装」，实际自 9/19 起每次登录都静默失败，维护停了 11 天。故此处必须回读快捷方式
    # 的 -File 目标并验证其真实存在，失效则显式报警（可观测性缺口，不是口味问题）。
    $startupState = '未安装'
    if (Test-Path $StartupLnk) {
        $startupState = '已安装'
        try {
            $sh = New-Object -ComObject WScript.Shell
            $m = [regex]::Match($sh.CreateShortcut($StartupLnk).Arguments, '-File\s+"([^"]+)"')
            if (-not $m.Success) {
                $startupState = '已安装·失效（无法解析目标脚本）'
            } elseif (-not (Test-Path -LiteralPath $m.Groups[1].Value)) {
                $startupState = "已安装·失效（目标不存在：$($m.Groups[1].Value)）—— 重跑 -InstallStartup 修复"
            }
        } catch {
            $startupState = "已安装·校验异常（$($_.Exception.Message)）"
        }
    }
    Write-Host ("[AUTO] 登录自启：{0}  {1}" -f $startupState, $StartupLnk)
    $st = Read-MaintState
    Write-Host ("[AUTO] 上次清理：{0}（{1}）  上次 DB 瘦身：{2}（{3}）" -f `
        $(if ($st.lastCleanup) { $st.lastCleanup } else { '从未' }), $(if (Test-Due $st.lastCleanup $CleanupEveryDays) { '已到期' } else { '未到期' }), `
        $(if ($st.lastDb) { $st.lastDb } else { '从未' }), $(if (Test-Due $st.lastDb $DbEveryDays) { '已到期' } else { '未到期' }))
    Write-Host "[LOG ] $LogDir"
    if (Test-Path $LogDir) {
        Get-ChildItem -LiteralPath $LogDir -File | Sort-Object LastWriteTime -Descending |
            Select-Object -First 5 | ForEach-Object { Write-Host ("       {0}  {1:N1} KB  {2}" -f $_.LastWriteTime, ($_.Length / 1KB), $_.Name) }
    }
    # 失败留痕：自启是隐藏进程，出错只能靠 error.log 发现
    $errLog = Join-Path $LogDir 'error.log'
    if (Test-Path $errLog) {
        Write-Host "[ERR ] $errLog（最近 3 条）："
        Get-Content -LiteralPath $errLog -Encoding UTF8 | Select-Object -Last 3 | ForEach-Object { Write-Host "       $_" }
    }
    exit 0
}

if ($UninstallStartup) {
    if (Test-Path $StartupLnk) { Remove-Item -LiteralPath $StartupLnk -Force; Write-Host "[STARTUP] 已移除 $StartupLnk" }
    else { Write-Host "[STARTUP] 未安装（跳过）" }
    exit 0
}

if ($InstallStartup) { Install-StartupShortcut; exit 0 }

if ($Unregister) {
    foreach ($t in @($TaskDaily, $TaskWeekly)) {
        if (Get-MaintenanceTask $t) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "[TASK] 已删除 $t" }
        else { Write-Host "[TASK] 未注册 $t（跳过）" }
    }
    exit 0
}

if ($Register) {
    $bash = Resolve-Bash
    $self = $SelfPath
    $actionClean = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -CleanupOnly' -f $self) `
        -WorkingDirectory $RepoDir
    $actionFull = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -RunOnce' -f $self) `
        -WorkingDirectory $RepoDir

    # 只在用户会话内运行（无需存储密码）；未登录/关机时 StartWhenAvailable 决定补跑
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

    $tDaily  = New-ScheduledTaskTrigger -Daily -At 04:00
    $tWeekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 04:30

    try {
        Register-ScheduledTask -TaskName $TaskDaily -Action $actionClean -Trigger $tDaily -Principal $principal -Settings $settings -Description $TaskDesc -Force | Out-Null
        Register-ScheduledTask -TaskName $TaskWeekly -Action $actionFull -Trigger $tWeekly -Principal $principal -Settings $settings -Description $TaskDesc -Force | Out-Null
    }
    catch {
        # 常见失败：非管理员（Access denied / 0x80070005）。放宽 catch —— 只捕 RuntimeException
        # 会漏掉 UnauthorizedAccessException 等原生异常，导致输出裸堆栈而非友好提示。
        Write-Warning "[TASK] 系统计划任务注册失败（$($_.Exception.GetType().Name)）：$($_.Exception.Message)"
        Write-Warning "[TASK] 免管理员替代方案：以管理员身份重开 PowerShell 后重跑本命令，或改用 -InstallStartup（登录自启 + 到期判断）。"
        exit 2
    }
    Write-Host "[TASK] 已注册：$TaskDaily（每日 04:00 清理）、$TaskWeekly（每周日 04:30 清理 + DB 瘦身）"
    Write-Host "[TASK] bash: $bash"
    Write-Host "[TASK] VACUUM 未自动化（需独占锁）：在 Kilo 全部关闭后人工跑 ./db-maintain.sh"
    exit 0
}

if ($DbStatus) { exit (Invoke-DbMaintain -StatusOnly) }

if ($CleanupOnly) {
    $rc = Invoke-Cleanup
    $st = Read-MaintState
    if ($rc -eq 0) { $st.lastCleanup = Get-Date; Write-MaintState $st }
    exit $rc
}

if ($RunOnce) {
    $rc1 = Invoke-Cleanup
    $rc2 = Invoke-DbMaintain
    $st = Read-MaintState
    if ($rc1 -eq 0) { $st.lastCleanup = Get-Date }
    if ($rc2 -eq 0) { $st.lastDb = Get-Date }
    Write-MaintState $st
    if ($rc1 -ne 0 -or $rc2 -ne 0) { exit 1 } else { exit 0 }
}

# 登录自启入口：只执行真正过期的部分，避免每次登录都动 DB
if ($AutoIfDue) {
    $st = Read-MaintState
    $did = @()
    if (Test-Due $st.lastCleanup $CleanupEveryDays) {
        if ((Invoke-Cleanup) -eq 0) { $st.lastCleanup = Get-Date; $did += 'cleanup' }
    }
    if (Test-Due $st.lastDb $DbEveryDays) {
        if ((Invoke-DbMaintain) -eq 0) { $st.lastDb = Get-Date; $did += 'db' }
    }
    Write-MaintState $st
    if ($did.Count -eq 0) { Write-Host '[AUTO] 均未到期，跳过（-Status 可看到期时间）' }
    else { Write-Host "[AUTO] 已执行：$($did -join ' + ')" }
    exit 0
}

Write-Host "未指定动作。用 -RunOnce / -CleanupOnly / -DbStatus / -AutoIfDue / -InstallStartup / -Register / -Status。"
exit 0
