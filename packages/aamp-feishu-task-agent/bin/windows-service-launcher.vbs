Option Explicit
' WScript is a GUI host: no terminal is allocated for the scheduled action.
' Hidden Run creates the worker console hidden and waits to preserve its exit code.
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Dim shell, command, i, result
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To 2
  If InStr(WScript.Arguments(i), Chr(34)) > 0 Then WScript.Quit 2
  If i > 0 Then command = command & " "
  command = command & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
result = shell.Run(command, 0, True)
WScript.Quit result
