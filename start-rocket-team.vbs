' Rocket Team — silent launcher. Runs server-keepalive.cmd with no visible
' console window. A copy of this file lives in the user Startup folder so the
' dashboard server comes up at login and self-restarts on crash.
' 0 = hidden window, False = don't wait.
CreateObject("WScript.Shell").Run "cmd /c ""D:\hrdai\team\server-keepalive.cmd""", 0, False
