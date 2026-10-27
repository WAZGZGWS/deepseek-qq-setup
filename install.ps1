<#
一键部署 —— 体检 → 选位置 → 装好 → 依次启动
================================================================

流程：
  1. 先体检这台电脑（系统/CPU/内存/磁盘/UAC/已装组件），缺什么当场说
  2. 安装位置：**第一次问**，记到 %LOCALAPPDATA%\qq-bot-stack\install.json
     之后每次运行都读这条记录，所有东西继续装到同一个地方
  3. 复制脚本 → 生成启动器 → 注册计划任务 → 电源设置
  4. 可选「依次启动」：NapCat → 等 :3000 → 桥接 → 等 :3100 → supervisor

生成的启动器都会**先打印风险提示**，让你自己决定要不要启动。
无人值守（计划任务/守护脚本）调用时 stdin 是空的，`set /p` 直接读到 EOF，
默认继续，不会卡住。

它不会装：Node.js、DeepSeek Harness、NapCat、桥接 dsh-qq
（都要人工下载/扫码/选路径，缺了它会直接告诉你）

用法：
  双击 install.cmd
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell ... -File install.ps1 -TargetDir D:\qq-bot-stack -OwnerQQ 123456 -BotQQ 654321 -DryRun
#>

param(
    [string]$TargetDir = '',
    [string]$OwnerQQ = '',
    [string]$BotQQ = '',
    [string]$NapCatDir = '',
    [string]$BridgeDir = '',
    [switch]$Reset,     # 忘掉记下来的安装位置，重新问
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# ── 小工具 ──────────────────────────────────────────────────────
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head($m) { Say ''; Say $m 'White'; Say ('=' * 64) 'DarkGray' }
function Row($k, $v, $c = 'Gray') { Say ('  {0,-16}{1}' -f $k, $v) $c }

$STATE_DIR = Join-Path $env:LOCALAPPDATA 'qq-bot-stack'
$STATE_FILE = Join-Path $STATE_DIR 'install.json'
$GBK = [Text.Encoding]::GetEncoding(936)
$ASCII = New-Object Text.ASCIIEncoding

function Read-InstallState {
    if (-not (Test-Path $STATE_FILE)) { return $null }
    try { return (Get-Content $STATE_FILE -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}
function Save-InstallState($obj) {
    if ($DryRun) { Say "  [plan] 记住安装位置 → $STATE_FILE" 'DarkGray'; return }
    try {
        New-Item -ItemType Directory -Force -Path $STATE_DIR | Out-Null
        ($obj | ConvertTo-Json -Depth 5) | Set-Content -Path $STATE_FILE -Encoding UTF8
        Say "  [OK] 已记住安装位置，下次不用再填 → $STATE_FILE" 'Green'
    } catch {
        Say "  [!] 没能记住位置（$($_.Exception.Message)），下次还得填一次" 'Yellow'
    }
}

Head 'QQ Bot 运维套件 · 一键部署'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# ── 1. 机器体检 ─────────────────────────────────────────────────
Head '① 这台电脑的情况'

$osName = 'Windows'; $osBuild = ''
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osName = $os.Caption; $osBuild = "$($os.Version) build $($os.BuildNumber)"
} catch {
    try {
        $cur = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $osName = (Get-ItemProperty $cur).ProductName
        $osBuild = (Get-ItemProperty $cur).CurrentBuild
    } catch {}
}
Row '系统' "$osName  $osBuild" 'White'
Row '当前用户' "$env:USERDOMAIN\$env:USERNAME"
Row '管理员权限' $(if ($isAdmin) { '有' } else { '没有（计划任务和电源设置会跳过）' }) $(if ($isAdmin) { 'Green' } else { 'Yellow' })

try {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
    Row 'CPU' ("$($cpu.Name.Trim())   $($cpu.NumberOfCores)核 $($cpu.NumberOfLogicalProcessors)线程")
} catch { Row 'CPU' '(读不到)' 'DarkGray' }

try {
    $os2 = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $ramTotal = [math]::Round($os2.TotalVisibleMemorySize / 1MB, 1)
    $ramFree = [math]::Round($os2.FreePhysicalMemory / 1MB, 1)
    Row '内存' "$ramTotal GB（空闲 $ramFree GB）" $(if ($ramTotal -lt 4) { 'Yellow' } else { 'Gray' })
    if ($ramTotal -lt 4) { Say '                    ⚠ 内存偏小，同时开 QQ + DSH 会比较紧' 'Yellow' }
    if ($ramFree -lt 1) { Say '                    ⚠ 空闲内存不足 1 GB，建议先关点别的程序' 'Yellow' }
} catch { Row '内存' '(读不到)' 'DarkGray' }

$drives = @()
try {
    foreach ($d in [IO.DriveInfo]::GetDrives()) {
        if ($d.IsReady -and $d.DriveType -eq 'Fixed') {
            $drives += [pscustomobject]@{
                Name = $d.Name.TrimEnd('\')
                Free = [math]::Round($d.AvailableFreeSpace / 1GB, 1)
                Total = [math]::Round($d.TotalSize / 1GB, 1)
            }
        }
    }
} catch {}
if ($drives.Count) {
    Say ''
    Say '  磁盘：' 'Gray'
    foreach ($d in $drives) {
        $c = if ($d.Free -lt 5) { 'Red' } elseif ($d.Free -lt 20) { 'Yellow' } else { 'Green' }
        Say ('    {0}   剩 {1} GB / 共 {2} GB' -f $d.Name, $d.Free, $d.Total) $c
    }
    Say '    （整套跑起来约占 800 MB：NapCat 350 MB + 脚本和日志）' 'DarkGray'
}

try {
    $uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop).ConsentPromptBehaviorAdmin
    Row 'UAC' $(if ($uac -eq 0) { '从不通知（提权不弹窗，适合无人值守）' } else { "级别 $uac（提权会弹窗）" }) 'Gray'
} catch {}
try {
    $hb = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
    Row '快速启动' $(if ($hb -eq 1) { '开着（关机再开机不会自动登录）' } else { '已关闭' }) $(if ($hb -eq 1) { 'Yellow' } else { 'Green' })
} catch {}

Say ''
Say '  已装的组件：' 'Gray'
$nodeVer = ''
try { $nodeVer = (& node -v 2>$null) } catch {}
Row '  Node.js' $(if ($nodeVer) { "$nodeVer" } else { '没装' }) $(if ($nodeVer) { 'Green' } else { 'Red' })

$dshExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
Row '  DSH 桌面版' $(if (Test-Path $dshExe) { '已安装' } else { '没装' }) $(if (Test-Path $dshExe) { 'Green' } else { 'Red' })

$has7z = $false
foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) { if (Test-Path $p) { $has7z = $true; break } }
Row '  7-Zip' $(if ($has7z) { '已安装' } else { '没装（可选，只影响加密备份）' }) $(if ($has7z) { 'Green' } else { 'DarkGray' })

# ── 2. 安装位置 ─────────────────────────────────────────────────
Head '② 安装位置'

$state = if ($Reset) { $null } else { Read-InstallState }

if (-not $TargetDir -and $state -and $state.targetDir) {
    Say "  上次装在这：$($state.targetDir)" 'Cyan'
    Say "  （主人 QQ：$($state.ownerQQ)）" 'DarkGray'
    $inp = (Read-Host '  回车=继续用这个位置；输入新路径=换地方；输入 R=重置记录').Trim()
    if ($inp -match '^[Rr]$') {
        $state = $null
        Say '  已重置，重新选一个位置。' 'Yellow'
    } elseif ($inp) {
        $TargetDir = $inp
    } else {
        $TargetDir = $state.targetDir
        if (-not $OwnerQQ -and $state.ownerQQ) { $OwnerQQ = [string]$state.ownerQQ }
        if (-not $BotQQ -and $state.botQQ) { $BotQQ = [string]$state.botQQ }
        if (-not $NapCatDir -and $state.napCatDir) { $NapCatDir = $state.napCatDir }
        if (-not $BridgeDir -and $state.bridgeDir) { $BridgeDir = $state.bridgeDir }
    }
}

if (-not $TargetDir) {
    Say '  脚本、启动器、运行状态都会放在同一个目录里。' 'Gray'
    Say '  建议放空间大的盘，比如 D:\qq-bot-stack 或 E:\qq-bot-stack。' 'DarkGray'
    do {
        $inp = (Read-Host '  安装目录 [E:\qq-bot-stack]').Trim()
        if (-not $inp) { $inp = 'E:\qq-bot-stack' }
        $TargetDir = $inp
        $parent = Split-Path $TargetDir -Parent
        if (-not $parent -or -not (Test-Path $parent)) {
            Say "  上级目录不存在：$parent" 'Red'
            $TargetDir = ''
        }
    } while (-not $TargetDir)
}
$TargetDir = $TargetDir.TrimEnd('\')
if (-not $NapCatDir) { $NapCatDir = Join-Path $TargetDir 'napcat' }
if (-not $BridgeDir) { $BridgeDir = Join-Path $TargetDir 'dsh-qq\qq-bridge-enhanced-v1.1.0' }

try {
    $di = [IO.DriveInfo]::new((Split-Path $TargetDir -Qualifier))
    $freeGB = [math]::Round($di.AvailableFreeSpace / 1GB, 1)
    Say ''
    Row '目标盘空闲' "$freeGB GB" $(if ($freeGB -lt 3) { 'Red' } elseif ($freeGB -lt 10) { 'Yellow' } else { 'Green' })
    if ($freeGB -lt 3) {
        Say '  ⚠ 不到 3 GB：NapCat 本体就要 350 MB，加上日志备份建议留 5 GB' 'Yellow'
        if ((Read-Host '  还是装这儿？(y/N)') -notmatch '^[Yy]') { Say '  已取消。'; Read-Host 'Press Enter'; exit 0 }
    }
} catch {}

# ── 3. QQ 号 ────────────────────────────────────────────────────
if (-not $OwnerQQ) {
    Say ''
    Say '  你的 QQ 号（机器人给谁发消息、余额提醒发给谁）：' 'Cyan'
    do { $inp = (Read-Host '  主人 QQ').Trim() } while (-not ($inp -match '^\d{5,12}$'))
    $OwnerQQ = $inp
}
if ($OwnerQQ -notmatch '^\d{5,12}$') { Say '  [X] 主人 QQ 必须是 5~12 位数字' 'Red'; Read-Host 'Press Enter'; exit 1 }

if (-not $BotQQ) {
    Say ''
    Say '  机器人那个 QQ 号（填了能免扫码快速登录；留空也行）：' 'Cyan'
    $BotQQ = (Read-Host '  机器人 QQ [可空]').Trim()
}

# ── 4. 能不能装 ─────────────────────────────────────────────────
Head '③ 能不能装'
$problems = @()
$warnings = @()

$nodeMajor = 0
if ($nodeVer -and $nodeVer -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if (-not $nodeVer) { $problems += '没装 Node.js —— 去 https://nodejs.org 下 LTS，装完重开这个窗口' }
elseif ($nodeMajor -lt 20) { $problems += "Node.js 太旧（$nodeVer），需要 20 以上" }
else { Say "  [OK] Node.js $nodeVer" 'Green' }

if (-not (Test-Path $dshExe)) { $problems += '没装 DeepSeek Harness 桌面版（AI 那一层靠它）' } else { Say '  [OK] DeepSeek Harness' 'Green' }

if (Test-Path (Join-Path $NapCatDir 'launcher.bat')) { Say '  [OK] NapCat' 'Green' }
else { $warnings += "NapCat 还没装（$NapCatDir）—— 启动器照常生成，但得你先装 NapCat Shell 并扫码登录" }

if (Test-Path (Join-Path $BridgeDir 'src\bridge.js')) { Say '  [OK] 桥接 dsh-qq' 'Green' }
else { $warnings += "桥接还没部署（$BridgeDir）—— 先按 dsh-qq-bridge 的说明装，装完再跑一次本脚本" }

if ($problems.Count) {
    Say ''
    Say '  这几件得先解决：' 'Red'
    foreach ($p in $problems) { Say "    · $p" 'Red' }
    Say ''
    Say '  弄好重新双击 install.cmd 就行，安装位置已经记下来了。' 'Yellow'
    Read-Host 'Press Enter to close'
    exit 1
}

# ── 5. 确认 ─────────────────────────────────────────────────────
Head '④ 准备就绪'
Say ''
Row '安装到' $TargetDir 'Cyan'
Row '主人 QQ' $OwnerQQ 'Cyan'
if ($BotQQ) { Row '机器人 QQ' $BotQQ 'Cyan' }
Row 'NapCat 目录' $NapCatDir 'Gray'
Row '桥接目录' $BridgeDir 'Gray'
Say ''
if ($DryRun) { Say '  [DryRun] 只看不做，不会改任何文件' 'Yellow' }
else {
    $go = Read-Host '  开始部署？(Y/n)'
    if ($go -and $go -notmatch '^[Yy]') { Say '  已取消。'; exit 0 }
}

Save-InstallState ([pscustomobject]@{
    targetDir = $TargetDir; ownerQQ = $OwnerQQ; botQQ = $BotQQ
    napCatDir = $NapCatDir; bridgeDir = $BridgeDir; savedAt = (Get-Date).ToString('s')
})

# ── 6. 复制脚本 ─────────────────────────────────────────────────
Head '⑤ 复制脚本'
$repoRoot = $PSScriptRoot
$skipNames = @('.git', 'install.ps1', 'install.cmd')
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir 'state') | Out-Null
}
$copied = 0
Get-ChildItem $repoRoot -Force | Where-Object { $skipNames -notcontains $_.Name } | ForEach-Object {
    if ($DryRun) { Say "  [plan] $($_.Name)" 'DarkGray'; return }
    Copy-Item $_.FullName -Destination (Join-Path $TargetDir $_.Name) -Recurse -Force
    $copied++
}
if (-not $DryRun) { Say "  [OK] 已复制 $copied 项" 'Green' }

# ── 7. 生成启动器（先风险提示，再自己决定）──────────────────────
Head '⑥ 生成启动器'

# 风险提示写成独立的 .ps1：**中文绝不能直接写进 .bat**。
# GBK 编码里汉字的尾字节会落在 0x7C(|) / 0x5E / 0x26 这些特殊字符上，
# cmd 解析 .bat 时会把一行 echo 拆成两条命令，报"不是内部或外部命令"。
# 所以 .bat 一律纯 ASCII，中文交给 PowerShell 打印。
$riskPs1 = @'
# 启动前的风险提示（由各个启动器调用；输入 N 则不启动）
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

Write-Host ''
Write-Host '==============================================================' -ForegroundColor DarkGray
Write-Host '  启动前，请先看一眼这些风险' -ForegroundColor White
Write-Host '==============================================================' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  1. 这是用非官方协议端挂 QQ：账号有被限制甚至封禁的可能，' -ForegroundColor Yellow
Write-Host '     强烈建议用一个小号，不要拿主号试。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  2. 机器人会读取你们私聊的内容，并发给 DeepSeek 的 API 处理。' -ForegroundColor Yellow
Write-Host '     介意隐私就别接，或者只在小号上聊。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  3. API 按用量计费，聊得越多花得越多（大约每句话一分钱）。' -ForegroundColor Yellow
Write-Host '     余额耗尽她会直接不说话。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  4. 本套件不含人设。角色是什么性格，得你自己写（roles\README.md）。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  5. 电脑要一直开着、不休眠，断电重启后靠计划任务自己恢复。' -ForegroundColor Yellow
Write-Host ''
Write-Host '--------------------------------------------------------------' -ForegroundColor DarkGray
$ans = Read-Host '  确定启动吗？输入 N 退出，直接回车继续'
if ($ans -match '^[Nn]') { Write-Host '  已取消，没有启动。' -ForegroundColor DarkGray; exit 1 }
exit 0
'@
if ($DryRun) { Say '  [plan] risk-notice.ps1（风险提示文案）' 'DarkGray' }
else {
    [IO.File]::WriteAllText((Join-Path $TargetDir 'risk-notice.ps1'), $riskPs1, (New-Object Text.UTF8Encoding($true)))
    Say '  [OK] risk-notice.ps1' 'Green'
}

function Write-Launcher($fileName, $title, $body) {
    # 纯 ASCII：中文一律走 risk-notice.ps1
    $content = "@echo off`r`nsetlocal`r`ntitle $title`r`n" +
               "rem  -y skips the risk prompt (used by the watchdog / scheduled task)`r`n" +
               "if /i `"%1`"==`"-y`" goto run`r`n" +
               "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0risk-notice.ps1`"`r`n" +
               "if errorlevel 1 exit /b 0`r`n" +
               ":run`r`n" + $body
    if ($DryRun) { Say "  [plan] $fileName" 'DarkGray'; return }
    [IO.File]::WriteAllText((Join-Path $TargetDir $fileName), $content, $ASCII)
    Say "  [OK] $fileName" 'Green'
}

$bootArg = if ($BotQQ) { "-q $BotQQ" } else { '' }

Write-Launcher '1-启动NapCat.bat' 'NapCat (QQ backend)' @"
cd /d "$NapCatDir"
if not exist launcher.bat (
  echo [X] launcher.bat not found in $NapCatDir
  echo     Download NapCat Shell from https://github.com/NapNeko/NapCatQQ/releases
  pause
  exit /b 1
)
call launcher.bat $bootArg
pause
"@

Write-Launcher 'napcat-boot.bat' 'NapCat boot' @"
cd /d "$NapCatDir"
if not exist launcher.bat exit /b 1
call launcher.bat $bootArg
"@

Write-Launcher '2-启动桥接.bat' 'QQ Bridge' @"
cd /d "$BridgeDir"
if errorlevel 1 (
  echo [X] cannot enter $BridgeDir
  pause
  exit /b 1
)
netstat -ano | findstr /C:"127.0.0.1:3100" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [i] port 3100 already in use - another bridge is running.
  timeout /t 8 /nobreak >nul
  exit /b 0
)
:loop
node src\bridge.js
echo.
echo [bridge] exited, restarting in 5s (Ctrl+C to stop)
timeout /t 5 /nobreak >nul
netstat -ano | findstr /C:"127.0.0.1:3100" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
goto loop
"@

