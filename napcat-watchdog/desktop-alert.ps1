param([string]$Text = 'QQ 机器人掉线了，需要人工处理')

# 掉线告警：QQ 自己挂了，没法用 QQ 通知自己，只能弹窗
try {
    Add-Type -AssemblyName System.Windows.Forms
    $title = 'QQ Bot 掉线'
    $full = $Text + "`r`n`r`n" + '（这个窗口可能出现多次，每 30 分钟最多提醒一次）'
    [System.Windows.Forms.MessageBox]::Show($full, $title, 'OK', 'Warning') | Out-Null
} catch {
    # 没有桌面会话时不弹，避免任务里报错
}
