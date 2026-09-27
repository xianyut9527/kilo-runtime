<#
  Kilo Runtime 全量下发器（PowerShell 原生版，与 install.sh 行为一致；原仓库名 kilo_config）

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

# 剥离 JSON 尾随逗号（模板 ad2e312 起允许尾随逗号风格，部署副本必须回归纯 JSON：
# PS5.1 ConvertFrom-Json / python json.load / bun JSON.parse 均拒绝尾随逗号）。
# 字符级状态机跟踪引号/转义——正则 ,\s*[}\]] 会误伤字符串字面量内的 ",}"（commit_message
# prompt 实证，lib/hx-client.ts stripTrailingCommas 同款语义）。注意：PS7 的 ?. 等语法禁用。
function Remove-TrailingCommas([string]$Text) {
    $sb = New-Object System.Text.StringBuilder
    $inStr = $false; $esc = $false
    $chars = $Text.ToCharArray()
    for ($i = 0; $i -lt $chars.Length; $i++) {
        $c = $chars[$i]
        if ($inStr) {
            [void]$sb.Append($c)
            if ($esc) { $esc = $false }
            elseif ($c -eq '\') { $esc = $true }
            elseif ($c -eq '"') { $inStr = $false }
            continue
        }
        if ($c -eq '"') { $inStr = $true; [void]$sb.Append($c); continue }
        if ($c -eq ',') {
            $j = $i + 1
            while ($j -lt $chars.Length -and ($chars[$j] -eq ' ' -or $chars[$j] -eq "`t" -or $chars[$j] -eq "`r" -or $chars[$j] -eq "`n")) { $j++ }
            if ($j -lt $chars.Length -and ($chars[$j] -eq '}' -or $chars[$j] -eq ']')) { continue }
        }
        [void]$sb.Append($c)
    }
    return $sb.ToString()
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
        # 尾随逗号在注释剥离之后去除（注释行可能含未配对引号，会干扰状态机）；
        # 仅 *.tmpl 走此分支，INSTRUCTIONS.md 等文档绝不能做逗号剥离。
        $text = Remove-TrailingCommas $text
        $text = $text.Replace('__KILO_CONFIG__', $TargetNative)
        $text = $text.Replace('__KILO_HOME__', $HomeSlash)
    }
    elseif (Test-NeedsSubst $SrcPath) {
        # 归一 LF：与 install.sh 对齐（Git Bash sed 输出 LF），否则两端部署副本行尾漂移、
        # check 永远报差异互相打架（2026-09-25 实测：ps1 透传 CRLF vs sh LF）。
        $text = $text -replace "`r`n", "`n"
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

# 备份策略（2026-09-27 移位）：只在「确有内容要写」时才 prune+打包——此前备份块位于
# 差异收集之前，--Check 通过后的例行同步 / 空跑 install 也会每次烧一个 ~12MB 的 zip
# （实测「差异/写入: 0」仍产 [BACKUP]）。现移到冒烟预检之后、写入循环之前：
# 预检失败会中止（未删任何东西、未打包），只有真正要动盘了才消耗一次备份位。
$changed = 0; $same = 0; $wrote = 0

# 先收集待写清单：预检必须在任何写入之前完成，否则第 N 个文件检查失败时
# 前 N-1 个已落盘 → 留下「半套部署」（新 plugin + 旧 lib 的混合态），比不部署更危险。
$toWrite = @()
foreach ($p in $pairs) {
    $dstPath = Join-Path $TargetDir $p.Dst
    $newText = Render-Content $p.Src

    $oldText = ''
    if (Test-Path $dstPath) { $oldText = [System.IO.File]::ReadAllText($dstPath, [System.Text.UTF8Encoding]::new($false)) }

    if ($oldText -eq $newText) { $same++; continue }

    $changed++
    $toWrite += [pscustomobject]@{ Src = $p.Src; Dst = $p.Dst; DstPath = $dstPath; NewText = $newText }
}

# ---------- 写入前全量冒烟预检（防复发闸门，2026-09-22 启动崩溃的教训） ----------
# 事故：把编辑中的中间态 plugin/*.ts 下发 → Kilo 7.7.6 插件加载失败 →
# config hook 级联崩溃 → provider 列表全挂 → 无法选择模型（16:18 s.highRisk.size、16:47 s.edited 两例）。
# 真根因（2026-09-22 逆向 kilo.exe vE2/iE2/kE2 确认）：Kilo 把 plugin 模块里**每个导出函数**
# 都当插件工厂用 (ctx, options) 调一遍——非工厂导出函数（如 reviewSubject(root,s,...)）收到
# (ctx,undefined) 即抛错 → "failed to load plugin"；返回 undefined 的 → "plugin config hook
# failed"(N.config)。因此本预检对 plugin/*.ts 做两级检查：
#   ① import 不抛（语法/顶层求值错）；
#   ② vE2 模拟：每个导出函数用 (ctx, options) 调一遍，抛错或返回非对象即中止下发。
# lib/*.ts 只做 ①（库文件不被 Kilo 当插件加载）。
# 注意：Kilo 会把 plugin/ 下每个 .ts 当插件模块求值（库文件放这里会 "fetch() URL is invalid"
# 式加载失败）——因此 lib/ 只作共享依赖目录，plugin/ 只放真正的插件入口。
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
# dist 冒烟需要 node>=18（Web Streams 全局：TransformStream/Headers/TextDecoderStream）。
# 默认 PATH 上的 node 可能是老版本（本机实证 v14 冒烟必炸 "TransformStream is not defined"，
# 而 dist 本身在 node18+/bun/kilo 运行时全部正常）——探测失败则回退 hermes node22。
$nodeSmokeCmd = $null
$nodeSmokeSrc = $null
# PS 5.1 无 ?. 运算符（PS7+ 专属，实测解析即炸），用 if 表达式取 Source。
$nodePath = if ($nodeCmd) { $nodeCmd.Source } else { $null }
foreach ($cand in @($nodePath, (Join-Path $env:LOCALAPPDATA "hermes\node\node.exe"))) {
    if ($cand -and (Test-Path $cand)) {
        & $cand -e "process.exit(typeof TransformStream === 'function' && typeof Headers === 'function' ? 0 : 1)" *> $null
        if ($LASTEXITCODE -eq 0) {
            $nodeSmokeCmd = $cand
            $nodeSmokeSrc = $cand
            break
        }
    }
}
if ($nodeCmd -and -not $nodeSmokeCmd) {
    Write-Warning "[INSTALL] 无 node>=18 可用（PATH node 与 hermes 均缺 Web Streams 全局），dist 冒烟跳过"
}
# vE2 模拟脚本（写入临时 .mjs 再用 bun 跑——inline -e 传参时 PowerShell 会吃掉 JS 里的
# 双引号，导致语法错；文件形式彻底规避引号转义问题）。
$ve2SmokeMjs = @'
// 模拟 kilo.exe vE2/iE2：模块里每个导出函数（引用去重）都被当插件工厂用 (ctx, options) 调用。
// 契约：全模块恰好 1 个不同函数导出引用（工厂），调用不抛且返回对象；
// 对象导出不得含 server 函数（kE2 会把 obj.server 当工厂调用）。
// 违反任一条 = 启动崩溃级缺陷（"failed to load plugin" / "plugin config hook failed"）。
const target = process.argv[2];
const mod = await import(target);
const fnByRef = new Map();
for (const [k, v] of Object.entries(mod)) {
  if (typeof v !== "function") {
    if (v && typeof v === "object" && typeof v.server === "function") {
      console.error(`object export "${k}" contains a server function - kE2 would call it as a factory -> startup crash`);
      process.exit(1);
    }
    continue;
  }
  if (!fnByRef.has(v)) fnByRef.set(v, k);
}
if (fnByRef.size !== 1) {
  console.error(`expected exactly 1 distinct function export (the factory), got ${fnByRef.size}: ${[...fnByRef.values()].join(", ")} - vE2 registers/calls each as a plugin -> startup crash`);
  process.exit(1);
}
for (const [fn, name] of fnByRef) {
  const r = await fn({ directory: "C:/kilo-smoke-nonexistent", client: {}, $: undefined }, undefined);
  if (r === null || r === undefined || typeof r !== "object") {
    console.error(`factory "${name}" called with (ctx,options) returned ${String(r)} (non-object) - pollutes hook registry -> startup crash`);
    process.exit(1);
  }
}
'@
foreach ($w in $toWrite) {
    if ($w.Src -match '[\\/]plugin[\\/].*\.ts$') {
        if ($bunCmd) {
            $fileUrl = 'file:///' + ($w.Src -replace '\\', '/')
            # ① import 冒烟
            $smokeJs = "import('$fileUrl').then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })"
            $null = & bun -e $smokeJs 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "[INSTALL] FAIL: 插件冒烟加载失败（import 抛错），已中止下发（未写入任何文件；该文件会导致 kilo server 启动崩溃）：$($w.Src)"
                exit 1
            }
            # ② vE2 工厂模拟（真根因防线：裸导出工具函数会在此现形）
            $tmpMjs = Join-Path ([System.IO.Path]::GetTempPath()) "kilo-ve2-smoke-$PID.mjs"
            try {
                Set-Content -LiteralPath $tmpMjs -Value $ve2SmokeMjs -Encoding UTF8
                $null = & bun $tmpMjs $fileUrl 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Error "[INSTALL] FAIL: vE2 工厂模拟失败（裸导出工具函数或工厂返回非对象），已中止下发（未写入任何文件）：$($w.Src)"
                    exit 1
                }
            } finally {
                Remove-Item -LiteralPath $tmpMjs -Force -ErrorAction SilentlyContinue
            }
        }
        else {
            Write-Warning "[INSTALL] WARN: bun 不可用，跳过插件冒烟检查（$($w.Src) 未经验证即下发）"
        }
    }
    elseif ($w.Src -match '[\\/]lib[\\/].*\.ts$') {
        if ($bunCmd) {
            $fileUrl = 'file:///' + ($w.Src -replace '\\', '/')
            $smokeJs = "import('$fileUrl').then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })"
            $null = & bun -e $smokeJs 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "[INSTALL] FAIL: 共享库冒烟加载失败，已中止下发（未写入任何文件）：$($w.Src)"
                exit 1
            }
        }
        else {
            Write-Warning "[INSTALL] WARN: bun 不可用，跳过共享库冒烟检查（$($w.Src)）"
        }
    }

    # provider dist 冒烟：hx-failover dist/index.js 是 server 启动时加载的模块，
    # 语法错/半写文件同样会让整个 provider 注册失败。node 真加载一遍。
    if ($w.Src -match '[\\/]provider[\\/]hx-failover[\\/]dist[\\/].*\.m?js$') {
        if ($nodeSmokeCmd) {
            $fileUrl = 'file:///' + ($w.Src -replace '\\', '/')
            $smokeJs = "import('$fileUrl').then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })"
            $null = & $nodeSmokeSrc --input-type=module -e $smokeJs 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "[INSTALL] FAIL: provider dist 冒烟加载失败，已中止下发（未写入任何文件）：$($w.Src)"
                exit 1
            }
        }
        else {
            Write-Warning "[INSTALL] WARN: 无 node>=18 可用，跳过 provider dist 冒烟检查（$($w.Src)）"
        }
    }
}

