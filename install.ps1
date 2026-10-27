<#
一键部署 —— 把这套运维脚本装到你的机器上
================================================

它不做的事（这些得你自己来，因为都需要人工确认）：
  · 装 Node.js
  · 装 DeepSeek Harness 桌面版
  · 装 NapCat 并扫码登录 QQ
  · 部署桥接（dsh-qq）

它做的事：
  · 检查上面几样有没有装好，缺了直接告诉你缺什么
  · 把脚本复制到你指定的目录
  · 按你的 QQ 号生成启动脚本（NapCat / 桥接 / supervisor）
  · 注册「全栈体检」计划任务（每 2 分钟自愈一次）
  · 关掉自动睡眠和快速启动（不然重启后不会自己起来）

用法：双击 install.cmd（会自动提权），或者
     powershell -ExecutionPolicy Bypass -File install.ps1 -TargetDir D:\qq-bot-stack -OwnerQQ 123456
#>

param(
    [string]$TargetDir = '',
    [string]$OwnerQQ = '',
    [string]$BotQQ = '',
    [string]$NapCatDir = '',
    [string]$BridgeDir = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head($m) { Say ''; Say $m 'White'; Say ('=' * 60) 'DarkGray' }

Head 'QQ Bot 运维套件 · 一键部署'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# ── 0. 确认目标目录 ──────────────────────────────────────────────
if (-not $TargetDir) {
    Say '装到哪个目录？（直接回车用默认值）' 'Cyan'
    $inp = Read-Host 'TargetDir [E:\qq-bot-stack]'
    if ($inp) { $TargetDir = $inp } else { $TargetDir = 'E:\qq-bot-stack' }
}
$TargetDir = $TargetDir.TrimEnd('\')
if (-not $NapCatDir) { $NapCatDir = Join-Path $TargetDir 'napcat' }
if (-not $BridgeDir) { $BridgeDir = Join-Path $TargetDir 'dsh-qq\qq-bridge-enhanced-v1.1.0' }

# ── 1. 主人 QQ ───────────────────────────────────────────────────
if (-not $OwnerQQ) {
    Say ''
    Say '你的 QQ 号（机器人给谁发消息、余额提醒发给谁）：' 'Cyan'
    do { $inp = Read-Host 'OwnerQQ' } while (-not ($inp -match '^\d{5,12}$'))
    $OwnerQQ = $inp
}
if ($OwnerQQ -notmatch '^\d{5,12}$') { Say '[X] 主人 QQ 必须是 5~12 位数字' 'Red'; Read-Host 'Press Enter'; exit 1 }

# ── 2. 机器人 QQ（可选，用于快速登录）───────────────────────────
if (-not $BotQQ) {
    Say ''
    Say '机器人那个 QQ 号（填了就能免扫码快速登录；不填留空）：' 'Cyan'
    $BotQQ = (Read-Host 'BotQQ [可空]').Trim()
}

# ── 3. 环境检查 ─────────────────────────────────────────────────
Head '检查环境'

$problems = @()
$warnings = @()

# Node
$nodeOk = $false
try {
    $v = & node -v 2>$null
    if ($v -match '^v(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 20) { $nodeOk = $true; Say "  [OK] Node.js $v" 'Green' }
        else { $problems += "Node.js 版本太旧（$v），需要 20 以上" }
    }
} catch {}
if (-not $nodeOk -and $problems.Count -eq 0) { $problems += '找不到 node，请先装 Node.js 20+（https://nodejs.org）' }

# DSH
$dshExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
if (Test-Path $dshExe) { Say '  [OK] DeepSeek Harness 已安装' 'Green' }
else { $problems += "找不到 DeepSeek Harness（$dshExe），请先装桌面版" }

# NapCat
$napcatLauncher = Join-Path $NapCatDir 'launcher.bat'
if (Test-Path $napcatLauncher) { Say '  [OK] NapCat 已就位' 'Green' }
else { $warnings += "NapCat 目录里没有 launcher.bat（$NapCatDir）——启动脚本照常生成，但得你先装好 NapCat" }

# 桥接
$bridgeMain = Join-Path $BridgeDir 'src\bridge.js'
$hasBridge = Test-Path $bridgeMain
if ($hasBridge) { Say '  [OK] 桥接已就位' 'Green' }
else { $warnings += "没找到桥接（$BridgeDir\src\bridge.js）——先按 dsh-qq-bridge 的说明部署，再跑一次本脚本" }

# 7z（备份用，可选）
$has7z = $false
foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) {
    if (Test-Path $p) { $has7z = $true; break }
}
if ($has7z) { Say '  [OK] 7-Zip 已安装（备份会用）' 'Green' } else { Say '  [--] 没装 7-Zip（可选，只影响加密备份）' 'DarkGray' }

if ($problems.Count) {
    Say ''
    Say '先解决这几件事再装：' 'Red'
    foreach ($p in $problems) { Say "  · $p" 'Red' }
    Read-Host 'Press Enter to close'
    exit 1
}

Say ''
Say "安装目录：$TargetDir" 'Cyan'
Say "主人 QQ：$OwnerQQ" 'Cyan'
if ($BotQQ) { Say "机器人 QQ：$BotQQ" 'Cyan' }
if ($DryRun) { Say '[DryRun] 只看不做，不会改任何文件' 'Yellow' }
Say ''
if (-not $DryRun) {
    $go = Read-Host '开始部署？(Y/n)'
    if ($go -and $go -notmatch '^[Yy]') { Say '已取消。'; exit 0 }
}

# ── 4. 复制脚本 ─────────────────────────────────────────────────
Head '复制脚本'
$repoRoot = $PSScriptRoot
$skip = @('.git', 'install.ps1', 'install.cmd')

$copied = 0
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir 'state') | Out-Null
}
Get-ChildItem $repoRoot -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    $dest = Join-Path $TargetDir $_.Name
    if ($DryRun) { Say "  [plan] $($_.Name)" 'DarkGray'; return }
    Copy-Item $_.FullName -Destination $dest -Recurse -Force
    $copied++
}
if (-not $DryRun) { Say "  已复制 $copied 项到 $TargetDir" 'Green' }

