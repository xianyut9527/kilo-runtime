<#
  Kilo 周期性维护（Windows 计划任务入口）
  =====================================
  背景：Kilo 内置清理只管 tool-output（7 天）与 remote-attachments（会话关闭即删）。
  agent 在 Kilo 托管临时目录里写的脚本/测试库、install 产生的配置备份、以及
  kilo.db 的事件溯源流水，都没有回收者 —— 本脚本是这三者的统一维护入口。

  组成：
    1) cleanup.sh --run            临时目录 + 配置备份保留（无 DB 锁）
    2) storage-maintain.mjs --run  数据目录增长项回收：session_diff/log/snapshot 留 30 天（无 DB 锁）
    3) db-maintain.sh               kilo.db 事件/过期会话瘦身（分批短锁，Kilo 活着也安全）
       · VACUUM（回收文件空间）按阈值自动执行：空闲页占比 ≥ VACUUM_MIN_PCT（默认 25%）
         且无 kilo 写者时才跑（实测 7.34GB→1.49GB 约 150s）；否则自动跳过，绝不打断会话

  用法：
    .\kilo-maintenance.ps1 -RunOnce       立即执行一次（清理 + 数据目录回收 + DB 瘦身 + 孤儿收割）
    .\kilo-maintenance.ps1 -CleanupOnly   只清理，不碰 DB
    .\kilo-maintenance.ps1 -DbStatus      只打印 kilo.db 体检（只读）
    .\kilo-maintenance.ps1 -VacuumNow     关闭全部 Kilo 后立即离线 VACUUM（含 auto_vacuum=2 引导）
    .\kilo-maintenance.ps1 -AutoIfDue     按到期规则执行（登录自启用；清理 >1 天、DB >1 天）
    .\kilo-maintenance.ps1 -ReapOrphans   立即收割泄漏孤儿进程树（安全判定见 Invoke-OrphanReap）
    .\kilo-maintenance.ps1 -ListOrphans   只读干跑：列出会收割/只报告的孤儿（不杀任何进程）
    .\kilo-maintenance.ps1 -InstallStartup    安装登录自启（免管理员）
    .\kilo-maintenance.ps1 -UninstallStartup  移除登录自启
    .\kilo-maintenance.ps1 -Register      注册系统计划任务（登录时清理 / 登录时清理+DB，需管理员）
    .\kilo-maintenance.ps1 -Unregister    删除系统计划任务
    .\kilo-maintenance.ps1 -Status        查看计划任务/自启/自愈通道与最近日志

  日志：$HOME\.local\state\kilo\maintenance\*.log（只保留最近 14 份，自身不产生垃圾）
  状态：$HOME\.local\state\kilo\maintenance\state.json（记录上次清理/瘦身时间，供 -AutoIfDue 判定）
#>
[CmdletBinding()]
param(
    [switch]$RunOnce,
    [switch]$CleanupOnly,
    [switch]$DbStatus,
    [switch]$VacuumNow,
    [switch]$AutoIfDue,
    [switch]$ReapOrphans,
    [switch]$ListOrphans,
    [switch]$InstallStartup,
    [switch]$UninstallStartup,
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [int]$KeepLogs = 14,
    [int]$ReapMinAgeHours = 24
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
$TaskDesc    = 'Kilo 维护：临时文件/配置备份/数据目录(session_diff/log/snapshot)清理 + kilo.db 瘦身（VACUUM 按阈值自动）'
$CleanupEveryDays = 1
# 2026-10-18：event 表约 1.3GB/天（message.updated 单类 3.35GB/3 天），7 天间隔会让事件表
# 涨到 ~9GB。改为每日清事件（DELETE 分批短锁，Kilo 运行中也安全；VACUUM 仍按阈值+无写者门槛）。
$DbEveryDays      = 1

# 引导死锁自愈闭环（2026-11-04，MoA 升级双通道）：db-maintain.sh 检测到 auto_vacuum≠2
# 且有写者时写 vacuum-needed.flag；本脚本据此自动装两路自愈通道：
#   · 登录通道（Startup lnk，免管理员，保底常备，不再成功后自删——MoA 裁决：永久保留
#     作 boot 任务被组策略禁用/损坏时的唯一非提权退路；vacuum-boot.ps1 无 flag 秒退）
#   · 开机通道（SYSTEM AtStartup 计划任务，管理员注册后升格；开机未登录窗口即可跑）
# flag 解决后仅清 flag，通道保留兜底。全程无人工步骤；用户可放 vacuum-bootstrap.disabled
# 哨兵显式 opt-out（尊重手动删除快捷方式的意图）。
$FlagFile          = Join-Path $LogDir 'vacuum-needed.flag'
$BootstrapLnk      = Join-Path $StartupDir 'kilo-vacuum-bootstrap.lnk'
$BootstrapDisabled = Join-Path $LogDir 'vacuum-bootstrap.disabled'
$VacuumBootScript  = Join-Path $RepoDir 'scripts\vacuum-boot.ps1'
# 开机通道（MoA P0-2）：SYSTEM AtStartup 任务在「开机未登录」窗口跑离线 VACUUM；注册需
# 管理员（-Register 管理员流程装；日常用户态尝试失败属预期，登录 lnk 兜底常备）。
$BootTaskName      = 'kilo-vacuum-boot'
# 状态目录卫生门限（MoA P0-3）：时间戳日志年龄上限；追加式长文件滚动阈值 256KB；总量告警 200MB。
$LogMaxAgeDays     = 30
$StateDirMaxBytes  = 200MB

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

function Resolve-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'FAIL: 找不到 node.exe（storage-maintain.mjs 数据目录回收需要 Node）'
}

