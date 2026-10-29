# Optional belt-and-braces: hold a system wake lock while this window is open.
# Use it if Windows Update or the OEM utility keeps re-enabling sleep.
# Run:  powershell -ExecutionPolicy Bypass -File "E:\1\qq-stack\4-hold-awake.ps1"
# Stop: close the window or press Ctrl+C.

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class PowerKeepAwake
{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS       = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED  = 0x00000001;
    public const uint ES_AWAYMODE_REQUIRED = 0x00000040;
    public const uint ES_DISPLAY_REQUIRED  = 0x00000002;
}
'@

if (-not ('PowerKeepAwake' -as [type])) {
    Add-Type -TypeDefinition $signature
}

Write-Host "Holding the system awake. Close this window (or Ctrl+C) to stop." -ForegroundColor Cyan
Write-Host "Screen may still turn off; the machine will not sleep." -ForegroundColor DarkGray

# 心跳文件：巡检靠它判断「保持唤醒还活着」。
# 2026-10-29 教训：这个进程悄悄没了没人发现，合盖后机器自己睡了，QQ 跟着掉线 10 小时。
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$beat = Join-Path $root 'state\keep-awake.heartbeat'
$errFile = Join-Path $root 'state\keep-awake.err'

try {
    while ($true) {
        # ES_CONTINUOUS keeps the request in force; re-assert every 30s is harmless.
        [void][PowerKeepAwake]::SetThreadExecutionState(
            [PowerKeepAwake]::ES_CONTINUOUS -bor
            [PowerKeepAwake]::ES_SYSTEM_REQUIRED
        )
        try {
            [IO.File]::WriteAllText($beat, (Get-Date).ToString('o'))
        } catch {
            try { [IO.File]::WriteAllText($errFile, ("{0}`n{1}" -f (Get-Date).ToString('o'), $_.Exception.Message)) } catch {}
        }
        Start-Sleep -Seconds 30
    }
}
finally {
    [void][PowerKeepAwake]::SetThreadExecutionState([PowerKeepAwake]::ES_CONTINUOUS)
    Write-Host "Wake lock released."
}
