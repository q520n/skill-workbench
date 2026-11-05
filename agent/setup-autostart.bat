@echo off
title Skill Workbench - Auto Start Setup
setlocal
echo ============================================
echo   Register the local agent to start at logon
echo   (minimized window, no admin rights needed)
echo ============================================
echo.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SkillWorkbench-Agent.lnk"
set "WB_AGENT=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\agent"
if not exist "%WB_AGENT%\start-agent.bat" goto :noagent
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); if(-not $s){exit 1}; $s.TargetPath='%WB_AGENT%\start-agent.bat'; $s.WorkingDirectory='%WB_AGENT%'; $s.WindowStyle=7; $s.Description='Skill Workbench local agent'; $s.Save()"
if errorlevel 1 (
  echo.
  echo [FAILED] Could not create the shortcut. No changes were made.
) else (
  echo.
  echo [OK] Created: %LNK%
  echo The agent will start automatically next time you sign in to Windows.
  echo To undo, run remove-autostart.bat
)
echo.
pause
exit /b 0

:noagent
echo [X] Agent folder not found: %WB_AGENT%
pause
exit /b 1
