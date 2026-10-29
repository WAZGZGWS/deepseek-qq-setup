' run-hidden.vbs -- run a console program with no visible window (for scheduled tasks)
' usage: wscript.exe run-hidden.vbs "E:\path\thing.cmd" [args...]
'
' 注意：不要直接 Shell.Run 那个 .cmd/.bat —— 那是走 ShellExecute，
' 目标不是 System32 里的可信 exe 时 Windows 会弹「打开文件 - 安全警告」，
' 对话框一挂就把任务卡住（2026-10-29 实测：10:01 那次体检被它挡住没跑）。
' 所以统一用 cmd /c 包一层：被执行的是受信任的 cmd.exe，脚本只是参数。
If WScript.Arguments.Count = 0 Then WScript.Quit 64

Dim cmd, i, target
target = WScript.Arguments(0)
cmd = "cmd /c """ & target & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

' 0 = hidden window, False = don't wait for it to finish
CreateObject("WScript.Shell").Run cmd, 0, False
