# 设置 QQ 邮箱 SMTP 授权码（给「掉线时发邮件」用）
# 授权码不是登录密码：QQ邮箱 → 设置 → 账户 → POP3/SMTP服务 → 开启 → 生成授权码（16 位）
# 本脚本用 DPAPI（当前用户）加密后存到 qq-mail-auth.dat，不落明文。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

Write-Host ''
Write-Host '=== 设置 QQ 邮箱授权码 ===' -ForegroundColor Cyan
Write-Host '先去 QQ 邮箱开通 SMTP 并拿到 16 位授权码：' -ForegroundColor Gray
Write-Host '  邮箱设置 → 账户 → POP3/IMAP/SMTP 服务 → 开启 → 生成授权码' -ForegroundColor Gray
Write-Host ''

$secure = Read-Host '授权码（输入时不会显示）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $plain -or $plain.Trim().Length -lt 8) {
    Write-Host '[X] 授权码看起来不对（少于 8 位），没保存。' -ForegroundColor Red
    Read-Host '按 Enter 关闭'
    exit 1
}

Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($plain.Trim())
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$b64 = [Convert]::ToBase64String($enc)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path (Split-Path -Parent $here) 'qq-mail-auth.dat'
[IO.File]::WriteAllText($out, $b64, [Text.UTF8Encoding]::new($false))
Write-Host "[OK] 已加密保存到 $out" -ForegroundColor Green
Write-Host '     现在可以跑：node tools\notify-offline.mjs --test 验证能不能发出去' -ForegroundColor Gray
Read-Host '按 Enter 关闭'
