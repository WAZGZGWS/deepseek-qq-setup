# 设置机器人 QQ 的密码（只存本地，DPAPI 加密）
#
# 用途：QQ 掉线后不用手机扫码，直接 `node tools/qq-login.mjs password` 登回去。
# 安全性：用 Windows DPAPI 按「当前用户」加密，只有这台电脑上的你这个账户能解开；
#         拷到别的机器、别的账户都读不出来。文件是 <部署目录>\qq-password.dat。
#
# 用法：双击 tools\set-qq-password.cmd（或右键用 PowerShell 运行本文件）

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

Write-Host ''
Write-Host '=== 设置机器人 QQ 密码（输入时不显示） ===' -ForegroundColor Cyan
Write-Host '提示：这个密码只用来「掉线后自动登录」，不会上传到任何地方。' -ForegroundColor DarkGray

$secure = Read-Host -AsSecureString '机器人 QQ 的密码'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $plain) {
  Write-Host '没有输入密码，已退出。' -ForegroundColor Yellow
  exit 1
}

$plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
$enc = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, 'CurrentUser')
$target = Join-Path (Split-Path -Parent $PSScriptRoot) 'qq-password.dat'
[IO.File]::WriteAllBytes($target, $enc)

Write-Host ''
Write-Host "已保存：$target" -ForegroundColor Green
Write-Host '（DPAPI 加密，只有这台电脑的这个 Windows 账户能解开）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '现在可以测一下：' -ForegroundColor Cyan
Write-Host '  node tools/qq-login.mjs status' -ForegroundColor Gray
Write-Host '  node tools/qq-login.mjs password' -ForegroundColor Gray