# 变更类入口跨进程单飞（2026-11-12 维护并发专项，error.log 05:35:06 实锤）：
# 计划任务（AtLogOn 触发 + 12:30/12:45 定时，StartWhenAvailable 负责错过补跑）与登录
# 自启 lnk（-AutoIfDue）是**三个独立进程**，MultipleInstances=IgnoreNew 只防同名任务
# 自叠——补跑窗口会让「任务 + lnk」同秒并发清理：撞同名日志中止 + 并发写 state.json。
# 实现用独占锁文件（FileShare.None 跨进程/跨会话生效），进程结束由 OS 自动释放，
# 无需 try/finally 兜底（异常/被杀也不留死锁）。拿不到锁 → 静默跳过（另一实例正在维护）。
function Enter-MaintRunLock {
    $lockPath = Join-Path $LogDir 'run.lock'
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    try {
        return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch {
        Write-Host '[SKIP] 另一维护实例正在运行（单飞锁占用），本次跳过'
        return $null
    }
}

# 跑一个仓库内脚本：传原生正斜杠路径，避免 Git Bash 对反斜杠/盘符的歧义。
# -Node 开关：用 node 跑 .mjs（storage-maintain）；默认走 Git Bash（.sh）。
function Invoke-RepoScript {
    param([string]$Script, [string[]]$ScriptArgs = @(), [string]$Label, [switch]$Node)
    $exe = if ($Node) { Resolve-Node } else { Resolve-Bash }
    $scriptPath = Join-Path $RepoDir $Script
    if (-not (Test-Path $scriptPath)) { throw "FAIL: 仓库脚本缺失 $Script" }
    $scriptNative = $scriptPath -replace '\\', '/'

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    # 日志名带 PID 唯一化（2026-11-12）：并发入口同秒启动时同秒时间戳会撞同名日志，
    # Out-File -Append 撞上对方独占写 → IOException 直接中止整轮维护（error.log 有据）。
    # 格式仍匹配轮转/卫生正则 ^\d{8}-\d{6}-.+\.log$。
    $log = Join-Path $LogDir "$stamp-$PID-$Label.log"

    $header = "== $stamp  pid=$PID  $Script $($ScriptArgs -join ' ') =="
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
    $prevEnc = $null
    $ErrorActionPreference = 'Continue'
    try {
        # Git Bash / Node 输出 UTF-8；PS 5.1 默认按控制台代码页解码，中文日志会变 mojibake。
        try { $prevEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
        # 原生 stderr 在 PS 5.1 会变成 ErrorRecord；直接 Out-File 会写入
        # "bash.exe : ... NativeCommandError" 包装，既脏又容易被误判为失败。
        # 只取真实消息文本，退出码仍以 $LASTEXITCODE 为准。
        $output = & $exe $scriptNative @ScriptArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }
        }
        $rc = $LASTEXITCODE
    } finally {
        if ($prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
        $ErrorActionPreference = $prevEap
    }
    $output | ForEach-Object { Write-Host $_ }
    $output | Out-File -LiteralPath $log -Append -Encoding utf8
    "exit=$rc" | Out-File -LiteralPath $log -Append -Encoding utf8
    Write-Host "  -> exit=$rc  log=$log"

    # 日志自身也要封顶：只留最近 N 份。
    # 只轮转 Invoke-RepoScript 生成的 yyyyMMdd-HHmmss-*.log；error.log / vacuum-boot.log
    # 是长期故障/离线 VACUUM 证据，不能被日常轮转误删。
    Get-ChildItem -LiteralPath $LogDir -File -Filter '*.log' |
        Where-Object { $_.Name -match '^\d{8}-\d{6}-.+\.log$' } |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepLogs |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    return $rc
}

function Invoke-Cleanup {
    # 临时目录兄弟项留 3 天；Kilo 托管临时目录内部留 7 天；配置备份留最近 2 个；
    # 数据目录增长项（session_diff/log/tsc-cache 30 天；session_share 60 天独立窗；
    # snapshot 按顶层目录 mtime 整份删除，2026-10-07/10-08 体检闭环）。
    # 两者失败都不互相阻断：返回首个非零退出码（后续步骤照跑）。
    $rc1 = Invoke-RepoScript -Script 'cleanup.sh' -ScriptArgs @('--run', '--days', '3', '--tmp-days', '7', '--keep-backups', '2') -Label 'cleanup'
    # 2026-10-07：不再带 --keep-snapshots。snapshot 是每个项目一份的影子 git 对象库（实测 423MB）
    # 且永不回收——storage-maintain 现按「顶层目录 mtime 超期」整份删除（只删含 .git/objects 的目录，
    # 不碰活跃库），这是「越用越臃肿」的最后一个无回收增长项。
    $rc2 = Invoke-RepoScript -Script 'scripts/storage-maintain.mjs' -ScriptArgs @('--run', '--days', '30') -Label 'storage' -Node
    if ($rc1 -ne 0) { return $rc1 }
    return $rc2
}

function Invoke-DbMaintain {
    param([switch]$StatusOnly)
    # 2026-10-07：不再无条件 --no-vacuum。db-maintain.sh 现自带 VACUUM 门槛——
    # 「空闲页占比 ≥ VACUUM_MIN_PCT（默认 25%）且当前无 kilo 写者」才执行，否则自动跳过。
    # 因此自动维护可以在无人值守时安全回收文件空间（此前只 DELETE，文件永不缩：
    # 实测 7.34GB 文件里 5.4GB 是 freelist 空洞）。Kilo 开着时该步自然跳过，不打断会话。
    $a = @('--days', '30')
    if ($StatusOnly) { $a = @('--status') }
    return Invoke-RepoScript -Script 'db-maintain.sh' -ScriptArgs $a -Label 'db'
}

# sqlite3 探测（安装期固化绝对路径进快捷方式，防登录时 PATH 差异/劫持）
function Resolve-Sqlite3 {
    $c = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\SQLite\sqlite3.exe",
                     "${env:ProgramFiles(x86)}\SQLite\sqlite3.exe",
                     "$env:LOCALAPPDATA\Programs\SQLite\sqlite3.exe")) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

