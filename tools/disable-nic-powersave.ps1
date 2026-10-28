# 关闭网卡省电（管理员运行）
#
# 为什么要做这件事：
#   2026-10-28 凌晨 00:41，系统日志里出现 Wi-Fi 驱动事件 + Windows Update 开始下载，
#   同一分钟 NapCat 报「账号已离线」，随后票据失效、快速登录救不回来，
#   早上起来就得重新扫码。
#
#   这台机器的 Wi-Fi（Intel Wi-Fi 6 AX101）省电设置是「允许计算机关闭此设备以节约电源」。
#   夜里没人用网，网卡进省电 → 连接断一下 → QQ 掉线。掉线本身能自愈，
#   但**票据一旦失效就必须扫码**，于是每天早上都要扫一次。
#
# 这个脚本把网卡的 PnPCapabilities 设成 24（= 关闭省电），需要管理员。

$ErrorActionPreference = 'Continue'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say ''
Say '================================================' -ForegroundColor DarkGray
Say '  关闭网卡省电（防止夜里掉线要扫码）' -ForegroundColor White
Say '================================================' -ForegroundColor DarkGray
Say ''

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Say '[X] 没有管理员权限，请右键 bat →「以管理员身份运行」。' 'Red'
    Read-Host 'Press Enter to close'
    exit 1
}

$base = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
$changed = 0

Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $props.DriverDesc) { return }
    # 只处理真实的物理网卡：跳过 WAN Miniport / 虚拟适配器 / 蓝牙 / 调试网卡
    if ($props.DriverDesc -match 'Miniport|Virtual|Bluetooth|Debug|Loopback|Teredo|ISATAP') { return }

    $before = $props.PnPCapabilities
    try {
        Set-ItemProperty -Path $_.PSPath -Name 'PnPCapabilities' -Value 24 -Type DWord -ErrorAction Stop
        Say ("  [OK] {0}  （{1} → 24）" -f $props.DriverDesc, $(if ($null -eq $before) { '未设置' } else { $before })) 'Green'
        $changed++
    } catch {
        Say ("  [X] {0} → {1}" -f $props.DriverDesc, $_.Exception.Message) 'Red'
    }
}

Say ''
if ($changed -gt 0) {
    Say "  改好了 $changed 张网卡。**要重启一次才生效**（或者禁用再启用网卡）。" 'Yellow'
    Say ''
    Say '  验证方法：设备管理器 → 网络适配器 → 双击你的网卡 →' 'Gray'
    Say '            「电源管理」选项卡 →「允许计算机关闭此设备以节约电源」应该是没勾的状态' 'Gray'
} else {
    Say '  没有改到任何网卡，可能名字对不上。可以手动改：' 'Yellow'
    Say '  设备管理器 → 网络适配器 → 双击网卡 → 电源管理 → 取消勾选「允许计算机关闭此设备…」' 'Gray'
}

Say ''
Say '------------------------------------------------' -ForegroundColor DarkGray
Say '  顺带建议（可选）：把这个 Wi-Fi 设成「按流量计费的连接」' 'Gray'
Say '  这样 Windows Update 不会在半夜自动下载，免得抢带宽把 QQ 挤掉线。' 'Gray'
Say '  设置 → 网络和 Internet → WLAN → 你的网络 → 按流量计费的连接' 'Gray'
Say '------------------------------------------------' -ForegroundColor DarkGray
Say ''
Read-Host 'Press Enter to close'