Write-Launcher '20-supervisor.bat' 'QQ Bot Supervisor' @"
cd /d "$TargetDir\supervisor"
node supervisor.mjs
pause
"@

# stack-doctor.cmd 由计划任务调用，不带交互，保持 ASCII
$sdCmd = @"
@echo off
setlocal
chcp 65001 >nul
cd /d "$TargetDir\stack-doctor"
node "$TargetDir\stack-doctor\stack-doctor.mjs"
exit /b 0
"@
if ($DryRun) { Say '  [plan] stack-doctor.cmd' 'DarkGray' }
else { [IO.File]::WriteAllText((Join-Path $TargetDir 'stack-doctor.cmd'), $sdCmd, $ASCII); Say '  [OK] stack-doctor.cmd' 'Green' }

# ── 8. 计划任务 ─────────────────────────────────────────────────
Head '⑦ 注册全栈体检（每 2 分钟自愈）'
if (-not $isAdmin) {
    Say '  [跳过] 没有管理员权限。' 'Yellow'
    Say '         右键 install.cmd「以管理员身份运行」可以补上。' 'Yellow'
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
        Say '  [OK] 已注册（登录启动 + 每 2 分钟）' 'Green'
    } catch {
        Say "  [X] 失败：$($_.Exception.Message)" 'Red'
    }
}

