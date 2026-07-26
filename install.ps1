# Kilo Global Config Installer (Windows)
# Syncs this repo to: $env:USERPROFILE\.config\kilo\
# IMPORTANT: EXCLUDE lists must be kept in sync with install.sh

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$env:USERPROFILE\.config\kilo"

# 仅在仓库根层级排除的项（防止误伤子目录中同名合法文件，如 .kilo/memory/README.md）
$RootOnlyExclude = @("install.ps1", "install.sh", "README.md", "LICENSE")

# 所有层级都排除的项
$RecursiveExclude = @(
    ".git", ".gitignore",
    "node_modules",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "yarn.lock",
    "agent-manager.json"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kilo Global Config Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $Source" -ForegroundColor Gray
Write-Host "Target: $Target" -ForegroundColor Gray
Write-Host ""

try {
    # ============================================================
    # 全量覆盖式更新策略：先彻底清空目标目录，再从源目录全量同步
    # 这样确保每次安装后目标目录与源目录完全一致，不留历史残留垃圾
    # ============================================================
    if (Test-Path $Target) {
        Write-Host "[CLEAN] Purging target directory: $Target" -ForegroundColor Yellow
        Remove-Item -Path "$Target\*" -Recurse -Force -ErrorAction Stop
    }

    if (-not (Test-Path $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        Write-Host "[CREATE] $Target" -ForegroundColor Green
    }
    Write-Host ""

    function Should-Exclude($name, $depth) {
        if ($depth -eq 0 -and $RootOnlyExclude -contains $name) { return $true }
        if ($RecursiveExclude -contains $name) { return $true }
        return $false
    }

    function Copy-SourceTree($srcDir, $dstDir, $depth) {
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }

        foreach ($item in Get-ChildItem -Path $srcDir -Force) {
            if (Should-Exclude $item.Name $depth) { continue }

            $dest = Join-Path $dstDir $item.Name

            if ($item.PSIsContainer) {
                Copy-SourceTree $item.FullName $dest ($depth + 1)
                Write-Host "[COPY]   $($dest.Substring($Target.Length + 1))/" -ForegroundColor Green
                $script:CopiedDirs++
            } else {
                Copy-Item -Path $item.FullName -Destination $dest -Force -ErrorAction Stop
                Write-Host "[COPY]   $($dest.Substring($Target.Length + 1))" -ForegroundColor Green
                $script:CopiedFiles++
            }
        }
    }

    $CopiedFiles = 0
    $CopiedDirs = 0
    Copy-SourceTree $Source $Target 0

    # 注意：不再创建 agents/ 兼容副本，避免 agent 被注册两次导致路由不稳定
    # 详见 https://kilo.ai/docs/configure/agents

    Write-Host ""
    Write-Host "Done! Restart Kilo to apply changes." -ForegroundColor Green
    Write-Host ""

    # ============================================================
    # 关键文件存在性校验
    # ============================================================
    $CriticalFiles = @(
        "kilo.json",
        "AGENTS.md",
        ".kilo/instructions/core.md",
        ".kilo/instructions/workflow-core.md",
        ".kilo/instructions/reflection.md",
        "agent/orchestrator.md"
    )

    $Missing = @()
    foreach ($f in $CriticalFiles) {
        $path = Join-Path $Target $f
        if (-not (Test-Path $path)) {
            $Missing += $f
        }
    }

    if ($Missing.Count -gt 0) {
        Write-Host "[SYNC] FAIL: missing critical files: $($Missing -join ', ')" -ForegroundColor Red
        exit 1
    }

    # ============================================================
    # UTF-8 编码配置（解决 Kilo 在 Windows PowerShell 上的中文乱码）
    # ============================================================
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

    Write-Host ""
    Write-Host "[SYNC] OK | files=$CopiedFiles dirs=$CopiedDirs | critical=$($CriticalFiles.Count)/$($CriticalFiles.Count) | target=$Target" -ForegroundColor Green

    # ============================================================
    # kilo.json 路径占位符替换（保证 skills.external_dirs 跨平台可移植）
    # ============================================================
    Write-Host ""
    Write-Host "Substituting kilo.json path placeholders..." -ForegroundColor Cyan
    $KiloJsonPath = Join-Path $Target "kilo.json"
    if (Test-Path $KiloJsonPath) {
        $JsonContent = Get-Content -Path $KiloJsonPath -Raw -Encoding UTF8
        $JsonContent = $JsonContent -replace '\$\{KILO_CONFIG_DIR\}', ($Target -replace '\\', '\\')
        # 注意：memory.db 路径使用 ${HOME}/.config/kilo-data/memory.db，由 bash + sqlite3 CLI 直接访问（v2.5-过渡版主通道），install 阶段不替换
        # 注意：memory-mcp（v3.0 备用通道）已在 v2.6.2 精简中随 api/ 目录删除，kilo.json 不再引用 memory-mcp.js，此处无需替换 mcp 路径
        # 写回必须无 BOM：PS 5.1 Set-Content -Encoding UTF8 会写入 BOM，导致严格 JSON.parse 失败（AP-001）
        [System.IO.File]::WriteAllText($KiloJsonPath, $JsonContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[WRITE]  kilo.json path placeholders substituted (KILO_CONFIG_DIR=$Target)" -ForegroundColor Green
    } else {
        Write-Host "[WARN]   kilo.json not found at $KiloJsonPath, skip substitution" -ForegroundColor Yellow
    }

    # ============================================================
    # Memory 层初始化（sqlite3 CLI + memory.db）
    # 检测到缺失时提示用户，同意则自动安装 sqlite3 + 初始化 memory.db
    # 缺失时记忆层静默降级（不报错但不写入，自我进化闭环不生效）
    # ============================================================
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Memory Layer Setup (sqlite3 + memory.db)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    $DbDir = "$env:USERPROFILE\.config\kilo-data"
    $DbPath = Join-Path $DbDir "memory.db"
    # init.sql 从 Target（已同步的全局配置目录）取；schema/init.sql 内含 7 表 + 索引 + 视图 + project_context 种子
    $InitSql = Join-Path $Target ".kilo\memory\schema\init.sql"
    # v2.6.2 精简：原 api/migrate_skill_to_fact_store.sql + api/seed_project_context.sql 已随 api/ 目录删除；
    #   AP/PAT bootstrap 经验由既有 DB 保留，全新安装从空 DB 开始（schema/init.sql 内含 project_context 种子）

    # --- 辅助函数：刷新会话 PATH（从注册表读 Machine+User 合并，解决 winget 安装后会话 PATH 未更新问题）---
    function Refresh-SessionPath {
        $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
        $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $env:PATH = "$machinePath;$userPath"
    }

    # --- 辅助函数：探测 winget 安装的 sqlite3 目录并加入会话 PATH ---
    function Find-WingetSqlite {
        $wingetRoot = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
        $sqliteDir = Get-ChildItem $wingetRoot -Filter "SQLite*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sqliteDir) {
            $env:PATH = "$($sqliteDir.FullName);$env:PATH"
            return (Get-Command sqlite3 -ErrorAction SilentlyContinue)
        }
        return $null
    }

    # --- Step 0: 刷新会话 PATH（解决"已安装但当前会话 PATH 未含"的误报）---
    Refresh-SessionPath

    # --- Step 1: 检测 sqlite3 CLI ---
    $SqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
    if (-not $SqliteExe) {
        # 再尝试从 winget 安装目录探测（可能已安装但 PATH 尚未刷新）
        $SqliteExe = Find-WingetSqlite
    }

    if (-not $SqliteExe) {
        Write-Host "[CHECK]  sqlite3 CLI 未检测到" -ForegroundColor Yellow
        Write-Host "记忆层（经验沉淀/错误总结/模型校准/skill 升级）依赖 sqlite3。" -ForegroundColor Gray
        Write-Host "缺失时记忆层静默降级：不报错但不写入，自我进化闭环不生效。" -ForegroundColor Gray
        Write-Host ""
        $Choice = Read-Host "是否现在自动安装 sqlite3？（winget install SQLite.SQLite）[Y/n]"

        if ($Choice -eq "" -or $Choice -match "^[Yy]") {
            Write-Host "[INSTALL] winget install SQLite.SQLite ..." -ForegroundColor Cyan
            try {
                # winget 安装（可能需要较长时间）
                & winget install --id SQLite.SQLite --accept-source-agreements --accept-package-agreements --silent 2>&1 | ForEach-Object { Write-Host $_ }

                # 安装后主动刷新 PATH（从注册表重读 + 探测 winget 安装目录）
                Refresh-SessionPath
                $SqliteExe = Get-Command sqlite3 -ErrorAction SilentlyContinue
                if (-not $SqliteExe) {
                    $SqliteExe = Find-WingetSqlite
                }

                if ($SqliteExe) {
                    Write-Host "[OK]     sqlite3 安装成功: $($SqliteExe.Source)" -ForegroundColor Green
                } else {
                    Write-Host "[WARN]   sqlite3 安装完成但未在 PATH 中找到，请重启终端后重新运行 install.ps1" -ForegroundColor Yellow
                    Write-Host "         或手动运行: winget install SQLite.SQLite" -ForegroundColor Gray
                }
            } catch {
                Write-Host "[WARN]   sqlite3 安装失败: $($_.Exception.Message)" -ForegroundColor Yellow
                Write-Host "         可手动安装: winget install SQLite.SQLite 或 choco install sqlite" -ForegroundColor Gray
            }
        } else {
            Write-Host "[SKIP]   用户跳过 sqlite3 安装" -ForegroundColor Gray
            Write-Host "[WARN]   记忆层将静默降级（经验/错误/校准零写入，自我进化闭环不生效）" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[CHECK]  sqlite3 CLI 已安装: $($SqliteExe.Source)" -ForegroundColor Green
    }

    # --- Step 2: 初始化 memory.db（sqlite3 可用时）---
    if ($SqliteExe) {
        # 建数据目录
        if (-not (Test-Path $DbDir)) {
            New-Item -ItemType Directory -Path $DbDir -Force | Out-Null
            Write-Host "[CREATE] $DbDir" -ForegroundColor Green
        }

        if (Test-Path $DbPath) {
            Write-Host "[SKIP]   memory.db 已存在，跳过初始化: $DbPath" -ForegroundColor Gray
        } else {
            # 执行 init.sql 建表
            if (Test-Path $InitSql) {
                Write-Host "[INIT]   执行 schema/init.sql 建表..." -ForegroundColor Cyan
                & sqlite3 $DbPath ".read `"$InitSql`"" 2>&1 | ForEach-Object { Write-Host $_ }
                Write-Host "[OK]     memory.db 表结构初始化完成: $DbPath" -ForegroundColor Green
            } else {
                Write-Host "[WARN]   schema/init.sql 未找到（$InitSql），跳过建表" -ForegroundColor Yellow
            }

            # schema/init.sql 内含 project_context 种子（v2.6.2 起），无需单独 seed 脚本

            # 健康度验证
            $Tables = & sqlite3 $DbPath "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%';" 2>&1
            Write-Host "[VERIFY] 表清单: $Tables" -ForegroundColor Gray
        }
    } else {
        Write-Host "[WARN]   sqlite3 CLI 不可用，memory.db 未初始化" -ForegroundColor Yellow
        Write-Host "         记忆层静默降级。安装 sqlite3 后重新运行 install.ps1 即可补初始化。" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "Memory layer setup done." -ForegroundColor Cyan

    exit 0
}
catch {
    Write-Host "[SYNC] FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