# ---------- 备份（预检通过、写入循环之前；仅在确有写入时） ----------
# 历史教训：每次下发各留一份、无人回收，单个备份含 plugin 依赖时可达数十 MB。
# 顺序很关键：**先裁剪、后创建**。若先创建再裁剪，刚建的那份会参与排序，
# 而同秒产生的备份 LastWriteTime 并列 + $env:TEMP 返回 8.3 短路径（ADMINI~1）
# 与 Get-ChildItem 的长路径不相等，字符串排除失效 → 新备份会被自己删掉（实测踩过）。
# 裁剪只发生在真实写盘模式：--DryRun / -Check 一律不得删除任何文件。
if (-not $DryRun -and -not $Check -and $changed -gt 0 -and (Test-Path $TargetDir)) {
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

foreach ($w in $toWrite) {
    if ($DryRun -or $Check) { continue }

    $dstDir = Split-Path -Parent $w.DstPath
    if (-not (Test-Path $dstDir)) { $null = New-Item -ItemType Directory -Path $dstDir -Force }
    # 原子写入：先写同目录临时文件再 rename 覆盖。
    # 事故复盘（2026-09-22）：运行中的 kilo server 会随时重新加载 plugin 目录；
    # 直接 WriteAllText 期间启动的 server 会读到「半写文件」→ 模块求值抛错 →
    # failed to load plugin → config hook 级联 → provider 列表全挂。rename 在同一卷内是原子替换，
    # 目标路径要么是旧完整内容、要么是新完整内容，不存在中间态可见窗口。
    $tmpPath = "$($w.DstPath).tmp-$PID"
    [System.IO.File]::WriteAllText($tmpPath, $w.NewText, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmpPath -Destination $w.DstPath -Force
    $wrote++
    # 部署≠生效提醒（2026-09-24 ⑥）：Kilo 不热加载插件——运行中的旧进程（含旧 Kilo/VS Code
    # 窗口会话）仍执行旧逻辑，须重载窗口才生效；quality-gate ⑥ 检测也会在交付节点告警。
    if ($w.Dst -match '^plugin[\\/].+\.tsx?$' -or $w.Dst -match '^plugin[\\/]') {
        $script:pluginWritten = $true
    }
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
# ⑥ 部署≠生效提醒：只在真实写盘且含 plugin 文件时提示（DryRun/Check/纯文档下发不打扰）
if (-not $DryRun -and -not $Check -and $script:pluginWritten) {
    Write-Host ''
    Write-Host "[INSTALL] 提示：本次更新了 plugin/ 文件。Kilo 不热加载插件——运行中的 Kilo/VS Code 窗口仍执行旧逻辑，重载窗口后新版才生效（quality-gate ⑥ 检测亦会在交付节点告警）。"
}

# ---------- 登录自启快捷方式自愈（2026-09-27 事故回归防护）----------
# 事故：仓库目录改名（kilo_config → kilo-runtime）后，Startup 里的 kilo-maintenance.lnk 仍指向
# 旧路径的 kilo-maintenance.ps1——快捷方式文件存在、目标脚本已不存在，于是每次登录都静默失败，
# 自动维护停了 11 天而无人察觉。此处在下发后检测该失效态并以当前真实路径重建（仅当快捷方式已
# 存在才修复，不替用户新增自启——安装自启仍是 -InstallStartup 的显式选择）。
if (-not $DryRun -and -not $Check) {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $startupLnk = Join-Path $startupDir 'kilo-maintenance.lnk'
    if (Test-Path -LiteralPath $startupLnk) {
        $maintScript = Join-Path $ScriptDir 'scripts\kilo-maintenance.ps1'
        $lnkTarget = $null
        try {
            $sh = New-Object -ComObject WScript.Shell
            $m = [regex]::Match($sh.CreateShortcut($startupLnk).Arguments, '-File\s+"([^"]+)"')
            if ($m.Success) { $lnkTarget = $m.Groups[1].Value }
        } catch { }
        if ($lnkTarget -and (Test-Path -LiteralPath $lnkTarget)) {
            # 目标有效但可能不是本仓库（多副本场景）：仅当它指向本仓 scripts 时才对齐
            $maintFull = [System.IO.Path]::GetFullPath($maintScript)
            if ([System.IO.Path]::GetFullPath($lnkTarget) -ne $maintFull) {
                Write-Host "[INSTALL] 提示：登录自启指向其它维护脚本（$lnkTarget）——如非本仓请忽略。"
            }
        }
        elseif (Test-Path -LiteralPath $maintScript) {
            $why = if ($lnkTarget) { "目标不存在：$lnkTarget" } else { '无法解析 -File 目标（快捷方式损坏）' }
            Write-Host ''
            Write-Host "[INSTALL] 检测到登录自启失效（$why），按当前路径重建…"
            # PS 5.1 stderr 陷阱与本脚本全局 EAP='Stop'：子进程往 stderr 写一行就构造
            # ErrorRecord 抛终止异常——会把整个 install 在「文件已下发之后」炸死（半完成态
            # 比不跑更糟）。与 kilo-maintenance.ps1 Invoke-RepoScript 同款修法：临时降
            # Continue、只看 $LASTEXITCODE、finally 还原。
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $healRc = 1
            try {
                $healOut = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $maintScript -InstallStartup 2>&1
                $healRc = $LASTEXITCODE
            }
            finally { $ErrorActionPreference = $prevEap }
            $healOut | ForEach-Object { Write-Host "  $_" }
            # 自愈失败不中止 install：下发已完成，快捷方式重建失败只损失「下次登录自动维护」，
            # 提示人工 -InstallStartup 即可；此时 exit 1 反而让调用方误判为部署失败。
            if ($healRc -ne 0) { Write-Warning "[INSTALL] WARN: 自启重建失败（exit=$healRc）——请人工跑 scripts\kilo-maintenance.ps1 -InstallStartup" }
        }
    }
}

if ($Check -and ($changed -gt 0 -or $strayList.Count -gt 0)) {
    Write-Host ''
    Write-Host "[check] 漂移：内容差异 $changed 处 + 多余文件 $($strayList.Count) 个 —— 执行 .\install.ps1 同步（多余文件需人工确认后删除）。"
    exit 1
}
exit 0