# ── 5. 生成启动脚本 ─────────────────────────────────────────────
Head '生成启动脚本'

function Write-Bat($path, $content) {
    if ($DryRun) { Say "  [plan] $(Split-Path $path -Leaf)" 'DarkGray'; return }
    [IO.File]::WriteAllText($path, $content, (New-Object Text.ASCIIEncoding))
    Say "  [OK] $(Split-Path $path -Leaf)" 'Green'
}

$bootBat = @"
@echo off
setlocal
cd /d "$NapCatDir"
if not exist launcher.bat (
  echo ERROR: launcher.bat not found in $NapCatDir
  echo Install NapCat Shell first.
  pause
  exit /b 1
)
call launcher.bat $($(if ($BotQQ) { "-q $BotQQ" } else { '' }))
pause
"@
Write-Bat (Join-Path $TargetDir 'napcat-boot.bat') $bootBat

$bridgeBat = @"
@echo off
setlocal
title QQ Bridge
cd /d "$BridgeDir"
if errorlevel 1 (
  echo ERROR: cannot enter $BridgeDir
  pause
  exit /b 1
)
netstat -ano | findstr /C:"127.0.0.1:3100" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Port 3100 already in use - another bridge is running.
  timeout /t 8 /nobreak >nul
  exit /b 0
)
:loop
node src\bridge.js
echo.
echo [bridge] exited, restarting in 5s (Ctrl+C to stop)...
timeout /t 5 /nobreak >nul
goto loop
"@
Write-Bat (Join-Path $TargetDir '2-启动桥接.bat') $bridgeBat