# ── 状态目录卫生（MoA P0-3，2026-11-04 实证：3 天堆 12 个日志、10-25 旧脚本副本、──
# ── 10-26 vacuum-at-logon 遗留、10-27 done 哨兵——只增不删就是新的泄漏面）────────
# 规则：时间戳日志年龄 >30 天强制删（数量门仍在 Invoke-RepoScript 既有轮转）；
# vacuum-boot.log / error.log 追加式长文件 >256KB 滚动成时间戳名进轮转；
# 遗留物幂等清理；reclaim-intent 消费副本 >30 天删；总量 >200MB 告警（心跳侧独立复查）。
function Invoke-StateDirHygiene {
    if (-not (Test-Path -LiteralPath $LogDir)) { return }
    $now = Get-Date
    Get-ChildItem -LiteralPath $LogDir -File -Filter '*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{8}-\d{6}-.+\.log$' -and $now.Subtract($_.LastWriteTime).TotalDays -gt $LogMaxAgeDays } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    foreach ($n in @('vacuum-boot.log', 'error.log')) {
        $f = Join-Path $LogDir $n
        if (Test-Path -LiteralPath $f) {
            $item = Get-Item -LiteralPath $f
            if ($item.Length -gt 256KB) {
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                try { Move-Item -LiteralPath $f -Destination (Join-Path $LogDir "$stamp-rotated-$n") -Force } catch { }
            }
        }
    }
    # 遗留物：vacuum-at-logon.*（10-25 起被 vacuum-boot.ps1 取代）、vacuum-boot.done（旧一次性哨兵）
    foreach ($n in @('vacuum-at-logon.ps1', 'vacuum-at-logon.log', 'vacuum-boot.done')) {
        Remove-Item -LiteralPath (Join-Path $LogDir $n) -Force -ErrorAction SilentlyContinue
    }
    # 状态目录里的旧脚本副本（-VacuumNow 过渡兼容兜底）：仓库 SSOT 存在且副本 >30 天即清
    $stateCopy = Join-Path $LogDir 'vacuum-boot.ps1'
    if (Test-Path -LiteralPath $stateCopy) {
        $item = Get-Item -LiteralPath $stateCopy
        if ($now.Subtract($item.LastWriteTime).TotalDays -gt $LogMaxAgeDays -and (Test-Path -LiteralPath $VacuumBootScript)) {
            Remove-Item -LiteralPath $stateCopy -Force -ErrorAction SilentlyContinue
            Write-Host '[MAINT] 已清理状态目录陈旧脚本副本（>30 天，仓库 SSOT 优先）'
        }
    }
    # reclaim-intent 消费副本（db-maintain.sh 单次消费 rename 产物）>30 天清理
    Get-ChildItem -LiteralPath $LogDir -File -Filter 'reclaim-intent.json.consumed-*' -ErrorAction SilentlyContinue |
        Where-Object { $now.Subtract($_.LastWriteTime).TotalDays -gt $LogMaxAgeDays } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    # 总量观测（>200MB 说明轮转/卫生链路本身失效，交给心跳告警闭环）
    $files = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($bytes -gt $StateDirMaxBytes) {
        Write-Warning ("[MAINT] 状态目录 {0:N1}MB 超 200MB 上限（{1} 个文件）——轮转/卫生是否停摆？" -f ($bytes / 1MB), $files.Count)
    }
}

