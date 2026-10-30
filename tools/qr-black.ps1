# qr-black.ps1 -- fullscreen black QR screen (WinForms, no browser needed)
#
# Why WinForms: launching a browser from a script here often leaves the page never opened.
# A WinForms window in the user session is always visible; the QR refreshes every 3s and
# the window closes itself once login succeeds.
#
# ASCII only: PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, then non-ASCII
# punctuation breaks the parser.
#
# The heartbeat file is what the caller uses to know the window is really up:
# written once before ShowDialog, then every tick. The beat is written BEFORE any network
# call, so a slow/unreachable QR service can never make it look "not started".
#
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\qr-black.ps1 -Port 7790 -StateDir <state>

param(
  [int]$Port = 7790,
  [string]$StateDir = 'E:\1\qq-stack\dsh-qq\qq-bridge-enhanced-v1.1.0\state'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:PORT = $Port
$script:HB = Join-Path $StateDir 'qr-black.json'
$script:PNG = Join-Path $StateDir 'qr-black.png'

function Write-Beat([string]$Stage) {
  try {
    $beat = @{ at = [DateTime]::Now.ToString('o'); pid = $PID; port = $script:PORT; stage = $Stage } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($script:HB, $beat)
  } catch {}
}

Write-Beat 'boot'

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.WindowState = 'Maximized'
$form.BackColor = [System.Drawing.Color]::Black
$form.TopMost = $true

$script:PIC = New-Object System.Windows.Forms.PictureBox
$script:PIC.SizeMode = 'Zoom'
$script:PIC.BackColor = [System.Drawing.Color]::Black
$script:PIC.Dock = 'Fill'
$form.Controls.Add($script:PIC)

$script:LBL = New-Object System.Windows.Forms.Label
$script:LBL.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$script:LBL.BackColor = [System.Drawing.Color]::Black
$script:LBL.Font = New-Object System.Drawing.Font('Consolas', 14)
$script:LBL.Text = 'Scan the QR to log in (auto refresh, ESC to close)'
$script:LBL.Dock = 'Bottom'
$script:LBL.Height = 46
$script:LBL.TextAlign = 'MiddleCenter'
$form.Controls.Add($script:LBL)

$script:FORM = $form
$form.KeyPreview = $true
$form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $script:FORM.Close() } })

$script:TICK = New-Object System.Windows.Forms.Timer
$script:TICK.Interval = 3000
$script:TICK.Add_Tick({
# (ascii note) see README: QR black screen
  try {
    $beat = @{ at = [DateTime]::Now.ToString('o'); pid = $PID; port = $script:PORT; stage = 'tick' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($script:HB, $beat)
  } catch {}
  try {
    $s = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $script:PORT + '/status') -TimeoutSec 4
    if ($s.logged) { $script:FORM.Close(); return }
    if ($s.url) {
      $pngUrl = 'http://127.0.0.1:' + $script:PORT + '/qr.png?t=' + [DateTime]::Now.Ticks
      Invoke-WebRequest -Uri $pngUrl -OutFile $script:PNG -TimeoutSec 6
      $img = [System.Drawing.Image]::FromFile($script:PNG)
      $old = $script:PIC.Image
      $script:PIC.Image = $img
      if ($old) { $old.Dispose() }
    }
    if ($s.error) { $script:LBL.Text = 'QR service error: ' + $s.error }
    else { $script:LBL.Text = 'Scan the QR to log in (auto refresh, ESC to close)' }
  } catch {
    $script:LBL.Text = 'QR service unreachable: ' + $_.Exception.Message
  }
})

$form.Add_Shown({ $script:TICK.Start(); Write-Beat 'shown' })
[void]$form.ShowDialog()