$supBat = @"
@echo off
setlocal
title QQ Bot Supervisor
cd /d "$TargetDir\supervisor"
node supervisor.mjs
pause
"@
Write-Bat (Join-Path $TargetDir '20-supervisor.bat') $supBat

$sdCmd = @"
@echo off
setlocal
chcp 65001 >nul
cd /d "$TargetDir\stack-doctor"
node "$TargetDir\stack-doctor\stack-doctor.mjs"
exit /b 0
"@
Write-Bat (Join-Path $TargetDir 'stack-doctor.cmd') $sdCmd

# ── 6. 注册计划任务 ─────────────────────────────────────────────
Head '注册全栈体检（每 2 分钟自愈）'
if (-not $isAdmin) {
    Say '  [跳过] 没有管理员权限，计划任务没注册。' 'Yellow'
    Say '         右键本脚本「以管理员身份运行」可以补上。' 'Yellow'
} elseif ($DryRun) {
    Say '  [plan] 注册计划任务 QQStackDoctor' 'DarkGray'
} else {
    $taskName = 'QQStackDoctor'
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    try {
        $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$TargetDir\stack-doctor.cmd`"" -WorkingDirectory $TargetDir
        $logon = New-ScheduledTaskTrigger -AtLogOn
        $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
            -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        $who = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) `
            -Settings $set -Principal $who -Force | Out-Null
        Say "  [OK] 计划任务 $taskName 已注册（登录时启动 + 每 2 分钟）" 'Green'
    } catch {
        Say "  [X] 注册失败：$($_.Exception.Message)" 'Red'
        Say '      可以手动跑：schtasks /create /tn QQStackDoctor /tr "cmd /c ..." /sc minute /mo 2 /rl highest' 'Gray'
    }
}

# ── 7. 电源设置 ─────────────────────────────────────────────────
Head '电源设置（保证长时间挂机）'
if ($DryRun) {
    Say '  [plan] 关闭睡眠/休眠超时 + 关闭快速启动' 'DarkGray'
} else {
    try {
        powercfg /change standby-timeout-ac 0 2>$null
        powercfg /change hibernate-timeout-ac 0 2>$null
        Say '  [OK] 交流电下不再自动睡眠' 'Green'
    } catch { Say '  [--] 电源设置没改成功（可以手动在电源选项里设）' 'Yellow' }
    try {
        Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -ErrorAction Stop
        Say '  [OK] 快速启动已关闭（重启后才会自动登录）' 'Green'
    } catch { Say '  [--] 快速启动没关掉（不影响使用，只是重启后可能要手动登录）' 'Yellow' }
}

# ── 8. 收尾 ─────────────────────────────────────────────────────
Head '完成'
Say ''
Say '接下来还需要你手动做的：' 'White'
Say ''
Say '  1. 装 NapCat Shell，扫码登录机器人那个 QQ' 'Yellow'
Say "     目录：$NapCatDir" 'Gray'
Say '  2. 部署桥接 dsh-qq-bridge（它的 README 更详细）' 'Yellow'
Say "     目录：$BridgeDir" 'Gray'
if (-not $hasBridge) { Say '     ← 这一步还没做，做完再跑一次本脚本' 'Red' }
Say '  3. 写人设：roles\README.md 有模板，角色的性格得你自己定' 'Yellow'
Say '  4. 双击 1-启动NapCat.bat → 2-启动桥接.bat → 20-supervisor.bat' 'Yellow'
Say ''
Say '  想让它开机自启：把上面三个 .bat 的快捷方式丢进' 'Gray'
Say '  shell:startup（Win+R 输入就能打开那个文件夹）' 'Gray'
Say ''
if ($warnings.Count) {
    Say '还有几处提醒：' 'DarkYellow'
    foreach ($w in $warnings) { Say "  · $w" 'DarkYellow' }
    Say ''
}
Say '------------------------------------------------' 'DarkGray'
Say "  装好了，目录：$TargetDir" 'White'
Say '------------------------------------------------' 'DarkGray'
Say ''
Read-Host 'Press Enter to close'
