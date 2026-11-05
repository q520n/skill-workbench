' Auto-types the sign-in steps into the CLI console window.
' 1) Press Enter once (accepts the "trust this folder" prompt if it appears, harmless at the main prompt).
' 2) Wait for the prompt to settle.
' 3) Type /login and press Enter to start browser sign-in.
' Manual fallback: do the same steps yourself in that window.
Option Explicit
Dim sh, ok, i
Set sh = CreateObject("WScript.Shell")

' Wait for the CLI TUI to finish starting up.
WScript.Sleep 12000

ok = False
For i = 1 To 15
  ok = sh.AppActivate("Skill Workbench - CLI Sign-in")
  If ok Then Exit For
  WScript.Sleep 1500
Next

If ok Then
  ' Accept the folder-trust prompt if present (Enter selects the highlighted "Trust folder only").
  WScript.Sleep 800
  sh.SendKeys "{ENTER}"
  ' Let the TUI transition to the main prompt.
  WScript.Sleep 2500
  ' Trigger browser sign-in.
  sh.SendKeys "/login"
  WScript.Sleep 500
  sh.SendKeys "{ENTER}"
End If