# ── 9. 电源 ─────────────────────────────────────────────────────
Head '⑧ 电源设置'
if ($DryRun) { Say '  [plan] 关闭睡眠/休眠 + 关闭快速启动' 'DarkGray' }
else {
    try { powercfg /change standby-timeout-ac 0 2>$null
          powercfg /change hibernate-timeout-ac 0 2>$null
          Say '  [OK] 插电时不再自动睡眠' 'Green' } catch { Say '  [--] 电源设置没改成功' 'Yellow' }
    try { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -ErrorAction Stop
          Say '  [OK] 快速启动已关闭' 'Green' } catch { Say '  [--] 快速启动没关掉' 'Yellow' }
}

# ── 10. 依次启动 ────────────────────────────────────────────────
Head '⑨ 依次启动'

function Wait-Port($port, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (netstat -ano | Select-String ":$port\s" | Select-String 'LISTENING') { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}
function Port-Up($port) { [bool](netstat -ano | Select-String ":$port\s" | Select-String 'LISTENING') }

if ($DryRun) {
    Say '  [plan] NapCat → 等 :3000 → 桥接 → 等 :3100 → supervisor' 'DarkGray'
} else {
    Say ''
    Say '  依次启动的意思是：' 'Gray'
    Say '    NapCat（QQ 协议层）→ 桥接 → supervisor（后台脚本）' 'Gray'
    Say '  每一步都会等端口真的通了才走下一步。' 'Gray'
    Say ''
    $go = Read-Host '  现在依次启动吗？(Y/n)'
    if (-not $go -or $go -match '^[Yy]') {
        if (Port-Up 3000) {
            Say '  [1/3] NapCat 已在线，跳过' 'Green'
        } else {
            Say '  [1/3] 启动 NapCat…（弹二维码就用手机 QQ 扫）' 'Cyan'
            Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$(Join-Path $TargetDir '1-启动NapCat.bat')`" -y" -WindowStyle Minimized
            if (Wait-Port 3000 120) { Say '        [OK] 3000 通了' 'Green' }
            else { Say '        [!] 120 秒没通：看窗口是不是在等扫码' 'Yellow' }
        }

        if (Port-Up 3100) {
            Say '  [2/3] 桥接已在线，跳过' 'Green'
        } else {
            Say '  [2/3] 启动桥接…' 'Cyan'
            Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$(Join-Path $TargetDir '2-启动桥接.bat')`" -y" -WindowStyle Minimized
            if (Wait-Port 3100 60) { Say '        [OK] 3100 控制台起来了' 'Green' }
            else { Say '        [!] 60 秒没起来，看窗口里的报错' 'Yellow' }
        }

        Say '  [3/3] 启动后台脚本…' 'Cyan'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$(Join-Path $TargetDir '20-supervisor.bat')`" -y" -WindowStyle Minimized
        Start-Sleep -Seconds 3
        Say '        [OK] 已启动' 'Green'
    } else {
        Say '  跳过。以后按这个顺序手动双击：' 'Gray'
        Say '    1-启动NapCat.bat → 2-启动桥接.bat → 20-supervisor.bat' 'Gray'
    }
}

# ── 11. 收尾 ────────────────────────────────────────────────────
Head '完成'
Say ''
if ($warnings.Count) {
    Say '  还要你手动补的：' 'DarkYellow'
    foreach ($w in $warnings) { Say "    · $w" 'DarkYellow' }
    Say ''
}
Say '  常用：' 'White'
Say "    启动      $TargetDir\1-启动NapCat.bat（然后 2-、20-）" 'Gray'
Say "    日志      $TargetDir\state\stack-doctor.log" 'Gray'
Say "    自检      node `"$TargetDir\self-check\self-check.mjs`"" 'Gray'
Say "    换位置    install.cmd，在提示里输入新路径（或加 -Reset 重新问）" 'Gray'
Say ''
Say '------------------------------------------------' 'DarkGray'
Say "  安装位置：$TargetDir" 'White'
Say "  位置记录：$STATE_FILE" 'Gray'
Say '------------------------------------------------' 'DarkGray'
Say ''
Read-Host 'Press Enter to close'