# ── 孤儿进程收割（MoA P0-1：deny 优先 + 签名 allowlist + 父死 + 年龄 + 杀前复验）──
# 根因：Windows 不级联收割被中止命令的子进程树。实证泄漏：2× kilo.exe __background-process-runner
# 整树 powershell→npm→vite dev（10-29/11-03）、npm run dev ×2、start:test、npx jest、npx MCP——
# node 累计烧 117 CPU 小时。2026-11-05 扩面：Playwright/Puppeteer/vitest/mocha 驱动也收割
# （浏览器子进程随 taskkill /T 树杀；chrome/msedge 自身仍绝对 deny，永不按名字碰）。安全模型：
#   deny 优先   —— 候选只收 node.exe/kilo.exe（chrome/用户 shell 不在列）；命令行含 chrome/edge
#                  一律跳过；父进程仍活 = 活跃会话/用户自启，天然豁免。
#   三条件 AND  —— 父 PID 不在存活集 + 年龄 > $ReapMinAgeHours + 命中泄漏签名才杀；
#                  未命中签名只报告（含 pm2：可能托管用户业务，默认绝不杀）。
#   杀前复验   —— PID 复用防线：taskkill 前重查该 PID 的 CreationDate 与快照一致才动手。
#   树杀根层   —— 只对父死的最上层根 taskkill /T /F（内部父仍活的整树随根收割）。
# 日志：yyyyMMdd-HHmmss-reap.log（匹配既有轮转模式，随 KeepLogs/年龄门自动回收）。
function Invoke-OrphanReap {
    param([switch]$ListOnly)

    $null = New-Item -ItemType Directory -Force -Path $LogDir
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $reapLog = Join-Path $LogDir "$stamp-reap.log"
    # 惰性落盘：无孤儿时只输出控制台摘要、不写文件（否则每日两趟干跑会把日志堆爆，
    # KeepLogs=14 的轮转窗口被无信息量记录挤占）。有孤儿根才留下完整记录。
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $say = { param($m) Write-Host $m; $lines.Add($m) }

    $killSigs = @(
        '__background-process-runner',                  # kilo 后台 runner 泄漏（实证）
        'npm-cli\.js.*\srun\s+dev',                     # npm run dev（vite dev server 实证）
        'npm-cli\.js.*\srun\s+start:test',              # llamas-api start:test 实证
        'npx-cli\.js',                                  # npx 拉起的 MCP/jest（实证 10-28/11-01）
        'node_modules[\\/].*(mcp|modelcontextprotocol)',# npx 缓存里的 MCP server
        '[\\/]jest([\\/]|\.js)',                        # jest 残留
        'playwright[\\/]',                              # Playwright 驱动残留（其浏览器子进程随树杀）
        'puppeteer[\\/]',                               # Puppeteer 驱动残留
        'node_modules[\\/].*(vitest|mocha)[\\/]'        # 测试 runner 残留
    )
    $reportOnlySigs = @('pm2')                          # pm2 daemon：只报告（P1 再条件化）

    $all = @(Get-CimInstance Win32_Process)
    $live = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($p in $all) { [void]$live.Add([uint32]$p.ProcessId) }
    $cut = (Get-Date).AddHours(-1 * $ReapMinAgeHours)

    $considered = 0; $killed = 0; $reported = 0; $protected = 0
    foreach ($p in $all) {
        if ($p.Name -ne 'node.exe' -and $p.Name -ne 'kilo.exe') { continue }
        $cl = [string]$p.CommandLine
        if ($cl -match 'chrome|msedge') { continue }                     # deny：浏览器绝不碰
        if ($live.Contains([uint32]$p.ParentProcessId)) { continue }    # 父活=非孤儿（活跃会话/用户自启）
        if ($p.CreationDate -ge $cut) { continue }                       # 留 24h 观察窗
        $considered++
        $isPm2 = $false
        foreach ($s in $reportOnlySigs) { if ($cl -match $s) { $isPm2 = $true; break } }
        $clShort = if ($cl.Length -gt 140) { $cl.Substring(0, 140) } else { $cl }
        $age = [int]((Get-Date) - $p.CreationDate).TotalDays
        if ($isPm2) {
            & $say ("[REAP][REPORT-PM2] pid={0} ppid={1} age={2}d {3}" -f $p.ProcessId, $p.ParentProcessId, $age, $clShort)
            $reported++
            continue
        }
        $isKill = $false
        foreach ($s in $killSigs) { if ($cl -match $s) { $isKill = $true; break } }
        if (-not $isKill) {
            & $say ("[REAP][REPORT] pid={0} ppid={1} age={2}d {3}" -f $p.ProcessId, $p.ParentProcessId, $age, $clShort)
            $reported++
            continue
        }
        if ($ListOnly) {
            & $say ("[REAP][WOULD-KILL] pid={0} ppid={1} age={2}d {3}" -f $p.ProcessId, $p.ParentProcessId, $age, $clShort)
            continue
        }
        # 杀前复验（PID 复用防线）：PID 仍在且 CreationDate 与快照一致才动手
        $again = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)" -ErrorAction SilentlyContinue
        if (-not $again -or $again.CreationDate -ne $p.CreationDate) {
            & $say ("[REAP][SKIP-REVALIDATE] pid={0}（PID 已变化/退出，跳过防误杀）" -f $p.ProcessId)
            $protected++
            continue
        }
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $null = & taskkill.exe /PID $p.ProcessId /T /F 2>&1
            $rc = $LASTEXITCODE
        } finally { $ErrorActionPreference = $prevEap }
        # 退出判定必须等：taskkill /F 返回 0 后进程可能仍在「终止中」，立刻 Get-Process
        # 会误报 KILL-FAILED（2026-11-04 实测 5/7 误报）。等进程真正退出（上限 5s）。
        $gone = $true
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc) {
            try { $gone = $proc.WaitForExit(5000) } catch { $gone = $false }
        }
        if ($rc -eq 0 -and $gone) {
            & $say ("[REAP][KILLED] pid={0} ppid={1} age={2}d {3}" -f $p.ProcessId, $p.ParentProcessId, $age, $clShort)
            $killed++
        } else {
            & $say ("[REAP][KILL-FAILED] pid={0} rc={1} gone={2}（权限不足/仍在退出，下轮复扫）" -f $p.ProcessId, $rc, $gone)
        }
    }
    $mode = if ($ListOnly) { 'DRY-RUN' } else { 'EXECUTE' }
    & $say ("[REAP] {0} 完成：孤儿根 {1} 个（收割成功 {2}），只报告 {3}，复验保护 {4}（minAge={5}h）" -f `
        $mode, $considered, $killed, $reported, $protected, $ReapMinAgeHours)
    if ($considered -gt 0) {
        try { $lines | Out-File -LiteralPath $reapLog -Append -Encoding utf8 } catch { }
    }
    return 0
}

# 开机通道注册（MoA P0-2/P1-6）：SYSTEM AtStartup 任务。注册需管理员——日常用户态尝试失败
# 属预期（保持登录通道兜底，不算故障）；-Register（管理员流程）时无 flag 也注册（boot 通道
# 常备，死锁 flag 一出现即可在下次开机自愈）。显式设置电池/补跑参数（schtasks 默认值会静默
# 跳过电池供电场景）。EFS 库 SYSTEM 读不了——注册前检测，让位登录通道。
function Ensure-BootTask {
    param([switch]$EvenWithoutFlag)

    if (-not $EvenWithoutFlag) {
        if (-not (Test-Path -LiteralPath $FlagFile)) { return }
        if (Test-Path -LiteralPath $BootstrapDisabled) { return }
    }
    $existing = Get-ScheduledTask -TaskName $BootTaskName -ErrorAction SilentlyContinue
    if ($existing) { Write-Host "[BOOT] 开机通道已注册（$BootTaskName）"; return }
    $sqlite = Resolve-Sqlite3
    if (-not $sqlite -or -not (Test-Path -LiteralPath $VacuumBootScript)) { return }
    try {
        $dbPath = Join-Path $HOME '.local\share\kilo\kilo.db'
        if ((Test-Path -LiteralPath $dbPath) -and ((Get-Item -LiteralPath $dbPath).Attributes -band [IO.FileAttributes]::Encrypted)) {
            Write-Host '[BOOT] db 被 EFS 加密：跳过开机通道注册（SYSTEM 读不了 EFS；登录通道照常）'
            return
        }
    } catch { }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -SqlitePath "{1}" -Trigger boot' -f $VacuumBootScript, $sqlite) `
        -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    # 显式 AllowStartIfOnBatteries（schtasks/计划任务默认 DisallowStartIfOnBatteries=true 会
    # 静默跳过电池场景，MoA 审计点）；StartWhenAvailable 补跑错过的触发；15min 硬时限防挂死。
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
    try {
        Register-ScheduledTask -TaskName $BootTaskName -Action $action -Trigger $trigger -Principal $principal `
            -Settings $settings -Description 'Kilo 引导死锁自愈（开机未登录窗口离线 VACUUM；无 flag 时秒退兜底）' -Force | Out-Null
        Write-Host "[BOOT] 开机通道已注册：$BootTaskName（SYSTEM，AtStartup）"
    } catch {
        Write-Host "[BOOT] 开机通道注册失败（未提权属预期，$($_.Exception.GetType().Name)）——登录通道兜底"
    }
}

# 引导死锁自愈：flag 存在 → 装登录快捷方式；flag 已解决 → 清掉遗留快捷方式（幂等自清洁）。
# 装配前校验目标脚本与 sqlite3 真实存在（回读校验），避免「装了但静默失败」的假自愈。
function Ensure-VacuumBootstrap {
    if (-not (Test-Path -LiteralPath $FlagFile)) {
        # MoA 裁决修正：引导已解决后【保留】lnk 作永久兜底（boot 任务被组策略禁用/损坏时的
        # 唯一非提权退路）；vacuum-boot.ps1 无 flag 秒退（<2s），常备开销可忽略。
        if (Test-Path -LiteralPath $BootstrapLnk) { Write-Host '[BOOT] 引导已解决；自愈快捷方式保留作兜底（无 flag 时秒退）' }
        return
    }
    if (Test-Path -LiteralPath $BootstrapDisabled) {
        Write-Warning "[BOOT] 自愈被用户禁用（$BootstrapDisabled 存在）——引导死锁需人工 -VacuumNow 处理"
        return
    }
    # 机会升格：boot 通道（需管理员；未提权失败属预期，登录通道兜底，双通道并存）
    Ensure-BootTask
    if (Test-Path -LiteralPath $BootstrapLnk) { Write-Host '[BOOT] 登录自愈快捷方式已就绪（下次登录无写者时自动离线 VACUUM）'; return }
    if (-not (Test-Path -LiteralPath $VacuumBootScript)) {
        Write-Warning "[BOOT] 缺 $VacuumBootScript —— 无法自动安装自愈（仓库不完整？）"
        return
    }
    $sqlite = Resolve-Sqlite3
    if (-not $sqlite) {
        Write-Warning '[BOOT] 找不到 sqlite3.exe —— 无法自动安装自愈；安装 sqlite3 后下次维护自动补装（详见 -Status）'
        return
    }
    $ps = (Get-Command powershell.exe).Source
    $args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -SqlitePath "{1}"' -f $VacuumBootScript, $sqlite
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($BootstrapLnk)
    $lnk.TargetPath = $ps
    $lnk.Arguments = $args
    $lnk.WorkingDirectory = $RepoDir
    $lnk.Description = 'Kilo 引导死锁自愈（登录时无 kilo 写者则离线 VACUUM 转 auto_vacuum=2；常备兜底，无 flag 秒退）'
    $lnk.Save()
    $check = $shell.CreateShortcut($BootstrapLnk)
    if (-not (Test-Path -LiteralPath $BootstrapLnk) -or $check.Arguments -notmatch [regex]::Escape($VacuumBootScript)) {
        Write-Warning "[BOOT] 自愈快捷方式校验失败（Arguments=$($check.Arguments)）"
        return
    }
    Write-Host "[BOOT] 已自动安装登录自愈：$BootstrapLnk（下次登录无写者时离线 VACUUM，无需人工）"
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
    Write-Host "[STARTUP] 触发条件：清理间隔 > $CleanupEveryDays 天、DB 瘦身间隔 > $DbEveryDays 天（VACUUM 按阈值自动，无需人工）"
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
    Write-Host "[AUTO] DB 瘦身：VACUUM 按阈值自动（空闲占比 ≥25% 且无写者才执行，无需人工；详见 -DbStatus）"
    # 引导死锁自愈状态（2026-11-04 全自动闭环）
    if (Test-Path -LiteralPath $FlagFile) {
        $since = (Select-String -LiteralPath $FlagFile -Pattern '^unresolvedSince=(.+)$' | Select-Object -Last 1).Matches.Groups[1].Value
        $bootState = '未安装（下次维护 RunOnce 自动补装）'
        if (Test-Path -LiteralPath $BootstrapDisabled) { $bootState = '被用户禁用（vacuum-bootstrap.disabled）' }
        elseif (Test-Path -LiteralPath $BootstrapLnk) {
            $bootState = '已安装（下次登录无写者时自动离线 VACUUM）'
            try {
                $sh = New-Object -ComObject WScript.Shell
                $m = [regex]::Match($sh.CreateShortcut($BootstrapLnk).Arguments, '-File\s+"([^"]+)"')
                if (-not $m.Success -or -not (Test-Path -LiteralPath $m.Groups[1].Value)) { $bootState = '已安装·失效（目标脚本不存在）' }
            } catch { $bootState = "已安装·校验异常（$($_.Exception.Message)）" }
        }
        elseif (-not (Test-Path -LiteralPath $VacuumBootScript)) { $bootState = "无法安装（缺 $VacuumBootScript）" }
        elseif (-not (Resolve-Sqlite3)) { $bootState = '无法安装（找不到 sqlite3.exe，安装后下次维护自动补装）' }
        Write-Host ("[BOOT] 引导死锁 flag：存在（{0} 起）  登录自愈：{1}" -f $(if ($since) { $since } else { '?' }), $bootState)
    } else {
        Write-Host '[BOOT] 引导死锁 flag：无（库健康或自愈已完成）'
    }
    # 开机通道状态（MoA P0-2 双通道可见性：boot 任务 + 登录 lnk 兜底）
    $bt = Get-ScheduledTask -TaskName $BootTaskName -ErrorAction SilentlyContinue
    if ($bt) {
        $bi = $bt | Get-ScheduledTaskInfo
        Write-Host ("[BOOT] 开机通道：{0}  状态={1}  上次={2}  结果={3}" -f $BootTaskName, $bt.State, $bi.LastRunTime, $bi.LastTaskResult)
    } else {
        Write-Host "[BOOT] 开机通道：未注册（可选升级；登录 lnk 兜底已常备，日常无需操作）"
    }
    # 最近一次孤儿收割记录（无记录=无孤儿，健康态不落盘）
    $lastReap = @(Get-ChildItem -LiteralPath $LogDir -File -Filter '*-reap.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if ($lastReap.Count) {
        Write-Host "[REAP] 最近收割（$($lastReap[0].Name)）："
        Get-Content -LiteralPath $lastReap[0].FullName -Encoding UTF8 | Select-Object -Last 3 | ForEach-Object { Write-Host "       $_" }
    } else {
        Write-Host '[REAP] 孤儿收割：尚无记录（健康；-ListOrphans 可只读干跑）'
    }
    if (Test-Path $LogDir) {
        $dirFiles = @(Get-ChildItem -LiteralPath $LogDir -File)
        $dirBytes = ($dirFiles | Measure-Object -Property Length -Sum).Sum
        Write-Host ("[DIR ] {0}  {1} 个文件  {2:N1} MB（卫生上限 200MB）" -f $LogDir, $dirFiles.Count, ($dirBytes / 1MB))
    }
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

if ($ListOrphans) { Invoke-OrphanReap -ListOnly | Out-Null; exit 0 }
if ($ReapOrphans) { Invoke-OrphanReap | Out-Null; exit 0 }

if ($Unregister) {
    foreach ($t in @($TaskDaily, $TaskWeekly)) {
        if (Get-MaintenanceTask $t) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "[TASK] 已删除 $t" }
        else { Write-Host "[TASK] 未注册 $t（跳过）" }
    }
    # 开机通道一并移除（SYSTEM 任务删除需管理员；失败不阻断其余清理）
    try {
        if (Get-ScheduledTask -TaskName $BootTaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $BootTaskName -Confirm:$false
            Write-Host "[TASK] 已删除 $BootTaskName"
        }
    } catch { Write-Warning "[TASK] $BootTaskName 删除失败（需管理员）：$($_.Exception.Message)" }
    exit 0
}

if ($Register) {
    $bash = Resolve-Bash
    # 注册前置校验：storage-maintain.mjs 走 node——缺 Node 在注册时就报，
    # 而不是每天 04:00 任务静默失败（error.log 才能发现）
    $node = Resolve-Node
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

    # 触发器（2026-10-18 修正）：仅 AtLogOn 在常开机上会漏跑——10-15 05:04 开机后连续运行
    # 3 天未登录，DB 从 4.46GB 涨到 7.29GB。改为 AtLogOn + 每日 12:30/12:45 双触发：
    # 12:30 清理文件、12:45 清理 + DB 瘦身；StartWhenAvailable 负责关机/休眠错过补跑，
    # 两者靠 state.json 的到期判断保持幂等。12:30 选在常用工作时段，避开 04:00 关机窗口。
    $tDaily  = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -Daily -At '12:30'))
    $tWeekly = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -Daily -At '12:45'))

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
    # 开机自愈通道（MoA P0-2）：管理员流程里无 flag 也注册——boot 任务常备，死锁 flag
    # 一出现即可在下次开机（未登录窗口）自愈；EFS 库自动让位登录通道。
    Ensure-BootTask -EvenWithoutFlag
    Write-Host "[TASK] 已注册：$TaskDaily（登录时 + 每日 12:30 清理）、$TaskWeekly（登录时 + 每日 12:45 清理 + DB 瘦身）"
    Write-Host "[TASK] 触发器=登录时 + 每日 12:30/12:45；StartWhenAvailable 补跑；state.json 到期判断保持幂等"
    Write-Host "[TASK] bash: $bash  node: $node"
    Write-Host "[TASK] VACUUM 已按阈值自动化（空闲页 ≥25% 且无 kilo 写者才跑；否则跳过）"
    exit 0
}

if ($DbStatus) { exit (Invoke-DbMaintain -StatusOnly) }

if ($VacuumNow) {
    # 手动兜底：不依赖受保护的 kilo-vacuum-once 计划任务。关闭全部 Kilo 后执行，
    # vacuum-boot.ps1 自身会拒绝在有 kilo 写者时启动，避免独占锁打断会话。
    # 优先仓库内脚本（SSOT；随仓库更新）；state 目录遗留副本仅作过渡兼容兜底。
    $vacuumScript = $VacuumBootScript
    if (-not (Test-Path -LiteralPath $vacuumScript)) { $vacuumScript = Join-Path $LogDir 'vacuum-boot.ps1' }
    if (-not (Test-Path -LiteralPath $vacuumScript)) { throw "FAIL: 缺少离线 VACUUM 脚本 $vacuumScript" }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $vacuumScript -SqlitePath (Resolve-Sqlite3) -Trigger manual
    exit $LASTEXITCODE
}

# 变更类入口（-CleanupOnly / -RunOnce / -AutoIfDue）单飞互斥：只读入口（-Status /
# -DbStatus / -ListOrphans）不加锁，维护运行中仍可诊断。锁随进程存活（OS 释放）。
$script:MaintRunLock = Enter-MaintRunLock
if ($null -eq $script:MaintRunLock) { exit 0 }

if ($CleanupOnly) {
    $rc = Invoke-Cleanup
    $st = Read-MaintState
    if ($rc -eq 0) { $st.lastCleanup = Get-Date; Write-MaintState $st }
    Invoke-StateDirHygiene
    Invoke-OrphanReap | Out-Null
    Ensure-VacuumBootstrap
    exit $rc
}

if ($RunOnce) {
    $rc1 = Invoke-Cleanup
    $rc2 = Invoke-DbMaintain
    $st = Read-MaintState
    if ($rc1 -eq 0) { $st.lastCleanup = Get-Date }
    if ($rc2 -eq 0) { $st.lastDb = Get-Date }
    Write-MaintState $st
    Invoke-StateDirHygiene
    Invoke-OrphanReap | Out-Null
    Ensure-VacuumBootstrap
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
    Invoke-StateDirHygiene
    Invoke-OrphanReap | Out-Null
    Ensure-VacuumBootstrap
    if ($did.Count -eq 0) { Write-Host '[AUTO] 均未到期，跳过（-Status 可看到期时间）' }
    else { Write-Host "[AUTO] 已执行：$($did -join ' + ')" }
    exit 0
}

Write-Host "未指定动作。用 -RunOnce / -CleanupOnly / -DbStatus / -VacuumNow / -AutoIfDue / -InstallStartup / -Register / -Status。"
exit 0
